'use client';

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'use-intl';
import { KdsHeader } from '@/components/kds/KdsHeader';
import { KdsKanbanBoard } from '@/components/kds/KdsKanbanBoard';
import { KdsMessageBar } from '@/components/kds/KdsMessageBar';
import { KdsSettingsDialog } from '@/components/kds/KdsSettingsDialog';
import { KdsSearchBox } from '@/components/kds/KdsSearchBox';
import { KdsTabsView } from '@/components/kds/KdsTabsView';
import { kdsOrderMatches, normalizeKdsSearch } from '@/lib/kds-search';
import { useKdsView } from '@/hooks/useKdsView';
import { useKdsScreenMode } from '@/lib/kds-screen-mode';
import type { KitchenStatus, UseKdsConnectionResult } from '@/hooks/useKdsConnection';
import {
  playKdsAlert,
  playKdsReadyBell,
  readKdsReadyBell,
  readKdsReadyDelay,
  unlockKdsAlertSound,
} from '@/lib/kds-alert-sound';
import {
  kdsSpeechLang,
  readKdsSoundSettings,
  queueKdsSound,
  speakKds,
  speakKdsNow,
  primeKdsVoice,
  writeKdsSoundSettings,
  type KdsSoundSetting,
  type KdsSoundSettings,
} from '@/lib/kds-sound-settings';
import {
  addKdsMessages,
  cancelKdsTakeawayMessages,
  detectKdsBoardChanges,
  dismissKdsMessage,
  getKdsMessages,
  getServerKdsMessages,
  kdsItemPlaces,
  markKdsKotReady,
  readSeenKdsAlerts,
  subscribeKdsMessages,
  writeSeenKdsAlerts,
  type KdsItemPlace,
  type KdsMessage,
} from '@/lib/kds-messages';
import { TERMINAL_ITEM_STATUSES } from '@shared/order-item-status';
import { optionsNote, spokenItemName, withoutOptionsNote } from '@/lib/item-options-note';
import { parseVariantSelection } from '@/lib/printer/item-heading';

const INACTIVE_STAGES_KEY = 'flocafe:kds-inactive-stages';
type InactiveStages = Record<string, KitchenStatus[]>;

