'use client';

import { PointerActivationConstraints, PointerSensor } from '@dnd-kit/dom';
import { DragDropProvider, useDraggable, type DragEndEvent } from '@dnd-kit/react';
import { Clock } from 'lucide-react';
import { memo, useMemo } from 'react';
import toast from 'react-hot-toast';
import { ElapsedTime } from '@/components/kds/ElapsedTime';
import { KdsColumn } from '@/components/kds/KdsColumn';
import { KdsSetPrice } from '@/components/kds/KdsSetPrice';
import { KdsServiceNotice, noticeRowClass } from '@/components/kds/KdsServiceNotice';
import { KdsStatusToggle } from '@/components/kds/KdsStatusToggle';
import {
  activeStages,
  boardColumnForItem,
  skipsActiveStage,
  useKdsCancellationClock,
  type BoardStatus,
} from '@/lib/kds-stages';
import { Badge } from '@/components/ui/badge';
import {
  STATUS_CONFIG,
  STATUS_ORDER,
  normalizeKitchenStatus,
  ORDER_TYPE_BADGE_STYLES,
  type KitchenStatus,
  type KdsOrder,
  type KdsOrderItem,
} from '@/hooks/useKdsConnection';
import { ORDER_TYPE_LABEL_KEYS, type OrderType } from '@/lib/order-types';
import { useTranslations } from 'use-intl';
import { useConfirm } from '@/hooks/use-confirm';
import { Ltr } from '@/components/layout/Ltr';
import { kdsItemLine } from '@/lib/item-options-note';

export interface KdsKanbanBoardProps {
  orders: KdsOrder[];
  updating: number | null;
  /** Stages this display has switched off; their columns leave the board. */
  inactiveStatuses: readonly KitchenStatus[];
  updateItemStatus: (
    itemId: number,
    status: KitchenStatus,
    opts?: { silent?: boolean; expectedStatus?: KitchenStatus },
  ) => Promise<boolean>;
}

interface DropData {
  status: KitchenStatus;
}

interface DragData {
  items: { id: number; status: KitchenStatus }[];
  fromStatus: KitchenStatus;
}

function statusOf(item: KdsOrderItem): KitchenStatus {
  return normalizeKitchenStatus(item.status);
}

