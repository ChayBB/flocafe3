import type { GuestOrder, GuestOrderItem } from '@/components/server-app/GuestOrderHistory';

interface CloudSentItem {
  name: string;
  quantity: number;
  status?: string | null;
  total_satang?: number;
}

interface CloudSentOrder {
  status: string;
  pos_order_number: string | null;
  items: CloudSentItem[];
}

const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value);
const BILL_KEYS = [
  'subtotal',
  'discount_amount',
  'service_charge',
  'tax_amount',
  'round_off',
  'total',
] as const;

/** The POS bill the Cloud relays, when it has the expected shape. */
function readPosBill(raw: unknown): Pick<GuestOrder, 'order_number' | 'items' | 'bill'> | null {
  const data = raw as {
    order_number?: unknown;
    items?: unknown;
    bill?: Record<string, unknown>;
  } | null;
  if (!data || typeof data.order_number !== 'string' || !Array.isArray(data.items)) return null;
  const bill = data.bill;
  if (
    !bill ||
    !BILL_KEYS.every((key) => finite(bill[key])) ||
    typeof bill.tax_included !== 'boolean'
  )
    return null;
  const items: GuestOrderItem[] = [];
  for (const raw of data.items as Record<string, unknown>[]) {
    if (
      !raw ||
      !Number.isSafeInteger(raw.id) ||
      typeof raw.product_name !== 'string' ||
      !finite(raw.quantity) ||
      typeof raw.status !== 'string' ||
      !finite(raw.total)
    )
      return null;
    items.push({
      id: raw.id as number,
      product_id: typeof raw.product_id === 'string' ? raw.product_id : '',
      product_name: raw.product_name,
      quantity: raw.quantity as number,
      status: raw.status,
      total: raw.total as number,
      ordered_by: typeof raw.ordered_by === 'string' ? raw.ordered_by : null,
      ordered_by_guest: raw.ordered_by_guest === true,
    });
  }
  return {
    order_number: data.order_number,
    items,
    bill: {
      subtotal: bill.subtotal as number,
      discount_amount: bill.discount_amount as number,
      service_charge: bill.service_charge as number,
      tax_amount: bill.tax_amount as number,
      tax_included: bill.tax_included,
      round_off: bill.round_off as number,
      total: bill.total as number,
    },
  };
}

/**
 * What a Cloud table-QR guest sees in the order history and bill. The POS bill, relayed by the
 * Cloud, is authoritative; before the POS has shared one, the guest's own Cloud orders stand in.
 */
export function cloudGuestOrder(
  body: { bill?: unknown; bill_requested?: unknown; as_of?: unknown },
  sent: CloudSentOrder[],
): GuestOrder | null {
  const requestedAt =
    body.bill_requested === true
      ? typeof body.as_of === 'string'
        ? body.as_of
        : new Date().toISOString()
      : null;
  const pos = readPosBill(body.bill);
  if (pos) return { ...pos, customer_name: null, bill_requested_at: requestedAt };
  const items: GuestOrderItem[] = [];
  for (const order of [...sent].reverse()) {
    order.items.forEach((item) => {
      items.push({
        id: items.length + 1,
        product_id: '',
        product_name: item.name,
        quantity: item.quantity,
        status:
          item.status ??
          (order.status === 'cancelled' || order.status === 'rejected' ? 'cancelled' : 'pending'),
        total: finite(item.total_satang) ? (item.total_satang as number) / 100 : 0,
        ordered_by: null,
        ordered_by_guest: true,
      });
    });
  }
  if (items.length === 0) return null;
  const total = items
    .filter((item) => item.status !== 'cancelled')
    .reduce((sum, item) => sum + item.total, 0);
  return {
    order_number: sent.find((order) => order.pos_order_number)?.pos_order_number ?? '',
    customer_name: null,
    bill_requested_at: requestedAt,
    items,
    bill: {
      subtotal: total,
      discount_amount: 0,
      service_charge: 0,
      tax_amount: 0,
      tax_included: false,
      round_off: 0,
      total,
    },
  };
}
