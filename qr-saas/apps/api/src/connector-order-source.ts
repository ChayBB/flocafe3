import type { Sql, TransactionSql } from 'postgres';
import type { ConnectorScope } from './connector-notifications';

const PAGE_SIZE = 30;

export async function readConnectorEventPage(
  sql: Sql | TransactionSql,
  { tenantId, branchId }: ConnectorScope,
  after: string | null,
) {
  const rows = await sql<{ id: string; kind: string; payload: unknown; created_at: Date }[]>`
    SELECT e.id, e.kind, e.payload, e.created_at FROM outbox_events e
    JOIN connector_deliveries d ON (d.event_id, d.tenant_id, d.branch_id) = (e.id, e.tenant_id, e.branch_id)
    WHERE e.tenant_id = ${tenantId} AND e.branch_id = ${branchId} AND d.status = 'pending'
      AND (${after}::uuid IS NULL OR (e.created_at, e.id) > (
        SELECT a.created_at, a.id FROM outbox_events a
        WHERE a.id = ${after} AND a.tenant_id = ${tenantId} AND a.branch_id = ${branchId}
      ))
    ORDER BY e.created_at, e.id LIMIT ${PAGE_SIZE + 1}
  `;
  const events = rows.slice(0, PAGE_SIZE);
  return { events, next_cursor: rows.length > PAGE_SIZE ? events[PAGE_SIZE - 1].id : null };
}

export async function readConnectorOrder(
  sql: Sql | TransactionSql,
  { tenantId, branchId, installationId = null }: ConnectorScope & { installationId?: string | null },
  eventId: string,
) {
  const [order] = await sql<{ items: { addons?: unknown[] }[] | null }[]>`
    SELECT o.id AS order_id, d.name AS table_name, d.pos_table_id, o.created_at, o.total_satang, o.note,
      CASE WHEN s.qr_generation IS NULL THEN NULL ELSE coalesce(
        s.qr_generation = d.qr_session_generation AND d.qr_ordering_until > now(), false
      ) END AS table_session_current,
      (SELECT jsonb_agg(jsonb_build_object(
        'external_id', coalesce(m.pos_product_id, m.external_id), 'pos_variant_id', m.pos_variant_id,
        'name', i.name_snapshot, 'quantity', i.quantity,
        'unit_price_satang', i.unit_price_satang, 'note', i.note, 'addons', i.addons_snapshot
      ) ORDER BY i.id)
      FROM order_items i JOIN menu_items m ON m.id = i.menu_item_id
        AND m.tenant_id = o.tenant_id AND m.branch_id = o.branch_id
      WHERE i.order_id = o.id) AS items
    FROM connector_deliveries delivery
    JOIN outbox_events e ON (e.id, e.tenant_id, e.branch_id) =
      (delivery.event_id, delivery.tenant_id, delivery.branch_id)
    JOIN orders o ON o.id::text = e.payload->>'order_id'
      AND (o.tenant_id, o.branch_id) = (e.tenant_id, e.branch_id)
    JOIN table_sessions s ON s.id = o.table_session_id
      AND (s.tenant_id, s.branch_id) = (o.tenant_id, o.branch_id)
    JOIN dining_tables d ON (d.id, d.tenant_id, d.branch_id) =
      (s.table_id, s.tenant_id, s.branch_id)
    WHERE e.id = ${eventId} AND e.tenant_id = ${tenantId}
      AND e.branch_id = ${branchId} AND e.kind = 'order.created'
      AND (d.pos_installation_id IS NULL OR d.pos_installation_id = ${installationId}::uuid)
      AND delivery.status = 'pending' AND o.status IN ('created', 'sent_to_pos')
  `;
  return order ?? null;
}
