'use client';

import { useMemo, useState } from 'react';
import { ChevronDown, Printer } from 'lucide-react';
import { useTranslations } from 'use-intl';
import {
  parseReceiptLogoData,
  RECEIPT_LOGO_OFFSET_LIMIT_MM,
  RECEIPT_LOGO_OFFSET_STEP_MM,
  RECEIPT_LOGO_SIZES,
  receiptLogoPrintScale,
  type ReceiptLogoSize,
} from '@print/image-raster';
import { getThermalPreviewDataUrl } from '@/lib/printer/logo-processor';
import { usePosSettingsStore } from '@/store/pos-settings';

const COLUMN_OPTIONS = [32, 40, 42, 48] as const;
const OFFSET_LIMIT_MM = 5;
const DOTS_PER_MM = 8;

type Props = {
  printerName: string;
  portLabel: string;
  profileId: string;
  paperWidth: string;
  onColumnsChange: (paperWidth: string) => void;
  showLogo: boolean;
  logoSize: ReceiptLogoSize;
  logoSizeEditable: boolean;
  onLogoSizeChange: (size: ReceiptLogoSize) => void;
  logoOffsetMm: number;
  onLogoOffsetChange: (offsetMm: number) => void;
};

export function paperMmForProfile(profileId: string): number {
  if (profileId === 'generic-escpos-58') return 58;
  if (profileId === 'escpos-impact-76') return 76;
  return 80;
}

function printedLogoWidthMm(
  rasterJson: string,
  paperMm: number,
  size: ReceiptLogoSize,
): number | null {
  const parsed = rasterJson ? parseReceiptLogoData(rasterJson) : null;
  if (!parsed) return null;
  const targetDots = paperMm <= 58 ? 384 : 576;
  const variant =
    parsed.variants[String(targetDots)] ?? parsed.variants['576'] ?? parsed.variants['384'];
  if (!variant) return null;
  const factor = Math.max(
    1,
    Math.min(receiptLogoPrintScale(size), Math.floor(targetDots / variant.width)),
  );
  return (variant.width * factor) / DOTS_PER_MM;
}

function columnsFromPaperWidth(paperWidth: string): number {
  const parsed = Number.parseInt(paperWidth.replace(/^cols-/, ''), 10);
  return Number.isFinite(parsed) ? parsed : 42;
}

