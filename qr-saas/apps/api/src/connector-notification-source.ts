import type { Sql, TransactionSql } from 'postgres';
import type { ConnectorScope } from './connector-notifications';

export function readPendingConnectorOrders(
  sql: Sql | TransactionSql,
  { tenantId, branchId }: ConnectorScope,
  limit: number,
) {
  return sql`
    SELECT e.id AS event_id, d.event_id AS delivery_id, o.id AS order_id
    FROM connector_deliveries d
    JOIN outbox_events e ON e.id = d.event_id
      AND e.tenant_id = d.tenant_id AND e.branch_id = d.branch_id
    JOIN orders o ON o.id = CASE
      WHEN e.payload->>'order_id' ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
      THEN (e.payload->>'order_id')::uuid END
      AND o.tenant_id = d.tenant_id AND o.branch_id = d.branch_id
    WHERE d.tenant_id = ${tenantId} AND d.branch_id = ${branchId}
      AND d.status = 'pending' AND e.kind = 'order.created'
    ORDER BY e.created_at, e.id
    LIMIT ${limit}
  `;
}
