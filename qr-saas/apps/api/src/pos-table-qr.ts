import { Elysia, t } from 'elysia';
import type { Sql } from 'postgres';
import { sha256, token } from '../../../packages/shared/src/index';
import type { ConnectorIdentity } from './connector-auth';

interface Options {
  sql: Sql;
  authorize(request: Request): ConnectorIdentity | null | Promise<ConnectorIdentity | null>;
  publicOrigin?: string;
}

function reply(status: number, body: object) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export function posTableQr({ sql, authorize, publicOrigin }: Options) {
  return new Elysia({ name: 'pos-table-qr' })
    .post(
      '/api/v1/connectors/table-states',
      async ({ request, body }) => {
        const identity = await authorize(request);
        if (!identity) return reply(401, { error: 'unauthorized' });
        const { tenantId, branchId, installationId } = identity;
        await sql.begin(async (tx) => {
          await tx`
          UPDATE dining_tables d SET name = s.name, bill_awaiting_payment = s.awaiting_payment,
            qr_ordering_until = CASE WHEN s.active THEN now() + interval '365 days' ELSE NULL END,
            qr_session_generation = CASE WHEN NOT s.active THEN NULL
              WHEN d.qr_ordering_until > now() THEN coalesce(d.qr_session_generation, gen_random_uuid())
              ELSE gen_random_uuid() END
          FROM jsonb_to_recordset(${tx.json(body.tables)})
            AS s(pos_table_id text, name text, active boolean, awaiting_payment boolean)
          WHERE d.tenant_id = ${tenantId} AND d.branch_id = ${branchId}
            AND d.pos_installation_id IS NOT DISTINCT FROM ${installationId}::uuid
            AND d.pos_table_id = s.pos_table_id
            AND (d.name IS DISTINCT FROM s.name OR d.bill_awaiting_payment IS DISTINCT FROM s.awaiting_payment
              OR (s.active AND (d.qr_ordering_until IS NULL OR d.qr_ordering_until < now() + interval '1 day' OR d.qr_session_generation IS NULL))
              OR (NOT s.active AND (d.qr_ordering_until IS NOT NULL OR d.qr_session_generation IS NOT NULL)))
        `;
          const inactive = body.tables
            .filter((table) => !table.active)
            .map((table) => table.pos_table_id);
          if (inactive.length)
            await tx`
          UPDATE table_sessions s SET revoked_at = now() FROM dining_tables d
          WHERE s.table_id = d.id AND s.tenant_id = d.tenant_id AND s.branch_id = d.branch_id
            AND d.tenant_id = ${tenantId} AND d.branch_id = ${branchId}
            AND d.pos_installation_id IS NOT DISTINCT FROM ${installationId}::uuid
            AND d.pos_table_id = ANY(${inactive}) AND s.revoked_at IS NULL
        `;
        });
        return reply(200, { ok: true });
      },
      {
        body: t.Object({
          tables: t.Array(
            t.Object({
              pos_table_id: t.String({ minLength: 1, maxLength: 128 }),
              name: t.String({ minLength: 1, maxLength: 80 }),
              active: t.Boolean(),
              awaiting_payment: t.Boolean(),
            }),
            { minItems: 1, maxItems: 250 },
          ),
        }),
      },
    )
    .post(
      '/api/v1/connectors/table-qr',
      async ({ request, body }) => {
        const identity = await authorize(request);
        if (!identity) return reply(401, { error: 'unauthorized' });
        const { tenantId, branchId, installationId } = identity;
        if (body.action === 'payment-state') {
          if (typeof body.awaiting_payment !== 'boolean')
            return reply(400, { error: 'payment state required' });
          const [table] = await sql`
          UPDATE dining_tables SET bill_awaiting_payment = ${body.awaiting_payment}
          WHERE tenant_id = ${tenantId} AND branch_id = ${branchId} AND pos_table_id = ${body.pos_table_id}
            AND pos_installation_id IS NOT DISTINCT FROM ${installationId}::uuid
          RETURNING bill_awaiting_payment
        `;
          return table
            ? reply(200, { awaiting_payment: table.bill_awaiting_payment })
            : reply(404, { error: 'table not found' });
        }
        if (body.action === 'close') {
          await sql.begin(async (tx) => {
            const [table] = await tx`
            UPDATE dining_tables SET qr_ordering_until = NULL
            WHERE tenant_id = ${tenantId} AND branch_id = ${branchId} AND pos_table_id = ${body.pos_table_id}
              AND pos_installation_id IS NOT DISTINCT FROM ${installationId}::uuid
            RETURNING id
          `;
            if (table)
              await tx`
            UPDATE table_sessions SET revoked_at = now()
            WHERE tenant_id = ${tenantId} AND branch_id = ${branchId} AND table_id = ${table.id}
              AND revoked_at IS NULL AND expires_at > now()
          `;
          });
          return reply(200, { closed: true });
        }
        const origin = URL.parse(publicOrigin ?? '');
        if (!origin || origin.protocol !== 'https:' || origin.origin !== publicOrigin) {
          return reply(503, { error: 'public ordering origin unavailable' });
        }
        const [table] = await sql<{ qr_public_id: string; qr_ordering_until: Date }[]>`
        INSERT INTO dining_tables (tenant_id, branch_id, name, pos_table_id, pos_installation_id,
          qr_ordering_until, qr_session_generation, bill_awaiting_payment)
        VALUES (${tenantId}, ${branchId}, ${body.name}, ${body.pos_table_id}, ${installationId},
          now() + interval '365 days', gen_random_uuid(), ${body.awaiting_payment ?? false})
        ON CONFLICT (tenant_id, branch_id, pos_table_id) DO UPDATE
        SET name = excluded.name, pos_installation_id = excluded.pos_installation_id,
          qr_ordering_until = excluded.qr_ordering_until,
          bill_awaiting_payment = coalesce(${body.awaiting_payment ?? null}::boolean, dining_tables.bill_awaiting_payment),
          qr_session_generation = CASE WHEN dining_tables.qr_ordering_until > now()
            THEN coalesce(dining_tables.qr_session_generation, excluded.qr_session_generation)
            ELSE excluded.qr_session_generation END
        WHERE dining_tables.pos_installation_id IS NULL
          OR dining_tables.pos_installation_id = excluded.pos_installation_id
        RETURNING qr_public_id, qr_ordering_until
      `;
        if (!table) return reply(409, { error: 'table is linked to another installation' });
        const url = new URL(origin);
        url.hash = new URLSearchParams({ table: table.qr_public_id }).toString();
        return reply(200, { url: url.href, expires_at: table.qr_ordering_until });
      },
      {
        body: t.Object({
          action: t.Union([t.Literal('open'), t.Literal('close'), t.Literal('payment-state')]),
          awaiting_payment: t.Optional(t.Boolean()),
          pos_table_id: t.String({ minLength: 1, maxLength: 128 }),
          name: t.String({ minLength: 1, maxLength: 80 }),
        }),
      },
    )
    .post(
      '/api/v1/table-qr/session',
      async ({ body }) => {
        return sql.begin(async (tx) => {
          const [table] = await tx`
          SELECT id, tenant_id, branch_id, qr_ordering_until, qr_session_generation FROM dining_tables
          WHERE qr_public_id = ${body.table_key} AND pos_table_id IS NOT NULL AND qr_ordering_until > now()
            AND qr_session_generation IS NOT NULL
            AND (pos_installation_id IS NULL OR EXISTS (
              SELECT 1 FROM connector_installations c WHERE c.id = dining_tables.pos_installation_id
                AND c.tenant_id = dining_tables.tenant_id AND c.branch_id = dining_tables.branch_id AND c.revoked_at IS NULL
            ))
          FOR UPDATE
        `;
          if (!table) return reply(409, { error: 'table closed' });
          const [active] = await tx`
          SELECT COUNT(*)::int AS count FROM table_sessions
          WHERE table_id = ${table.id} AND revoked_at IS NULL AND expires_at > now()
        `;
          if (active.count >= 12) return reply(429, { error: 'table device limit' });
          const secret = token();
          await tx`
          INSERT INTO table_sessions (tenant_id, branch_id, table_id, token_hash, expires_at, qr_generation)
          VALUES (${table.tenant_id}, ${table.branch_id}, ${table.id}, ${sha256(secret)},
            ${table.qr_ordering_until}, ${table.qr_session_generation})
        `;
          return reply(200, { table_token: secret });
        });
      },
      { body: t.Object({ table_key: t.String({ format: 'uuid' }) }) },
    );
}
