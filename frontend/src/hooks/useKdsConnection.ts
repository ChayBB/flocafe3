'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type SetStateAction,
} from 'react';
import toast from 'react-hot-toast';
import type { AxiosInstance } from 'axios';
import { useTranslations, type AppConfig } from 'use-intl';
import { useConfirm } from '@/hooks/use-confirm';
import { parseLoginFailure } from '../lib/login-errors';
import type { User, Tenant } from '@/lib/types';

// Exponential backoff for KDS WebSocket reconnects (1s to 30s)
// preventing server hammering during outages.
const KDS_RECONNECT_BASE_MS = 1000;
const KDS_RECONNECT_MAX_MS = 30000;
/** Keeps prior object identity for orders whose payload is unchanged, so memoized cards skip re-rendering. */
export function reconcileKdsOrders(prev: KdsOrder[], next: KdsOrder[]): KdsOrder[] {
  const previousById = new Map(prev.map((order) => [order.id, order]));
  let identical = prev.length === next.length;
  const merged = next.map((order, index) => {
    const existing = previousById.get(order.id);
    const reuse = existing !== undefined && JSON.stringify(existing) === JSON.stringify(order);
    const result = reuse ? existing : order;
    if (prev[index] !== result) identical = false;
    return result;
  });
  return identical ? prev : merged;
}

function kdsReconnectDelay(attempt: number): number {
  return Math.min(KDS_RECONNECT_MAX_MS, KDS_RECONNECT_BASE_MS * 2 ** attempt);
}

// 'voided' is a locked terminal status excluded from sequential status progressions.
export type KitchenStatus = 'pending' | 'preparing' | 'ready' | 'served' | 'voided';
export type ConnectionMode = 'websocket' | 'rest' | null;

type KdsKey = keyof AppConfig['Messages']['kds'];

interface StatusConfigEntry {
  labelKey: KdsKey;
  color: string;
  border: string;
  text: string;
  bg: string;
}

export const STATUS_CONFIG = {
  pending: {
    labelKey: 'statusWaiting',
    color: 'bg-(--kds-pending)',
    border: 'border-(--kds-pending-line)',
    text: 'text-(--kds-pending-text)',
    bg: 'bg-(--kds-pending-tint)',
  },
  preparing: {
    labelKey: 'statusPreparing',
    color: 'bg-(--kds-preparing)',
    border: 'border-(--kds-preparing-line)',
    text: 'text-(--kds-preparing-text)',
    bg: 'bg-(--kds-preparing-tint)',
  },
  ready: {
    labelKey: 'statusReady',
    color: 'bg-(--kds-ready)',
    border: 'border-(--kds-ready-line)',
    text: 'text-(--kds-ready-text)',
    bg: 'bg-(--kds-ready-tint)',
  },
  served: {
    labelKey: 'statusDelivered',
    color: 'bg-(--kds-served)',
    border: 'border-(--kds-served-line)',
    text: 'text-(--kds-served-text)',
    bg: 'bg-(--kds-served-tint)',
  },
  voided: {
    labelKey: 'statusVoided',
    color: 'bg-red-600',
    border: 'border-red-300 dark:border-red-700',
    text: 'text-red-800 dark:text-red-200',
    bg: 'bg-red-50 dark:bg-red-950/60',
  },
} as const satisfies Record<KitchenStatus, StatusConfigEntry>;

export const STATUS_ORDER: Exclude<KitchenStatus, 'voided'>[] = [
  'pending',
  'preparing',
  'ready',
  'served',
];

export function normalizeKitchenStatus(status: unknown): KitchenStatus {
  return typeof status === 'string' && status in STATUS_CONFIG
    ? (status as KitchenStatus)
    : 'pending';
}

export const ORDER_TYPE_BADGE_STYLES: Record<string, string> = {
  dine_in: 'bg-transparent text-muted-foreground border-border',
  takeaway: 'bg-transparent text-(--kds-pending-text) border-(--kds-pending-line)',
  delivery: 'bg-transparent text-(--kds-ready-text) border-(--kds-ready-line)',
  online: 'bg-transparent text-(--kds-served-text) border-(--kds-served-line)',
};

export interface KdsOrderItemAddon {
  id?: string | number;
  name: string;
  price?: number;
  quantity?: number;
}

export interface KdsOrderItem {
  id: number;
  order_id: number;
  product_id: string | number;
  product_name: string;
  quantity: number;
  status?: string;
  addons?: KdsOrderItemAddon[] | null;
  special_instructions?: string | null;
  /** Variant the kitchen actually received, JSON text or object per the API. */
  variant_selection?:
    | { id: string; name: string; price: number; sku?: string | null }
    | string
    | null;
  created_at?: string;
  updated_at?: string;
  /** Menu category the KDS station picker filters on. */
  station_category_id?: string | null;
  /** The line's unit price: the price per kg while a weighed line waits for its weight. */
  unit_price?: number | null;
  /** Price the kitchen set for a weighed or kitchen-priced line. */
  kitchen_set_price?: number | null;
  currency?: string;
  /** A change service staff made after sending: 'takeaway' or 'cancelled'. */
  service_change?: string | null;
  service_change_at?: string | null;
  /** When service staff confirmed the served item reached the table, and who. */
  served_confirmed_at?: string | null;
  served_confirmed_by_name?: string | null;
  /** When the kitchen flagged the dish out of stock, asking service staff to cancel it. */
  out_of_stock_at?: string | null;
  /** A line priced after the order: its weight in kg, whether it still waits, and how it is priced. */
  weight?: number | null;
  weight_pending?: number | boolean | null;
  pending_price_mode?: 'weight' | 'kitchen_price' | null;
  store_timezone?: string;
}

