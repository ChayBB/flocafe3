import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { publishCatalog } from './catalog-sync';
import { acknowledgeDelivery } from './connector-ack';
import { connectorAuthorizer, issueConnectorToken } from './connector-auth';
import { resolveCatalogAddons } from './catalog-addons';

const testUrl = process.env.QR_NOTIFICATION_TEST_DATABASE_URL;

test.skipIf(!testUrl)('M3 migrations, scoped credentials, catalog revisions and ACK replays', async () => {
  const url = new URL(testUrl!);
  if (url.hostname !== '127.0.0.1' || !url.pathname.endsWith('_test')) throw Error('Use a loopback test database');
  const sql = postgres(testUrl!, { max: 1, onnotice: () => {} });
  const schema = `m3_${randomUUID().replaceAll('-', '')}`;
  try {
    await sql.unsafe(`CREATE SCHEMA ${schema}`);
    await sql.unsafe(`SET search_path TO ${schema}, public`);
    const files = [...new Bun.Glob('*.sql').scanSync('db/migrations')].sort();
    const migrate = async (file: string) => {
      await sql.begin(async (tx) => { await tx.unsafe(await Bun.file(`db/migrations/${file}`).text()); });
    };
    for (const file of files.filter((file) => file < '003')) await migrate(file);
    const [legacyTenant] = await sql`INSERT INTO tenants(name) VALUES ('Legacy fixture') RETURNING id`;
    const [legacyBranch] = await sql`INSERT INTO branches(tenant_id,name) VALUES (${legacyTenant.id},'Legacy') RETURNING id`;
    const [legacyTable] = await sql`INSERT INTO dining_tables(tenant_id,branch_id,name,pos_table_id)
      VALUES (${legacyTenant.id},${legacyBranch.id},'07','legacy-07') RETURNING id`;
    for (const file of files.filter((file) => file >= '003')) await migrate(file);
    expect((await sql`SELECT bill_awaiting_payment FROM dining_tables WHERE id = ${legacyTable.id}`)[0].bill_awaiting_payment).toBe(false);
    expect((await sql`SELECT pos_table_id, pos_installation_id FROM dining_tables WHERE id = ${legacyTable.id}`)[0])
      .toEqual({ pos_table_id: 'legacy-07', pos_installation_id: null });
    const [tenant] = await sql`INSERT INTO tenants(name) VALUES ('Fixture') RETURNING id`;
    const [branch] = await sql`INSERT INTO branches(tenant_id,name) VALUES (${tenant.id},'A') RETURNING id`;
    const [otherBranch] = await sql`INSERT INTO branches(tenant_id,name) VALUES (${tenant.id},'B') RETURNING id`;
    const registration = { tenant_id: tenant.id, branch_id: branch.id, label: 'Fixture POS' };
    const original = (await issueConnectorToken(sql, { ...registration, scopes: ['orders.read'] }))!;
    const authorize = connectorAuthorizer(sql);
    const request = (token: string) => new Request('https://cloud.example', { headers: { authorization: `Bearer ${token}` } });
    expect(await authorize(request(original.connector_token), 'orders.ack')).toBeNull();
    const rotated = (await issueConnectorToken(sql, { ...registration, installation_id: original.installation_id,
      scopes: ['orders.read', 'orders.ack', 'catalog.write', 'tables.write'] }))!;
    expect(await authorize(request(original.connector_token), 'orders.read')).toBeNull();
    const identity = (await authorize(request(rotated.connector_token), 'orders.ack'))!;
    expect(identity).toEqual({ tenantId: tenant.id, branchId: branch.id, installationId: original.installation_id });

    const revision = randomUUID();
    const option = { id: 'oat', name: 'Oat milk', price_satang: 1000 };
    const groups = [{ name: 'Milk', min: 1, max: 1, multiple: false, options: [option] }];
    expect(resolveCatalogAddons(groups, [])).toBeNull();
    expect(resolveCatalogAddons(groups, [{ id: 'unlinked', quantity: 1 }])).toBeNull();
    expect(resolveCatalogAddons(groups, [{ id: 'oat', quantity: 2 }])).toBeNull();
    expect(resolveCatalogAddons(groups, [{ id: 'oat', quantity: 1 }])).toEqual([{ ...option, quantity: 1 }]);
    const item = { external_id: 'variant:large', pos_product_id: 'coffee', pos_variant_id: 'large',
      name: 'Large coffee', category: 'Drinks', price_satang: 6000, addon_groups: groups };
    const snapshot = { revision, base_revision: null, items: [item] };
    expect(await publishCatalog(sql, identity, snapshot)).toBe('published');
    expect((await sql`SELECT addon_groups FROM menu_items WHERE branch_id = ${branch.id}`)[0].addon_groups).toEqual(groups);
    expect(await publishCatalog(sql, identity, snapshot)).toBe('published');
    expect(await publishCatalog(sql, identity, { ...snapshot, revision: randomUUID() })).toBe('conflict');
    expect(await publishCatalog(sql, identity, { revision: randomUUID(), base_revision: revision,
      items: [{ ...item, pos_product_id: 'wrong-product' }] })).toBe('conflict');
    const staffPrice = { ...item, external_id: 'market-fish', pos_product_id: 'market-fish',
      pos_variant_id: null, name: 'Market fish', price_satang: 0, addon_groups: [] };
    const added = randomUUID();
    expect(await publishCatalog(sql, identity, { revision: added, base_revision: revision,
      items: [item, staffPrice] })).toBe('published');
    const [beforePrice] = await sql`SELECT id FROM menu_items WHERE branch_id = ${branch.id} AND external_id = 'market-fish'`;
    expect(await publishCatalog(sql, identity, { revision: randomUUID(), base_revision: added,
      items: [item, { ...staffPrice, price_satang: 18000 }] })).toBe('published');
    const [afterPrice] = await sql`SELECT id, price_satang FROM menu_items WHERE branch_id = ${branch.id} AND external_id = 'market-fish'`;
    expect(afterPrice).toEqual({ id: beforePrice.id, price_satang: 18000 });
    const [other] = await sql`SELECT count(*)::int n FROM menu_items WHERE branch_id = ${otherBranch.id}`;
    expect(other.n).toBe(0);

    const [table] = await sql`INSERT INTO dining_tables(tenant_id,branch_id,name,pos_table_id,pos_installation_id)
      VALUES (${tenant.id},${branch.id},'08','local-08',${identity.installationId}) RETURNING id`;
    const [session] = await sql`INSERT INTO table_sessions(tenant_id,branch_id,table_id,token_hash,expires_at)
      VALUES (${tenant.id},${branch.id},${table.id},'fixture-hash',now()+interval '1 hour') RETURNING id`;
    const [order] = await sql`INSERT INTO orders(tenant_id,branch_id,table_session_id,total_satang)
      VALUES (${tenant.id},${branch.id},${session.id},6000) RETURNING id`;
    const [event] = await sql`INSERT INTO outbox_events(tenant_id,branch_id,kind,payload)
      VALUES (${tenant.id},${branch.id},'order.created',${sql.json({ order_id: order.id })}) RETURNING id`;
    await sql`INSERT INTO connector_deliveries(event_id,tenant_id,branch_id) VALUES (${event.id},${tenant.id},${branch.id})`;
    const receipt = { event_id: event.id, cloud_order_id: order.id, pos_receipt_id: randomUUID(), pos_order_number: 'ORD-FIXTURE' };
    expect(await acknowledgeDelivery(sql, { ...identity, branchId: otherBranch.id }, receipt)).toBe('missing');
    expect(await acknowledgeDelivery(sql, { ...identity, installationId: randomUUID() }, receipt)).toBe('missing');
    await sql`ALTER TABLE audit_logs ADD CHECK (action <> 'order.pos_accepted')`;
    await expect(acknowledgeDelivery(sql, identity, receipt)).rejects.toMatchObject({ code: '23514' });
    expect((await sql`SELECT status FROM connector_deliveries`)[0].status).toBe('pending');
    expect((await sql`SELECT status FROM orders`)[0].status).toBe('created');
    await sql`ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_action_check`;
    expect(await acknowledgeDelivery(sql, identity, receipt)).toBe('accepted');
    expect(await acknowledgeDelivery(sql, identity, receipt)).toBe('accepted');
    expect(await acknowledgeDelivery(sql, identity, { ...receipt, pos_receipt_id: randomUUID() })).toBe('conflict');
    expect((await sql`SELECT status FROM orders`)[0].status).toBe('pos_accepted');
    expect((await sql`SELECT count(*)::int n FROM audit_logs`)[0].n).toBe(1);
    await sql`UPDATE connector_installations SET revoked_at=now() WHERE id=${identity.installationId}`;
    expect(await authorize(request(rotated.connector_token), 'orders.read')).toBeNull();
  } finally {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await sql.end();
  }
});
