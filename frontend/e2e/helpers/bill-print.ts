import { expect, type APIRequestContext } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './urls';

const TERMINAL = ['cancelled', 'voided', 'void_adjustment', 'refunded', 'completed'];

/** Confirms the order's live items reached the table before testing bill printing. */
export async function confirmOrderServed(
  request: APIRequestContext,
  headers: Record<string, string>,
  orderId: number,
): Promise<void> {
  const read = await request.get(`${BASE}/api/orders/${orderId}`, { headers });
  expect(read.ok(), await read.text()).toBeTruthy();
  const body = await read.json();
  const items = ((body.order ?? body).items ?? []) as { id: number; status: string }[];
  const live = items.filter((item) => !TERMINAL.includes(item.status));
  for (const item of live) {
    if (item.status === 'served') continue;
    const served = await request.patch(`${BASE}/api/order-items/${item.id}/status`, {
      headers,
      data: { status: 'served' },
    });
    expect(served.ok(), await served.text()).toBeTruthy();
  }
  if (live.length > 0) {
    const confirmed = await request.post(`${BASE}/api/orders/${orderId}/items/confirm-served`, {
      headers,
      data: { item_ids: live.map((item) => item.id) },
    });
    expect(confirmed.ok(), await confirmed.text()).toBeTruthy();
  }
}

/** Records the cashier's bill request so Orders offers Confirm payment. */
export async function printBillFirst(
  request: APIRequestContext,
  headers: Record<string, string>,
  orderId: number,
): Promise<void> {
  await confirmOrderServed(request, headers, orderId);
  const printed = await request.post(`${BASE}/api/orders/${orderId}/bill-request`, {
    headers,
    data: { cashier: true },
  });
  expect(printed.ok(), await printed.text()).toBeTruthy();
}
