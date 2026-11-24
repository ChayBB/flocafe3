'use client';

import { useMemo, useState } from 'react';
import { ChevronDown, Link2, Link2Off, Printer } from 'lucide-react';
import { useTranslations } from 'use-intl';
import {
  parseReceiptLogoData,
  RECEIPT_LOGO_OFFSET_LIMIT_MM,
  RECEIPT_LOGO_OFFSET_STEP_MM,
  DEFAULT_RECEIPT_LOGO_SIZE,
  normalizeReceiptLogoDimensionMm,
  RECEIPT_LOGO_DIMENSION_MAX_MM,
  RECEIPT_LOGO_DIMENSION_MIN_MM,
  RECEIPT_LOGO_DIMENSION_STEP_MM,
  receiptLogoBoxDots,
  receiptLogoPrintedWidthDots,
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
  logoWidthMm: number;
  logoHeightMm: number;
  onLogoDimensionsChange: (widthMm: number, heightMm: number) => void;
};

export function paperMmForProfile(profileId: string): number {
  if (profileId === 'generic-escpos-58') return 58;
  if (profileId === 'escpos-impact-76') return 76;
  return 80;
}

function printableWidthDots(paperMm: number): number {
  return paperMm <= 58 ? 384 : 576;
}

function printedLogoMm(
  rasterJson: string,
  paperMm: number,
  size: ReceiptLogoSize,
  widthMm: number,
  heightMm: number,
): { widthMm: number; heightMm: number } | null {
  const parsed = rasterJson ? parseReceiptLogoData(rasterJson) : null;
  if (!parsed) return null;
  const targetDots = printableWidthDots(paperMm);
  const variant =
    parsed.variants[String(targetDots)] ?? parsed.variants['576'] ?? parsed.variants['384'];
  if (!variant) return null;
  const box = receiptLogoBoxDots(variant.width, variant.height, targetDots, { widthMm, heightMm });
  if (box) return { widthMm: box.width / DOTS_PER_MM, heightMm: box.height / DOTS_PER_MM };
  const width = receiptLogoPrintedWidthDots(variant.width, targetDots, size);
  return {
    widthMm: width / DOTS_PER_MM,
    heightMm: Math.round((variant.height * width) / variant.width) / DOTS_PER_MM,
  };
}

