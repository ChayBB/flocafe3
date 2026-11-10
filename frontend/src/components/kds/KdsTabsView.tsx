'use client';

import { Clock } from 'lucide-react';
import { useState } from 'react';
import { ElapsedTime } from '@/components/kds/ElapsedTime';
import { KdsSetPrice } from '@/components/kds/KdsSetPrice';
import { KdsServiceNotice, noticeRowClass } from '@/components/kds/KdsServiceNotice';
import { KdsStatusToggle } from '@/components/kds/KdsStatusToggle';
import { activeStages, boardColumnForItem, useKdsCancellationClock } from '@/lib/kds-stages';
import { Badge } from '@/components/ui/badge';
import {
  STATUS_CONFIG,
  normalizeKitchenStatus,
  ORDER_TYPE_BADGE_STYLES,
  type KitchenStatus,
  type KdsOrder,
  type KdsOrderItem,
} from '@/hooks/useKdsConnection';
import { ORDER_TYPE_LABEL_KEYS, type OrderType } from '@/lib/order-types';
import { useTranslations } from 'use-intl';
import { Ltr } from '@/components/layout/Ltr';
import { kdsItemLine } from '@/lib/item-options-note';

export interface KdsTabsViewProps {
  orders: KdsOrder[];
  updating: number | null;
  /** Stages this display has switched off; their tabs leave the view. */
  inactiveStatuses: readonly KitchenStatus[];
  updateItemStatus: (
    itemId: number,
    status: KitchenStatus,
    opts?: { expectedStatus?: KitchenStatus },
  ) => Promise<boolean>;
}

export function KdsTabsView({
  orders,
  updating,
  inactiveStatuses,
  updateItemStatus,
}: KdsTabsViewProps) {
  const t = useTranslations('kds');
  const tOrders = useTranslations('orders');
  const [selectedTab, setSelectedTab] = useState<KitchenStatus>('pending');
  const cancellationClock = useKdsCancellationClock(orders);
  const tabs: KitchenStatus[] = [...activeStages(inactiveStatuses), 'voided'];
  const activeTab = tabs.includes(selectedTab) ? selectedTab : tabs[0];
  const tabOf = (item: KdsOrderItem): KitchenStatus | null => {
    const status = normalizeKitchenStatus(item.status);
    return status === 'voided'
      ? 'voided'
      : boardColumnForItem(item, inactiveStatuses, cancellationClock);
  };

  const statusLabel = (s: KitchenStatus) => t(STATUS_CONFIG[s].labelKey);

  const filteredOrders = orders
    .map((order) => ({
      ...order,
      items: (order.items || []).filter((item) => tabOf(item) === activeTab),
    }))
    .filter((order) => order.items.length > 0);

  const orderCounts = (status: KitchenStatus): number =>
    orders.reduce(
      (sum, order) => sum + (order.items || []).filter((item) => tabOf(item) === status).length,
      0,
    );

  return (
    <>
      <div className="shrink-0 flex flex-wrap items-center gap-2 mb-4">
        {tabs.map((status) => {
          const config = STATUS_CONFIG[status];
          const count = orderCounts(status);
          const isActive = activeTab === status;
          return (
            <button
              key={status}
              onClick={() => setSelectedTab(status)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all flex items-center gap-1.5 ${
                isActive
                  ? `${config.bg} ${config.text} ring-2 ring-current`
                  : `${config.bg} ${config.text} opacity-50 hover:opacity-80`
              }`}
            >
              <div className={`w-2 h-2 rounded-full ${config.color}`} />
              {statusLabel(status)}
              <span className="text-xs px-1.5 py-0.5 rounded-full bg-card/60">{count}</span>
            </button>
          );
        })}
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4 items-start">
          {filteredOrders.map((order) => (
            <div
              key={order.id}
              className="bg-card rounded-xl border border-border p-4 flex flex-col"
            >
              <div className="flex justify-between items-center mb-3 gap-2">
                <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
                  <Ltr as="span" className="font-bold text-base shrink-0">
                    #{order.order_number}
                  </Ltr>
                  <Badge
                    variant="outline"
                    className={
                      ORDER_TYPE_BADGE_STYLES[order.type] ||
                      'bg-muted text-foreground border-border'
                    }
                  >
                    {ORDER_TYPE_LABEL_KEYS[order.type as OrderType]
                      ? tOrders(ORDER_TYPE_LABEL_KEYS[order.type as OrderType])
                      : order.type}
                  </Badge>
                  {order.table?.name && (
                    <Badge variant="secondary" className="bg-muted text-foreground">
                      {t('tableLabel', { name: order.table.name })}
                    </Badge>
                  )}
                  {order.moved_from_table && (
                    <Badge variant="outline">
                      {t('movedFromTable', { name: order.moved_from_table })}
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-1 text-sm text-gray-400 font-mono shrink-0">
                  <Clock size={12} />
                  <Ltr>
                    <ElapsedTime dateStr={order.created_at} />
                  </Ltr>
                </div>
              </div>

              {order.special_instructions && (
                <div className="mb-2 px-2 py-1.5 bg-(--kds-note-bg) border border-(--kds-note-line) rounded-lg">
                  <p className="text-sm text-(--kds-note-text) font-medium break-words">
                    📝 {order.special_instructions}
                  </p>
                </div>
              )}

              <div className="divide-y divide-border flex-1">
                {order.items?.map((item) => {
                  const itemStatus = normalizeKitchenStatus(item.status);
                  const config = STATUS_CONFIG[itemStatus];
                  const isVoided = itemStatus === 'voided';

                  return (
                    <div
                      key={item.id}
                      data-testid="kds-item-row"
                      data-served-confirmed={item.served_confirmed_at ? 'true' : undefined}
                      className={`flex items-center gap-1 pe-1.5 ${noticeRowClass(item)}`}
                    >
                      {/* Only the toggle changes status; tapping the row does nothing. */}
                      <div className="flex-1 min-w-0 px-3 py-2.5">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${config.color}`} />
                          <span className={`font-bold text-base w-6 shrink-0 ${config.text}`}>
                            {item.quantity}×
                          </span>
                          <span
                            className={`text-lg font-semibold flex-1 min-w-32 truncate ${isVoided || item.status === 'cancelled' ? 'text-gray-400 line-through' : 'text-foreground'}`}
                          >
                            {kdsItemLine(item).name}
                          </span>
                          <KdsServiceNotice item={item} />
                        </div>
                        <KdsSetPrice item={item} className="ms-[26px] mt-0.5" />
                        {kdsItemLine(item).instructions && (
                          <p className="ms-[26px] text-sm text-(--kds-instruction) italic mt-0.5 font-medium break-words">
                            {`"${kdsItemLine(item).instructions}"`}
                          </p>
                        )}
                      </div>
                      {item.status !== 'cancelled' && (
                        <KdsStatusToggle
                          status={activeTab}
                          skipped={inactiveStatuses}
                          disabled={updating === item.id}
                          onAdvance={(nextStatus) => {
                            void updateItemStatus(item.id, nextStatus, {
                              expectedStatus: itemStatus,
                            });
                          }}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {filteredOrders.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-gray-400">
            <p className="text-lg">
              {t('emptyItems', { status: statusLabel(activeTab).toLowerCase() })}
            </p>
            <p className="text-sm">{t('emptyHint')}</p>
          </div>
        )}
      </div>
    </>
  );
}
