'use client';

import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/hooks/use-confirm';
import api from '@/lib/api';
import { printHtmlInFrame } from '@/lib/printer/print-html-frame';
import { escapeHtml } from '@/lib/printer/web-print';

interface TableQr {
  data_url: string;
  expires_at: string;
}

type BatchResult = {
  id: string;
  number: string;
  code?: string;
  closed?: boolean;
} & Partial<TableQr>;
const ALL_TABLES = '__all_cloud_qr_tables__';

export function CloudTableQr() {
  const t = useTranslations('settings');
  const common = useTranslations('common');
  const tableText = useTranslations('tables');
  const { confirm, ConfirmDialog } = useConfirm();
  const [tables, setTables] = useState<
    { id: string; number: string; is_active?: boolean }[] | null
  >(null);
  const [tableId, setTableId] = useState('');
  const [qr, setQr] = useState<TableQr | null>(null);
  const [batch, setBatch] = useState<BatchResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const selectedTable = tables?.find((table) => table.id === tableId);
  const tableName = selectedTable?.number;
  const allSelected = tableId === ALL_TABLES;
  const activeCount = tables?.filter((table) => table.is_active !== false).length ?? 0;
  const printable = batch.filter(
    (table) => !table.code && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(table.data_url ?? ''),
  );

  function printBatch() {
    if (!printable.length) return;
    const width = 192;
    const height = 279;
    const gap = 2;
    const padding = 2;
    const labelSpace = 13;
    let columns = 1;
    let qrSize = 0;
    for (let count = 1; count <= printable.length; count++) {
      const rows = Math.ceil(printable.length / count);
      const cardWidth = (width - (count - 1) * gap) / count;
      const cardHeight = (height - (rows - 1) * gap) / rows;
      const size = Math.floor(
        Math.min(cardWidth - padding * 2, cardHeight - labelSpace - padding * 2),
      );
      if (size > qrSize) {
        columns = count;
        qrSize = size;
      }
    }
    const cards = printable
      .map(
        (table) =>
          `<article><h2>${escapeHtml(tableText('tableQrTable', { name: table.number }))}</h2><img src="${escapeHtml(table.data_url)}" alt="QR"><p>${escapeHtml(tableText('guestQrScan'))}</p></article>`,
      )
      .join('');
    printHtmlInFrame(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(t('qcTableQrPrintAll'))}</title><style>
      @page{size:A4 portrait;margin:8mm}
      *{box-sizing:border-box}
      body{margin:0;font-family:system-ui,sans-serif;color:#111}
      main{display:grid;width:${width}mm;grid-template-columns:repeat(${columns},minmax(0,1fr));gap:${gap}mm}
      article{box-shadow:inset 0 0 0 1px #aaa;padding:${padding}mm;text-align:center;break-inside:avoid}
      h2,p{margin:0;line-height:4mm}
      h2{display:grid;place-items:center;height:8mm;font-size:11pt;overflow-wrap:anywhere;overflow:hidden}
      p{height:5mm;font-size:9pt}
      img{display:block;width:${qrSize}mm;height:${qrSize}mm;margin:auto;image-rendering:pixelated}
    </style></head><body><main>${cards}</main></body></html>`);
  }

  async function run(action?: 'open' | 'close') {
    setBusy(true);
    setError('');
    setStatus('');
    setQr(null);
    setBatch([]);
    try {
      if (!action) {
        const { data } = await api.get('/qr-cloud/table-qr');
        setTables(data.tables);
        setTableId('');
      } else if (allSelected) {
        const opening = action === 'open';
        if (
          !(await confirm(t(opening ? 'qcTableQrConfirmOpenAll' : 'qcTableQrConfirmCloseAll'), {
            confirmLabel: t(opening ? 'qcTableQrOpenAll' : 'qcTableQrCloseAll'),
          }))
        )
          return;
        const { data } = await api.post<{ tables: BatchResult[] }>('/qr-cloud/table-qr', {
          action,
          all_tables: true,
          confirmed: true,
        });
        setBatch(data.tables);
        setStatus(
          t('qcTableQrBatchResult', {
            success: data.tables.filter((table) => !table.code).length,
            total: data.tables.length,
          }),
        );
      } else {
        const { data } = await api.post('/qr-cloud/table-qr', { action, table_id: tableId });
        if (action === 'open') setQr(data);
        else setStatus(t('qcTableQrClosed'));
      }
    } catch (failure) {
      const response = (failure as { response?: { data?: { code?: string } } })?.response;
      setError(response?.data?.code ?? 'unknown');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-2 rounded-md border border-border p-3 text-sm">
      <h3 className="font-medium">{t('qcTableQrTitle')}</h3>
      <p className="text-muted-foreground">{t('qcTableQrHint')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void run()}
        >
          {t('qcTableQrLoad')}
        </Button>
        {tables && (
          <>
            <select
              aria-label={t('qcInboxPosTable')}
              value={tableId}
              disabled={busy}
              className="rounded border border-border bg-background p-1"
              onChange={(event) => {
                setTableId(event.target.value);
                setQr(null);
                setBatch([]);
                setStatus('');
                setError('');
              }}
            >
              <option value="">{t('qcInboxSelectTable')}</option>
              {tables.length > 0 && <option value={ALL_TABLES}>{t('qcTableQrSelectAll')}</option>}
              {tables.map((table) => (
                <option key={table.id} value={table.id}>
                  {table.number}
                  {table.is_active === false ? ` (${common('inactive')})` : ''}
                </option>
              ))}
            </select>
            <Button
              type="button"
              size="sm"
              disabled={
                busy ||
                (allSelected
                  ? activeCount === 0
                  : !selectedTable || selectedTable.is_active === false)
              }
              onClick={() => void run('open')}
            >
              {t(allSelected ? 'qcTableQrOpenAll' : 'qcTableQrOpen')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || !tableId}
              onClick={() => void run('close')}
            >
              {t(allSelected ? 'qcTableQrCloseAll' : 'qcTableQrClose')}
            </Button>
          </>
        )}
      </div>
      {busy && <p role="status">{t('qcInboxLoading')}</p>}
      {error && (
        <p role="alert" className="text-destructive">
          {t('qcInboxActionError', { code: error })}
        </p>
      )}
      {status && <p role="status">{status}</p>}
      {printable.length > 0 && (
        <Button type="button" size="sm" variant="outline" onClick={printBatch}>
          {t('qcTableQrPrintAll')}
        </Button>
      )}
      {batch.length > 0 && (
        <ul className="grid gap-2 sm:grid-cols-2">
          {batch.map((table) => (
            <li key={table.id} className="rounded border border-border p-2">
              <p className="font-medium">{table.number}</p>
              {table.code && (
                <p className="text-destructive">{t('qcInboxActionError', { code: table.code })}</p>
              )}
              {table.closed && <p>{t('qcTableQrClosed')}</p>}
              {table.data_url && table.expires_at && (
                <>
                  <p>{t('qcTableQrReady', { table: table.number })}</p>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={table.data_url} width={160} height={160} alt={t('qcTableQrTitle')} />
                  <a
                    href={table.data_url}
                    download={`cloud-qr-${table.number}.png`}
                    className="underline"
                  >
                    {t('qcTableQrDownload')}
                  </a>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {qr && tableName && (
        <div className="space-y-2">
          <p role="status">{t('qcTableQrReady', { table: tableName })}</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qr.data_url} width={260} height={260} alt={t('qcTableQrTitle')} />
          <a href={qr.data_url} download={`cloud-qr-${tableName}.png`} className="underline">
            {t('qcTableQrDownload')}
          </a>
        </div>
      )}
      {ConfirmDialog}
    </section>
  );
}