export interface KdsStation {
  id: string;
  name: string;
}

export interface KdsOrder {
  id: number;
  order_number: string;
  type: string;
  table_id?: string | number | null;
  customer_id?: string | null;
  status?: string;
  subtotal?: number;
  tax_amount?: number;
  total?: number;
  guest_count?: number | null;
  special_instructions?: string | null;
  created_at: string;
  updated_at?: string;
  items?: KdsOrderItem[];
  table?: { name: string } | null;
  moved_from_table?: string | null;
  /** The table owner's name, else the staff member who placed the order. */
  server_name?: string | null;
}

export interface KdsUser {
  id: string;
  name: string;
  role: string;
  token: string;
  has_pin?: boolean;
}

export interface KdsPinUser {
  id: string;
  name: string;
  role: string;
}

interface WsMessage {
  type: string;
  orders?: KdsOrder[];
  counts?: Record<string, number>;
  alerts?: KdsAlert[];
  user?: { id: string; name: string; role: string; stationIds?: string[] };
  message?: string;
}

export interface UseKdsConnectionEndpoints {
  login?: string;
  pinUsers?: string;
  pinLogin?: string;
  me?: string;
  logout?: string;
  orders?: string;
  /** Path template containing a literal `:itemId` placeholder, e.g. '/kds/items/:itemId/status'. */
  itemStatus?: string;
  stations?: string;
  /** Missing kitchen tickets a display can print again or drop. */
  unprintedKots?: string;
  view?: string;
}

export interface UseKdsConnectionOptions {
  api: AxiosInstance;
  /** Overrides endpoint paths for standalone KDS device page (:3002). */
  endpoints?: UseKdsConnectionEndpoints;
  /** Session restore, WebSocket, and REST polling stay idle until confirmed on. */
  enabled: boolean;
  /** Synchronizes an embedded host store when KDS clears or rotates the shared token. */
  onSessionCleared?: (clearedToken: string | null) => void;
  onSessionTokenReplaced?: (nextToken: string, hasPin?: boolean) => void;
  onSessionAuthenticated?: (payload: {
    token: string;
    user: User;
    tenant: Tenant | null;
    tenants: Tenant[];
  }) => void;
}

/** An emergency call staff sent, a kitchen ticket that did not print, or its printer being ready again. */
export interface KdsAlert {
  id: string;
  kind: 'emergency' | 'kot_unprinted' | 'kot_ready';
  message: string;
  table: string | null;
  sent_by: string | null;
  /** The missing kitchen ticket a `kot_unprinted` or `kot_ready` alert is about. */
  ref?: string | null;
  /** Why the ticket did not print: `paper_out`, `needs_attention`, `offline`, `timeout`, `error`. */
  reason?: string | null;
  created_at: string;
}

export interface UseKdsConnectionResult {
  user: KdsUser | null;
  orders: KdsOrder[];
  /** False until the server has sent this session's orders; the empty list before that is not the kitchen. */
  ordersSynced: boolean;
  alerts: KdsAlert[];
  stations: KdsStation[];
  selectedStation: string;
  selectStation: (id: string) => void;
  counts: Record<string, number>;
  loading: boolean;
  connected: boolean;
  connectionMode: ConnectionMode;
  updating: number | null;
  loginEmail: string;
  loginPassword: string;
  loginError: string;
  loginLoading: boolean;
  rememberMe: boolean;
  pinUsers: KdsPinUser[];
  setLoginEmail: (v: string) => void;
  setLoginPassword: (v: string) => void;
  setLoginError: (v: string) => void;
  setRememberMe: (v: boolean) => void;
  handleLogin: (e: React.FormEvent) => Promise<void>;
  handlePinLogin: (userId: string, pin: string) => Promise<void>;
  handleLogout: () => Promise<void>;
  /** Prints a missing kitchen ticket again; `gone` means it was already printed or dropped. */
  reprintUnprintedKot: (ref: string) => Promise<'printed' | 'gone' | 'failed'>;
  dropUnprintedKot: (ref: string) => Promise<void>;
  /** Moves an item to `status`, or with `outOfStock` set flags or clears it as out of stock instead. */
  updateItemStatus: (
    itemId: number,
    status: KitchenStatus,
    opts?: KdsItemUpdateOptions,
  ) => Promise<boolean>;
  persistViewMode?: (view: 'tabs' | 'kanban') => void;
  api?: AxiosInstance;
  credentialEndpoints?: {
    me: string;
    passwordChange: string;
    pinChange: string;
  };
  replaceSessionToken?: (token: string, hasPin?: boolean) => void;
  ConfirmDialog: ReactNode;
}

/** `outOfStock` flags the dish and `priceEntry` weighs or prices it; either keeps its stage. */
export interface KdsItemUpdateOptions {
  silent?: boolean;
  expectedStatus?: KitchenStatus;
  outOfStock?: boolean;
  priceEntry?: { weight: number } | { price: number };
}

