/** Cloud table-QR guests: the order history and bill read the POS bill the Cloud relays. */
import assert from 'node:assert/strict';
import { cloudGuestOrder } from '../frontend/src/lib/cloud-guest-order';

const posBill = {
  order_number: 'ORD-26',
  items: [
    {
      id: 7,
      product_id: 'p-tea',
      product_name: 'Thai tea',
      quantity: 2,
      status: 'served',
      total: 80,
      ordered_by: 'Ann',
      ordered_by_guest: false,
    },
  ],
  bill: {
    subtotal: 80,
    discount_amount: 0,
    service_charge: 0,
    tax_amount: 5.6,
    tax_included: false,
    round_off: 0,
    total: 85.6,
  },
};
// The Cloud lists a table's orders newest first.
const sent = [
  { status: 'created', pos_order_number: null, items: [{ name: 'Water', quantity: 2 }] },
  {
    status: 'pos_accepted',
    pos_order_number: 'ORD-26',
    items: [
      { name: 'Rice', quantity: 1, status: 'preparing', total_satang: 5000 },
      { name: 'Soup', quantity: 1, status: 'cancelled', total_satang: 3000 },
    ],
  },
];

const fromPos = cloudGuestOrder({ bill: posBill, bill_requested: false }, sent);
assert.equal(fromPos?.order_number, 'ORD-26', 'the POS bill wins over the Cloud orders');
assert.equal(fromPos?.bill.total, 85.6, 'with the POS total, tax included');
assert.equal(fromPos?.items[0].ordered_by, 'Ann', 'and who ordered each dish');
assert.equal(fromPos?.bill_requested_at, null, 'nothing requested yet');

const requested = cloudGuestOrder(
  { bill: posBill, bill_requested: true, as_of: '2026-11-22T13:00:00.000Z' },
  sent,
);
assert.equal(
  requested?.bill_requested_at,
  '2026-11-22T13:00:00.000Z',
  'a request shows as requested',
);

const fallback = cloudGuestOrder({ bill: null }, sent);
assert.deepEqual(
  fallback?.items.map((item) => `${item.product_name}:${item.status}:${item.total}`),
  ['Rice:preparing:50', 'Soup:cancelled:30', 'Water:pending:0'],
  'before the POS shares a bill, the guest sees its own Cloud orders, oldest first',
);
assert.equal(fallback?.bill.total, 50, 'and a total without cancelled dishes');
assert.equal(fallback?.order_number, 'ORD-26');

assert.equal(
  cloudGuestOrder({ bill: { ...posBill, bill: { total: 'x' } } }, sent)?.bill.total,
  50,
  'a malformed POS bill is ignored',
);
assert.equal(cloudGuestOrder({}, []), null, 'nothing ordered shows the empty state');
console.log('Cloud guest order checks passed');