export function PrinterCalibrationCard({
  printerName,
  portLabel,
  profileId,
  paperWidth,
  onColumnsChange,
  showLogo,
  logoSize,
  logoSizeEditable,
  onLogoSizeChange,
  logoOffsetMm,
  onLogoOffsetChange,
}: Props) {
  const t = useTranslations('settings');
  const paperMm = paperMmForProfile(profileId);
  const printMaxMm = paperMm - 8;
  const printMinMm = printMaxMm - 12;
  const [open, setOpen] = useState(false);
  const [offsetMm, setOffsetMm] = useState(0);
  const [printWidthMm, setPrintWidthMm] = useState(printMaxMm - 2);
  const clampedPrintWidth = Math.min(Math.max(printWidthMm, printMinMm), printMaxMm);
  const columns = columnsFromPaperWidth(paperWidth);

  const areaLeftPct = (((paperMm - clampedPrintWidth) / 2 + offsetMm) / paperMm) * 100;
  const areaWidthPct = (clampedPrintWidth / paperMm) * 100;
  const subtitle = [printerName, portLabel].filter(Boolean).join(' · ');
  const receiptLogoRaster = usePosSettingsStore((state) => state.receiptLogoRaster);
  const logoPreviewUrl = useMemo(
    () => getThermalPreviewDataUrl(receiptLogoRaster),
    [receiptLogoRaster],
  );
  const logoWidthMm = printedLogoWidthMm(receiptLogoRaster, paperMm, logoSize);
  const logoWidthPct =
    logoWidthMm === null ? null : Math.min(100, (logoWidthMm / clampedPrintWidth) * 100);
  const logoShiftLimitMm = logoWidthMm === null ? 0 : Math.max(0, (paperMm - logoWidthMm) / 2);
  const logoShiftMm = Math.min(logoShiftLimitMm, Math.max(-logoShiftLimitMm, logoOffsetMm));
  const logoShiftOwnPct =
    logoWidthMm === null || logoWidthMm === 0 ? 0 : (logoShiftMm / logoWidthMm) * 100;
  const logoEditable = logoSizeEditable && showLogo;

  return (
    <div
      className="mt-4 overflow-hidden rounded-xl border border-border bg-card"
      data-testid="printer-calibration"
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls="printer-calibration-body"
        className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-start hover:bg-muted/60 ${
          open ? 'border-b border-border' : ''
        }`}
      >
        <span className="min-w-0">
          <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Printer size={16} className="shrink-0 text-muted-foreground" />
            {t('printerCalibrationTitle')}
          </span>
          {subtitle && (
            <span className="mt-0.5 block truncate text-xs text-muted-foreground" dir="auto">
              {subtitle}
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            {t('printerCalibrationPreviewBadge')}
          </span>
          <ChevronDown
            size={18}
            className={`text-foreground transition-transform ${open ? 'rotate-180' : ''}`}
            aria-hidden
          />
        </span>
      </button>

      {open && (
        <div id="printer-calibration-body" className="space-y-4 p-4 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">{t('printerCalibrationPaperWidth')}</span>
            <span className="font-semibold text-foreground" dir="ltr">
              {paperMm} mm
            </span>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <label htmlFor="printer-calibration-logo-size" className="flex flex-col">
              <span className="text-foreground">{t('logoSize')}</span>
              <span className="text-[11px] text-muted-foreground">
                {showLogo ? t('logoSizeHint') : t('printerCalibrationLogoOffHint')}
              </span>
            </label>
            <select
              id="printer-calibration-logo-size"
              value={logoSize}
              disabled={!logoEditable}
              onChange={(e) => onLogoSizeChange(e.target.value as ReceiptLogoSize)}
              className="rounded-md border border-border px-3 py-1.5 text-sm shadow-sm focus:border-brand focus:ring-brand disabled:cursor-not-allowed disabled:bg-muted"
            >
              {RECEIPT_LOGO_SIZES.map((size) => (
                <option key={size} value={size}>
                  {t(`logoSize_${size}` as 'logoSize_small' | 'logoSize_medium' | 'logoSize_large')}
                </option>
              ))}
            </select>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <label htmlFor="printer-calibration-logo-offset" className="text-foreground">
                {t('logoOffset')}
              </label>
              <span className="flex items-center gap-2">
                {logoOffsetMm !== 0 && logoEditable && (
                  <button
                    type="button"
                    onClick={() => onLogoOffsetChange(0)}
                    className="rounded-full px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted"
                  >
                    {t('logoOffsetCenter')}
                  </button>
                )}
                <span className="font-semibold text-foreground" dir="ltr">
                  {logoOffsetMm.toFixed(1)} mm
                </span>
              </span>
            </div>
            <input
              id="printer-calibration-logo-offset"
              type="range"
              min={-RECEIPT_LOGO_OFFSET_LIMIT_MM}
              max={RECEIPT_LOGO_OFFSET_LIMIT_MM}
              step={RECEIPT_LOGO_OFFSET_STEP_MM}
              value={logoOffsetMm}
              disabled={!logoEditable}
              onChange={(e) => onLogoOffsetChange(Number(e.target.value))}
              className="w-full accent-brand disabled:opacity-50"
              dir="ltr"
            />
            <div className="flex justify-between text-[11px] text-muted-foreground" dir="ltr">
              <span>
                {t('printerCalibrationOffsetLeft', { mm: -RECEIPT_LOGO_OFFSET_LIMIT_MM })}
              </span>
              <span>0</span>
              <span>
                {t('printerCalibrationOffsetRight', { mm: RECEIPT_LOGO_OFFSET_LIMIT_MM })}
              </span>
            </div>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <label htmlFor="printer-calibration-offset" className="text-foreground">
                {t('printerCalibrationOffset')}
              </label>
              <span className="font-semibold text-foreground" dir="ltr">
                {offsetMm.toFixed(1)} mm
              </span>
            </div>
            <input
              id="printer-calibration-offset"
              type="range"
              min={-OFFSET_LIMIT_MM}
              max={OFFSET_LIMIT_MM}
              step={0.5}
              value={offsetMm}
              onChange={(e) => setOffsetMm(Number(e.target.value))}
              className="w-full accent-brand"
              dir="ltr"
            />
            <div className="flex justify-between text-[11px] text-muted-foreground" dir="ltr">
              <span>{t('printerCalibrationOffsetLeft', { mm: -OFFSET_LIMIT_MM })}</span>
              <span>0</span>
              <span>{t('printerCalibrationOffsetRight', { mm: OFFSET_LIMIT_MM })}</span>
            </div>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <label htmlFor="printer-calibration-print-width" className="text-foreground">
                {t('printerCalibrationPrintWidth')}
              </label>
              <span className="font-semibold text-foreground" dir="ltr">
                {clampedPrintWidth} mm
              </span>
            </div>
            <input
              id="printer-calibration-print-width"
              type="range"
              min={printMinMm}
              max={printMaxMm}
              step={1}
              value={clampedPrintWidth}
              onChange={(e) => setPrintWidthMm(Number(e.target.value))}
              className="w-full accent-brand"
              dir="ltr"
            />
            <div className="flex justify-between text-[11px] text-muted-foreground" dir="ltr">
              <span>{printMinMm} mm</span>
              <span>{printMaxMm} mm</span>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3">
            <span className="text-foreground">{t('printerCalibrationColumns')}</span>
            <div
              className="flex gap-1"
              role="radiogroup"
              aria-label={t('printerCalibrationColumns')}
            >
              {COLUMN_OPTIONS.map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={columns === option}
                  onClick={() => onColumnsChange(`cols-${option}`)}
                  className={`rounded-full px-3 py-1 text-xs font-medium ${
                    columns === option
                      ? 'bg-muted text-foreground'
                      : 'text-muted-foreground hover:bg-muted/60'
                  }`}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-lg bg-muted/50 px-4 py-5">
            <div className="mx-auto max-w-full" style={{ width: `${paperMm}mm` }}>
              <div className="border border-border bg-white py-3 text-neutral-900 shadow-sm">
                <div
                  className="flex flex-col border-2 border-dashed border-neutral-400 transition-all"
                  style={{ marginLeft: `${areaLeftPct}%`, width: `${areaWidthPct}%` }}
                  dir="ltr"
                >
                  <div className="border-b-2 border-dashed border-neutral-400 py-2 text-center">
                    {showLogo && logoPreviewUrl && logoWidthPct !== null && (
                      <img
                        src={logoPreviewUrl}
                        alt=""
                        className="mx-auto mb-1 block h-auto transition-all"
                        style={{ width: `${logoWidthPct}%`, translate: `${logoShiftOwnPct}% 0` }}
                        data-testid="printer-calibration-logo"
                      />
                    )}
                    <div className="text-sm font-bold">FloCafe POS</div>
                    <div className="text-[9px] tracking-wide text-neutral-600">
                      PRINTER CALIBRATION
                    </div>
                  </div>
                  <div className="space-y-0.5 border-b-2 border-dashed border-neutral-400 px-0.5 py-1.5">
                    <ColumnLine text={'1234567890'.repeat(5).slice(0, columns)} columns={columns} />
                    <ColumnLine text={'X'.repeat(columns)} columns={columns} />
                  </div>
                  <div className="flex justify-between px-1 pt-1.5 text-[11px]">
                    <span>Item A</span>
                    <span>150.00</span>
                  </div>
                  <div className="flex justify-between border-b-2 border-dashed border-neutral-400 px-1 py-1.5 text-[11px]">
                    <span>TOTAL</span>
                    <span>150.00</span>
                  </div>
                  <div className="h-3" />
                </div>
              </div>
              <div className="mt-2 flex items-center" dir="ltr" aria-hidden>
                <span className="h-3 w-px bg-foreground" />
                <span className="h-px flex-1 bg-foreground" />
                <span className="h-3 w-px bg-foreground" />
              </div>
              <div className="text-center text-xs text-foreground" dir="ltr">
                {paperMm} mm
              </div>
            </div>
            <p className="mt-1 text-center text-[11px] text-muted-foreground">
              {t('printerCalibrationHint')}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function ColumnLine({ text, columns }: { text: string; columns: number }) {
  return (
    <svg viewBox={`0 0 ${columns * 6} 12`} className="block w-full" aria-label={text}>
      <text
        x={0}
        y={10}
        fontSize={10}
        fontFamily="ui-monospace, monospace"
        textLength={text.length * 6}
        lengthAdjust="spacingAndGlyphs"
        fill="currentColor"
      >
        {text}
      </text>
    </svg>
  );
}