const LOGIN_ENDPOINT = '/auth/login';
const ME_ENDPOINT = '/auth/me';
const ORDERS_ENDPOINT = '/kitchen/orders';
const ITEM_STATUS_ENDPOINT = '/order-items/:itemId/status';
const STATIONS_ENDPOINT = '/kitchen/stations';
const UNPRINTED_KOTS_ENDPOINT = '/kds/unprinted-kots';
const VIEW_ENDPOINT = '/kds/view';
const KDS_AUTH_BLOCKED_KEY = 'flocafe:kds-auth-blocked';
const KDS_STATION_KEY = 'flocafe:kds-station';

function readStoredStation(): string {
  try {
    return typeof window === 'undefined' ? '' : window.localStorage.getItem(KDS_STATION_KEY) || '';
  } catch {
    return '';
  }
}

function storeStation(id: string): void {
  try {
    if (id) window.localStorage.setItem(KDS_STATION_KEY, id);
    else window.localStorage.removeItem(KDS_STATION_KEY);
  } catch {}
}

function isKdsAuthBlocked(): boolean {
  try {
    return window.sessionStorage.getItem(KDS_AUTH_BLOCKED_KEY) === '1';
  } catch {
    return false;
  }
}

function clearKdsAuthBlocked(): void {
  try {
    window.sessionStorage.removeItem(KDS_AUTH_BLOCKED_KEY);
  } catch {}
}

function markKdsAuthBlocked(): void {
  try {
    window.sessionStorage.setItem(KDS_AUTH_BLOCKED_KEY, '1');
  } catch {}
}