/** Switched-off stages per station on this display; '' is "all stations". */
function readInactiveStages(): InactiveStages {
  if (typeof window === 'undefined') return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(INACTIVE_STAGES_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const NONE_INACTIVE: KitchenStatus[] = [];
// A ready announcement waits this long after new items have been read out.
const AFTER_READ_ALOUD_MS = 3000;
// The pause between the parts of a read-out: an item and its special instructions, tables, the order note.
const READ_ALOUD_PAUSE_MS = 700;
// The table (or "new order") is read on its own, then this pause, then the dishes.
const READ_ALOUD_TABLE_PAUSE_MS = 600;
// An order of more than two dishes reads each dish on its own, with a 30% longer pause between them.
const READ_ALOUD_SPACED_DISHES_OVER = 2;
const READ_ALOUD_DISH_PAUSE_MS = Math.round(READ_ALOUD_PAUSE_MS * 1.3);

// Items switched to take-away are still cooked, so they are read out and announced; cancelled ones are not.
function liveItems(order: UseKdsConnectionResult['orders'][number]) {
  return (order.items || []).filter(
    (item) =>
      !TERMINAL_ITEM_STATUSES.includes(item.status || '') && item.service_change !== 'cancelled',
  );
}

/** Adds new notices to the message bar; each beeps (take-away already beeps on its own) and is read out, except an unprinted ticket, which only shows. */
function announceKdsMessages(fresh: KdsMessage[]) {
  if (fresh.length === 0) return;
  addKdsMessages(fresh);
  const loud = fresh.filter((message) => message.kind !== 'kot_unprinted');
  if (loud.length === 0) return;
  const emergency = loud.some((message) => message.kind === 'emergency');
  if (loud.some((message) => message.kind !== 'takeaway')) playKdsAlert(emergency ? 3 : 1);
  speakKds(loud.map((message) => message.speech ?? message.text).join('. '), kdsSpeechLang());
}

function serviceChangesById(orders: UseKdsConnectionResult['orders']): Map<number, string | null> {
  return new Map(
    orders.flatMap((order) =>
      (order.items || []).map((item) => [item.id, item.service_change ?? null] as const),
    ),
  );
}

export function KdsWorkspace({
  conn,
  serverDefault,
}: {
  conn: UseKdsConnectionResult;
  serverDefault: 'tabs' | 'kanban' | null;
}) {
  const t = useTranslations('kds');
  const { viewMode, setViewMode } = useKdsView(serverDefault);
  const screen = useKdsScreenMode();

  // Sound needs one tap per page in a browser; any tap or key press on the display unlocks it.
  useEffect(() => {
    window.addEventListener('pointerdown', unlockKdsAlertSound);
    window.addEventListener('keydown', unlockKdsAlertSound);
    return () => {
      window.removeEventListener('pointerdown', unlockKdsAlertSound);
      window.removeEventListener('keydown', unlockKdsAlertSound);
    };
  }, []);
  const flashRef = useRef<HTMLDivElement>(null);
  const [soundSettings, setSoundSettings] = useState<KdsSoundSettings>(readKdsSoundSettings);
  const soundSettingsRef = useRef(soundSettings);
  useEffect(() => {
    soundSettingsRef.current = soundSettings;
  }, [soundSettings]);
  const toggleSound = (setting: KdsSoundSetting) => {
    setSoundSettings((current) => {
      const next = { ...current, [setting]: !current[setting] };
      writeKdsSoundSettings(next);
      return next;
    });
  };

  // Alert when an item already on this display gains a service change; items seen for the first time do not.
  // While sound is blocked the screen flashes orange instead.
  const knownChangesRef = useRef<Map<number, string | null>>(new Map());
  useEffect(() => {
    const current = serviceChangesById(conn.orders);
    const known = knownChangesRef.current;
    let changed = false;
    for (const [id, change] of current) {
      if (change && known.has(id) && known.get(id) !== change) changed = true;
    }
    if (changed && !playKdsAlert()) {
      flashRef.current?.animate([{ opacity: 0 }, { opacity: 1 }, { opacity: 0 }], {
        duration: 700,
        iterations: 4,
      });
    }
    knownChangesRef.current = new Map([...known, ...current]);
  }, [conn.orders]);
  // Table moves, merges, items switched to take-away and emergency calls wait in the message bar
  // until acknowledged.
  const messages = useSyncExternalStore(subscribeKdsMessages, getKdsMessages, getServerKdsMessages);
  const knownPlacesRef = useRef<Map<number, KdsItemPlace> | null>(null);
  useEffect(() => {
    const places = kdsItemPlaces(conn.orders, (order) =>
      order.table?.name
        ? t('tableLabel', { name: order.table.name })
        : t('messageOrder', { number: order.order_number }),
    );
    const known = knownPlacesRef.current;
    knownPlacesRef.current = places;
    if (!known || !soundSettingsRef.current.showMessages) return;
    const at = new Date().toISOString();
    const notices = detectKdsBoardChanges(known, places).map((change) => ({
      id: `${change.key}:${at}`,
      kind: change.kind,
      at,
      // Take-away and cancelled items are read short: the place, the dish, then what changed.
      speech:
        'place' in change
          ? t(change.kind === 'takeaway' ? 'speechTakeaway' : 'speechCancelled', {
              place: change.place,
              item: change.spoken,
            })
          : undefined,
      text:
        'place' in change
          ? t(change.kind === 'takeaway' ? 'messageTakeaway' : 'messageCancelled', {
              place: change.place,
              item: change.item,
            })
          : t(change.kind === 'move' ? 'messageMove' : 'messageMerge', {
              from: change.from,
              to: change.to,
            }),
    }));
    announceKdsMessages(notices.filter((notice) => notice.kind !== 'cancelled'));
    // A cancellation only updates an item's take-away notice and the card beeps for it, but every
    // cancelled dish is still read out.
    const cancelled = notices.filter((notice) => notice.kind === 'cancelled');
    cancelKdsTakeawayMessages(cancelled);
    if (cancelled.length > 0)
      speakKds(cancelled.map((notice) => notice.speech).join('. '), kdsSpeechLang());
  }, [conn.orders, t]);
  useEffect(() => {
    const seen = readSeenKdsAlerts();
    const unseen = conn.alerts.filter((alert) => !seen.includes(alert.id));
    if (unseen.length === 0) return;
    writeSeenKdsAlerts([...seen, ...unseen.map((alert) => alert.id)]);
    if (!soundSettingsRef.current.showMessages) return;
    const kotText = (alert: (typeof unseen)[number]) =>
      [
        t('messageKotFailed'),
        alert.table
          ? t('tableLabel', { name: alert.table })
          : t('messageOrder', { number: alert.message }),
      ].join(' · ');
    announceKdsMessages(
      unseen
        .filter((alert) => alert.kind !== 'kot_ready')
        .map((alert) => ({
          id: `alert:${alert.id}`,
          kind: alert.kind as Exclude<typeof alert.kind, 'kot_ready'>,
          at: alert.created_at,
          ref: alert.ref ?? undefined,
          reason: alert.reason ?? undefined,
          text:
            alert.kind === 'kot_unprinted'
              ? kotText(alert)
              : [
                  t('messageEmergency'),
                  alert.table ? t('tableLabel', { name: alert.table }) : null,
                  alert.message || null,
                  alert.sent_by ? t('messageFrom', { name: alert.sent_by }) : null,
                ]
                  .filter(Boolean)
                  .join(' · '),
        })),
    );
    // The printer can print a kept ticket again: its notice opens so staff can reprint it by hand.
    const ready = unseen.filter((alert) => alert.kind === 'kot_ready' && alert.ref);
    for (const alert of ready) {
      markKdsKotReady(
        alert.ref!,
        {
          id: `alert:${alert.id}`,
          kind: 'kot_unprinted',
          at: alert.created_at,
          reason: alert.reason ?? undefined,
          text: kotText(alert),
        },
        alert.id,
      );
    }
    if (ready.length > 0) playKdsAlert(1);
  }, [conn.alerts, t]);
  // Every display opens on all stations; picking one narrows the board to that category.
  const [selectedStation, setSelectedStation] = useState('');
  const stationId = conn.stations.some((station) => station.id === selectedStation)
    ? selectedStation
    : '';
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inactiveStages, setInactiveStages] = useState<InactiveStages>(readInactiveStages);
  const inactiveStatuses = inactiveStages[stationId] ?? NONE_INACTIVE;
  const stationName = conn.stations.find((station) => station.id === stationId)?.name;

  const toggleStage = (status: KitchenStatus) => {
    setInactiveStages((current) => {
      const stages = current[stationId] ?? [];
      const nextStages = stages.includes(status)
        ? stages.filter((stage) => stage !== status)
        : [...stages, status];
      const next = { ...current, [stationId]: nextStages };
      try {
        window.localStorage.setItem(INACTIVE_STAGES_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  };

  const orders = useMemo(() => {
    if (!stationId) return conn.orders;
    return conn.orders
      .map((order) => ({
        ...order,
        items: (order.items || []).filter((item) => item.station_category_id === stationId),
      }))
      .filter((order) => order.items.length > 0);
  }, [conn.orders, stationId]);

  // Search only narrows what is drawn; read-outs and ready announcements still follow `orders`.
  const [search, setSearch] = useState('');
  const searchQuery = normalizeKdsSearch(search);
  const visibleOrders = useMemo(
    () => (searchQuery ? orders.filter((order) => kdsOrderMatches(order, searchQuery)) : orders),
    [orders, searchQuery],
  );

  // Items already in the kitchen when this display receives its orders are not announced, nor are items
  // already ready. Every station counts, so switching station never reads out what was already there.
  const knownItemIdsRef = useRef<Set<number> | null>(null);
  const knownStatusesRef = useRef<Map<number, string>>(new Map());
  // An order note is read with the order's new items, once per wording.
  const readOrderNotesRef = useRef<Map<number, string>>(new Map());
  const lastReadyAtRef = useRef<Map<string, number>>(new Map());
  const readAloudEndedAtRef = useRef(-Infinity);
  const readyAlertEndedAtRef = useRef(-Infinity);
  const readyChainRef = useRef<Promise<void>>(Promise.resolve());
  const ordersSynced = conn.ordersSynced;
  useEffect(() => {
    if (!ordersSynced) return;
    const allLive = conn.orders.flatMap((order) => liveItems(order));
    const itemIds = new Set(allLive.map((item) => item.id));
    const knownItems = knownItemIdsRef.current;
    const knownStatuses = knownStatusesRef.current;
    const readOrderNotes = readOrderNotesRef.current;
    const hasFresh =
      knownItems !== null &&
      orders.some((order) => liveItems(order).some((item) => !knownItems.has(item.id)));
    if (hasFresh && soundSettingsRef.current.newOrderAlert) {
      queueKdsSound(async () => {
        if (playKdsAlert(2)) await new Promise((resolve) => setTimeout(resolve, 700));
      });
    }
    if (knownItems && soundSettingsRef.current.readAloud) {
      // Each table is read in parts: special instructions follow their item after a short pause, and
      // the order note comes once the table's last item has been read.
      const parts = orders.flatMap((order) => {
        const fresh = liveItems(order).filter((item) => !knownItems.has(item.id));
        if (fresh.length === 0) return [];
        const chunks: { text: string; pauseMs: number }[] = [];
        const spaced = fresh.length > READ_ALOUD_SPACED_DISHES_OVER;
        let chunk = '';
        for (const item of fresh) {
          const variantName = parseVariantSelection(item.variant_selection)?.name;
          const name = spokenItemName(item.product_name, variantName, item.addons);
          const text = t('readAloudItem', { name, quantity: item.quantity });
          const note = withoutOptionsNote(
            item.special_instructions,
            optionsNote(variantName, item.addons),
          );
          if (spaced) {
            chunks.push({ text, pauseMs: READ_ALOUD_DISH_PAUSE_MS });
            if (note) chunks.push({ text: note, pauseMs: READ_ALOUD_PAUSE_MS });
            continue;
          }
          chunk = chunk ? `${chunk}, ${text}` : text;
          if (note) {
            chunks.push({ text: chunk, pauseMs: READ_ALOUD_PAUSE_MS });
            chunks.push({ text: note, pauseMs: READ_ALOUD_PAUSE_MS });
            chunk = '';
          }
        }
        if (chunk) chunks.push({ text: chunk, pauseMs: READ_ALOUD_PAUSE_MS });
        chunks[0] = { ...chunks[0], pauseMs: READ_ALOUD_TABLE_PAUSE_MS };
        chunks.unshift({
          text: order.table?.name
            ? t('readAloudTable', { table: order.table.name })
            : t('readAloudOrder', { number: order.order_number }),
          pauseMs: READ_ALOUD_PAUSE_MS,
        });
        const orderNote = order.special_instructions?.trim() || '';
        if (orderNote && readOrderNotes.get(order.id) !== orderNote) {
          chunks.push({
            text: t('readAloudOrderNote', { note: orderNote }),
            pauseMs: READ_ALOUD_PAUSE_MS,
          });
        }
        return chunks;
      });
      if (parts.length > 0) {
        const lang = kdsSpeechLang();
        primeKdsVoice(parts[0].text.split(/\s+/)[0] ?? '', lang);
        queueKdsSound(async () => {
          for (const [index, part] of parts.entries()) {
            if (index > 0) await new Promise((resolve) => setTimeout(resolve, part.pauseMs));
            await speakKdsNow(part.text, lang);
          }
          readAloudEndedAtRef.current = Date.now();
        });
      }
    }
    // Any menu item that turns ready rings the bell and names its table, even while the rest of the
    // order is still cooking. A table is announced once however many items turn ready together, and
    // not again until this display's repeat delay has passed.
    const now = Date.now();
    const repeatMs = readKdsReadyDelay('repeat') * 1000;
    const lastReadyAt = lastReadyAtRef.current;
    const readyPhrases = new Map<string, string>();
    for (const order of orders) {
      const turnedReady = liveItems(order).some(
        (item) =>
          item.status === 'ready' &&
          knownStatuses.has(item.id) &&
          knownStatuses.get(item.id) !== 'ready',
      );
      if (!turnedReady) continue;
      const key = order.table?.name ? `table:${order.table.name}` : `order:${order.id}`;
      if (readyPhrases.has(key) || now - (lastReadyAt.get(key) ?? -Infinity) < repeatMs) continue;
      readyPhrases.set(
        key,
        order.table?.name
          ? t('readyToServeTable', { table: order.table.name })
          : t('readyToServeOrder', { number: order.order_number }),
      );
    }
    if (readyPhrases.size > 0 && soundSettingsRef.current.orderReady) {
      for (const key of readyPhrases.keys()) lastReadyAt.set(key, now);
      const lang = kdsSpeechLang();
      const gapMs = readKdsReadyDelay('gap') * 1000;
      // With a delay between tables each table waits its turn; without one they share a bell.
      const announcements =
        gapMs > 0 ? [...readyPhrases.values()] : [[...readyPhrases.values()].join('. ')];
      const sleep = (ms: number) =>
        ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : undefined;
      for (const announcement of announcements) {
        // The wait between tables happens outside the speech queue, so new orders are still read out.
        readyChainRef.current = readyChainRef.current
          .then(async () => {
            await sleep(readyAlertEndedAtRef.current + gapMs - Date.now());
            await new Promise<void>((done) =>
              queueKdsSound(async () => {
                try {
                  await sleep(readAloudEndedAtRef.current + AFTER_READ_ALOUD_MS - Date.now());
                  const bell = readKdsReadyBell();
                  if (bell !== 'none') await playKdsReadyBell(bell);
                  await speakKdsNow(announcement, lang);
                } finally {
                  readyAlertEndedAtRef.current = Date.now();
                  done();
                }
              }),
            );
          })
          .catch(() => {});
      }
    }
    knownItemIdsRef.current = new Set([...(knownItems ?? []), ...itemIds]);
    for (const order of conn.orders) {
      const note = order.special_instructions?.trim();
      if (note) readOrderNotes.set(order.id, note);
    }
    knownStatusesRef.current = new Map(
      allLive.map((item) => [item.id, item.status || ''] as const),
    );
  }, [orders, conn.orders, ordersSynced, t]);

  return (
    <div data-testid="kds-workspace" className="relative h-full flex-1 flex flex-col">
      {/* Dims the board but not the settings dialog, so brightness can always be turned back up. */}
      {screen.brightness < 100 && (
        <div
          data-testid="kds-dimmer"
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 z-[45] bg-black"
          style={{ opacity: (100 - screen.brightness) / 100 }}
        />
      )}
      <div
        ref={flashRef}
        data-testid="kds-change-flash"
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-50 border-[12px] border-orange-500 bg-orange-400/30 opacity-0"
      />
      <KdsHeader
        userName={conn.user!.name}
        userRole={conn.user!.role}
        connected={conn.connected}
        connectionMode={conn.connectionMode}
        viewMode={viewMode}
        onChangeView={setViewMode}
        stations={conn.stations}
        stationId={stationId}
        onChangeStation={setSelectedStation}
        screenMode={screen.mode}
        onScreenMode={screen.setMode}
        onOpenSettings={() => setSettingsOpen(true)}
        onLogout={conn.handleLogout}
      />
      <KdsSearchBox value={search} onChange={setSearch} />
      <div className="flex-1 min-h-0 flex flex-col">
        {searchQuery && visibleOrders.length === 0 ? (
          <div
            data-testid="kds-search-empty"
            className="flex flex-col items-center justify-center py-16 text-gray-400"
          >
            <p className="text-lg">{t('searchNoResults', { query: search.trim() })}</p>
            <p className="text-sm">{t('searchNoResultsHint')}</p>
          </div>
        ) : viewMode === 'kanban' ? (
          <KdsKanbanBoard
            orders={visibleOrders}
            updating={conn.updating}
            inactiveStatuses={inactiveStatuses}
            updateItemStatus={conn.updateItemStatus}
          />
        ) : (
          <KdsTabsView
            orders={visibleOrders}
            updating={conn.updating}
            inactiveStatuses={inactiveStatuses}
            updateItemStatus={conn.updateItemStatus}
          />
        )}
      </div>
      {(soundSettings.showMessages || soundSettings.showBell) && (
        <KdsMessageBar
          messages={messages}
          onDismiss={dismissKdsMessage}
          onReprintKot={async (message) => {
            if (!message.ref) return false;
            if ((await conn.reprintUnprintedKot(message.ref)) === 'failed') return false;
            dismissKdsMessage(message.id);
            return true;
          }}
          onDropKot={(message) => {
            if (message.ref) void conn.dropUnprintedKot(message.ref);
            dismissKdsMessage(message.id);
          }}
          showMessages={soundSettings.showMessages}
          showBell={soundSettings.showBell}
        />
      )}
      <KdsSettingsDialog
        open={settingsOpen}
        stationName={stationName ?? t('allStations')}
        inactiveStatuses={inactiveStatuses}
        onToggleStatus={toggleStage}
        soundSettings={soundSettings}
        onToggleSound={toggleSound}
        screenMode={screen.mode}
        onScreenMode={screen.setMode}
        brightness={screen.brightness}
        onBrightness={screen.setBrightness}
        onClose={() => setSettingsOpen(false)}
      />
      {conn.ConfirmDialog}
    </div>
  );
}