export function KdsKanbanBoard({
  orders,
  updating,
  inactiveStatuses,
  updateItemStatus,
}: KdsKanbanBoardProps) {
  const t = useTranslations('kds');
  const { confirm, ConfirmDialog } = useConfirm();
  const cancellationClock = useKdsCancellationClock(orders);

  // Group by status, then by order. Default rendering matches the tabs view:
  // one card per order, with the order header and a list of items in that status.
  const groupsByStatus = useMemo(() => {
    const map: Record<BoardStatus, Array<{ order: KdsOrder; items: KdsOrderItem[] }>> = {
      pending: [],
      preparing: [],
      ready: [],
      served: [],
    };
    for (const order of orders) {
      const buckets: Record<BoardStatus, KdsOrderItem[]> = {
        pending: [],
        preparing: [],
        ready: [],
        served: [],
      };
      for (const item of order.items || []) {
        const column = boardColumnForItem(item, inactiveStatuses, cancellationClock);
        if (column) buckets[column].push(item);
      }
      for (const status of STATUS_ORDER) {
        if (buckets[status].length > 0) map[status].push({ order, items: buckets[status] });
      }
    }
    return map;
  }, [orders, inactiveStatuses, cancellationClock]);

  // Voided items, grouped per order — read-only, struck through, and never a
  // drag source or drop target (see BoardStatus above).
  const voidedGroups = useMemo(() => {
    const groups: Array<{ order: KdsOrder; items: KdsOrderItem[] }> = [];
    for (const order of orders) {
      const items = (order.items || []).filter((item) => statusOf(item) === 'voided');
      if (items.length > 0) groups.push({ order, items });
    }
    return groups;
  }, [orders]);

  async function handleDragEnd(event: DragEndEvent) {
    if (event.canceled) return;
    const sourceData = event.operation.source?.data as DragData | undefined;
    const targetData = event.operation.target?.data as DropData | undefined;
    if (!event.operation.target || !sourceData || !targetData) return;
    if (sourceData.fromStatus === targetData.status) return;

    // Require confirmation when a move passes over a column still in use.
    const skipsStage = skipsActiveStage(sourceData.fromStatus, targetData.status, inactiveStatuses);
    if (skipsStage) {
      const targetLabel = t(STATUS_CONFIG[targetData.status].labelKey);
      const proceed = await confirm(t('skipStageMessage', { status: targetLabel }), {
        title: t('skipStageTitle'),
        confirmLabel: t('markAs', { status: targetLabel }),
      });
      if (!proceed) return;
    }

    const results = await Promise.all(
      sourceData.items
        .filter((item) => item.status !== targetData.status)
        .map((item) =>
          updateItemStatus(item.id, targetData.status, {
            silent: !skipsStage,
            expectedStatus: item.status,
          }),
        ),
    );
    const failed = results.filter((result) => !result).length;
    if (failed > 0) {
      toast.error(t('itemsUpdateFailed', { count: failed }));
    }
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <DragDropProvider
        sensors={(defaults) => [
          ...defaults.filter((sensor) => sensor !== PointerSensor),
          PointerSensor.configure({
            activationConstraints: [new PointerActivationConstraints.Distance({ value: 6 })],
            preventActivation: () => false,
          }),
        ]}
        onDragEnd={handleDragEnd}
      >
        <div className="flex gap-3 px-1 overflow-x-auto flex-1 min-h-0">
          {activeStages(inactiveStatuses).map((status) => {
            const groups = groupsByStatus[status];
            return (
              <KdsColumn key={status} status={status} count={groups.length}>
                {groups.map(({ order, items }) => (
                  <KanbanOrderCard
                    key={`${order.id}-${status}`}
                    order={order}
                    status={status}
                    items={items}
                    updating={updating}
                    inactive={inactiveStatuses}
                    updateItemStatus={updateItemStatus}
                  />
                ))}
              </KdsColumn>
            );
          })}

          {voidedGroups.length > 0 && <VoidedColumn groups={voidedGroups} />}
        </div>
      </DragDropProvider>

      {ConfirmDialog}
    </div>
  );
}

type KanbanOrderCardProps = {
  order: KdsOrder;
  status: KitchenStatus;
  items: KdsOrderItem[];
  updating: number | null;
  inactive: readonly KitchenStatus[];
  updateItemStatus: KdsKanbanBoardProps['updateItemStatus'];
};

function kanbanOrderCardPropsEqual(
  prev: KanbanOrderCardProps,
  next: KanbanOrderCardProps,
): boolean {
  return (
    prev.order === next.order &&
    prev.updateItemStatus === next.updateItemStatus &&
    prev.inactive === next.inactive &&
    prev.status === next.status &&
    prev.updating === next.updating &&
    prev.items.length === next.items.length &&
    prev.items.every((item, index) => item === next.items[index])
  );
}

