'use client';

import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import type { KdsOrderItem } from '@/hooks/useKdsConnection';
import { kdsItemLine } from '@/lib/item-options-note';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';

/** A line priced after the order: weighed by the kitchen, or given a price by the kitchen. */
export function isKdsPricedLater(item: KdsOrderItem): boolean {
  return (
    Boolean(item.weight_pending) ||
    item.weight != null ||
    item.pending_price_mode === 'kitchen_price'
  );
}

export function kdsPriceMode(item: KdsOrderItem): 'weight' | 'price' {
  return item.pending_price_mode === 'kitchen_price' ? 'price' : 'weight';
}

/** The price per kg: the line's price while it waits, or its price over the weight once weighed. */
export function kdsBasePricePerKg(item: KdsOrderItem): number | null {
  const unit = Number(item.unit_price);
  if (!Number.isFinite(unit) || unit <= 0) return null;
  if (item.weight_pending || !item.weight) return unit;
  return unit / Number(item.weight);
}

/** The same bounds the backend enforces, so a wrong entry is caught before it is sent. */
function parseEntry(mode: 'weight' | 'price', text: string): number | null {
  const value = Number(text.trim().replace(',', '.'));
  if (!text.trim() || !Number.isFinite(value)) return null;
  if (mode === 'weight') {
    return value >= 0.3 && value <= 100 && Number(value.toFixed(3)) === value ? value : null;
  }
  return value > 0 && value <= 1_000_000 && Number(value.toFixed(2)) === value ? value : null;
}

export function KdsPriceDialog({
  item,
  canFlagOutOfStock,
  onSave,
  onOutOfStock,
  onClose,
}: {
  item: KdsOrderItem;
  canFlagOutOfStock: boolean;
  onSave: (entry: { weight: number } | { price: number }) => Promise<boolean>;
  onOutOfStock: () => void;
  onClose: () => void;
}) {
  const t = useTranslations('kds');
  const mode = kdsPriceMode(item);
  const current = mode === 'weight' ? item.weight : item.kitchen_set_price;
  const [text, setText] = useState(current != null && !item.weight_pending ? String(current) : '');
  const [saving, setSaving] = useState(false);
  const value = parseEntry(mode, text);
  const name = kdsItemLine(item).name;
  const fmt = useFormatCurrency();
  const basePrice = mode === 'weight' ? kdsBasePricePerKg(item) : null;

  const save = async () => {
    if (value === null || saving) return;
    setSaving(true);
    const saved = await onSave(mode === 'weight' ? { weight: value } : { price: value });
    setSaving(false);
    if (saved) onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="kds-price-dialog" className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {mode === 'weight'
              ? t('weightEntryTitle', { item: name })
              : t('priceEntryTitle', { item: name })}
          </DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {mode === 'weight' ? t('weightEntryLabel') : t('priceEntryLabel')}
            <Input
              data-testid="kds-price-input"
              autoFocus
              inputMode="decimal"
              value={text}
              onChange={(event) => setText(event.target.value)}
              className="h-14 text-2xl font-bold tabular-nums"
            />
          </label>
          {basePrice !== null && (
            <div data-testid="kds-price-formula" className="flex flex-col gap-1 tabular-nums">
              <p className="text-sm text-muted-foreground">
                {t('weightBasePrice', { price: fmt(basePrice) })}
              </p>
              {value !== null && (
                <p className="text-base font-semibold">
                  {t('weightAmount', { weight: value.toFixed(2) })} × {fmt(basePrice)} ={' '}
                  {fmt(basePrice * value)}
                </p>
              )}
            </div>
          )}
          {text.trim() !== '' && value === null && (
            <p className="text-sm text-red-600">
              {mode === 'weight' ? t('weightEntryInvalid') : t('priceEntryInvalid')}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {canFlagOutOfStock && (
              <Button
                type="button"
                variant="outline"
                data-testid="kds-price-out-of-stock"
                className="h-12 border-red-600 text-red-600 me-auto"
                onClick={onOutOfStock}
              >
                {item.out_of_stock_at ? t('outOfStockClear') : t('outOfStockConfirm')}
              </Button>
            )}
            <Button type="button" variant="outline" className="h-12" onClick={onClose}>
              {t('priceEntryClose')}
            </Button>
            <Button
              type="submit"
              data-testid="kds-price-save"
              className="h-12 min-w-24"
              disabled={value === null || saving}
            >
              {t('priceEntrySave')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
