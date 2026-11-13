import { Elysia, t } from 'elysia';
import postgres from 'postgres';
import Redis from 'ioredis';
import { bearer, constantEqual, sha256, token } from '../../../packages/shared/src/index';
import { connectorNotifications, connectorWebSocketOptions } from './connector-notifications';
import { readPendingConnectorOrders } from './connector-notification-source';
import { readConnectorEventPage, readConnectorOrder } from './connector-order-source';
import { menuPreview, tableSessionScope } from './menu-preview';
import { posTableQr } from './pos-table-qr';
import { acknowledgeDelivery } from './connector-ack';
import { kitchenStatuses, recordKitchenStatus } from './connector-kitchen-status';
import { connectorAuthorizer, issueConnectorToken } from './connector-auth';
import { publishCatalog } from './catalog-sync';
import { AddonGroups, AddonSelection, resolveCatalogAddons, type AddonGroup } from './catalog-addons';
const sql=postgres(process.env.DATABASE_URL!,{max:12});
const redis=new Redis(process.env.REDIS_URL!);
const adminSecret=process.env.ADMIN_BOOTSTRAP_TOKEN!;
const connectorSecret=process.env.ALLOW_LEGACY_CONNECTOR_TOKEN==='true' ? process.env.CONNECTOR_TOKEN : undefined;
if(!adminSecret||adminSecret.length<24|| (connectorSecret && connectorSecret.length<24)) throw Error('Configure strong secrets');
const err=(status:number,message:string)=>new Response(JSON.stringify({error:message}),{status,headers:{'content-type':'application/json'}});
const isAdmin=(r:Request)=>constantEqual(bearer(r),adminSecret);
const connectorScope = {
 tenantId: process.env.CONNECTOR_TENANT_ID ?? '',
 branchId: process.env.CONNECTOR_BRANCH_ID ?? '',
};
const authorizeConnector=connectorAuthorizer(sql, connectorSecret ? {...connectorScope,token:connectorSecret} : undefined);

async function createTableSession(scope: typeof tableSessionScope.static) {
  const secret = token();
  const [row] = await sql<{ id: string; expires_at: Date }[]>`
    INSERT INTO table_sessions(tenant_id, branch_id, table_id, token_hash, expires_at)
    SELECT tenant_id, branch_id, id, ${sha256(secret)}, now() + interval '365 days'
    FROM dining_tables
    WHERE id = ${scope.table_id} AND tenant_id = ${scope.tenant_id} AND branch_id = ${scope.branch_id}
    RETURNING id, expires_at
  `;
  return row ? { ...row, table_token: secret } : null;
}

