'use client';

import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/hooks/use-confirm';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import api from '@/lib/api';

interface InboxEvent {
  event_id: string;
  cloud_created_at: string | null;
  last_error?: string | null;
}

interface OrderPreview {
  table_name: string;
  pos_table_id?: string | null;
  total_satang: number;
  lines: {
    cloud_name: string;
    quantity: number;
    unit_price_satang: number;
    addons?: { id: string; name: string; quantity: number; price_satang: number }[];
    note: string;
    product: { name: string; price: number } | null;
  }[];
  validation: 'missing_product_mapping' | 'unsupported_items' | null;
  tables: { id: string; number: string }[];
}

function errorCode(error: unknown): string {
  const response = (error as { response?: { status?: number; data?: { code?: string } } })
    ?.response;
  return response?.status === 403 ? 'forbidden' : (response?.data?.code ?? 'unknown');
}

export function CloudInboxOrders() {
  const t = useTranslations('settings');
  const formatPrice = useFormatCurrency();
  const { confirm, ConfirmDialog } = useConfirm();
  const [events, setEvents] = useState<InboxEvent[] | null>(null);
  const [selected, setSelected] = useState<{ id: string; order: OrderPreview } | null>(null);
  const [tableId, setTableId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [accepted, setAccepted] = useState('');

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (failure) {
      setError(errorCode(failure));
    } finally {
      setBusy(false);
    }
  }

  function load() {
    setSelected(null);
    void run(async () => {
      const { data } = await api.get('/qr-cloud/inbox/orders');
      setEvents(data.events);
    });
  }

  function review(id: string) {
    setSelected(null);
    setTableId('');
    setAccepted('');
    void run(async () => {
      const { data } = await api.get<OrderPreview>(`/qr-cloud/inbox/orders/${id}`);
      setSelected({ id, order: data });
      if (data.pos_table_id && data.tables.length === 1) setTableId(data.pos_table_id);
    });
  }

  function accept() {
    if (!selected || !tableId) return;
    const table = selected.order.tables.find((entry) => entry.id === tableId);
    if (!table) return;
    void run(async () => {
      if (
        !(await confirm(t('qcInboxConfirm', { table: table.number }), {
          confirmLabel: t('qcInboxAccept'),
        }))
      )
        return;
      const { data } = await api.post(`/qr-cloud/inbox/orders/${selected.id}/accept`, {
        confirmed: true,
        table_id: tableId,
      });
      setAccepted(data.pos_order_number);
      setEvents((previous) => previous?.filter((event) => event.event_id !== selected.id) ?? null);
      setSelected(null);
    });
  }

  const validation = selected?.order.validation;
  return (
    <section className="space-y-3 rounded-md border border-border p-3 text-sm">
      <h3 className="font-medium">{t('qcInboxOrders')}</h3>
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={load}>
        {t('qcInboxLoad')}
      </Button>
      {busy && <p role="status">{t('qcInboxLoading')}</p>}
      {error && (
        <p role="alert" className="text-destructive">
          {t('qcInboxActionError', { code: error })}
        </p>
      )}
      {accepted && <p role="status">{t('qcInboxAccepted', { order: accepted })}</p>}
      {events?.length === 0 && <p>{t('qcInboxEmpty')}</p>}
      {!!events?.length && (
        <ul className="max-h-56 space-y-1 overflow-y-auto">
          {events.map((event) => (
            <li key={event.event_id}>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => review(event.event_id)}
              >
                {t('qcInboxReview', { event: event.event_id.slice(0, 8) })}
                {event.cloud_created_at && (
                  <> · {new Date(event.cloud_created_at).toLocaleString()}</>
                )}
              </Button>
              {event.last_error && (
                <p className="ms-2 text-xs text-destructive">
                  {t('qcInboxActionError', { code: event.last_error })}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      {selected && (
        <div className="space-y-2 rounded-md border border-border p-3">
          <p>{t('qcInboxCloudTable', { table: selected.order.table_name })}</p>
          <p>
            {t('qcInboxCloudTotal', { amount: (selected.order.total_satang / 100).toFixed(2) })}
          </p>
          <ul className="space-y-1">
            {selected.order.lines.map((line, index) => (
              <li key={index}>
                {line.quantity} × {line.cloud_name} · ฿{(line.unit_price_satang / 100).toFixed(2)}
                {line.addons?.map((addon) => (
                  <span key={addon.id} className="block text-muted-foreground">
                    {addon.quantity} × {addon.name} · ฿{(addon.price_satang / 100).toFixed(2)}
                  </span>
                ))}
                {line.note && <span className="block text-muted-foreground">{line.note}</span>}
                {line.product && (
                  <span className="block text-muted-foreground">
                    {t('qcInboxPosProduct', {
                      name: line.product.name,
                      price: formatPrice(line.product.price),
                    })}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {validation && (
            <p role="alert" className="text-destructive">
              {t(
                validation === 'missing_product_mapping'
                  ? 'qcInboxMappingRequired'
                  : 'qcInboxUnsupported',
              )}
            </p>
          )}
          <label className="block">
            {t('qcInboxPosTable')}
            <select
              className="ms-2 rounded border border-border bg-background p-1"
              value={tableId}
              disabled={busy || !!validation}
              onChange={(event) => setTableId(event.target.value)}
            >
              <option value="">{t('qcInboxSelectTable')}</option>
              {selected.order.tables.map((table) => (
                <option key={table.id} value={table.id}>
                  {table.number}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            size="sm"
            disabled={busy || !!validation || !tableId}
            onClick={accept}
          >
            {t('qcInboxAccept')}
          </Button>
        </div>
      )}
      {ConfirmDialog}
    </section>
  );
}