const KanbanOrderCard = memo(function KanbanOrderCard({
  order,
  status,
  items,
  updating,
  inactive,
  updateItemStatus,
}: KanbanOrderCardProps) {
  const t = useTranslations('kds');
  const tOrders = useTranslations('orders');
  const config = STATUS_CONFIG[status];
  const dragItems = items
    .filter((i) => i.status !== 'cancelled')
    .map((i) => ({ id: i.id, status: statusOf(i) }));
  const busy = items.some((i) => updating === i.id);
  const { ref, isDragging } = useDraggable({
    id: `order-${order.id}-${status}`,
    data: { items: dragItems, fromStatus: status },
    disabled: dragItems.length === 0,
  });

  return (
    <div
      ref={ref}
      className={`select-none cursor-grab active:cursor-grabbing transition ${
        isDragging ? 'opacity-40' : ''
      } ${busy ? 'pointer-events-none opacity-60' : ''}`}
    >
      <div className="rounded-xl border border-border bg-card p-3 flex flex-col">
        <div className="flex justify-between items-center mb-2 gap-2">
          <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
            <Ltr as="span" className="font-bold text-sm shrink-0">
              #{order.order_number}
            </Ltr>
            <Badge
              variant="outline"
              className={
                ORDER_TYPE_BADGE_STYLES[order.type] || 'bg-muted text-foreground border-border'
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
          <p className="mb-2 px-2 py-1 bg-(--kds-note-bg) border border-(--kds-note-line) rounded text-sm text-(--kds-note-text) font-medium break-words">
            📝 {order.special_instructions}
          </p>
        )}

        <div className="divide-y divide-border">
          {items.map((item) => (
            <div
              key={item.id}
              data-testid="kds-item-row"
              data-served-confirmed={item.served_confirmed_at ? 'true' : undefined}
              className={`flex items-center gap-1 pe-1 ${noticeRowClass(item)}`}
            >
              {/* Only the toggle changes status; tapping the row does nothing. */}
              <div className="flex-1 min-w-0 px-2 py-1.5">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className={`text-base font-bold w-6 shrink-0 ${config.text}`}>
                    {item.quantity}×
                  </span>
                  <span
                    className={`text-lg font-medium flex-1 min-w-32 truncate ${item.status === 'cancelled' ? 'text-gray-400 line-through' : 'text-foreground'}`}
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
                  status={status}
                  skipped={inactive}
                  disabled={updating === item.id}
                  onAdvance={(nextStatus) => {
                    void updateItemStatus(item.id, nextStatus, { expectedStatus: statusOf(item) });
                  }}
                />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}, kanbanOrderCardPropsEqual);

// Read-only display column for voided items; drag-and-drop transitions are disabled.
function VoidedColumn({ groups }: { groups: Array<{ order: KdsOrder; items: KdsOrderItem[] }> }) {
  const t = useTranslations('kds');
  const config = STATUS_CONFIG.voided;
  const count = groups.reduce((sum, g) => sum + g.items.length, 0);

  return (
    <div className="flex-1 min-w-[260px] min-h-0 flex flex-col">
      <div
        className={`flex items-center gap-2 px-3 py-2 ${config.bg} rounded-t-lg border border-border border-b-0`}
      >
        <div className={`w-2 h-2 rounded-full ${config.color}`} />
        <span className={`text-base font-semibold ${config.text}`}>{t(config.labelKey)}</span>
        <span className="ms-auto text-xs px-1.5 py-0.5 rounded-full bg-card/70 text-foreground font-medium tabular-nums">
          {count}
        </span>
      </div>
      <div
        className="flex-1 border border-border border-t-0 rounded-b-lg p-2 space-y-2 overflow-y-auto bg-muted/40"
        style={{ minHeight: '60vh' }}
      >
        {groups.map(({ order, items }) => (
          <div
            key={order.id}
            className="rounded-xl border border-border bg-card p-3 flex flex-col opacity-80"
          >
            <div className="flex items-center gap-1.5 min-w-0 flex-wrap mb-2">
              <Ltr as="span" className="font-bold text-sm shrink-0">
                #{order.order_number}
              </Ltr>
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
            <div className="space-y-1">
              {items.map((item) => (
                <div key={item.id} className="w-full text-start px-2 py-1.5">
                  <div className="flex items-center gap-2">
                    <span className={`text-base font-bold w-6 shrink-0 ${config.text}`}>
                      {item.quantity}×
                    </span>
                    <span className="text-lg text-gray-400 line-through font-medium flex-1 truncate">
                      {kdsItemLine(item).name}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
        {count === 0 && (
          <div className="flex flex-col items-center justify-center py-6 text-gray-400 text-xs">
            <span>{t('emptyColumn')}</span>
          </div>
        )}
      </div>
    </div>
  );
}
