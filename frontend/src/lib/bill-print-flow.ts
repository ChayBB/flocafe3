import api from '@/lib/api';
import type { Bill, Order } from '@/lib/types';

type BillPrintOrder = Pick<
  Order,
  | 'id'
  | 'status'
  | 'bill'
  | 'bills'
  | 'bill_requested_at'
  | 'bill_payment_received_at'
  | 'dispatch_policy'
  | 'release_status'
>;

function orderBills(order: Pick<Order, 'bill' | 'bills'>): Bill[] {
  return order.bills && order.bills.length > 0 ? order.bills : order.bill ? [order.bill] : [];
}

/** The bill is printed and the cashier has not yet confirmed the payment. */
export function isAwaitingBillPayment(
  order: Pick<Order, 'bill_requested_at' | 'bill_payment_received_at'>,
): boolean {
  return Boolean(order.bill_requested_at) && !order.bill_payment_received_at;
}

/** An open order nobody has paid towards must have its bill printed before payment is taken. */
export function needsBillPrintBeforePayment(order: BillPrintOrder): boolean {
  if (['completed', 'cancelled'].includes(order.status)) return false;
  if (order.dispatch_policy === 'on_payment') return false;
  if (order.release_status && order.release_status !== 'released') return false;
  if (isAwaitingBillPayment(order)) return false;
  return orderBills(order).every(
    (bill) => bill.payment_status === 'unpaid' && Number(bill.paid_amount || 0) === 0,
  );
}

export type BillPrintCheck = 'ok' | 'serve_unconfirmed' | 'failed';

/** Asks the backend whether the cashier may print; an unconfirmed table is flagged on the Server App. */
export async function checkCashierBillPrint(orderId: number): Promise<BillPrintCheck> {
  try {
    await api.post(`/orders/${orderId}/bill-request`, { cashier: true, preflight: true });
    return 'ok';
  } catch (error) {
    const code = (error as { response?: { data?: { code?: string } } })?.response?.data?.code;
    return code === 'served_unconfirmed' ? 'serve_unconfirmed' : 'failed';
  }
}

/** Records that the bill printed, so the order waits for the cashier to confirm the payment. */
export async function recordCashierBillPrint(orderId: number): Promise<boolean> {
  try {
    await api.post(`/orders/${orderId}/bill-request`, { cashier: true });
    return true;
  } catch {
    return false;
  }
}

/** What the cashier still has to collect on the order: open bill balances, or the order total before billing. */
export function amountDue(order: Pick<Order, 'total' | 'bill' | 'bills'>): number {
  const bills = orderBills(order).filter((bill) =>
    ['unpaid', 'partial'].includes(bill.payment_status),
  );
  if (bills.length === 0) return Number(order.total || 0);
  return bills.reduce((sum, bill) => sum + Number(bill.balance ?? bill.total ?? 0), 0);
}
