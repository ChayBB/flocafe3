/** Logs print actions to print_logs and updates the bill's printed_at timestamp. */

import { getDatabase, withTxn, now, recordOrderAudit } from '../db';

export type PrintType = 'receipt' | 'reprint';

export async function printReceipt(
  billId: number,
  userId: string,
  printType: PrintType,
): Promise<{ success: boolean; printLogId?: number }> {
  const db = getDatabase();

  // Log the print action and update bill timestamp atomically
  const result = withTxn(() => {
    const bill = db.prepare('SELECT id FROM bills WHERE id = ?').get(billId) as
      | { id: number }
      | undefined;
    if (!bill) {
      throw new Error('Bill not found');
    }

    const insertResult = db
      .prepare(
        'INSERT INTO print_logs (bill_id, user_id, print_type, printed_at) VALUES (?, ?, ?, ?)',
      )
      .run(billId, userId, printType, now());

    // Update bill's printed_at timestamp
    db.prepare('UPDATE bills SET printed_at = ?, updated_at = ? WHERE id = ?').run(
      now(),
      now(),
      billId,
    );

    return insertResult;
  });

  return { success: true, printLogId: result.lastInsertRowid as number };
}

export function isStaffBillPrintLocked(db: ReturnType<typeof getDatabase>, orderId: number) {
  return Boolean(
    db
      .prepare(`SELECT 1 FROM order_audit_log
                WHERE order_id = ? AND action = 'staff_bill_print_dispatched'
                UNION ALL
                SELECT 1 FROM bills WHERE order_id = ? AND printed_at IS NOT NULL
                LIMIT 1`)
      .get(orderId, orderId),
  );
}

export function claimStaffBillPrint(
  db: ReturnType<typeof getDatabase>,
  orderId: number,
  billId: number,
  actorUserId: string,
) {
  return withTxn(() => {
    if (isStaffBillPrintLocked(db, orderId)) return false;
    recordOrderAudit(db, {
      orderId,
      actorUserId,
      action: 'staff_bill_print_dispatched',
      details: { bill_id: billId },
    });
    return true;
  });
}
