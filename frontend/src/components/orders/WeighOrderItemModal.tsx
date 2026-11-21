'use client';

import { useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/ui/button';
import api from '@/lib/api';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { formatItemHeading } from '@/lib/printer/item-heading';
import type { Order, OrderItem } from '@/lib/types';

const MIN_WEIGHT = 0.3;
const MAX_WEIGHT = 100;
const HIGH_WEIGHT_WARNING = 10;
const WEIGHT_INPUT_PATTERN = /^\d{0,3}(\.\d{0,3})?$/;
const PRICE_INPUT_PATTERN = /^\d{0,7}(\.\d{0,2})?$/;
const MAX_KITCHEN_PRICE = 1_000_000;

interface Props {
  orderId: number;
  item: OrderItem;
  onClose: () => void;
  onSaved: (order: Order) => void;
}

export default function WeighOrderItemModal(props: Props) {
  return props.item.pending_price_mode === 'kitchen_price' ? (
    <KitchenPriceModal {...props} />
  ) : (
    <WeightModal {...props} />
  );
}

/** The kitchen gives a set price for a special-menu line; it is saved exactly as entered. */
function KitchenPriceModal({ orderId, item, onClose, onSaved }: Props) {
  const tOrders = useTranslations('orders');
  const tCommon = useTranslations('common');
  const fmt = useFormatCurrency();
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const price = Number(draft);
  const priceValid =
    draft.trim() !== '' && Number.isFinite(price) && price > 0 && price <= MAX_KITCHEN_PRICE;
  const priceInvalid = draft.trim() !== '' && !priceValid;
  const quantity = Number(item.quantity) || 1;

  const handleSave = async () => {
    if (!priceValid || saving) return;
    setSaving(true);
    try {
      const { data } = await api.patch(`/orders/${orderId}/items/${item.id}/price`, {
        price: Number(price.toFixed(2)),
      });
      onSaved(data.order);
      onClose();
    } catch {
      toast.error(tOrders('kitchenPriceSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-card rounded-xl shadow-xl w-full max-w-sm">
        <div className="flex items-start justify-between gap-3 p-5 border-b border-border">
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-foreground">{tOrders('enterKitchenPrice')}</h2>
            <p className="text-sm text-muted-foreground truncate">
              {formatItemHeading(item.product_name, item.variant_selection)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="touch-target rounded-full text-muted-foreground hover:text-foreground"
            aria-label={tCommon('close')}
          >
            <X size={20} />
          </button>
        </div>
        <div className="p-5 space-y-3">
          <label
            className="block text-sm font-medium text-foreground"
            htmlFor="kitchen-price-input"
          >
            {tOrders('kitchenPriceLabel')}
          </label>
          <input
            id="kitchen-price-input"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            autoFocus
            value={draft}
            onChange={(e) => {
              const next = e.target.value.replace(',', '.');
              if (PRICE_INPUT_PATTERN.test(next)) setDraft(next);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSave();
            }}
            className="w-full min-h-11 rounded-lg border border-border bg-background px-3 py-2 text-lg font-bold tabular-nums text-foreground outline-none focus:ring-2 focus:ring-brand"
          />
          {priceInvalid && (
            <p className="text-xs font-medium text-red-500 dark:text-red-400">
              {tOrders('kitchenPriceInvalid')}
            </p>
          )}
          {priceValid && quantity !== 1 && (
            <p className="text-sm font-semibold text-foreground tabular-nums">
              {fmt(price)} × {quantity} = {fmt(price * quantity)}
            </p>
          )}
        </div>
        <div className="flex gap-2 p-5 pt-0">
          <Button variant="outline" className="flex-1" onClick={onClose} disabled={saving}>
            {tCommon('cancel')}
          </Button>
          <Button className="flex-1" onClick={handleSave} disabled={!priceValid || saving}>
            {saving ? <Loader2 size={16} className="animate-spin" /> : tCommon('save')}
          </Button>
        </div>
      </div>
    </div>
  );
}

function WeightModal({ orderId, item, onClose, onSaved }: Props) {
  const tOrders = useTranslations('orders');
  const tCommon = useTranslations('common');
  const fmt = useFormatCurrency();
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const basePrice = Number(item.unit_price);
  const weight = Number(draft);
  const weightValid =
    draft.trim() !== '' && Number.isFinite(weight) && weight >= MIN_WEIGHT && weight <= MAX_WEIGHT;
  const weightInvalid = draft.trim() !== '' && !weightValid;
  const weightLooksHigh = weightValid && weight >= HIGH_WEIGHT_WARNING;
  const roundedWeight = weightValid ? Number(weight.toFixed(3)) : 0;

  const handleSave = async () => {
    if (!weightValid || saving) return;
    setSaving(true);
    try {
      const { data } = await api.patch(`/orders/${orderId}/items/${item.id}/weight`, {
        weight: roundedWeight,
      });
      onSaved(data.order);
      onClose();
    } catch {
      toast.error(tOrders('weightSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-card rounded-xl shadow-xl w-full max-w-sm">
        <div className="flex items-start justify-between gap-3 p-5 border-b border-border">
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-foreground">{tOrders('enterWeight')}</h2>
            <p className="text-sm text-muted-foreground truncate">
              {formatItemHeading(item.product_name, item.variant_selection)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="touch-target rounded-full text-muted-foreground hover:text-foreground"
            aria-label={tCommon('close')}
          >
            <X size={20} />
          </button>
        </div>
        <div className="p-5 space-y-3">
          <label className="block text-sm font-medium text-foreground" htmlFor="weigh-item-input">
            {tOrders('weightKgLabel')}
          </label>
          <input
            id="weigh-item-input"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            autoFocus
            value={draft}
            onChange={(e) => {
              const next = e.target.value.replace(',', '.');
              if (WEIGHT_INPUT_PATTERN.test(next)) setDraft(next);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSave();
            }}
            className="w-full min-h-11 rounded-lg border border-border bg-background px-3 py-2 text-lg font-bold tabular-nums text-foreground outline-none focus:ring-2 focus:ring-brand"
          />
          <p className="text-xs text-muted-foreground">
            {tOrders('weightBasePrice', { price: fmt(basePrice) })}
          </p>
          {weightInvalid && (
            <p className="text-xs font-medium text-red-500 dark:text-red-400">
              {tOrders('weightInvalid')}
            </p>
          )}
          {weightLooksHigh && (
            <p className="text-xs font-medium text-orange-600 dark:text-orange-400">
              {tOrders('weightLooksHigh', { weight: roundedWeight.toFixed(2) })}
            </p>
          )}
          {weightValid && (
            <p className="text-sm font-semibold text-foreground tabular-nums">
              {tOrders('weightAmount', { weight: roundedWeight.toFixed(2) })} × {fmt(basePrice)} ={' '}
              {fmt(basePrice * roundedWeight)}
            </p>
          )}
        </div>
        <div className="flex gap-2 p-5 pt-0">
          <Button variant="outline" className="flex-1" onClick={onClose} disabled={saving}>
            {tCommon('cancel')}
          </Button>
          <Button className="flex-1" onClick={handleSave} disabled={!weightValid || saving}>
            {saving ? <Loader2 size={16} className="animate-spin" /> : tCommon('save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