const app=new Elysia({ websocket: connectorWebSocketOptions })
.use(posTableQr({ sql, authorize: (request) => authorizeConnector(request, 'tables.write'), publicOrigin: process.env.QR_ORDERING_PUBLIC_ORIGIN }))
.use(menuPreview({
  secret: adminSecret,
  isAdmin,
  createSession: createTableSession,
  async readMenu(sessionId) {
    const [row] = await sql<{ table_name: string; items: { name: string; price_satang: number }[] }[]>`
      SELECT d.name AS table_name, COALESCE((
        SELECT jsonb_agg(jsonb_build_object('name', m.name, 'price_satang', m.price_satang)
                         ORDER BY m.name, m.id)
        FROM menu_items m
        WHERE m.tenant_id = s.tenant_id AND m.branch_id = s.branch_id AND m.available
      ), '[]'::jsonb) AS items
      FROM table_sessions s
      JOIN dining_tables d ON (d.tenant_id, d.branch_id, d.id) = (s.tenant_id, s.branch_id, s.table_id)
      WHERE s.id = ${sessionId} AND s.expires_at > now() AND s.revoked_at IS NULL
    `;
    return row ?? null;
  },
}))
.use(connectorNotifications({
 scope: connectorScope,
 async authenticate(request) {
  // The older WebSocket contract is fixed to one configured scope. Registered installations poll.
  const identity = await authorizeConnector(request, 'orders.read');
  return !!identity && identity.installationId === null;
 },
 readPending: (scope, limit) => readPendingConnectorOrders(sql, scope, limit),
 subscribe(wake) {
  const channel = 'qr:outbox';
  const subscriber = redis.duplicate({ autoResubscribe: false, maxRetriesPerRequest: 1 });
  subscriber.on('error', () => {});
  subscriber.on('ready', () => {
   void subscriber.subscribe(channel).then(wake, () => {});
  });
  subscriber.on('message', (name) => {
   if (name === channel) wake();
  });
  return () => subscriber.disconnect();
 },
}))
.get('/health/live',()=>({ok:true}))
.get('/health/ready',async()=>{await sql`SELECT 1`;await redis.ping();return {ok:true}})
.post('/api/v1/admin/connector-installations/token',async({request,body})=>{
 if(!isAdmin(request))return err(401,'unauthorized');
 try {
  const issued = await issueConnectorToken(sql, body);
  return issued ? Response.json(issued,{headers:{'Cache-Control':'no-store'}}) : err(404,'installation not found');
 } catch(error) {
  if ((error as { code?: string })?.code==='23505') return err(409,'branch already has an active installation');
  throw error;
 }
},{body:t.Object({
 tenant_id:t.String({format:'uuid'}),branch_id:t.String({format:'uuid'}),
 installation_id:t.Optional(t.String({format:'uuid'})),label:t.String({minLength:1,maxLength:80}),
 scopes:t.Array(t.Union([t.Literal('orders.read'),t.Literal('orders.ack'),t.Literal('tables.write'),t.Literal('catalog.write')]),{minItems:1,maxItems:4,uniqueItems:true}),
})})
.post('/api/v1/admin/connector-installations/revoke',async({request,body})=>{
 if(!isAdmin(request))return err(401,'unauthorized');
 await sql.begin(async tx=>{
  const [revoked]=await tx`UPDATE connector_installations SET revoked_at=coalesce(revoked_at,now())
    WHERE id=${body.installation_id} AND tenant_id=${body.tenant_id} AND branch_id=${body.branch_id} RETURNING id`;
  if(!revoked)return;
  await tx`UPDATE dining_tables SET qr_ordering_until=NULL WHERE pos_installation_id=${revoked.id}
    AND tenant_id=${body.tenant_id} AND branch_id=${body.branch_id}`;
  await tx`UPDATE table_sessions s SET revoked_at=now() FROM dining_tables d
    WHERE (s.tenant_id,s.branch_id,s.table_id)=(d.tenant_id,d.branch_id,d.id)
      AND d.pos_installation_id=${revoked.id} AND d.tenant_id=${body.tenant_id} AND d.branch_id=${body.branch_id}
      AND s.revoked_at IS NULL AND s.expires_at>now()`;
 });
 return {ok:true};
},{body:t.Object({installation_id:t.String({format:'uuid'}),tenant_id:t.String({format:'uuid'}),branch_id:t.String({format:'uuid'})})})
.post('/api/v1/admin/tenants',async({request,body})=>{
 if(!isAdmin(request))return err(401,'unauthorized');
 const [row]=await sql`INSERT INTO tenants(name) VALUES (${body.name}) RETURNING *`;return row;
},{body:t.Object({name:t.String({minLength:1,maxLength:100})})})
.post('/api/v1/admin/branches',async({request,body})=>{
 if(!isAdmin(request))return err(401,'unauthorized');
 const [row]=await sql`INSERT INTO branches(tenant_id,name) VALUES (${body.tenant_id},${body.name}) RETURNING *`;return row;
},{body:t.Object({tenant_id:t.String({format:'uuid'}),name:t.String({minLength:1,maxLength:100})})})
.post('/api/v1/admin/tables',async({request,body})=>{
 if(!isAdmin(request))return err(401,'unauthorized');
 const [row]=await sql`INSERT INTO dining_tables(tenant_id,branch_id,name) VALUES (${body.tenant_id},${body.branch_id},${body.name}) RETURNING *`;return row;
},{body:t.Object({tenant_id:t.String({format:'uuid'}),branch_id:t.String({format:'uuid'}),name:t.String({minLength:1,maxLength:80})})})
.post('/api/v1/admin/menu-items',async({request,body})=>{
 if(!isAdmin(request))return err(401,'unauthorized');
 return sql.begin(async tx=>{
  const [branch]=await tx`SELECT menu_revision FROM branches WHERE tenant_id=${body.tenant_id} AND id=${body.branch_id} FOR UPDATE`;
  if(!branch)return err(404,'branch not found');
  if(branch.menu_revision)return err(409,'branch menu is managed by POS');
  const [row]=await tx`INSERT INTO menu_items(tenant_id,branch_id,external_id,name,price_satang) VALUES (${body.tenant_id},${body.branch_id},${body.external_id},${body.name},${body.price_satang}) ON CONFLICT(tenant_id,branch_id,external_id) DO UPDATE SET name=excluded.name,price_satang=excluded.price_satang,updated_at=now() RETURNING *`;
  return row;
 });
},{body:t.Object({tenant_id:t.String({format:'uuid'}),branch_id:t.String({format:'uuid'}),external_id:t.String(),name:t.String(),price_satang:t.Integer({minimum:0})})})
.get('/api/v1/connectors/catalog',async({request})=>{
 const scope=await authorizeConnector(request,'catalog.write');
 if(!scope)return err(401,'unauthorized');
 const [row]=await sql`SELECT menu_revision AS revision FROM branches WHERE tenant_id=${scope.tenantId} AND id=${scope.branchId}`;
 return row ?? err(404,'branch not found');
})
.post('/api/v1/connectors/catalog',async({request,body})=>{
 const scope=await authorizeConnector(request,'catalog.write');
 if(!scope)return err(401,'unauthorized');
 const outcome=await publishCatalog(sql,scope,body);
 if(outcome==='invalid')return err(400,'invalid catalog');
 if(outcome==='missing')return err(404,'branch not found');
 if(outcome==='conflict')return err(409,'catalog revision conflict');
 return {revision:body.revision,count:body.items.length};
},{body:t.Object({
 revision:t.String({format:'uuid'}),base_revision:t.Union([t.Null(),t.String({format:'uuid'})]),
 items:t.Array(t.Object({
  external_id:t.String({minLength:1,maxLength:160}),pos_product_id:t.String({minLength:1,maxLength:128}),
  pos_variant_id:t.Union([t.Null(),t.String({minLength:1,maxLength:128})]),name:t.String({minLength:1,maxLength:200}),
  category:t.Union([t.Null(),t.String({maxLength:120})]),price_satang:t.Integer({minimum:0,maximum:100000000}),
  addon_groups:t.Optional(AddonGroups),
 }),{minItems:1,maxItems:1000}),
})})
.get('/api/v1/connectors/guest-settings',async({request})=>{
 const scope=await authorizeConnector(request,'catalog.write');
 if(!scope)return err(401,'unauthorized');
 const [row]=await sql`SELECT guest_scroll_percent AS scroll_percent FROM branches WHERE tenant_id=${scope.tenantId} AND id=${scope.branchId}`;
 return row ?? err(404,'branch not found');
})
.post('/api/v1/connectors/guest-settings',async({request,body})=>{
 const scope=await authorizeConnector(request,'catalog.write');
 if(!scope)return err(401,'unauthorized');
 const [row]=await sql`UPDATE branches SET guest_scroll_percent=${body.scroll_percent} WHERE tenant_id=${scope.tenantId} AND id=${scope.branchId} RETURNING guest_scroll_percent AS scroll_percent`;
 return row ?? err(404,'branch not found');
},{body:t.Object({scroll_percent:t.Integer({minimum:50,maximum:100})})})
.post('/api/v1/admin/table-sessions',async({request,body})=>{
 if(!isAdmin(request))return err(401,'unauthorized');
 return await createTableSession(body) ?? err(404,'table not found');
},{body:tableSessionScope})
.get('/api/v1/menu',async({request})=>{
 const secret=bearer(request);
 const tableKey=request.headers.get('x-flo-table-key');
 if(!secret && !tableKey)return err(401,'missing session');
 if(!secret && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(tableKey!))return err(404,'table not found');
 return sql.begin(async tx=>{
  const [scope]=secret
   ? await tx`SELECT tenant_id,branch_id FROM table_sessions WHERE token_hash=${sha256(secret)} AND expires_at>now() AND revoked_at IS NULL`
   : await tx`SELECT tenant_id,branch_id FROM dining_tables d
       WHERE qr_public_id=${tableKey} AND pos_table_id IS NOT NULL
         AND (pos_installation_id IS NULL OR EXISTS (
           SELECT 1 FROM connector_installations c WHERE c.id=d.pos_installation_id
             AND c.tenant_id=d.tenant_id AND c.branch_id=d.branch_id AND c.revoked_at IS NULL
         ))`;
  if(!scope)return secret ? err(401,'invalid session') : err(404,'table not found');
  const [branch]=await tx`SELECT menu_revision,guest_scroll_percent FROM branches WHERE tenant_id=${scope.tenant_id} AND id=${scope.branch_id} FOR SHARE`;
  const items=await tx`SELECT id,name,price_satang,category,addon_groups FROM menu_items WHERE tenant_id=${scope.tenant_id} AND branch_id=${scope.branch_id} AND available=true ORDER BY category,name,id`;
  return Response.json({items,menu_revision:branch?.menu_revision??null,scroll_percent:branch?.guest_scroll_percent??null},{headers:{'Cache-Control':'no-store'}});
 });
})
.post('/api/v1/orders',async({request,body})=>{
 const secret=bearer(request),key=request.headers.get('idempotency-key');
 if(!secret||!key||key.length>128)return err(400,'session and idempotency-key required');
 const [session]=await sql`SELECT * FROM table_sessions WHERE token_hash=${sha256(secret)} AND expires_at>now() AND revoked_at IS NULL`;
 if(!session)return err(401,'invalid session');
 const hash=sha256(JSON.stringify(body));
 try {
 return await sql.begin(async tx=>{
   // Serialize the branch idempotency key even when the buyer changes table sessions.
   await tx`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([session.tenant_id,session.branch_id,key])}, 0))`;
   const [table]=await tx`SELECT bill_awaiting_payment FROM dining_tables
     WHERE id=${session.table_id} AND tenant_id=${session.tenant_id} AND branch_id=${session.branch_id} FOR SHARE`;
   const [locked]=await tx`SELECT id FROM table_sessions WHERE id=${session.id} AND expires_at>now() AND revoked_at IS NULL FOR UPDATE`;
   if(!locked)return err(401,'invalid session');
   const [prior]=await tx`SELECT i.request_hash,i.order_id,s.table_id,s.qr_generation,s.id AS session_id FROM idempotency_records i
     JOIN orders o ON (o.id,o.tenant_id,o.branch_id)=(i.order_id,i.tenant_id,i.branch_id)
     JOIN table_sessions s ON s.id=o.table_session_id AND (s.tenant_id,s.branch_id)=(o.tenant_id,o.branch_id)
     WHERE i.tenant_id=${session.tenant_id} AND i.branch_id=${session.branch_id} AND i.key=${key}`;
   if(prior){
    const sameCycle=session.qr_generation ? prior.qr_generation===session.qr_generation : prior.session_id===session.id;
    if(prior.request_hash!==hash||prior.table_id!==session.table_id||!sameCycle)return err(409,'idempotency key reused with different table or payload');
    return {order_id:prior.order_id,replayed:true};
   }
   if(!table)return err(409,'table closed');
   if(table.bill_awaiting_payment)return Response.json({error:'bill_awaiting_payment',code:'bill_awaiting_payment'},
     {status:409,headers:{'Cache-Control':'no-store'}});
   const [branch]=await tx`SELECT menu_revision FROM branches WHERE tenant_id=${session.tenant_id} AND id=${session.branch_id} FOR SHARE`;
   if(branch?.menu_revision && branch.menu_revision!==body.menu_revision)return err(409,'menu revision changed');
   if(body.items.reduce((sum,line)=>sum+line.quantity,0)>100)return err(400,'order exceeds quantity limit');
   const ids=[...new Set(body.items.map(x=>x.menu_item_id))];
   const menu=await tx<{id:string;name:string;price_satang:number;addon_groups:AddonGroup[]}[]>`SELECT id,name,price_satang,addon_groups FROM menu_items WHERE tenant_id=${session.tenant_id} AND branch_id=${session.branch_id} AND available=true AND id IN ${tx(ids)}`;
   if(menu.length!==ids.length)return err(400,'invalid menu item');
   const lines=[];
   const combinations=new Set<string>();
   for(const item of body.items) {
    const product=menu.find(row=>row.id===item.menu_item_id)!;
    const addons=resolveCatalogAddons(product.addon_groups,item.addons??[]);
    if(!addons)return err(400,'invalid menu options');
    const combination=JSON.stringify([product.id,addons.map(({id,quantity})=>[id,quantity])]);
    if(combinations.has(combination))return err(400,'duplicate item ids; consolidate quantities');
    combinations.add(combination);
    const addonsPrice=addons.reduce((sum,addon)=>sum+addon.price_satang*addon.quantity,0);
    lines.push({...item,addons,name:product.name,unit:product.price_satang,line:(product.price_satang+addonsPrice)*item.quantity});
   }
   const total=lines.reduce((n,x)=>n+x.line,0);
   if(total>2147483647)return err(400,'order total exceeds limit');
   const [order]=await tx`INSERT INTO orders(tenant_id,branch_id,table_session_id,total_satang,note) VALUES (${session.tenant_id},${session.branch_id},${session.id},${total},${body.note?.trim()??''}) RETURNING id`;
   for(const x of lines)await tx`INSERT INTO order_items(order_id,menu_item_id,name_snapshot,unit_price_satang,quantity,line_total_satang,note,addons_snapshot) VALUES (${order.id},${x.menu_item_id},${x.name},${x.unit},${x.quantity},${x.line},${x.note??''},${tx.json(x.addons)})`;
   await tx`INSERT INTO idempotency_records(tenant_id,branch_id,key,request_hash,order_id) VALUES (${session.tenant_id},${session.branch_id},${key},${hash},${order.id})`;
   await tx`INSERT INTO outbox_events(tenant_id,branch_id,kind,payload) VALUES (${session.tenant_id},${session.branch_id},'order.created',${tx.json({version:1,order_id:order.id,cloud_table_id:session.table_id,menu_revision:branch?.menu_revision??null})})`;
   return {order_id:order.id,total_satang:total,status:'created',replayed:false};
 });
 }catch(e){console.error(e);return err(500,'order creation failed');}
},{body:t.Object({menu_revision:t.Optional(t.String({format:'uuid'})),note:t.Optional(t.String({maxLength:200})),items:t.Array(t.Object({menu_item_id:t.String({format:'uuid'}),quantity:t.Integer({minimum:1,maximum:50}),note:t.Optional(t.String({maxLength:160})),addons:t.Optional(t.Array(AddonSelection,{maxItems:20}))}),{minItems:1,maxItems:30})})})
.get('/api/v1/table-session/orders',async({request})=>{
 const secret=bearer(request);if(!secret)return err(401,'missing session');
 const [session]=await sql`SELECT tenant_id,branch_id,table_id,qr_generation,id FROM table_sessions WHERE token_hash=${sha256(secret)} AND expires_at>now() AND revoked_at IS NULL`;
 if(!session)return err(401,'invalid session');
 const orders=await sql`SELECT o.id,o.status,o.total_satang,o.note,o.created_at,
   (SELECT cd.pos_order_number FROM outbox_events e JOIN connector_deliveries cd ON cd.event_id=e.id
     WHERE e.tenant_id=o.tenant_id AND e.branch_id=o.branch_id AND e.kind='order.created' AND e.payload->>'order_id'=o.id::text LIMIT 1) AS pos_order_number,
   coalesce((SELECT jsonb_agg(jsonb_build_object('name',i.name_snapshot,'quantity',i.quantity,'note',i.note,'status',i.kitchen_status,
     'addons',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',a->>'name','quantity',(a->>'quantity')::int)),'[]'::jsonb) FROM jsonb_array_elements(i.addons_snapshot) a)
   ) ORDER BY i.id) FROM order_items i WHERE i.order_id=o.id),'[]'::jsonb) AS items
   FROM orders o JOIN table_sessions s ON s.id=o.table_session_id AND (s.tenant_id,s.branch_id)=(o.tenant_id,o.branch_id)
   WHERE o.tenant_id=${session.tenant_id} AND o.branch_id=${session.branch_id} AND s.table_id=${session.table_id}
     AND (CASE WHEN ${session.qr_generation}::uuid IS NULL THEN s.id=${session.id} ELSE s.qr_generation=${session.qr_generation}::uuid END)
   ORDER BY o.created_at DESC LIMIT 20`;
 const [table]=await sql`SELECT bill_awaiting_payment FROM dining_tables
   WHERE id=${session.table_id} AND tenant_id=${session.tenant_id} AND branch_id=${session.branch_id}`;
 return Response.json({orders,bill_awaiting_payment:table?.bill_awaiting_payment===true},{headers:{'Cache-Control':'no-store'}});
})
.get('/api/v1/orders/:id',async({request,params})=>{
 const secret=bearer(request);if(!secret)return err(401,'missing session');
 const [row]=await sql`SELECT o.id,o.status,o.total_satang,o.created_at FROM orders o JOIN table_sessions s ON s.id=o.table_session_id WHERE o.id=${params.id} AND s.token_hash=${sha256(secret)} AND s.expires_at>now() AND s.revoked_at IS NULL`;
 return row??err(404,'not found');
})
.get('/api/v1/connectors/events',async({request,query})=>{
 const scope=await authorizeConnector(request,'orders.read');
 if(!scope)return err(401,'unauthorized');
 const page=await readConnectorEventPage(sql, scope, query.after ?? null);
 return {...page,scope:{tenant_id:scope.tenantId,branch_id:scope.branchId}};
},{query:t.Object({after:t.Optional(t.String({format:'uuid'}))})})
.get('/api/v1/connectors/capabilities',async({request})=>{
 const identity=await authorizeConnector(request,'orders.read');
 if(!identity)return err(401,'unauthorized');
 const receipt=await authorizeConnector(request,'orders.ack');
 return {automatic_acceptance:!!receipt,tenant_id:identity.tenantId,branch_id:identity.branchId};
})
.get('/api/v1/connectors/events/:id/order', async ({ request, params, query }) => {
 const scope = await authorizeConnector(request, 'orders.read');
 if (!scope) return err(401, 'unauthorized');
 const order = await readConnectorOrder(sql, scope, params.id);
 if (query.addons !== '1' && order?.items?.some((item) => item.addons?.length)) {
  return err(409, 'connector upgrade required for menu options');
 }
 return order ?? err(404, 'pending order not found');
}, { params: t.Object({ id: t.String({ format: 'uuid' }) }), query: t.Object({ addons: t.Optional(t.Literal('1')) }) })
.post('/api/v1/connectors/ack-receipt',async({request,body})=>{
 const scope=await authorizeConnector(request,'orders.ack');
 if(!scope)return err(401,'unauthorized');
 const outcome = await acknowledgeDelivery(sql, scope, body);
 if(outcome==='missing')return err(404,'event not found');
 if(outcome==='conflict')return err(409,'delivery receipt conflict');
 return {ok:true,pos_receipt_id:body.pos_receipt_id};
},{body:t.Object({
 event_id:t.String({format:'uuid'}), cloud_order_id:t.String({format:'uuid'}),
 pos_receipt_id:t.String({format:'uuid'}), pos_order_number:t.String({minLength:1,maxLength:80}),
})})
.post('/api/v1/connectors/order-status',async({request,body})=>{
 const scope=await authorizeConnector(request,'orders.ack');
 if(!scope)return err(401,'unauthorized');
 const outcome=await recordKitchenStatus(sql,scope,body);
 if(outcome==='missing')return err(404,'order not found');
 if(outcome==='conflict')return err(409,'order not acknowledged');
 return {ok:true};
},{body:t.Object({order_id:t.String({format:'uuid'}),statuses:t.Array(t.Union(kitchenStatuses.map(status=>t.Literal(status))),{minItems:1,maxItems:30})})})
.post('/api/v1/admin/payments/cash-confirm',async({request,body})=>{
 if(!isAdmin(request))return err(401,'unauthorized');
 // Bootstrap-only: replace with branch-scoped staff RBAC before production.
 const [o]=await sql`SELECT id,tenant_id,branch_id,total_satang FROM orders WHERE id=${body.order_id}`;
 if(!o)return err(404,'order not found');
 const [p]=await sql`INSERT INTO payments(tenant_id,branch_id,order_id,method,status,amount_satang,confirmed_at) VALUES (${o.tenant_id},${o.branch_id},${o.id},'cash','confirmed',${o.total_satang},now()) RETURNING id,status`;
 await sql`INSERT INTO audit_logs(tenant_id,branch_id,actor,action,resource_id) VALUES (${o.tenant_id},${o.branch_id},'bootstrap-admin','cash.confirmed',${p.id})`;
 return p;
},{body:t.Object({order_id:t.String({format:'uuid'})})})
.listen({hostname:'0.0.0.0',port:Number(process.env.PORT??3000)});
console.log('QR API listening',app.server?.port);
