import type { Sql } from 'postgres';

export interface ConnectorReceipt {
  event_id: string;
  cloud_order_id: string;
  pos_receipt_id: string;
  pos_order_number: string;
}

export async function acknowledgeDelivery(
  sql: Sql,
  { tenantId, branchId, installationId }: { tenantId: string; branchId: string; installationId: string | null },
  receipt: ConnectorReceipt,
): Promise<'accepted' | 'missing' | 'conflict'> {
  try {
    return await sql.begin(async (tx) => {
      const [row] = await tx`
        SELECT d.status, d.pos_receipt_id, d.pos_order_number, o.status AS order_status
        FROM connector_deliveries d
        JOIN outbox_events e ON (e.id, e.tenant_id, e.branch_id) = (d.event_id, d.tenant_id, d.branch_id)
        JOIN orders o ON (o.tenant_id, o.branch_id) = (e.tenant_id, e.branch_id)
          AND o.id::text = e.payload->>'order_id'
        JOIN table_sessions s ON (s.id, s.tenant_id, s.branch_id) = (o.table_session_id, o.tenant_id, o.branch_id)
        JOIN dining_tables t ON (t.id, t.tenant_id, t.branch_id) = (s.table_id, s.tenant_id, s.branch_id)
        WHERE d.event_id = ${receipt.event_id} AND d.tenant_id = ${tenantId} AND d.branch_id = ${branchId}
          AND o.id = ${receipt.cloud_order_id} AND e.kind = 'order.created'
          AND (t.pos_installation_id IS NULL OR t.pos_installation_id = ${installationId}::uuid)
        FOR UPDATE OF d, o
      `;
      if (!row) return 'missing';
      if (row.status === 'acknowledged') {
        return row.pos_receipt_id === receipt.pos_receipt_id && row.pos_order_number === receipt.pos_order_number
          ? 'accepted' : 'conflict';
      }
      if (row.status !== 'pending' || !['created', 'sent_to_pos'].includes(row.order_status)) return 'conflict';
      await tx`
        UPDATE connector_deliveries SET status = 'acknowledged', acknowledged_at = now(),
          pos_receipt_id = ${receipt.pos_receipt_id}, pos_order_number = ${receipt.pos_order_number}
        WHERE event_id = ${receipt.event_id} AND tenant_id = ${tenantId} AND branch_id = ${branchId}
      `;
      await tx`
        UPDATE orders SET status = 'pos_accepted'
        WHERE id = ${receipt.cloud_order_id} AND tenant_id = ${tenantId} AND branch_id = ${branchId}
      `;
      await tx`
        INSERT INTO audit_logs (tenant_id, branch_id, actor, action, resource_id)
        VALUES (${tenantId}, ${branchId}, ${installationId ?? 'connector'}, 'order.pos_accepted', ${receipt.cloud_order_id})
      `;
      return 'accepted';
    });
  } catch (error) {
    if ((error as { code?: string })?.code === '23505') return 'conflict';
    throw error;
  }
}