function formatMm(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function DimensionInput({
  id,
  label,
  valueMm,
  maxMm,
  disabled,
  onCommit,
}: {
  id: string;
  label: string;
  valueMm: number | null;
  maxMm: number;
  disabled: boolean;
  onCommit: (valueMm: number) => void;
}) {
  const commit = (raw: string) => {
    const normalized = normalizeReceiptLogoDimensionMm(raw);
    if (normalized > 0) onCommit(Math.min(normalized, maxMm));
  };
  return (
    <label htmlFor={id} className="flex flex-1 flex-col gap-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="flex items-center rounded-md border border-border focus-within:border-brand">
        <input
          key={valueMm ?? 'none'}
          id={id}
          type="number"
          inputMode="decimal"
          min={RECEIPT_LOGO_DIMENSION_MIN_MM}
          max={maxMm}
          step={RECEIPT_LOGO_DIMENSION_STEP_MM}
          defaultValue={valueMm === null ? '' : formatMm(valueMm)}
          disabled={disabled}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(e.currentTarget.value);
          }}
          className="w-full min-w-0 rounded-md border-0 bg-transparent px-3 py-1.5 text-sm font-semibold text-foreground focus:ring-0 disabled:cursor-not-allowed"
          dir="ltr"
        />
        <span className="pe-3 text-xs text-muted-foreground" dir="ltr">
          mm
        </span>
      </span>
    </label>
  );
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
  logoWidthMm: typedLogoWidthMm,
  logoHeightMm: typedLogoHeightMm,
  onLogoDimensionsChange,
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
  const printedLogo = printedLogoMm(
    receiptLogoRaster,
    paperMm,
    logoSize,
    typedLogoWidthMm,
    typedLogoHeightMm,
  );
  const logoWidthMm = printedLogo?.widthMm ?? null;
  const logoMaxWidthMm = printableWidthDots(paperMm) / DOTS_PER_MM;
  const [aspectLocked, setAspectLocked] = useState(
    !(typedLogoWidthMm > 0 && typedLogoHeightMm > 0),
  );
  const logoCustomized =
    typedLogoWidthMm > 0 || typedLogoHeightMm > 0 || logoSize !== DEFAULT_RECEIPT_LOGO_SIZE;
  const logoShiftLimitMm = logoWidthMm === null ? 0 : Math.max(0, (paperMm - logoWidthMm) / 2);
  const logoShiftMm = Math.min(logoShiftLimitMm, Math.max(-logoShiftLimitMm, logoOffsetMm));
  const logoShiftOwnPct =
    logoWidthMm === null || logoWidthMm === 0 ? 0 : (logoShiftMm / logoWidthMm) * 100;
  const logoEditable = logoSizeEditable && showLogo;
  const commitLogoWidth = (widthMm: number) =>
    onLogoDimensionsChange(widthMm, aspectLocked ? 0 : (printedLogo?.heightMm ?? 0));
  const commitLogoHeight = (heightMm: number) =>
    onLogoDimensionsChange(
      aspectLocked ? 0 : Math.min(printedLogo?.widthMm ?? 0, logoMaxWidthMm),
      heightMm,
    );
  const toggleAspectLock = () => {
    if (printedLogo) {
      if (aspectLocked) {
        onLogoDimensionsChange(
          normalizeReceiptLogoDimensionMm(printedLogo.widthMm),
          normalizeReceiptLogoDimensionMm(printedLogo.heightMm),
        );
      } else {
        onLogoDimensionsChange(normalizeReceiptLogoDimensionMm(printedLogo.widthMm), 0);
      }
    }
    setAspectLocked((locked) => !locked);
  };

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

          <div>
            <div className="mb-1 flex items-center justify-between gap-3">
              <span className="flex flex-col">
                <span className="text-foreground">{t('logoSize')}</span>
                <span className="text-[11px] text-muted-foreground">
                  {showLogo
                    ? t('logoSizeHint', { mm: formatMm(logoMaxWidthMm) })
                    : t('printerCalibrationLogoOffHint')}
                </span>
              </span>
              {logoCustomized && logoEditable && (
                <button
                  type="button"
                  onClick={() => {
                    onLogoDimensionsChange(0, 0);
                    onLogoSizeChange(DEFAULT_RECEIPT_LOGO_SIZE);
                    setAspectLocked(true);
                  }}
                  className="shrink-0 rounded-full px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted"
                >
                  {t('logoSizeReset')}
                </button>
              )}
            </div>
            <div className="flex items-end gap-2" dir="ltr">
              <DimensionInput
                id="printer-calibration-logo-width"
                label={t('logoWidth')}
                valueMm={printedLogo?.widthMm ?? null}
                maxMm={logoMaxWidthMm}
                disabled={!logoEditable || !printedLogo}
                onCommit={commitLogoWidth}
              />
              <span className="pb-2 text-muted-foreground">×</span>
              <DimensionInput
                id="printer-calibration-logo-height"
                label={t('logoHeight')}
                valueMm={printedLogo?.heightMm ?? null}
                maxMm={RECEIPT_LOGO_DIMENSION_MAX_MM}
                disabled={!logoEditable || !printedLogo}
                onCommit={commitLogoHeight}
              />
              <button
                type="button"
                onClick={toggleAspectLock}
                disabled={!logoEditable || !printedLogo}
                aria-pressed={aspectLocked}
                title={t('logoAspectLock')}
                aria-label={t('logoAspectLock')}
                className={`mb-0.5 rounded-md p-2 disabled:cursor-not-allowed disabled:opacity-50 ${
                  aspectLocked ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted'
                }`}
              >
                {aspectLocked ? <Link2 size={16} /> : <Link2Off size={16} />}
              </button>
            </div>
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
                    {showLogo && logoPreviewUrl && printedLogo && (
                      <img
                        src={logoPreviewUrl}
                        alt=""
                        className="mx-auto mb-1 block transition-all"
                        style={{
                          width: `${printedLogo.widthMm}mm`,
                          height: `${printedLogo.heightMm}mm`,
                          maxWidth: 'none',
                          translate: `${logoShiftOwnPct}% 0`,
                        }}
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