export function useKdsConnection(options: UseKdsConnectionOptions): UseKdsConnectionResult {
  const {
    api,
    endpoints,
    enabled,
    onSessionCleared,
    onSessionTokenReplaced,
    onSessionAuthenticated,
  } = options;
  const loginPath = endpoints?.login ?? LOGIN_ENDPOINT;
  const pinUsersPath =
    endpoints?.pinUsers ??
    (loginPath.startsWith('/api/') ? '/api/auth/pin-users' : '/auth/pin-users?scope=kds');
  const pinLoginPath =
    endpoints?.pinLogin ??
    (loginPath.startsWith('/api/') ? '/api/auth/pin-login' : '/auth/pin-login');
  const mePath = endpoints?.me ?? ME_ENDPOINT;
  const logoutPath = endpoints?.logout ?? '/auth/logout';
  const passwordChangePath = loginPath.startsWith('/api/')
    ? '/api/auth/password/change'
    : '/auth/password/change';
  const pinChangePath = loginPath.startsWith('/api/') ? '/api/auth/pin/change' : '/auth/pin/change';
  const ordersPath = endpoints?.orders ?? ORDERS_ENDPOINT;
  const itemStatusPath = endpoints?.itemStatus ?? ITEM_STATUS_ENDPOINT;
  const stationsPath = endpoints?.stations ?? STATIONS_ENDPOINT;
  const unprintedKotsPath = endpoints?.unprintedKots ?? UNPRINTED_KOTS_ENDPOINT;
  const viewPath = endpoints?.view ?? VIEW_ENDPOINT;
  const t = useTranslations('kds');
  const tAuth = useTranslations('auth');
  const tNav = useTranslations('nav');
  const { confirm, ConfirmDialog } = useConfirm();

  const statusLabel = (s: KitchenStatus) => t(STATUS_CONFIG[normalizeKitchenStatus(s)].labelKey);

  const [user, setUser] = useState<KdsUser | null>(null);
  // Each display keeps its station across reloads; the ref is read before the first socket opens.
  const selectedStationRef = useRef(readStoredStation());
  const [orders, setOrdersState] = useState<KdsOrder[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  // Keep initial render deterministic with static server output;
  // cleared asynchronously when no stored session exists.
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>(null);
  const [updating, setUpdating] = useState<number | null>(null);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [alerts, setAlerts] = useState<KdsAlert[]>([]);
  const [ordersSynced, setOrdersSynced] = useState(false);
  // Server data always arrives as a reconcile function; a plain list only ever clears the board.
  const setOrders = (next: SetStateAction<KdsOrder[]>) => {
    setOrdersSynced(typeof next === 'function');
    setOrdersState(next);
  };
  const [pinUsers, setPinUsers] = useState<KdsPinUser[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const restIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const restInitialFetchRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restRequestSequenceRef = useRef(0);
  const restInFlightRequestRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const sessionGenerationRef = useRef(0);
  const kdsDisabledRef = useRef(false);
  const updatingIdsRef = useRef(new Set<number>());
  // Mutable ref allowing reconnect timer to invoke latest tryWebSocket recursively.
  const tryWebSocketRef = useRef<(token: string, retryDuringMaintenance?: boolean) => void>(
    () => {},
  );
  const onSessionClearedRef = useRef(onSessionCleared);
  onSessionClearedRef.current = onSessionCleared;
  const onSessionTokenReplacedRef = useRef(onSessionTokenReplaced);
  onSessionTokenReplacedRef.current = onSessionTokenReplaced;
  const onSessionAuthenticatedRef = useRef(onSessionAuthenticated);
  onSessionAuthenticatedRef.current = onSessionAuthenticated;
  const activeTokenRef = useRef<string | null>(null);
  const clearStoredSession = useCallback((expectedToken?: string | null) => {
    const fallbackToken = expectedToken !== undefined ? expectedToken : activeTokenRef.current;
    const tokenToClear =
      fallbackToken ??
      (typeof window !== 'undefined' ? window.localStorage.getItem('token') : null);
    activeTokenRef.current = null;
    if (
      typeof window !== 'undefined' &&
      tokenToClear &&
      window.localStorage.getItem('token') === tokenToClear
    ) {
      window.localStorage.removeItem('token');
    }
    onSessionClearedRef.current?.(tokenToClear ?? null);
  }, []);

  const stopRestPolling = useCallback(() => {
    if (restIntervalRef.current) {
      clearInterval(restIntervalRef.current);
      restIntervalRef.current = null;
    }
    if (restInitialFetchRef.current) {
      clearTimeout(restInitialFetchRef.current);
      restInitialFetchRef.current = null;
    }
    restRequestSequenceRef.current += 1;
    restInFlightRequestRef.current = null;
  }, []);

  const disableKdsConnection = useCallback(
    (message: string) => {
      kdsDisabledRef.current = true;
      sessionGenerationRef.current += 1;
      stopRestPolling();
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      const activeWs = wsRef.current;
      wsRef.current = null;
      if (activeWs) activeWs.close();
      updatingIdsRef.current.clear();
      setUpdating(null);
      setUser(null);
      setOrders([]);
      setCounts({});
      setConnected(false);
      setConnectionMode(null);
      setLoading(false);
      setLoginError(message);
    },
    [stopRestPolling],
  );

  // Background polls skip active requests; required refreshes supersede them
  // so item updates and conflict recovery fetch fresh state immediately.
  const fetchOrdersRest = useCallback(
    async (options?: { skipIfInFlight?: boolean }) => {
      const generation = sessionGenerationRef.current;
      if (options?.skipIfInFlight && restInFlightRequestRef.current !== null) return;
      const requestSequence = ++restRequestSequenceRef.current;
      restInFlightRequestRef.current = requestSequence;
      try {
        const { data } = await api.get(
          `${ordersPath}?status=pending,preparing,ready,served${selectedStationRef.current ? `&station_id=${encodeURIComponent(selectedStationRef.current)}` : ''}`,
        );
        if (
          generation !== sessionGenerationRef.current ||
          requestSequence !== restRequestSequenceRef.current ||
          (typeof window !== 'undefined' && !window.localStorage.getItem('token'))
        )
          return;
        setOrders((prev) => reconcileKdsOrders(prev, data.orders || []));
        setCounts(data.counts || {});
        setAlerts(data.alerts || []);
        setConnected(true);
      } catch (error: unknown) {
        if (
          generation !== sessionGenerationRef.current ||
          requestSequence !== restRequestSequenceRef.current
        )
          return;
        const axiosError = error as { response?: { status?: number; data?: { error?: string } } };
        const status = axiosError?.response?.status;
        const tokenMissing = typeof window !== 'undefined' && !window.localStorage.getItem('token');
        if (status === 401 || tokenMissing) {
          sessionGenerationRef.current += 1;
          stopRestPolling();
          updatingIdsRef.current.clear();
          setUpdating(null);
          setUser(null);
          setOrders([]);
          setCounts({});
          setConnected(false);
          setConnectionMode(null);
          setLoading(false);
          clearStoredSession();
        } else if (status === 403) {
          const message = axiosError.response?.data?.error || t('authFailed');
          const kdsDisabled = /kds is disabled/i.test(message);
          if (kdsDisabled) {
            disableKdsConnection(message);
            return;
          }
          sessionGenerationRef.current += 1;
          markKdsAuthBlocked();
          stopRestPolling();
          updatingIdsRef.current.clear();
          setUpdating(null);
          setUser(null);
          setLoginError(t('authFailed'));
          setConnectionMode(null);
          setOrders([]);
          setCounts({});
          setConnected(false);
          setLoading(false);
        } else {
          setConnected(false);
        }
      } finally {
        if (restInFlightRequestRef.current === requestSequence)
          restInFlightRequestRef.current = null;
      }
    },
    [api, disableKdsConnection, ordersPath, stopRestPolling, t],
  );
  // Re-starts polling loop; initial fetch is deferred a tick (setTimeout 0)
  // so state updates do not land in the invoking effect commit.
  const startRestPolling = useCallback(() => {
    stopRestPolling();
    restInitialFetchRef.current = setTimeout(() => {
      restInitialFetchRef.current = null;
      void fetchOrdersRest({ skipIfInFlight: true });
    }, 0);
    restIntervalRef.current = setInterval(() => {
      void fetchOrdersRest({ skipIfInFlight: true });
    }, 5000);
  }, [fetchOrdersRest, stopRestPolling]);

  const updateItemStatus = useCallback(
    async (itemId: number, status: KitchenStatus, opts: KdsItemUpdateOptions = {}) => {
      const generation = sessionGenerationRef.current;
      updatingIdsRef.current.add(itemId);
      setUpdating(itemId);
      try {
        await api.patch(
          itemStatusPath.replace(':itemId', String(itemId)),
          opts.priceEntry
            ? opts.priceEntry
            : opts.outOfStock !== undefined
              ? { out_of_stock: opts.outOfStock }
              : {
                  status,
                  ...(opts.expectedStatus ? { expected_status: opts.expectedStatus } : {}),
                },
        );
        // A closed socket stays in wsRef for the reconnect timer, so test readiness, not presence.
        if (
          generation === sessionGenerationRef.current &&
          wsRef.current?.readyState !== WebSocket.OPEN
        ) {
          await fetchOrdersRest();
        }
        if (generation === sessionGenerationRef.current && !opts.silent) {
          toast.success(
            opts.priceEntry
              ? Object.hasOwn(opts.priceEntry, 'price')
                ? t('priceEntrySaved')
                : t('weightEntrySaved')
              : opts.outOfStock === undefined
                ? t('itemMarked', { status: statusLabel(status) })
                : t(opts.outOfStock ? 'outOfStockSent' : 'outOfStockCleared'),
          );
        }
        return true;
      } catch (error: unknown) {
        if (generation !== sessionGenerationRef.current) return false;
        const axiosError = error as { response?: { status?: number; data?: { error?: string } } };
        const statusCode = axiosError.response?.status;
        const errorMessage = axiosError.response?.data?.error || t('failedToUpdateItem');
        const kdsDisabled = /kds is disabled/i.test(errorMessage);
        if (statusCode === 409) {
          await fetchOrdersRest();
          if (!opts.silent) toast.error(t('failedToUpdateItem'));
          return false;
        }
        const authorizationFailure =
          /invalid|expired|revoked|authentication required|no active kitchen station|only chef|only kitchen staff|user account is not active|not authorized to update (this item|this station)/i.test(
            errorMessage,
          );
        if (statusCode === 401 || (statusCode === 403 && !kdsDisabled && authorizationFailure)) {
          sessionGenerationRef.current += 1;
          if (statusCode === 401) clearStoredSession();
          else markKdsAuthBlocked();
          stopRestPolling();
          if (reconnectTimerRef.current) {
            clearTimeout(reconnectTimerRef.current);
            reconnectTimerRef.current = null;
          }
          if (wsRef.current) {
            wsRef.current.close();
            wsRef.current = null;
          }
          updatingIdsRef.current.clear();
          setUpdating(null);
          setUser(null);
          setOrders([]);
          setCounts({});
          setConnected(false);
          setConnectionMode(null);
          setLoading(false);
          setLoginError(t('authFailed'));
          return false;
        }
        if (kdsDisabled) {
          disableKdsConnection(errorMessage);
          return false;
        }
        if (!opts.silent) {
          toast.error(t('failedToUpdateItem'));
        }
        return false;
      } finally {
        updatingIdsRef.current.delete(itemId);
        if (generation === sessionGenerationRef.current) {
          setUpdating(updatingIdsRef.current.values().next().value ?? null);
        }
      }
    },
    // statusLabel is derived from `t` (already in deps), so omit it.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [api, disableKdsConnection, fetchOrdersRest, itemStatusPath, stopRestPolling, t],
  );

  const tryWebSocket = useCallback(
    (token: string, retryDuringMaintenance = false) => {
      if (!enabled || kdsDisabledRef.current) return;
      const generation = sessionGenerationRef.current;
      if (wsRef.current) {
        wsRef.current.close();
      }

      const apiBase = api.defaults.baseURL || '';
      // Derive WS host from axios baseURL so dev proxy reaches correct backend;
      // falls back to page origin.
      let wsHost = window.location.host;
      try {
        if (apiBase) {
          const u = new URL(apiBase, window.location.origin);
          if (u.host) wsHost = u.host;
        }
      } catch {
        // ignore — keep window.location.host fallback
      }
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${wsHost}/kds`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      let connectionTimeout: ReturnType<typeof setTimeout> | null = null;
      let authTimeout: ReturnType<typeof setTimeout> | null = null;
      let authenticated = false;

      const cleanup = () => {
        if (connectionTimeout) clearTimeout(connectionTimeout);
        if (authTimeout) clearTimeout(authTimeout);
      };

      ws.onopen = () => {
        if (wsRef.current !== ws || generation !== sessionGenerationRef.current) {
          ws.close();
          return;
        }
        cleanup();
        if (wsRef.current === ws && reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = null;
        }
        setConnectionMode('websocket');
        setConnected(false);
        ws.send(JSON.stringify({ type: 'auth', token, station_id: selectedStationRef.current }));
        authTimeout = setTimeout(() => {
          if (wsRef.current !== ws || generation !== sessionGenerationRef.current) return;
          wsRef.current = null;
          ws.close();
          setConnected(false);
          setConnectionMode('rest');
          setLoading(false);
        }, 5000);
      };

      ws.onclose = (event) => {
        cleanup();
        if (wsRef.current !== ws || generation !== sessionGenerationRef.current) return;
        if (/kds is disabled/i.test(event.reason)) {
          disableKdsConnection(event.reason);
          return;
        }
        if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
        setConnected(false);
        setConnectionMode('rest');
        setLoading(false);
        if (!authenticated) {
          if (retryDuringMaintenance) {
            const delay = kdsReconnectDelay(reconnectAttemptRef.current++);
            reconnectTimerRef.current = setTimeout(() => {
              if (
                generation === sessionGenerationRef.current &&
                window.localStorage.getItem('token') === token
              ) {
                tryWebSocketRef.current(token, true);
              }
            }, delay);
          }
          return;
        }
        const delay = kdsReconnectDelay(reconnectAttemptRef.current++);
        reconnectTimerRef.current = setTimeout(() => {
          if (wsRef.current === ws && generation === sessionGenerationRef.current) {
            tryWebSocketRef.current(token);
          }
        }, delay);
      };

      ws.onerror = () => {
        if (wsRef.current === ws && generation === sessionGenerationRef.current) ws.close();
      };

      ws.onmessage = (event) => {
        if (wsRef.current !== ws || generation !== sessionGenerationRef.current) return;
        try {
          const msg: WsMessage = JSON.parse(event.data);
          if (msg.type === 'auth_success' && msg.user) {
            authenticated = true;
            reconnectAttemptRef.current = 0;
            // Invalidate any in-flight REST response before accepting WebSocket snapshot.
            stopRestPolling();
            if (authTimeout) {
              clearTimeout(authTimeout);
              authTimeout = null;
            }
            setUser((prev) => (prev ? { ...prev, ...msg.user, token: prev.token } : null));
            const pickedStation = selectedStationRef.current;
            if (
              pickedStation &&
              (msg.user.stationIds?.length !== 1 || msg.user.stationIds[0] !== pickedStation)
            ) {
              selectedStationRef.current = '';
              setSelectedStation('');
              storeStation('');
            }
            const authOrders = msg.orders;
            if (authOrders) setOrders((prev) => reconcileKdsOrders(prev, authOrders));
            setCounts(msg.counts || {});
            setConnected(true);
            setLoading(false);
          } else if (msg.type === 'auth_error') {
            if (wsRef.current !== ws) return;
            if (authTimeout) {
              clearTimeout(authTimeout);
              authTimeout = null;
            }
            const maintenanceInProgress = /database maintenance/i.test(msg.message || '');
            const kdsDisabled = /kds is disabled/i.test(msg.message || '');
            if (kdsDisabled) {
              disableKdsConnection(msg.message || t('authFailed'));
              return;
            }
            const temporaryUnavailable = maintenanceInProgress;
            const authorizationFailure =
              /user not found|only kitchen staff|no active kitchen station|could not load station permissions/i.test(
                msg.message || '',
              );
            const invalidSession = /invalid|expired|revoked|authentication required/i.test(
              msg.message || '',
            );
            sessionGenerationRef.current += 1;
            setLoginError(maintenanceInProgress ? '' : msg.message || t('authFailed'));
            if (wsRef.current === ws) wsRef.current = null;
            if (reconnectTimerRef.current) {
              clearTimeout(reconnectTimerRef.current);
              reconnectTimerRef.current = null;
            }
            stopRestPolling();
            updatingIdsRef.current.clear();
            setUpdating(null);
            if (!temporaryUnavailable) setUser(null);
            setOrders([]);
            setCounts({});
            setConnected(false);
            setConnectionMode(null);
            if (authorizationFailure) markKdsAuthBlocked();
            if (invalidSession) clearStoredSession(token);
            if (temporaryUnavailable) {
              setLoading(true);
              const delay = kdsReconnectDelay(reconnectAttemptRef.current++);
              reconnectTimerRef.current = setTimeout(() => {
                if (
                  generation + 1 === sessionGenerationRef.current &&
                  window.localStorage.getItem('token') === token
                ) {
                  tryWebSocketRef.current(token, true);
                }
              }, delay);
            }
            ws.close();
            setLoading(temporaryUnavailable);
          } else if ((msg.type === 'initial_data' || msg.type === 'orders') && msg.orders) {
            const incomingOrders = msg.orders;
            setOrders((prev) => reconcileKdsOrders(prev, incomingOrders));
            setCounts(msg.counts || {});
            setAlerts(msg.alerts || []);
            setConnected(true);
            if (msg.type === 'initial_data') setLoading(false);
          }
        } catch (e) {
          console.error('Failed to parse message', e);
        }
      };

      connectionTimeout = setTimeout(() => {
        if (
          ws.readyState === WebSocket.CONNECTING &&
          wsRef.current === ws &&
          generation === sessionGenerationRef.current
        ) {
          if (wsRef.current === ws) wsRef.current = null;
          ws.close();
          setConnectionMode('rest');
          setLoading(false);
        }
      }, 5000);
    },
    [t, api, disableKdsConnection, enabled, stopRestPolling],
  );
  useEffect(() => {
    tryWebSocketRef.current = tryWebSocket;
  }, [tryWebSocket]);

  /** Persists a successful KDS login, syncs shared dashboard state, and connects WebSocket. */
  const completeAuthenticatedLogin = useCallback(
    (data: {
      access_token?: string;
      token?: string;
      user: User & { role?: string };
      tenant?: Tenant | null;
      tenants?: Tenant[];
    }) => {
      const token = data.access_token ?? data.token;
      if (!token) return;
      const loggedInUser: KdsUser = {
        id: String(data.user.id),
        name: data.user.name,
        role: String(data.user.role ?? ''),
        token,
        has_pin: typeof data.user.has_pin === 'boolean' ? data.user.has_pin : undefined,
      };

      activeTokenRef.current = token;
      setUser(loggedInUser);
      window.localStorage.setItem('token', token);
      const tenant =
        data.tenant ??
        (Array.isArray(data.tenants) && data.tenants.length > 0 ? data.tenants[0] : null);
      const tenants = Array.isArray(data.tenants) ? data.tenants : tenant ? [tenant] : [];
      if (data.user) {
        try {
          window.localStorage.setItem('user', JSON.stringify(data.user));
        } catch {}
      }
      if (tenant) {
        try {
          window.localStorage.setItem('tenant', JSON.stringify(tenant));
        } catch {}
      }
      onSessionAuthenticatedRef.current?.({
        token,
        user: data.user,
        tenant,
        tenants,
      });
      tryWebSocket(token);
    },
    [tryWebSocket],
  );

  /** Authenticates KDS using email and password credentials. */
  const handleLogin = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!enabled || kdsDisabledRef.current) return;
      clearKdsAuthBlocked();
      setLoginError('');
      sessionGenerationRef.current += 1;
      const generation = sessionGenerationRef.current;
      setLoginLoading(true);
      setLoading(true);

      try {
        const { data } = await api.post(loginPath, {
          email: loginEmail,
          password: loginPassword,
          rememberMe,
        });

        if (generation !== sessionGenerationRef.current) return;
        completeAuthenticatedLogin(data);
      } catch {
        if (generation !== sessionGenerationRef.current) return;
        setLoginError(t('loginFailed'));
      } finally {
        if (generation === sessionGenerationRef.current) {
          setLoginLoading(false);
          setLoading(false);
        }
      }
    },
    [loginEmail, loginPassword, rememberMe, loginPath, api, t, completeAuthenticatedLogin, enabled],
  );

  /** Authenticates KDS using a staff quick-switch PIN. */
  const handlePinLogin = useCallback(
    async (userId: string, pin: string) => {
      if (!enabled || kdsDisabledRef.current) return;
      clearKdsAuthBlocked();
      setLoginError('');
      sessionGenerationRef.current += 1;
      const generation = sessionGenerationRef.current;
      setLoginLoading(true);

      try {
        const { data } = await api.post(pinLoginPath, {
          user_id: userId,
          pin,
          rememberMe,
        });

        if (generation !== sessionGenerationRef.current) return;
        completeAuthenticatedLogin(data);
      } catch (error: unknown) {
        if (generation === sessionGenerationRef.current) {
          const failure = parseLoginFailure(error);
          let msg = failure.message || t('loginFailed');
          if (failure.status === 401) {
            const remaining = failure.attemptsRemaining;
            if (remaining === 0) {
              msg = tAuth('lockedOut', { minutes: failure.lockoutMinutes ?? 15 });
            } else if (typeof remaining === 'number' && remaining < 4) {
              msg = `${tAuth('invalidCredentials')} ${tAuth('attemptsRemaining', { count: remaining })}`;
            } else {
              msg = tAuth('invalidCredentials');
            }
          } else if (failure.status === 429) {
            msg = tAuth('lockedOut', { minutes: failure.lockoutMinutes ?? 15 });
          } else if (failure.status === undefined) {
            msg = tAuth('connectionFailed');
          }
          setLoginError(msg);
        }
        throw error;
      } finally {
        if (generation === sessionGenerationRef.current) {
          setLoginLoading(false);
        }
      }
    },
    [rememberMe, pinLoginPath, api, t, tAuth, completeAuthenticatedLogin, enabled],
  );

  const handleLogout = useCallback(async () => {
    if (!(await confirm(tNav('confirmLogout')))) return;
    sessionGenerationRef.current += 1;
    const logoutGeneration = sessionGenerationRef.current;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    const activeWs = wsRef.current;
    wsRef.current = null;
    if (activeWs) activeWs.close();
    const token = user?.token || window.localStorage.getItem('token') || activeTokenRef.current;
    if (token) {
      try {
        await api.post(logoutPath, undefined, { headers: { Authorization: `Bearer ${token}` } });
      } catch {
        // Local logout must still complete if the server is offline.
      }
    }
    if (logoutGeneration !== sessionGenerationRef.current) return;
    stopRestPolling();
    updatingIdsRef.current.clear();
    setUpdating(null);
    selectedStationRef.current = '';
    setSelectedStation('');
    setUser(null);
    setOrders([]);
    setCounts({});
    setConnected(false);
    setConnectionMode(null);
    clearStoredSession(token ?? null);
  }, [api, clearStoredSession, confirm, logoutPath, stopRestPolling, tNav, user]);

  const persistViewMode = useCallback(
    (view: 'tabs' | 'kanban') => {
      if (!enabled || kdsDisabledRef.current) return;
      if (typeof api.put === 'function') {
        void api.put(viewPath, { kds_default_view: view }).catch(() => {});
      }
    },
    [api, enabled, viewPath],
  );

  const replaceSessionToken = useCallback((nextToken: string, hasPin?: boolean) => {
    if (!nextToken) return;
    activeTokenRef.current = nextToken;
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('token', nextToken);
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    sessionGenerationRef.current += 1;
    const activeWs = wsRef.current;
    wsRef.current = null;
    if (activeWs) activeWs.close();
    setUser((prev) =>
      prev
        ? {
            ...prev,
            token: nextToken,
            ...(hasPin !== undefined ? { has_pin: hasPin } : {}),
          }
        : prev,
    );
    onSessionTokenReplacedRef.current?.(nextToken, hasPin);
    tryWebSocketRef.current(nextToken);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!enabled) {
      const disabledTimer = window.setTimeout(() => setLoading(false), 0);
      return () => window.clearTimeout(disabledTimer);
    }
    const savedToken = window.localStorage.getItem('token');
    if (!savedToken || isKdsAuthBlocked()) {
      const resetTimer = window.setTimeout(() => setLoading(false), 0);
      return () => window.clearTimeout(resetTimer);
    }
    const generation = sessionGenerationRef.current;
    api
      .get(mePath)
      .then(({ data }) => {
        if (
          generation !== sessionGenerationRef.current ||
          window.localStorage.getItem('token') !== savedToken
        )
          return;
        activeTokenRef.current = savedToken;
        setUser({
          id: data.user.id,
          name: data.user.name,
          role: data.user.role,
          token: savedToken,
          has_pin: typeof data.user.has_pin === 'boolean' ? data.user.has_pin : undefined,
        });
        tryWebSocket(savedToken);
      })
      .catch((error: unknown) => {
        if (
          generation !== sessionGenerationRef.current ||
          window.localStorage.getItem('token') !== savedToken
        )
          return;
        const axiosError = error as { response?: { status?: number; data?: { error?: string } } };
        const status = axiosError?.response?.status;
        if (status === 401) {
          sessionGenerationRef.current += 1;
          stopRestPolling();
          updatingIdsRef.current.clear();
          setUpdating(null);
          setUser(null);
          setOrders([]);
          setCounts({});
          setConnected(false);
          setConnectionMode(null);
          clearStoredSession(savedToken);
        } else if (status === 403) {
          sessionGenerationRef.current += 1;
          markKdsAuthBlocked();
          stopRestPolling();
          updatingIdsRef.current.clear();
          setUpdating(null);
          setUser(null);
          setOrders([]);
          setCounts({});
          setConnected(false);
          setConnectionMode(null);
          setLoginError(t('authFailed'));
        }
        setLoading(false);
      });

    return () => {
      sessionGenerationRef.current += 1;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      stopRestPolling();
    };
  }, [api, mePath, tryWebSocket, stopRestPolling, t, enabled]);

  useEffect(() => {
    if (enabled && connectionMode === 'rest' && user) {
      startRestPolling();
    }
    return () => stopRestPolling();
  }, [connectionMode, user, startRestPolling, stopRestPolling, enabled]);

  const [selectedStation, setSelectedStation] = useState('');
  useEffect(() => setSelectedStation(selectedStationRef.current), []);
  const [stations, setStations] = useState<KdsStation[]>([]);
  const userId = user?.id;
  useEffect(() => {
    if (!enabled || !userId) {
      setStations([]);
      return;
    }
    let cancelled = false;
    api
      .get(stationsPath)
      .then(({ data }) => {
        if (!cancelled) setStations(Array.isArray(data?.stations) ? data.stations : []);
      })
      .catch(() => {
        if (!cancelled) setStations([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api, stationsPath, enabled, userId]);

  const reprintUnprintedKot = useCallback(
    async (ref: string): Promise<'printed' | 'gone' | 'failed'> => {
      try {
        await api.post(`${unprintedKotsPath}/${encodeURIComponent(ref)}/reprint`);
        return 'printed';
      } catch (error: unknown) {
        const status = (error as { response?: { status?: number } }).response?.status;
        return status === 404 ? 'gone' : 'failed';
      }
    },
    [api, unprintedKotsPath],
  );

  const dropUnprintedKot = useCallback(
    async (ref: string) => {
      try {
        await api.delete(`${unprintedKotsPath}/${encodeURIComponent(ref)}`);
      } catch {}
    },
    [api, unprintedKotsPath],
  );

  const selectStation = (id: string) => {
    selectedStationRef.current = id;
    setSelectedStation(id);
    storeStation(id);
    sessionGenerationRef.current += 1;
    restRequestSequenceRef.current += 1;
    stopRestPolling();
    setOrders([]);
    setCounts({});
    setAlerts([]);
    setConnected(false);
    setConnectionMode(null);
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    const token = user?.token;
    if (token) tryWebSocket(token);
  };

  useEffect(() => {
    if (typeof window === 'undefined' || !enabled || user || loading) return;
    let cancelled = false;
    api
      .get(pinUsersPath)
      .then((res) => {
        if (!cancelled && Array.isArray(res.data?.users)) {
          setPinUsers(res.data.users);
        }
      })
      .catch(() => {
        if (!cancelled) setPinUsers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api, pinUsersPath, enabled, user, loading]);

  return {
    user,
    orders,
    ordersSynced,
    alerts,
    stations,
    selectedStation,
    selectStation,
    counts,
    loading,
    connected,
    connectionMode,
    updating,
    loginEmail,
    loginPassword,
    loginError,
    loginLoading,
    rememberMe,
    pinUsers,
    setLoginEmail,
    setLoginPassword,
    setLoginError,
    setRememberMe,
    handleLogin,
    handlePinLogin,
    handleLogout,
    reprintUnprintedKot,
    dropUnprintedKot,
    updateItemStatus,
    persistViewMode,
    api,
    credentialEndpoints: {
      me: mePath,
      passwordChange: passwordChangePath,
      pinChange: pinChangePath,
    },
    replaceSessionToken,
    ConfirmDialog,
  };
}
