'use client';

import axios, { AxiosInstance, type AxiosResponse } from 'axios';
import dynamic from 'next/dynamic';
import toast from 'react-hot-toast';
import {
  ArrowRightLeft,
  LayoutGrid,
  Minus,
  Plus,
  QrCode,
  Send,
  ShoppingCart,
  Smartphone,
  SquarePen,
  Trash2,
  UserRound,
  UtensilsCrossed,
  MoreVertical,
  ArrowLeftRight,
  Merge,
  Clock,
} from 'lucide-react';
import { Drawer, DrawerContent, DrawerTrigger } from '@/components/ui/drawer';
import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useSyncServerLanguage, writeLanguageOverride } from '@/lib/i18n';
import type { Language } from '@/lib/i18n/languages';
import { usePosSettingsStore } from '@/store/pos-settings';
import { ServerAppHeader } from '@/components/server-app/ServerAppHeader';
import { StaffSignIn } from '@/components/server-app/StaffSignIn';
import { GuestOrderHistory, type GuestOrder } from '@/components/server-app/GuestOrderHistory';
import { useReloadOnNewBuild } from '@/hooks/useReloadOnNewBuild';
import { holdDarkClass } from '@/lib/kds-screen-mode';
import { useTranslations } from 'use-intl';
import { Ltr } from '@/components/layout/Ltr';
import { StoreClock } from '@/components/layout/StoreClock';
import GuestAlerts from '@/components/tables/GuestAlerts';
import {
  OrderedItemList,
  OrderedItemsScreen,
  TableKitchenSummary,
  type OrderedItem,
} from '@/components/server-app/OrderedItems';
import { isCancelledItem } from '@/components/server-app/ItemStatus';
import {
  TableTransferDialog,
  type TransferMode,
  type TransferTable,
} from '@/components/server-app/TableTransferDialog';
import { toastApiError } from '@/lib/api-error';
import { parseDbTimestamp } from '@/lib/utils';
import { formatCurrencyForTenant } from '@/lib/countries';
import { createPaymentIdempotencyKey } from '@/lib/payment-idempotency';
import { generateCartItemId } from '@/lib/cart-identity';
import { productNeedsCustomizer, scannedVariantNeedsCustomizer } from '@/lib/product-variants';
import AddonModal from '@/components/pos/AddonModal';
import ProductGrid, { type QuickFilter } from '@/components/pos/ProductGrid';
import { hasTag } from '@/components/pos/DietaryBadge';
import type { PosCategorySort, PosItemSort } from '@/lib/pos-sort';
import { tenantCan } from '@/lib/permissions';
import type {
  Table as FullTable,
  Tenant,
  Product,
  Addon,
  CartItem,
  Category,
  ProductVariant,
} from '@/lib/types';
import { cartItemToOrderItem } from '@/lib/cart-order-item';
import { playSoundFile, unlockKdsAlertSound } from '@/lib/kds-alert-sound';

const SERVE_CONFIRM_BELL = '/sounds/serve-confirm-bell.wav';

type User = { id: string; name: string; email: string; role: string; permission_ids?: string[] };
type Table = {
  id: string;
  name?: string;
  number?: string;
  status?: string;
  owner_user_id?: string | null;
  activeOrder?: Order | null;
  current_order?: Order | null;
};
type OrderItem = {
  id: number;
  product_id?: string | number;
  created_at?: string;
  product_name: string;
  quantity: number;
  status: string;
  special_instructions?: string | null;
  variant_selection?: unknown;
  service_change?: string | null;
  served_confirmed_at?: string | null;
};
type Order = {
  id: number;
  order_number: string;
  table_id?: string | null;
  status: string;
  total?: number;
  items?: OrderItem[];
  customer?: { id: string; name: string; phone?: string } | null;
  /** Menu lines still waiting or cooking, ready to serve, and served. */
  kitchen_counts?: { waiting: number; ready: number; served: number };
  bill_requested_at?: string | null;
  bill_payment_received_at?: string | null;
  /** The cashier tried to print the bill before every item was confirmed served. */
  serve_confirm_requested_at?: string | null;
};
type DraftLine = CartItem;
type ServerAppInfo = {
  country: string;
  currency: string;
  currency_symbol: string;
  currency_position: 'prefix' | 'suffix';
  currency_fraction_digits: number;
  timezone?: string;
  server_time?: string;
  business_name?: string;
  store_logo_version?: string | null;
  store_cover_version?: string | null;
  category_sort?: PosCategorySort;
  item_sort?: PosItemSort;
};

// Staff-only dialogs load on first use so a guest phone does not download their printing code.
const GuestTableQrDialog = dynamic(() => import('@/components/tables/GuestTableQrDialog'), {
  ssr: false,
});
const MoveTableModal = dynamic(() => import('@/components/tables/MoveTableModal'), { ssr: false });

const TOKEN_KEY = 'flocafe:server-app-token';
const LANGUAGE_KEY = 'flocafe:server-app-language';
const LIVE_REFRESH_MS = 5000;
const GUEST_MENU_PREFETCH_MAX_AGE_MS = 30_000;

type Settled<T> = { response: T; error: null } | { response: null; error: unknown };
const settle = <T,>(request: Promise<T>): Promise<Settled<T>> =>
  request.then(
    (response) => ({ response, error: null }),
    (error: unknown) => ({ response: null, error }),
  );

type GuestJoinBody = {
  table_id: string;
  device_token?: string;
  table_token?: string;
  sticker?: string;
  unlock_key?: string;
};

const guestJoinBody = (
  tableId: string,
  storedDevice: string | null,
  tableToken: string | null,
  sticker: string | null,
  unlockKey: string | null,
): GuestJoinBody => ({
  table_id: tableId,
  device_token: storedDevice ?? undefined,
  table_token: tableToken ?? undefined,
  sticker: sticker ?? undefined,
  unlock_key: unlockKey ?? undefined,
});

const subscribeToNothing = () => () => {};

// Tablets and computers: the current ticket sits beside the menu.
const WIDE_QUERY = '(min-width: 768px)';
function subscribeToWide(onChange: () => void) {
  const media = window.matchMedia(WIDE_QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

function createApi(): AxiosInstance {
  const api = axios.create({ baseURL: window.location.origin, timeout: 10000 });
  api.interceptors.request.use((config) => {
    const token = localStorage.getItem(TOKEN_KEY);
    if (token && !config.headers.Authorization) config.headers.Authorization = `Bearer ${token}`;
    return config;
  });
  api.interceptors.response.use(
    (response) => response,
    (error) => {
      const sentAuth = error.config?.headers?.Authorization;
      const currentToken = localStorage.getItem(TOKEN_KEY);
      if (error.response?.status === 401 && currentToken && sentAuth === `Bearer ${currentToken}`) {
        localStorage.removeItem(TOKEN_KEY);
      }
      return Promise.reject(error);
    },
  );
  return api;
}

function money(value: number | string, regional: ServerAppInfo | null) {
  return formatCurrencyForTenant(
    Number(value || 0),
    regional?.country || '',
    regional?.currency || '',
  );
}

type SendSnapshot = {
  tableId: string;
  requestTableId?: string;
  tableName: string | undefined;
  orderId: number | null;
  orderCustomer: Order['customer'] | null;
  existingItemIds: Set<number>;
  draftLines: DraftLine[];
  customerName: string;
  customerPhone: string;
  orderNotes: string;
};

function sendAttemptSignature(
  tableId: string,
  draft: DraftLine[],
  customerName: string,
  customerPhone: string,
  orderNotes: string,
): string {
  const items = draft.map((line) => `${line.id}:${line.quantity}`).join('|');
  return `${tableId}|${items}|${customerName.trim()}|${customerPhone.trim()}|${orderNotes.trim()}`;
}

/** Staff who own tables see only those; everyone else sees every table. Ownership never restricts ordering. */
/** A table whose bill is printed waits for the cashier and takes no more orders. */
function awaitingPayment(order: Order | null | undefined): boolean {
  return Boolean(order?.bill_requested_at && !order.bill_payment_received_at);
}

function ownedOrAllTables<T extends { owner_user_id?: string | null }>(
  tables: T[],
  userId: string | undefined,
  areaOnly: boolean,
): T[] {
  const owned = userId ? tables.filter((table) => table.owner_user_id === userId) : [];
  return areaOnly || owned.length > 0 ? owned : tables;
}

/** A table QR opens this app with `?table=<id>`; otherwise the first table the staff member sees is selected. */
/** A table named in the link (`?table=`); staff otherwise pick the table for every order. */
function pickLinkedTable<T extends { id: string }>(tables: T[]): T | undefined {
  if (typeof window === 'undefined') return undefined;
  const wanted = new URLSearchParams(window.location.search).get('table');
  return wanted ? tables.find((table) => table.id === wanted) : undefined;
}

const guestDeviceStorageKey = (tableId: string) => `flocafe:guest-device:${tableId}`;
const guestOrderStorageKey = (tableId: string) => `flocafe:guest-order:${tableId}`;
const guestOrderJson = { headers: { 'Content-Type': 'application/json' } };
const guestOrderStatusPath = '/api/guest/order/status';

function readGuestDevice(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeGuestDevice(key: string, token: string): void {
  try {
    localStorage.setItem(key, token);
  } catch {}
}

function removeGuestDevice(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {}
}

export default function ServerStandalonePage() {
  // Syncs tenant language preference from /api/server-app/info.
  useSyncServerLanguage('/api/server-app/info', LANGUAGE_KEY);
  const language = usePosSettingsStore((s) => s.language);
  const setLanguage = usePosSettingsStore((s) => s.setLanguage);
  const chooseLanguage = (next: Language) => {
    writeLanguageOverride(LANGUAGE_KEY, next);
    setLanguage(next);
  };
  const t = useTranslations('serverApp');
  const tAuth = useTranslations('auth');
  const tTables = useTranslations('tables');
  const tCommon = useTranslations('common');
  const tNav = useTranslations('nav');
  const tPos = useTranslations('pos');

  // Fall back to caller-supplied localized message for server-app errors without dotted error codes.
  const apiErrorT = (key: string): string => key;
  const api = useMemo(() => (typeof window !== 'undefined' ? createApi() : null), []);
  const [loading, setLoading] = useState(true);
  const [loginLoading, setLoginLoading] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [user, setUser] = useState<User | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [tablePickerOpen, setTablePickerOpen] = useState(true);
  const [orderedItemsOpen, setOrderedItemsOpen] = useState(false);
  const [ticketMenuOpen, setTicketMenuOpen] = useState(false);
  const [transferMode, setTransferMode] = useState<TransferMode | null>(null);
  const [transferring, setTransferring] = useState(false);
  const isWide = useSyncExternalStore(
    subscribeToWide,
    () => window.matchMedia(WIDE_QUERY).matches,
    () => false,
  );
  // A tablet always shows its tables beside the menu; a phone opens on them and toggles them with Select Table.
  const showTablePicker = Boolean(user) && (tablePickerOpen || isWide);
  const staffAreaOnly = useSyncExternalStore(
    subscribeToNothing,
    () => new URLSearchParams(window.location.search).get('staff') === 'area',
    () => false,
  );
  useEffect(() => {
    document.documentElement.classList.add('theme-server-app');
    return () => document.documentElement.classList.remove('theme-server-app');
  }, []);
  // undefined while rendering on the server; null when the address carries no QR table.
  const guestTableId = useSyncExternalStore(
    subscribeToNothing,
    () => new URLSearchParams(window.location.search).get('table'),
    () => undefined,
  );
  const guestTableToken = useSyncExternalStore(
    subscribeToNothing,
    () => new URLSearchParams(window.location.search).get('t'),
    () => null,
  );
  // A permanent table sticker: a tap joins the table's open session, or asks staff to open it.
  const guestSticker = useSyncExternalStore(
    subscribeToNothing,
    () => new URLSearchParams(window.location.search).get('s'),
    () => null,
  );
  const guestMenuPrefetchRef = useRef<{
    startedAt: number;
    request: Promise<Settled<AxiosResponse>>;
    join: { key: string; request: Promise<Settled<AxiosResponse>> } | null;
  } | null>(null);
  const [guestTable, setGuestTable] = useState<{ id: string; name: string } | null>(null);
  const [guestDeviceToken, setGuestDeviceToken] = useState<string | null>(null);
  const [guestOrder, setGuestOrder] = useState<GuestOrder | null>(null);
  const [guestOrderLoaded, setGuestOrderLoaded] = useState(false);
  const [guestHistoryOpen, setGuestHistoryOpen] = useState(false);
  const [guestGate, setGuestGate] = useState<{
    kind: 'tap' | 'waiting' | 'declined';
    table: { id: string; name: string };
  } | null>(null);
  const [guestTapped, setGuestTapped] = useState(false);
  const [guestJoinRound, setGuestJoinRound] = useState(0);
  const guestUnlockKeyRef = useRef<string | null>(null);
  const [guestChecked, setGuestChecked] = useState(false);
  const [guestClosed, setGuestClosed] = useState(false);
  const [guestExpired, setGuestExpired] = useState(false);
  const [tableQrOpen, setTableQrOpen] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const guestAttemptRef = useRef<{ signature: string; key: string } | null>(null);
  const [guestDeliveryStatus, setGuestDeliveryStatus] = useState<
    { kind: 'queued' | 'review' | 'failed' } | { kind: 'received'; orderNumber: string } | null
  >(null);
  const [regional, setRegional] = useState<ServerAppInfo | null>(null);

  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const productImageOf = useMemo(() => {
    const byId = new Map(products.map((product) => [String(product.id), product]));
    return (item: OrderedItem): string | null => {
      const product = byId.get(String(item.product_id ?? ''));
      if (!product?.has_image) return null;
      const version = product.updated_at ? parseDbTimestamp(product.updated_at).getTime() : 0;
      return `${window.location.origin}/api/products/${product.id}/image?t=${version}`;
    };
  }, [products]);
  // Best sellers of the last 30 days; staff only, so a guest at a QR table sees no popular filter.
  const [popularIds, setPopularIds] = useState<string[] | null>(null);
  const [tables, setTables] = useState<Table[]>([]);
  const staffTables = ownedOrAllTables(tables, user?.id, staffAreaOnly);
  // Tables whose bill the cashier could not print yet: every item must be confirmed served first.
  const serveConfirmTables = user
    ? staffTables.filter(
        (table) => (table.activeOrder || table.current_order)?.serve_confirm_requested_at,
      )
    : [];
  // Each new serve-confirmation request rings the bell on the phones that see that table.
  const serveConfirmKeys = serveConfirmTables
    .map(
      (table) =>
        `${table.id}|${(table.activeOrder || table.current_order)?.serve_confirm_requested_at}`,
    )
    .join(',');
  const serveConfirmRungRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const keys = serveConfirmKeys ? serveConfirmKeys.split(',') : [];
    const fresh = keys.some((key) => !serveConfirmRungRef.current.has(key));
    serveConfirmRungRef.current = new Set(keys);
    if (fresh) void playSoundFile(SERVE_CONFIRM_BELL);
  }, [serveConfirmKeys]);
  useEffect(() => {
    window.addEventListener('pointerdown', unlockKdsAlertSound);
    window.addEventListener('keydown', unlockKdsAlertSound);
    return () => {
      window.removeEventListener('pointerdown', unlockKdsAlertSound);
      window.removeEventListener('keydown', unlockKdsAlertSound);
    };
  }, []);
  const [tablesLoaded, setTablesLoaded] = useState(false);
  const [selectedTableId, setSelectedTableId] = useState<string>('');
  const [orderLoadedTableId, setOrderLoadedTableId] = useState<string>('');
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<DraftLine[]>([]);
  const [orderNotes, setOrderNotes] = useState('');
  const [addonModalProduct, setAddonModalProduct] = useState<Product | null>(null);
  const [addonModalQuantity, setAddonModalQuantity] = useState(1);
  const [addonModalVariant, setAddonModalVariant] = useState<ProductVariant | null>(null);
  const [editingDraftLine, setEditingDraftLine] = useState<DraftLine | null>(null);
  const [mobileCartOpen, setMobileCartOpen] = useState(false);
  const [moveTableModalOpen, setMoveTableModalOpen] = useState(false);
  const [currentOrder, setCurrentOrder] = useState<Order | null>(null);
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [, setCustomerMatch] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [, setCustomerSearched] = useState(false);
  const phoneDebounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const tablePickerRef = useRef<HTMLElement>(null);
  // Set when the cart sent the server to pick a table, so the cart comes back ready to send.
  const reopenCartAfterTableRef = useRef(false);
  const phoneAbortRef = useRef<AbortController | null>(null);
  const [sending, setSending] = useState(false);
  // Synchronous re-entry guard: `sending` state updates too late to stop a second click fired before the first render.
  const sendInFlightRef = useRef(false);
  // Nonce and frozen target snapshot for the pending send attempt, paired with a signature of what defines it.
  // Reused while retrying that exact same attempt so a lost create response cannot switch to append on retry.
  const sendAttemptRef = useRef<{
    signature: string;
    nonce: string;
    snapshot: SendSnapshot;
  } | null>(null);
  const sendSeqRef = useRef(0);
  const addonModalSendSeqRef = useRef(0);
  // The phone's ticket sheet would cover the edit dialog, so it steps aside and comes back after.
  const reopenCartAfterEditRef = useRef(false);
  const editingDraftSendSeqRef = useRef(0);
  const selectedTableIdRef = useRef('');
  // The linked table is applied once; after an order is sent the table is cleared for the next one.
  const linkedTableAppliedRef = useRef(false);
  const orderLoadedTableIdRef = useRef('');
  const orderLookupFailedRef = useRef(false);
  const orderLoadSeqRef = useRef(0);
  const authSessionSeqRef = useRef(0);
  const activeUserIdRef = useRef<string | null>(null);
  const [autoLockMinutes, setAutoLockMinutes] = useState(0);
  const lastActivityRef = useRef(0);
  const liveDraftRef = useRef({
    tableId: '',
    draft: [] as DraftLine[],
    customerName: '',
    customerPhone: '',
    orderNotes: '',
  });
  const suspendedDraftRef = useRef<
    | (typeof liveDraftRef.current & {
        ownerId: string;
        attempt: typeof sendAttemptRef.current;
      })
    | null
  >(null);

  useEffect(() => {
    liveDraftRef.current = {
      tableId: selectedTableId,
      draft,
      customerName,
      customerPhone,
      orderNotes,
    };
  }, [selectedTableId, draft, customerName, customerPhone, orderNotes]);

  const loadUser = useCallback(async () => {
    if (!api || sendInFlightRef.current) return;
    const requestToken = localStorage.getItem(TOKEN_KEY);
    if (!requestToken) return;
    const sessionSeq = authSessionSeqRef.current;
    const res = await api.get('/api/auth/me');
    if (
      sendInFlightRef.current ||
      sessionSeq !== authSessionSeqRef.current ||
      localStorage.getItem(TOKEN_KEY) !== requestToken ||
      !res.data?.user
    ) {
      return;
    }
    const nextUser: User = res.data.user;
    setUser((prev) => {
      if (!prev || prev.id !== nextUser.id) return prev;
      if (
        prev.role === nextUser.role &&
        prev.name === nextUser.name &&
        prev.email === nextUser.email &&
        (prev.permission_ids || []).join(',') === (nextUser.permission_ids || []).join(',')
      ) {
        return prev;
      }
      return nextUser;
    });
  }, [api]);

  async function loadAll(options?: { allowWhileSending?: boolean }) {
    if (!api) return;
    if (sendInFlightRef.current && !options?.allowWhileSending) return;
    const session = authSessionSeqRef.current;
    const token = localStorage.getItem(TOKEN_KEY);
    const [categoriesRes, productsRes, tablesRes] = await Promise.all([
      api.get('/api/categories', { params: { active: 'true' } }),
      api.get('/api/products', { params: { active: 'true' } }),
      api.get('/api/tables', { params: { active: 'true' } }),
    ]);
    if (session !== authSessionSeqRef.current || token !== localStorage.getItem(TOKEN_KEY)) return;
    if (sendInFlightRef.current && !options?.allowWhileSending) return;
    setCategories(categoriesRes.data.categories || []);
    setProducts(productsRes.data.products || []);
    const loadedTables = tablesRes.data.tables || [];
    setTables(loadedTables);
    setTablesLoaded(true);
    const linkedTable = linkedTableAppliedRef.current ? undefined : pickLinkedTable(loadedTables);
    linkedTableAppliedRef.current = true;
    if (!selectedTableIdRef.current && linkedTable) {
      selectedTableIdRef.current = linkedTable.id;
      setSelectedTableId(linkedTable.id);
    }
  }

  function cancelPendingCustomerLookup() {
    clearTimeout(phoneDebounceRef.current);
    phoneAbortRef.current?.abort();
  }

  function fetchTableOrder(tableId: string) {
    return api!.get('/api/orders', {
      params: {
        table_id: tableId,
        type: 'dine_in',
        status: 'pending,preparing,ready,served',
        per_page: 1,
      },
    });
  }

  /** Picks up changes made elsewhere (payments at the POS, other staff) without disturbing the cart. */
  async function refreshLive() {
    if (!api || sendInFlightRef.current) return;
    const tableId = selectedTableIdRef.current;
    const loadSeq = orderLoadSeqRef.current;
    const orderLoaded = Boolean(tableId) && orderLoadedTableIdRef.current === tableId;
    const [tablesRes, orderRes] = await Promise.all([
      api.get('/api/tables', { params: { active: 'true' } }),
      orderLoaded ? fetchTableOrder(tableId) : Promise.resolve(null),
    ]);
    if (sendInFlightRef.current) return;
    const keepIfSame =
      <T,>(next: T) =>
      (prev: T) =>
        JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
    setTables(keepIfSame<Table[]>(tablesRes.data.tables || []));
    if (orderRes && loadSeq === orderLoadSeqRef.current && selectedTableIdRef.current === tableId) {
      setCurrentOrder(keepIfSame<Order | null>(orderRes.data.orders?.[0] || null));
    }
  }

  async function loadOrder(tableId: string, options?: { allowWhileSending?: boolean }) {
    if (!api || !tableId) return;
    if (sendInFlightRef.current && !options?.allowWhileSending) return;
    const loadSeq = ++orderLoadSeqRef.current;
    orderLookupFailedRef.current = false;
    if (!options?.allowWhileSending) {
      orderLoadedTableIdRef.current = '';
      setOrderLoadedTableId('');
    }
    cancelPendingCustomerLookup();
    try {
      const res = await fetchTableOrder(tableId);
      if (
        (sendInFlightRef.current && !options?.allowWhileSending) ||
        loadSeq !== orderLoadSeqRef.current ||
        selectedTableIdRef.current !== tableId
      ) {
        return;
      }
      const order = res.data.orders?.[0] || null;
      setCurrentOrder(order);
      const suspended = suspendedDraftRef.current;
      const pendingAttempt =
        sendAttemptRef.current?.snapshot.tableId === tableId
          ? sendAttemptRef.current.snapshot
          : suspended?.ownerId === activeUserIdRef.current && suspended.tableId === tableId
            ? suspended
            : null;
      if (pendingAttempt) {
        setCustomerName(pendingAttempt.customerName);
        setCustomerPhone(pendingAttempt.customerPhone);
      } else if (order?.customer) {
        setCustomerName(order.customer.name || '');
        setCustomerPhone(order.customer.phone || '');
      } else {
        setCustomerName('');
        setCustomerPhone('');
      }
      if (suspended && !sendInFlightRef.current) suspendedDraftRef.current = null;
      setCustomerMatch(null);
      setCustomerSearched(false);
      orderLoadedTableIdRef.current = tableId;
      setOrderLoadedTableId(tableId);
    } catch (error) {
      if (
        !options?.allowWhileSending &&
        !sendInFlightRef.current &&
        loadSeq === orderLoadSeqRef.current &&
        selectedTableIdRef.current === tableId
      ) {
        setCurrentOrder(null);
        orderLoadedTableIdRef.current = '';
        setOrderLoadedTableId('');
        orderLookupFailedRef.current = true;
      }
      throw error;
    }
  }

  // A guest's table order feeds the header's customer name and the order history.
  useEffect(() => {
    if (!api || !guestTable || !guestDeviceToken) return;
    let cancelled = false;
    const load = () =>
      api
        .get<{ order: GuestOrder | null }>('/api/guest/order', {
          params: { table_id: guestTable.id, d: guestDeviceToken },
        })
        .then((res) => {
          if (!cancelled) setGuestOrder(res.data.order);
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setGuestOrderLoaded(true);
        });
    void load();
    const timer = window.setInterval(load, LIVE_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [api, guestTable, guestDeviceToken]);

  useEffect(() => {
    if (!api || user || !guestTable || !guestDeviceToken) return;
    const storageKey = guestOrderStorageKey(guestTable.id);
    const submission = readGuestDevice(storageKey);
    if (!submission) return;
    try {
      if (JSON.parse(submission).device_token !== guestDeviceToken) return;
    } catch {
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let misses = 0;
    const check = async () => {
      if (controller.signal.aborted || readGuestDevice(storageKey) !== submission) return;
      try {
        const res = await api.post(guestOrderStatusPath, submission, {
          ...guestOrderJson,
          signal: controller.signal,
          validateStatus: (status) => status < 500,
        });
        if (controller.signal.aborted || readGuestDevice(storageKey) !== submission) return;
        if (res.status === 201 && typeof res.data?.order_number === 'string') {
          setGuestDeliveryStatus({ kind: 'received', orderNumber: res.data.order_number });
          return;
        }
        if (res.data?.code === 'order_needs_review') {
          setGuestDeliveryStatus({ kind: 'review' });
          return;
        }
        if (res.data?.code === 'order_queued') {
          misses = 0;
          setGuestDeliveryStatus({ kind: 'queued' });
        } else if (res.data?.code === 'order_not_found' && ++misses < 4) {
          // The original submission may still be committing when the page reloads.
        } else {
          if (res.status !== 404 || res.data?.code === 'order_not_found') {
            setGuestDeliveryStatus({ kind: 'failed' });
          }
          return;
        }
      } catch {
        if (controller.signal.aborted) return;
      }
      timer = setTimeout(() => void check(), 2500);
    };
    void check();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [api, user, guestTable?.id, guestDeviceToken]);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    const hasStaffToken = Boolean(localStorage.getItem(TOKEN_KEY));
    if (guestTableId && !hasStaffToken && !guestMenuPrefetchRef.current) {
      // Without a staff token the guest join cannot depend on /info or /me, so it races the menu.
      const storedDevice = readGuestDevice(guestDeviceStorageKey(guestTableId));
      const sticker = guestTableToken ? null : guestSticker;
      const joinBody =
        sticker && !storedDevice
          ? null
          : guestJoinBody(guestTableId, storedDevice, guestTableToken, sticker, null);
      guestMenuPrefetchRef.current = {
        startedAt: Date.now(),
        request: settle(api.get('/api/guest/menu')),
        join: joinBody
          ? {
              key: JSON.stringify(joinBody),
              request: settle(api.post('/api/guest/join', joinBody)),
            }
          : null,
      };
    }
    // A guest phone has no staff token, so it skips the guaranteed-401 /me round trip.
    void Promise.allSettled([
      api.get<ServerAppInfo>('/api/server-app/info'),
      hasStaffToken ? api.get('/api/auth/me') : Promise.resolve(null),
    ]).then(([info, me]) => {
      if (cancelled) return;
      if (info.status === 'fulfilled') {
        setRegional(info.value.data);
        if (me.status === 'fulfilled' && me.value) setUser(me.value.data.user);
      } else if ((info.reason as { response?: { status?: number } })?.response?.status === 404) {
        setDisabled(true);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the QR address is read once on mount.
  }, [api, guestTableId]);

  const userId = user?.id;

  useEffect(() => {
    activeUserIdRef.current = userId ?? null;
  }, [userId]);

  useEffect(() => {
    if (!api || !userId) return;
    let cancelled = false;
    const session = authSessionSeqRef.current;
    const token = localStorage.getItem(TOKEN_KEY);
    const refresh = () => {
      api
        .get('/api/settings/auto_lock_minutes')
        .then((response) => {
          if (
            cancelled ||
            session !== authSessionSeqRef.current ||
            token !== localStorage.getItem(TOKEN_KEY)
          )
            return;
          const minutes = Number(response.data?.setting?.value);
          if ([0, 1, 5, 15, 30].includes(minutes)) setAutoLockMinutes(minutes);
        })
        .catch(() => {});
    };
    lastActivityRef.current = Date.now();
    refresh();
    window.addEventListener('focus', refresh);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', refresh);
    };
  }, [api, userId]);

  useEffect(() => {
    if (!api || !userId || autoLockMinutes <= 0) return;
    const timeout = autoLockMinutes * 60_000;
    let timer: ReturnType<typeof setTimeout>;
    let locked = false;
    const lock = () => {
      if (locked) return;
      locked = true;
      const token = localStorage.getItem(TOKEN_KEY);
      suspendedDraftRef.current = {
        ...liveDraftRef.current,
        ownerId: userId,
        attempt: sendAttemptRef.current,
      };
      authSessionSeqRef.current += 1;
      orderLoadSeqRef.current += 1;
      sendSeqRef.current += 1;
      cancelPendingCustomerLookup();
      localStorage.removeItem(TOKEN_KEY);
      sendAttemptRef.current = null;
      selectedTableIdRef.current = '';
      orderLoadedTableIdRef.current = '';
      activeUserIdRef.current = null;
      setUser(null);
      setEmail('');
      setPassword('');
      setDraft([]);
      setOrderNotes('');
      setCustomerName('');
      setCustomerPhone('');
      setCustomerMatch(null);
      setCustomerSearched(false);
      setSelectedTableId('');
      setOrderLoadedTableId('');
      setCurrentOrder(null);
      setAddonModalProduct(null);
      setEditingDraftLine(null);
      setMoveTableModalOpen(false);
      setMobileCartOpen(false);
      setAutoLockMinutes(0);
      if (token)
        void api
          .post('/api/auth/logout', {}, { headers: { Authorization: `Bearer ${token}` } })
          .catch(() => {});
    };
    const check = () => {
      const remaining = timeout - (Date.now() - lastActivityRef.current);
      if (remaining <= 0) lock();
      else timer = setTimeout(check, remaining);
    };
    const activity = () => {
      lastActivityRef.current = Date.now();
      clearTimeout(timer);
      timer = setTimeout(check, timeout);
    };
    const visible = () => {
      if (document.visibilityState === 'visible') {
        clearTimeout(timer);
        check();
      }
    };
    const events = ['pointerdown', 'keydown', 'touchstart', 'wheel', 'mousemove'] as const;
    events.forEach((event) => window.addEventListener(event, activity, { passive: true }));
    document.addEventListener('visibilitychange', visible);
    check();
    return () => {
      clearTimeout(timer);
      events.forEach((event) => window.removeEventListener(event, activity));
      document.removeEventListener('visibilitychange', visible);
    };
  }, [api, userId, autoLockMinutes]);

  useEffect(() => {
    if (!userId || !api) return;
    let cancelled = false;
    api
      .get('/api/products/popular')
      .then((res) => !cancelled && setPopularIds(res.data.product_ids || []))
      .catch(() => !cancelled && setPopularIds(null));
    return () => {
      cancelled = true;
    };
  }, [user, api]);

  const quickFilters = useMemo<QuickFilter[]>(() => {
    const rank = new Map((popularIds ?? []).map((id, index) => [id, index]));
    return [
      ...(popularIds
        ? [
            {
              key: 'popular',
              label: t('menuPopular'),
              match: (product: Product) => rank.has(product.id),
              emptyText: t('menuPopularEmpty'),
            },
          ]
        : []),
      {
        key: 'recommended',
        label: t('menuRecommended'),
        match: (product: Product) => hasTag(product.tags, 'recommended'),
        emptyText: t('menuRecommendedEmpty'),
      },
      {
        key: 'promotion',
        label: t('menuPromotion'),
        match: (product: Product) => hasTag(product.tags, 'promotion'),
        emptyText: t('menuPromotionEmpty'),
      },
    ];
  }, [popularIds, t]);

  useEffect(() => {
    if (!user || !api) return;
    let cancelled = false;
    Promise.all([
      api.get('/api/categories', { params: { active: 'true' } }),
      api.get('/api/products', { params: { active: 'true' } }),
      api.get('/api/tables', { params: { active: 'true' } }),
    ])
      .then(([categoriesRes, productsRes, tablesRes]) => {
        if (cancelled || sendInFlightRef.current) return;
        setCategories(categoriesRes.data.categories || []);
        setProducts(productsRes.data.products || []);
        const loadedTables = tablesRes.data.tables || [];
        setTables(loadedTables);
        setTablesLoaded(true);
        const linkedTable = linkedTableAppliedRef.current
          ? undefined
          : pickLinkedTable(loadedTables);
        linkedTableAppliedRef.current = true;
        if (!selectedTableIdRef.current && linkedTable) {
          selectedTableIdRef.current = linkedTable.id;
          setSelectedTableId(linkedTable.id);
        }
      })
      .catch((error) => {
        if (error?.response?.status === 401) setUser(null);
        else toast.error(t('couldNotLoadData'));
      });
    return () => {
      cancelled = true;
    };
  }, [api, selectedTableId, userId, t]);

  const refreshLiveRef = useRef(refreshLive);
  useEffect(() => {
    refreshLiveRef.current = refreshLive;
  });
  useEffect(() => {
    if (!user || !api) return;
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      refreshLiveRef.current().catch(() => {});
    };
    const timer = setInterval(refresh, LIVE_REFRESH_MS);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [api, user]);

  // A table QR opens the app as a guest bound to that one table until someone signs in. The phone
  // joins the table's open session once and keeps the device token it gets for its orders; a
  // sticker scan joins only after a tap, and waits for staff while the table is not open.
  useEffect(() => {
    if (!api || user || !guestTableId || loading) return;
    let cancelled = false;
    let poll: ReturnType<typeof setTimeout> | undefined;
    const storageKey = guestDeviceStorageKey(guestTableId);
    const storedDevice = readGuestDevice(storageKey);
    const fail = (error: unknown) => {
      if (cancelled) return;
      const data = (
        error as {
          response?: { data?: { code?: string; table?: { id: string; name: string } } };
        }
      )?.response?.data;
      const code = data?.code;
      setGuestTable(null);
      if ((code === 'table_not_open' || code === 'unlock_declined') && data?.table) {
        setGuestGate({ kind: code === 'unlock_declined' ? 'declined' : 'tap', table: data.table });
        return;
      }
      setGuestGate(null);
      setGuestClosed(code === 'guest_ordering_disabled');
      setGuestExpired(code === 'qr_expired');
    };
    const done = () => {
      if (!cancelled) setGuestChecked(true);
    };
    const sticker = guestTableToken ? null : guestSticker;
    if (sticker && !storedDevice && !guestTapped) {
      api
        .get('/api/guest/table', { params: { table_id: guestTableId, s: sticker } })
        .then((res) => {
          if (!cancelled) setGuestGate({ kind: 'tap', table: res.data.table });
        })
        .catch(fail)
        .finally(done);
      return () => {
        cancelled = true;
      };
    }
    if (guestTapped && !guestUnlockKeyRef.current) {
      guestUnlockKeyRef.current = createPaymentIdempotencyKey();
    }
    const prefetched = guestMenuPrefetchRef.current;
    guestMenuPrefetchRef.current = null;
    const fresh = prefetched && Date.now() - prefetched.startedAt < GUEST_MENU_PREFETCH_MAX_AGE_MS;
    const menuPromise = fresh ? prefetched.request : settle(api.get('/api/guest/menu'));
    const joinBody = guestJoinBody(
      guestTableId,
      storedDevice,
      guestTableToken,
      sticker,
      sticker && guestTapped ? guestUnlockKeyRef.current : null,
    );
    const joinPromise =
      fresh && prefetched.join?.key === JSON.stringify(joinBody)
        ? prefetched.join.request.then((result) => {
            if (!result.response) throw result.error;
            return result.response;
          })
        : api.post('/api/guest/join', joinBody);
    joinPromise
      .then(async (joinRes) => {
        if (cancelled) return;
        const table = joinRes.data.table as { id: string; name: string };
        if (joinRes.status === 202) {
          setGuestGate({ kind: 'waiting', table });
          poll = setTimeout(() => setGuestJoinRound((round) => round + 1), 3000);
          return;
        }
        const deviceToken = joinRes.data.device_token as string;
        writeGuestDevice(storageKey, deviceToken);
        const menuResult = await menuPromise;
        if (!menuResult.response) throw menuResult.error;
        const menuRes = menuResult.response;
        if (cancelled) return;
        setGuestDeviceToken(deviceToken);
        setGuestGate(null);
        setGuestExpired(false);
        setGuestTable(table);
        setTables([{ id: table.id, name: table.name }]);
        setTablesLoaded(true);
        setCategories(menuRes.data.categories || []);
        setProducts(menuRes.data.products || []);
        selectedTableIdRef.current = table.id;
        setSelectedTableId(table.id);
        orderLoadedTableIdRef.current = table.id;
        setOrderLoadedTableId(table.id);
      })
      .catch(fail)
      .finally(done);
    return () => {
      cancelled = true;
      if (poll) clearTimeout(poll);
    };
  }, [
    api,
    user,
    guestTableId,
    guestTableToken,
    guestSticker,
    guestTapped,
    loading,
    guestJoinRound,
  ]);

  const askStaffAgain = () => {
    guestUnlockKeyRef.current = null;
    setGuestJoinRound((round) => round + 1);
  };

  useEffect(() => {
    if (!selectedTableId || !userId || !api) return;
    let cancelled = false;
    const loadSeq = ++orderLoadSeqRef.current;
    const targetTableId = selectedTableId;
    orderLookupFailedRef.current = false;
    orderLoadedTableIdRef.current = '';
    cancelPendingCustomerLookup();
    fetchTableOrder(targetTableId)
      .then((res) => {
        if (
          cancelled ||
          sendInFlightRef.current ||
          loadSeq !== orderLoadSeqRef.current ||
          selectedTableIdRef.current !== targetTableId
        ) {
          return;
        }
        const order = res.data.orders?.[0] || null;
        setCurrentOrder(order);
        const suspended = suspendedDraftRef.current;
        const pendingAttempt =
          sendAttemptRef.current?.snapshot.tableId === targetTableId
            ? sendAttemptRef.current.snapshot
            : suspended?.ownerId === activeUserIdRef.current && suspended.tableId === targetTableId
              ? suspended
              : null;
        if (pendingAttempt) {
          setCustomerName(pendingAttempt.customerName);
          setCustomerPhone(pendingAttempt.customerPhone);
        } else if (order?.customer) {
          setCustomerName(order.customer.name || '');
          setCustomerPhone(order.customer.phone || '');
        } else {
          setCustomerName('');
          setCustomerPhone('');
        }
        if (suspended && !sendInFlightRef.current) suspendedDraftRef.current = null;
        setCustomerMatch(null);
        setCustomerSearched(false);
        orderLoadedTableIdRef.current = targetTableId;
        setOrderLoadedTableId(targetTableId);
      })
      .catch(() => {
        if (
          !cancelled &&
          !sendInFlightRef.current &&
          loadSeq === orderLoadSeqRef.current &&
          selectedTableIdRef.current === targetTableId
        ) {
          setCurrentOrder(null);
          orderLoadedTableIdRef.current = '';
          setOrderLoadedTableId('');
          orderLookupFailedRef.current = true;
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, selectedTableId, userId]);

  useEffect(() => {
    if (!userId || !api) return;
    const onFocus = () => {
      loadUser().catch(() => {});
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
    };
  }, [api, loadUser, userId]);

  useEffect(() => {
    return () => {
      clearTimeout(phoneDebounceRef.current);
      phoneAbortRef.current?.abort();
    };
  }, []);

  function handleOrderNotesChange(value: string) {
    if (sendInFlightRef.current) return;
    setOrderNotes(value.slice(0, 200));
  }

  function movePendingSendAttempt(
    sourceTableId: string,
    targetTableId: string,
    targetTableName?: string,
  ) {
    const attempt = sendAttemptRef.current;
    if (attempt?.snapshot.tableId !== sourceTableId) return;
    const snapshot: SendSnapshot = {
      ...attempt.snapshot,
      tableId: targetTableId,
      requestTableId: attempt.snapshot.requestTableId ?? sourceTableId,
      tableName: targetTableName ?? attempt.snapshot.tableName,
    };
    sendAttemptRef.current = {
      signature: sendAttemptSignature(
        targetTableId,
        snapshot.draftLines,
        snapshot.customerName,
        snapshot.customerPhone,
        snapshot.orderNotes,
      ),
      nonce: attempt.nonce,
      snapshot,
    };
  }

  /** Moves the open order to a free table, or merges all its items into another table's order. */
  async function transferOrderTo(mode: TransferMode, target: TransferTable) {
    if (!api || !currentOrder || !selectedTableId || sendInFlightRef.current) return;
    if (mode === 'move' && !canMoveTable) return;
    setTransferring(true);
    try {
      if (mode === 'move') {
        await api.post(`/api/tables/${selectedTableId}/move-order`, {
          target_table_id: target.id,
          order_id: currentOrder.id,
        });
        movePendingSendAttempt(selectedTableId, target.id, target.name);
      } else {
        await api.post(`/api/orders/${currentOrder.id}/merge-table`, {
          target_table_id: target.id,
        });
      }
      toast.success(
        mode === 'move'
          ? t('tableMoved', { name: target.name })
          : t('tablesMerged', { name: target.name }),
      );
      setTransferMode(null);
      const listWasOpen = orderedItemsOpen;
      await loadAll({ allowWhileSending: true }).catch(() => {});
      selectTable(target.id);
      // Started from the ordered-items list: show it again for the table the items went to.
      if (listWasOpen) setOrderedItemsOpen(true);
    } catch (error: unknown) {
      const code = (error as { response?: { data?: { code?: string } } })?.response?.data?.code;
      if (code === 'source_billed') toast.error(t('mergeBlockedBilled'));
      else if (code === 'source_discount') toast.error(t('mergeBlockedDiscount'));
      else if (code === 'target_paying') toast.error(t('mergeBlockedPaying'));
      else if (code === 'target_empty') toast.error(t('tableHasNoOrder', { name: target.name }));
      else
        toastApiError(
          error,
          mode === 'move' ? t('moveTableFailed') : t('mergeTableFailed'),
          apiErrorT,
        );
    } finally {
      setTransferring(false);
    }
  }

  /** Prints the table's bill and records the request, so the POS times the wait for payment. */
  async function requestBill() {
    if (!api || !currentOrder) return;
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) return;
    const session = authSessionSeqRef.current;
    const isCurrent = () =>
      authSessionSeqRef.current === session && localStorage.getItem(TOKEN_KEY) === token;
    try {
      const { data } = await api.post(
        `/api/orders/${currentOrder.id}/bill-request`,
        {},
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!isCurrent()) return;
      // The table stops taking orders as soon as its bill is out.
      if (data?.order)
        setCurrentOrder((order) =>
          order && order.id === data.order.id
            ? { ...order, ...data.order, items: order.items }
            : order,
        );
    } catch (error: unknown) {
      if (!isCurrent()) return;
      const code = (error as { response?: { data?: { code?: string } } })?.response?.data?.code;
      if (code === 'weight_pending') toast.error(t('billBlockedPricePending'));
      else if (code === 'served_unconfirmed') toast.error(t('billBlockedNotServed'));
      else toastApiError(error, t('billRequestFailed'), apiErrorT);
      return;
    }
    const printed = await printOrderSlip(currentOrder.id, token, isCurrent);
    if (printed === 'cancelled' || !isCurrent()) return;
    if (printed === 'printed') toast.success(t('billRequested'));
    else if (printed === 'not-allowed') toast.success(t('billRequestNotified'));
    else toast.error(t('billRequestCashierPrintFailed'));
  }

  /** Packs a sent item to go, cancels one still waiting, or confirms a served one reached the table. */
  async function changeSentItem(itemId: number, change: 'takeaway' | 'cancel' | 'confirm-served') {
    if (!api || !currentOrder || sendInFlightRef.current) return;
    const tableId = selectedTableIdRef.current;
    try {
      await api.patch(
        `/api/orders/${currentOrder.id}/items/${itemId}/${change}`,
        change === 'cancel' ? { reason: 'Cancelled from the Server App' } : {},
      );
      toast.success(
        change === 'cancel'
          ? t('itemCancelled')
          : change === 'confirm-served'
            ? t('itemServedConfirmed')
            : t('itemChangedToTakeaway'),
      );
    } catch (error: unknown) {
      toastApiError(error, t('itemChangeFailed'), apiErrorT);
    }
    if (tableId) await loadOrder(tableId).catch(() => {});
  }

  /** Confirms several dishes reached the table together; all or none are saved. */
  async function confirmServedMany(items: OrderedItem[]): Promise<boolean> {
    if (!api || !currentOrder || sendInFlightRef.current) return false;
    const tableId = selectedTableIdRef.current;
    let done = false;
    try {
      await api.post(`/api/orders/${currentOrder.id}/items/confirm-served`, {
        item_ids: items.map((item) => item.id),
      });
      toast.success(t('itemsServedConfirmed', { count: items.length }));
      done = true;
    } catch (error: unknown) {
      toastApiError(error, t('itemChangeFailed'), apiErrorT);
    }
    if (tableId) await loadOrder(tableId).catch(() => {});
    return done;
  }

  function clearSelectedTable() {
    selectedTableIdRef.current = '';
    orderLookupFailedRef.current = false;
    orderLoadedTableIdRef.current = '';
    orderLoadSeqRef.current += 1;
    cancelPendingCustomerLookup();
    setOrderLoadedTableId('');
    setCurrentOrder(null);
    setCustomerName('');
    setCustomerPhone('');
    setCustomerMatch(null);
    setCustomerSearched(false);
    setOrderedItemsOpen(false);
    setSelectedTableId('');
  }

  function selectTable(tableId: string) {
    if (sendInFlightRef.current) return;
    if (tableId === selectedTableIdRef.current) {
      if (orderLookupFailedRef.current) {
        loadOrder(tableId).catch(() => toast.error(t('couldNotLoadData')));
      }
      return;
    }
    selectedTableIdRef.current = tableId;
    setMoveTableModalOpen(false);
    orderLookupFailedRef.current = false;
    orderLoadedTableIdRef.current = '';
    setOrderLoadedTableId('');
    orderLoadSeqRef.current += 1;
    cancelPendingCustomerLookup();
    setCurrentOrder(null);
    const pendingAttempt =
      sendAttemptRef.current?.snapshot.tableId === tableId ? sendAttemptRef.current.snapshot : null;
    setCustomerName(pendingAttempt?.customerName ?? '');
    setCustomerPhone(pendingAttempt?.customerPhone ?? '');
    setCustomerMatch(null);
    setCustomerSearched(false);
    setOrderedItemsOpen(false);
    setSelectedTableId(tableId);
  }

  function openAddonModal(
    product: Product,
    quantity: number,
    variant: ProductVariant | null = null,
  ) {
    if (sendInFlightRef.current) return;
    addonModalSendSeqRef.current = sendSeqRef.current;
    setAddonModalQuantity(quantity);
    setAddonModalVariant(variant);
    setAddonModalProduct(product);
  }

  function openEditDraftModal(line: DraftLine) {
    if (sendInFlightRef.current) return;
    editingDraftSendSeqRef.current = sendSeqRef.current;
    reopenCartAfterEditRef.current = mobileCartOpen;
    setMobileCartOpen(false);
    setEditingDraftLine(line);
  }

  async function handleLogin(event: FormEvent) {
    event.preventDefault();
    if (!api) return;
    setLoginLoading(true);
    try {
      const res = await api.post('/api/auth/login', {
        identifier: email.trim(),
        password,
      });
      authSessionSeqRef.current += 1;
      localStorage.setItem(TOKEN_KEY, res.data.access_token);
      const suspended = suspendedDraftRef.current;
      if (suspended && suspended.ownerId === res.data.user.id) {
        selectedTableIdRef.current = suspended.tableId;
        setSelectedTableId(suspended.tableId);
        setDraft(suspended.draft);
        setCustomerName(suspended.customerName);
        setCustomerPhone(suspended.customerPhone);
        setOrderNotes(suspended.orderNotes);
        sendAttemptRef.current = suspended.attempt;
      } else if (suspended) {
        const hadDraft =
          suspended.draft.length > 0 ||
          Boolean(suspended.attempt) ||
          Boolean(suspended.orderNotes.trim()) ||
          Boolean(suspended.customerName.trim()) ||
          Boolean(suspended.customerPhone.trim());
        suspendedDraftRef.current = null;
        if (hadDraft) {
          toast(t('draftDiscardedOnUserChange'));
        }
      }
      activeUserIdRef.current = res.data.user.id;
      setUser(res.data.user);
      setShowLogin(false);
    } catch (error: unknown) {
      toastApiError(error, t('signInFailed'), apiErrorT);
    } finally {
      setLoginLoading(false);
    }
  }

  useEffect(() => {
    if (!user) return;
    const token = localStorage.getItem(TOKEN_KEY);
    let expiresAt = 0;
    try {
      expiresAt =
        JSON.parse(atob((token ?? '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp *
        1000;
    } catch {
      return;
    }
    if (!Number.isFinite(expiresAt)) return;
    const endSession = () => {
      localStorage.removeItem(TOKEN_KEY);
      setUser(null);
    };
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      endSession();
      return;
    }
    const timer = setTimeout(endSession, Math.min(remaining, 2 ** 31 - 1));
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() >= expiresAt) endSession();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [user]);

  async function logout() {
    authSessionSeqRef.current += 1;
    try {
      await api?.post('/api/auth/logout');
    } catch {}
    localStorage.removeItem(TOKEN_KEY);
    setUser(null);
  }

  function addDraftLine(
    product: Product,
    quantity: number,
    addons: Addon[],
    specialInstructions: string,
    variant: ProductVariant | null = null,
  ) {
    if (sendInFlightRef.current) return;
    setDraft((lines) => {
      const lineId = generateCartItemId(
        product.id,
        variant?.id ?? null,
        addons,
        specialInstructions,
      );
      const existing = lines.find((line) => line.id === lineId);
      if (existing) {
        return lines.map((line) =>
          line.id === lineId ? { ...line, quantity: line.quantity + quantity } : line,
        );
      }
      return [
        ...lines,
        {
          id: lineId,
          product,
          quantity,
          addons,
          special_instructions: specialInstructions,
          variant,
        },
      ];
    });
  }

  function updateDraftLine(
    lineId: string,
    quantity: number,
    addons: Addon[],
    specialInstructions: string,
    variant: ProductVariant | null = null,
  ) {
    if (sendInFlightRef.current) return;
    setDraft((lines) => {
      const target = lines.find((line) => line.id === lineId);
      if (!target) return lines;

      const newId = generateCartItemId(
        target.product.id,
        (variant ?? target.variant)?.id ?? null,
        addons,
        specialInstructions,
      );
      if (newId === lineId) {
        return lines.map((line) =>
          line.id === lineId
            ? {
                ...line,
                quantity,
                addons,
                special_instructions: specialInstructions,
                variant: variant ?? target.variant ?? null,
              }
            : line,
        );
      }

      // The edit produced a config that matches another existing line — merge into it.
      const collision = lines.find((line) => line.id === newId && line.id !== lineId);
      if (collision) {
        return lines
          .filter((line) => line.id !== lineId)
          .map((line) =>
            line.id === newId ? { ...line, quantity: line.quantity + quantity } : line,
          );
      }
      return lines.map((line) =>
        line.id === lineId
          ? {
              ...line,
              id: newId,
              quantity,
              addons,
              special_instructions: specialInstructions,
              variant: variant ?? target.variant ?? null,
            }
          : line,
      );
    });
  }

  function removeDraftLine(lineId: string) {
    if (sendInFlightRef.current) return;
    setDraft((lines) => lines.filter((line) => line.id !== lineId));
  }

  function changeQty(lineId: string, delta: number) {
    if (sendInFlightRef.current) return;
    setDraft((lines) =>
      lines
        .map((line) => (line.id === lineId ? { ...line, quantity: line.quantity + delta } : line))
        .filter((line) => line.quantity > 0),
    );
  }

  async function ensureCustomer(
    submittedName: string,
    submittedPhone: string,
    token: string,
    isCurrent: () => boolean,
  ): Promise<string | null> {
    if (!api) return null;
    const name = submittedName.trim();
    const rawPhone = submittedPhone.trim();
    if (!name && !rawPhone) return null;
    let normalizedPhone: string | undefined = undefined;
    if (rawPhone) {
      const parsed = regional?.country
        ? (await import('@/lib/phone')).parsePhone(rawPhone, regional.country)
        : null;
      normalizedPhone = parsed ? parsed.e164 : rawPhone;
      try {
        const lookup = await api.get('/api/crm/lookup', {
          params: { phone: normalizedPhone },
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!isCurrent()) throw new Error('Session changed');
        if (lookup.data.found && lookup.data.customer?.id) return lookup.data.customer.id;
      } catch {
        if (!isCurrent()) throw new Error('Session changed');
      }
    }
    if (!isCurrent()) throw new Error('Session changed');
    const fallbackName = name || t('guestFallbackName', { last4: rawPhone.slice(-4) });
    const res = await api.post(
      '/api/customers',
      {
        name: fallbackName,
        phone: normalizedPhone || undefined,
      },
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!isCurrent()) throw new Error('Session changed');
    return res.data.customer?.id || null;
  }

  // Stays quiet on 400 (no hardware printer configured) so tableside devices never open window.print().
  async function printKotForOrder(
    orderId: number,
    orderForPrint: Record<string, unknown>,
    token: string,
    isCurrent: () => boolean,
  ) {
    if (!api || !isCurrent()) return;
    try {
      await api.post(
        '/api/printers/print-kot',
        {
          orderId,
          items: orderForPrint.items,
        },
        { headers: { Authorization: `Bearer ${token}` } },
      );
    } catch (printError: unknown) {
      if (!isCurrent()) return;
      const status = axios.isAxiosError(printError) ? printError.response?.status : undefined;
      const errorCode = axios.isAxiosError(printError)
        ? (printError.response?.data as { code?: unknown } | undefined)?.code
        : undefined;
      if (status === 400 || (status === 403 && errorCode === 'KOT_PRINTING_DISABLED')) return;
      toastApiError(printError, t('kotPrintFailed'), apiErrorT);
    }
  }

  async function printOrderSlip(
    orderId: number,
    token: string,
    isCurrent: () => boolean,
  ): Promise<'printed' | 'not-allowed' | 'unavailable' | 'failed' | 'cancelled'> {
    if (!api || !isCurrent()) return 'cancelled';
    try {
      await api.post(
        '/api/printers/print-bill',
        { orderId },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      return isCurrent() ? 'printed' : 'cancelled';
    } catch (printError: unknown) {
      if (!isCurrent()) return 'cancelled';
      const response = axios.isAxiosError(printError) ? printError.response : undefined;
      if (response?.status === 400) return 'unavailable';
      if (response?.status === 403 && response.data?.code === 'BILL_PRINTING_DISABLED') {
        return 'not-allowed';
      }
      return 'failed';
    }
  }

  async function sendGuestDraft() {
    if (!api || !guestTable || draft.length === 0 || sendInFlightRef.current) {
      return;
    }
    const lines = draft.map((line) => ({
      ...line,
      addons: line.addons.map((addon) => ({ ...addon })),
    }));
    const items = lines.map((line) => cartItemToOrderItem(line));
    const notes = orderNotes.trim();
    const signature = JSON.stringify([guestTable.id, guestDeviceToken, items, notes]);
    if (guestAttemptRef.current?.signature !== signature) {
      guestAttemptRef.current = { signature, key: createPaymentIdempotencyKey() };
    }
    const { key } = guestAttemptRef.current;
    sendInFlightRef.current = true;
    setSending(true);
    setGuestDeliveryStatus(null);
    try {
      const submission = JSON.stringify({
        table_id: guestTable.id,
        device_token: guestDeviceToken,
        items,
        special_instructions: notes || undefined,
        idempotency_key: key,
      });
      writeGuestDevice(guestOrderStorageKey(guestTable.id), submission);
      let res = await api.post('/api/guest/order', submission, guestOrderJson);
      if (res.status === 202 && res.data?.code === 'order_queued') {
        setGuestDeliveryStatus({ kind: 'queued' });
        toast(t('guestOrderQueued'));
        for (let poll = 0; poll < 175; poll++) {
          await new Promise<void>((resolve) => setTimeout(resolve, 2500));
          try {
            res = await api.post(guestOrderStatusPath, submission, guestOrderJson);
          } catch (error) {
            const status = axios.isAxiosError(error) ? error.response?.status : undefined;
            if (!status || status >= 500) continue;
            throw error;
          }
          if (res.status !== 202 || res.data?.code !== 'order_queued') break;
        }
        if (res.status === 202 && res.data?.code === 'order_queued') return;
      }
      if (res.status === 201 && typeof res.data?.order_number === 'string') {
        setGuestDeliveryStatus({ kind: 'received', orderNumber: res.data.order_number });
      }
      if (guestAttemptRef.current?.signature === signature) guestAttemptRef.current = null;
      const submittedQtyById = new Map(lines.map((line) => [line.id, line.quantity]));
      setDraft((currentLines) =>
        currentLines.flatMap((line) => {
          const ackedQty = submittedQtyById.get(line.id);
          if (ackedQty === undefined) return [line];
          const remainingQuantity = line.quantity - ackedQty;
          return remainingQuantity > 0 ? [{ ...line, quantity: remainingQuantity }] : [];
        }),
      );
      setOrderNotes((currentNotes) => (currentNotes === orderNotes ? '' : currentNotes));
      setMobileCartOpen(false);
      toast.success(t(res.status === 202 ? 'guestOrderHeld' : 'orderSent'));
    } catch (error: unknown) {
      const data = (error as { response?: { data?: { code?: string; retry_after?: number } } })
        ?.response?.data;
      const code = data?.code;
      if (code === 'bill_awaiting_payment') toast.error(t('tableAwaitingPaymentLocked'));
      else if (code === 'order_needs_review') {
        setGuestDeliveryStatus({ kind: 'review' });
        toast.error(t('guestOrderNeedsReview'));
      } else if (code === 'order_cooldown') {
        toast.error(t('guestOrderCooldown', { seconds: data?.retry_after ?? 5 }));
      } else if (code === 'order_rejected') {
        guestAttemptRef.current = null;
        toast.error(t('guestOrderRejected'));
      } else if (code === 'qr_expired') {
        // The party's session ended; a sticker can join the next one after another tap.
        removeGuestDevice(guestDeviceStorageKey(guestTable.id));
        if (guestSticker) {
          guestUnlockKeyRef.current = null;
          setGuestTapped(false);
          setGuestJoinRound((round) => round + 1);
        } else setGuestExpired(true);
      } else toastApiError(error, t('couldNotSendOrder'), apiErrorT);
    } finally {
      sendInFlightRef.current = false;
      setSending(false);
    }
  }

  async function sendDraft() {
    if (!user) {
      await sendGuestDraft();
      return;
    }
    if (
      !api ||
      !selectedTableId ||
      orderLoadedTableIdRef.current !== selectedTableId ||
      draft.length === 0 ||
      sendInFlightRef.current
    ) {
      return;
    }
    const requestToken = localStorage.getItem(TOKEN_KEY);
    const requestSession = authSessionSeqRef.current;
    const requestOwner = user?.id;
    if (!requestToken || !requestOwner) return;
    const isCurrent = () =>
      authSessionSeqRef.current === requestSession &&
      localStorage.getItem(TOKEN_KEY) === requestToken;
    const snapshotTable = tables.find((table) => table.id === selectedTableId) || null;
    const candidateSnapshot: SendSnapshot = {
      tableId: selectedTableId,
      tableName: snapshotTable ? snapshotTable.name || snapshotTable.number : undefined,
      orderId: currentOrder?.id ?? null,
      orderCustomer: currentOrder?.customer ?? null,
      existingItemIds: new Set((currentOrder?.items || []).map((item) => item.id)),
      draftLines: draft.map((line) => ({
        ...line,
        addons: line.addons.map((addon) => ({ ...addon })),
      })),
      customerName: customerName.trim(),
      customerPhone: customerPhone.trim(),
      orderNotes,
    };
    // Nonce first via the LAN-safe helper: anything thrown after the
    // sending flag is set sticks the UI on Sending... forever.
    const signature = sendAttemptSignature(
      candidateSnapshot.tableId,
      candidateSnapshot.draftLines,
      candidateSnapshot.customerName,
      candidateSnapshot.customerPhone,
      candidateSnapshot.orderNotes,
    );
    if (sendAttemptRef.current?.signature !== signature) {
      sendAttemptRef.current = {
        signature,
        nonce: createPaymentIdempotencyKey(),
        snapshot: candidateSnapshot,
      };
    }
    const { nonce, snapshot } = sendAttemptRef.current;
    const requestTableId = snapshot.requestTableId ?? snapshot.tableId;
    const idempotencyKey = `server-app-${requestTableId}-${nonce}`;
    sendSeqRef.current += 1;
    orderLoadSeqRef.current += 1;
    cancelPendingCustomerLookup();
    sendInFlightRef.current = true;
    setSending(true);
    try {
      const customerId = await ensureCustomer(
        snapshot.customerName,
        snapshot.customerPhone,
        requestToken,
        isCurrent,
      );
      if (!isCurrent()) return;
      const items = snapshot.draftLines.map((line) => cartItemToOrderItem(line));
      const specialInstructions = snapshot.orderNotes.trim() || undefined;
      let orderId: number;
      let rawOrder: Record<string, unknown>;
      let newItems: OrderItem[];
      if (snapshot.orderId) {
        const { data } = await api.post(
          `/api/orders/${snapshot.orderId}/items`,
          { items, special_instructions: specialInstructions },
          {
            headers: { 'Idempotency-Key': idempotencyKey, Authorization: `Bearer ${requestToken}` },
          },
        );
        orderId = data.order.id;
        rawOrder = data.order;
        // Print only what this call added — omitting items reprints every pending item on the order.
        newItems =
          Array.isArray(data.added_items) && data.added_items.length > 0
            ? data.added_items
            : (data.order.items || []).filter(
                (item: OrderItem) => !snapshot.existingItemIds.has(item.id),
              );
      } else {
        const { data } = await api.post(
          '/api/orders',
          {
            table_id: requestTableId,
            customer_id: customerId,
            type: 'dine_in',
            special_instructions: specialInstructions,
            items,
          },
          { headers: { 'Idempotency-Key': idempotencyKey } },
        );
        orderId = data.order.id;
        rawOrder = data.order;
        newItems = data.order.items || [];
      }
      if (!isCurrent()) {
        const suspended = suspendedDraftRef.current;
        if (suspended?.ownerId === requestOwner && suspended.attempt?.nonce === nonce) {
          const submitted = new Map(snapshot.draftLines.map((line) => [line.id, line.quantity]));
          const remaining = suspended.draft.flatMap((line) => {
            const count = submitted.get(line.id);
            if (count === undefined) return [line];
            return line.quantity > count ? [{ ...line, quantity: line.quantity - count }] : [];
          });
          suspended.draft = remaining;
          if (suspended.orderNotes === snapshot.orderNotes) suspended.orderNotes = '';
          suspended.attempt = null;
          if (activeUserIdRef.current === requestOwner) {
            setDraft(remaining);
            setOrderNotes(suspended.orderNotes);
            if (sendAttemptRef.current?.nonce === nonce) sendAttemptRef.current = null;
          }
        }
        return;
      }
      if (sendAttemptRef.current?.signature === signature) {
        sendAttemptRef.current = null;
      }
      const submittedQtyById = new Map(snapshot.draftLines.map((line) => [line.id, line.quantity]));
      setDraft((currentLines) =>
        currentLines.flatMap((line) => {
          const ackedQty = submittedQtyById.get(line.id);
          if (ackedQty === undefined) return [line];
          const remainingQuantity = line.quantity - ackedQty;
          return remainingQuantity > 0 ? [{ ...line, quantity: remainingQuantity }] : [];
        }),
      );
      setOrderNotes((currentNotes) => (currentNotes === snapshot.orderNotes ? '' : currentNotes));
      if (selectedTableIdRef.current === snapshot.tableId) {
        setCurrentOrder(rawOrder as unknown as Order);
        orderLoadedTableIdRef.current = snapshot.tableId;
        setOrderLoadedTableId(snapshot.tableId);
      }
      setMobileCartOpen(false);
      await Promise.all([
        loadAll({ allowWhileSending: true }),
        loadOrder(snapshot.tableId, { allowWhileSending: true }),
      ]).catch(() => {});
      if (!isCurrent()) return;
      toast.success(t('orderSent'));
      if (user && !guestTable) clearSelectedTable();
      // rawOrder only has table_id/customer_id; the KOT/slip renderers need the nested table/customer for display.
      const enrichedOrder = {
        ...rawOrder,
        table: snapshot.tableName ? { name: snapshot.tableName } : undefined,
        customer:
          snapshot.orderCustomer ||
          (snapshot.customerName ? { name: snapshot.customerName } : undefined),
      };
      void printKotForOrder(
        orderId,
        { ...enrichedOrder, items: newItems },
        requestToken,
        isCurrent,
      );
    } catch (error: unknown) {
      if (!isCurrent()) return;
      if (
        (error as { response?: { data?: { code?: string } } })?.response?.data?.code ===
        'bill_awaiting_payment'
      )
        toast.error(t('tableAwaitingPaymentLocked'));
      else toastApiError(error, t('couldNotSendOrder'), apiErrorT);
    } finally {
      sendInFlightRef.current = false;
      setSending(false);
    }
  }

  const activeTable = tables.find((table) => table.id === selectedTableId) || null;
  // When the cashier asks this table to confirm serving, its ordered items open without a tap.
  const activeServeConfirmFlag = (activeTable?.activeOrder || activeTable?.current_order)
    ?.serve_confirm_requested_at;
  // Kitchen chips only for a table that has ordered, or that the cashier asked to confirm serving.
  const showKitchenSummary =
    Boolean(activeServeConfirmFlag) ||
    (currentOrder?.items ?? []).some((item) => !isCancelledItem(String(item.status)));
  const serveConfirmSeenRef = useRef('');
  useEffect(() => {
    const key =
      activeServeConfirmFlag && selectedTableId
        ? `${selectedTableId}|${activeServeConfirmFlag}`
        : '';
    if (!key || key === serveConfirmSeenRef.current) return;
    serveConfirmSeenRef.current = key;
    setOrderedItemsOpen(true);
  }, [activeServeConfirmFlag, selectedTableId]);
  const orderingLocked =
    awaitingPayment(currentOrder) ||
    awaitingPayment(activeTable?.activeOrder || activeTable?.current_order);
  const headerTableText = activeTable
    ? t('tableLabel', { name: activeTable.name ?? String(activeTable.number) })
    : t('selectTable');
  const canMoveTable = tenantCan(user as unknown as Tenant, 'tables.orders.move');
  const draftTotal = draft.reduce((sum, line) => {
    const addonTotal = line.addons.reduce(
      (addonSum, addon) => addonSum + Number(addon.price || 0) * (addon.quantity || 1),
      0,
    );
    return (
      sum + ((Number(line.variant?.price ?? line.product.price) || 0) + addonTotal) * line.quantity
    );
  }, 0);
  const draftQuantities = useMemo(() => {
    const quantities = new Map<string, number>();
    for (const line of draft) {
      quantities.set(line.product.id, (quantities.get(line.product.id) || 0) + line.quantity);
    }
    return quantities;
  }, [draft]);
  const draftItemCount = draft.reduce((sum, line) => sum + line.quantity, 0);

  /** Opens the table list to pick where the ticket goes; the cart comes back once a table is picked. */
  function chooseTableToSend(reopenCart: boolean) {
    reopenCartAfterTableRef.current = reopenCart;
    setMobileCartOpen(false);
    setTablePickerOpen(true);
    // Below the three-column layout the table list sits above the menu, out of view from here.
    window.setTimeout(() => tablePickerRef.current?.scrollIntoView({ block: 'start' }), 350);
  }
  useReloadOnNewBuild('/api/server-app/info', draft.length === 0 && !sending);

  const guestMode = !user && !!guestTable && !showLogin;
  // Customers ordering from a table QR always see the day theme; staff keep the app's theme.
  const customerFacing = !user;
  useEffect(() => (customerFacing ? holdDarkClass(false) : undefined), [customerFacing]);
  const waitingForGuest =
    !user && (guestTableId === undefined || (!!guestTableId && !guestChecked));

  if (loading || waitingForGuest) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-brand border-t-transparent" />
      </div>
    );
  }

  if (disabled) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background px-6 text-center text-foreground">
        <Smartphone size={44} className="text-muted-foreground" />
        <h1 className="text-lg font-semibold">{t('disabledTitle')}</h1>
        <p className="max-w-sm text-sm text-muted-foreground">{t('disabledHint')}</p>
      </div>
    );
  }

  if (!user && guestExpired && !showLogin) {
    return (
      <div
        data-testid="server-app-guest-expired"
        className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background px-6 text-center text-foreground"
      >
        <QrCode size={44} className="text-muted-foreground" />
        <h1 className="text-lg font-semibold">{t('guestExpiredTitle')}</h1>
        <p className="max-w-sm text-sm text-muted-foreground">{t('guestExpiredHint')}</p>
      </div>
    );
  }

  if (!user && guestGate && !showLogin) {
    return (
      <div
        data-testid={`server-app-guest-${guestGate.kind}`}
        className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center text-foreground"
      >
        <QrCode size={44} className="text-muted-foreground" />
        <h1 className="text-lg font-semibold">{t('tableLabel', { name: guestGate.table.name })}</h1>
        {guestGate.kind === 'tap' ? (
          <button
            type="button"
            onClick={() => setGuestTapped(true)}
            disabled={guestTapped}
            data-testid="server-app-guest-start"
            className="h-14 w-full max-w-xs rounded-xl bg-brand text-lg font-semibold text-white disabled:opacity-60"
          >
            {t('guestTapToOrder')}
          </button>
        ) : guestGate.kind === 'waiting' ? (
          <>
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand border-t-transparent" />
            <p className="max-w-sm text-sm text-muted-foreground">{t('guestWaitingHint')}</p>
          </>
        ) : (
          <>
            <p className="max-w-sm text-sm text-muted-foreground">{t('guestDeclinedHint')}</p>
            <button
              type="button"
              onClick={askStaffAgain}
              className="h-11 rounded-lg bg-brand px-6 font-semibold text-white"
            >
              {t('guestAskAgain')}
            </button>
          </>
        )}
      </div>
    );
  }

  if (!user && guestClosed && !showLogin) {
    return (
      <div
        data-testid="server-app-guest-closed"
        className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background px-6 text-center text-foreground"
      >
        <QrCode size={44} className="text-muted-foreground" />
        <h1 className="text-lg font-semibold">{t('guestClosedTitle')}</h1>
        <p className="max-w-sm text-sm text-muted-foreground">{t('guestClosedHint')}</p>
      </div>
    );
  }

  if (!user && !guestMode) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <form
          onSubmit={handleLogin}
          className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-sm"
        >
          {regional?.server_time && regional.timezone && (
            <div className="-mx-6 -mt-6 mb-5 rounded-t-xl border-b border-border bg-muted/40 px-6 py-4">
              <StoreClock
                key={regional.server_time}
                serverTime={regional.server_time}
                timezone={regional.timezone}
                country={regional.country}
              />
            </div>
          )}
          <div className="mb-6 text-center">
            <UserRound size={42} className="mx-auto mb-3 text-red-600" aria-hidden="true" />
            <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t('loginSubtitle')}</p>
          </div>
          <div className="space-y-3">
            <input
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              type="text"
              autoComplete="username"
              placeholder={t('staffNamePlaceholder')}
              required
              className="h-11 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20"
            />
            <input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              autoComplete="current-password"
              placeholder={t('staffCodePlaceholder')}
              required
              className="h-11 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20"
            />
            <button
              disabled={loginLoading}
              className="h-11 w-full rounded-lg bg-brand font-semibold text-white disabled:opacity-60"
            >
              {loginLoading ? tAuth('signingIn') : tAuth('signIn')}
            </button>
          </div>
          <p className="mt-4 text-center text-xs text-muted-foreground">{t('loginHint')}</p>
          {guestTable && (
            <button
              type="button"
              onClick={() => setShowLogin(false)}
              className="mt-3 w-full text-center text-sm font-medium text-muted-foreground underline"
            >
              {t('continueAsGuest')}
            </button>
          )}
        </form>
      </div>
    );
  }

  const ticketPanelBody = (
    <>
      <div className="relative flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{t('currentTicket')}</h2>
        {currentOrder && activeTable && canMoveTable && (
          <button
            type="button"
            disabled={sending}
            onClick={() => {
              if (sendInFlightRef.current) return;
              setMobileCartOpen(false);
              setMoveTableModalOpen(true);
            }}
            className="flex items-center gap-1 text-xs font-medium text-brand hover:underline disabled:opacity-50"
          >
            <ArrowRightLeft size={13} />
            {tTables('moveTable')}
          </button>
        )}
        {user && currentOrder && selectedTableId && (
          <>
            <button
              type="button"
              data-testid="server-app-ticket-menu"
              aria-label={t('ticketActions')}
              aria-haspopup="menu"
              aria-expanded={ticketMenuOpen}
              disabled={sending}
              onClick={() => setTicketMenuOpen((open) => !open)}
              className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-muted-foreground disabled:opacity-50"
            >
              <MoreVertical size={18} />
            </button>
            {ticketMenuOpen && (
              <div
                role="menu"
                className="absolute end-0 top-full z-20 min-w-44 overflow-hidden rounded-lg border border-border bg-card shadow-lg"
              >
                {(['move', 'merge'] as const)
                  .filter((mode) => mode === 'merge' || canMoveTable)
                  .map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setTicketMenuOpen(false);
                        setMobileCartOpen(false);
                        setTransferMode(mode);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2.5 text-start text-sm hover:bg-muted"
                    >
                      {mode === 'move' ? <ArrowLeftRight size={16} /> : <Merge size={16} />}
                      {mode === 'move' ? t('moveTable') : t('mergeTable')}
                    </button>
                  ))}
              </div>
            )}
          </>
        )}
      </div>

      {isWide && user && currentOrder && selectedTableId && showKitchenSummary && (
        <div className="mt-2">
          <TableKitchenSummary
            items={(currentOrder.items ?? []) as OrderedItem[]}
            onOpenDetails={() => setOrderedItemsOpen(true)}
          />
        </div>
      )}

      <div className="mt-4 border-t border-border pt-3">
        <p className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
          {t('newItems')}
        </p>
        {draft.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t('emptyDraft')}</p>
        ) : (
          <div className="space-y-3">
            {draft.map((line) => (
              <div key={line.id} className="rounded-lg border border-border p-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {line.variant
                        ? `${line.product.name} (${line.variant.name})`
                        : line.product.name}
                    </span>
                    {line.addons.length > 0 && (
                      <div className="mt-0.5 space-y-0.5">
                        {line.addons.map((addon) => (
                          <p key={addon.id} className="truncate text-xs text-muted-foreground">
                            + {addon.name}
                            {(addon.quantity || 1) > 1 ? ` x${addon.quantity}` : ''}
                          </p>
                        ))}
                      </div>
                    )}
                    {line.special_instructions && (
                      <p className="mt-0.5 truncate text-xs italic text-muted-foreground">
                        {line.special_instructions}
                      </p>
                    )}
                  </div>
                  <button
                    disabled={sending}
                    onClick={() => removeDraftLine(line.id)}
                    aria-label={tCommon('removeItem')}
                    className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-red-500 disabled:opacity-50"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <button
                      disabled={sending}
                      onClick={() => changeQty(line.id, -1)}
                      className="rounded-md border border-border bg-card p-1 disabled:opacity-50"
                    >
                      <Minus size={14} />
                    </button>
                    <span className="w-6 text-center text-sm font-semibold">
                      <Ltr>{line.quantity}</Ltr>
                    </span>
                    <button
                      disabled={sending}
                      onClick={() => changeQty(line.id, 1)}
                      className="rounded-md border border-border bg-card p-1 disabled:opacity-50"
                    >
                      <Plus size={14} />
                    </button>
                  </div>
                  <button
                    disabled={sending}
                    onClick={() => openEditDraftModal(line)}
                    className="flex items-center gap-1 rounded-full bg-amber-100 px-2 py-1 text-xs font-medium text-amber-700 hover:bg-amber-200 disabled:opacity-50 dark:bg-amber-950/40 dark:text-amber-300 dark:hover:bg-amber-950/60"
                  >
                    <SquarePen size={12} />
                    {tCommon('edit')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {draft.length > 0 && (
        <div className="mt-3">
          <textarea
            value={orderNotes}
            disabled={sending}
            onChange={(event) => handleOrderNotesChange(event.target.value)}
            placeholder={tPos('orderNotesPlaceholder')}
            rows={2}
            maxLength={200}
            className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-brand focus:outline-none disabled:opacity-50"
          />
          <p className="mt-0.5 text-end text-xs text-muted-foreground">
            <Ltr>{orderNotes.length}/200</Ltr>
          </p>
        </div>
      )}

      {currentOrder?.items && currentOrder.items.length > 0 && (
        <div className="mt-4 border-t border-border pt-3">
          <p
            data-testid="server-app-sent-heading"
            className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground"
          >
            <span>{t('sentToKitchen')}</span>
            <Ltr
              as="span"
              className="rounded bg-muted px-1.5 py-0.5 font-mono normal-case text-foreground"
            >
              #{currentOrder.order_number}
            </Ltr>
          </p>
          <OrderedItemList
            itemTestId="server-app-ticket-item"
            items={currentOrder.items as OrderedItem[]}
            onTakeaway={(item) => changeSentItem(item.id, 'takeaway')}
            onCancel={(item) => changeSentItem(item.id, 'cancel')}
            onConfirmServed={(item) => changeSentItem(item.id, 'confirm-served')}
          />
        </div>
      )}

      {/* The total and send button stay in view however long the sent list grows. */}
      <div className="sticky bottom-0 z-10 -mx-3 mt-4 bg-card px-3 pb-3">
        <div className="flex items-center justify-between border-t border-border pt-3">
          <span className="text-sm text-muted-foreground">{t('draftTotal')}</span>
          <span className="text-lg font-bold">
            <Ltr>{money(draftTotal, regional)}</Ltr>
          </span>
        </div>
        {!selectedTableId && user ? (
          <button
            type="button"
            data-testid="server-app-choose-table"
            onClick={() => chooseTableToSend(mobileCartOpen)}
            className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-lg border border-amber-400 bg-amber-50 font-semibold text-amber-700"
          >
            <UtensilsCrossed size={17} />
            {t('chooseTableFirst')}
          </button>
        ) : (
          <button
            onClick={sendDraft}
            disabled={
              !selectedTableId ||
              orderingLocked ||
              orderLoadedTableId !== selectedTableId ||
              draft.length === 0 ||
              sending
            }
            className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-brand font-semibold text-white disabled:opacity-50"
          >
            <Send size={17} />
            {sending ? t('sending') : currentOrder ? t('addToOrder') : t('sendToKitchen')}
          </button>
        )}
      </div>
    </>
  );

  return (
    <div className="min-h-screen bg-background text-foreground">
      <ServerAppHeader
        businessName={regional?.business_name ?? ''}
        logoUrl={
          regional?.store_logo_version
            ? `/api/server-app/branding/logo?v=${regional.store_logo_version}`
            : null
        }
        coverUrl={
          regional?.store_cover_version
            ? `/api/server-app/branding/cover?v=${regional.store_cover_version}`
            : null
        }
        tableText={headerTableText}
        customerName={
          (user
            ? (currentOrder?.customer?.name ?? customerName.trim())
            : guestOrder?.customer_name) || null
        }
        language={language}
        onLanguage={chooseLanguage}
        onHistory={() => (user ? setOrderedItemsOpen(true) : setGuestHistoryOpen(true))}
        historyDisabled={user ? !activeTable : !guestTable}
        actions={
          <>
            {user ? (
              <>
                <span
                  data-testid="server-app-staff-name"
                  className="hidden max-w-[96px] truncate text-sm font-medium text-white drop-shadow min-[400px]:block"
                >
                  {user.name}
                </span>
                {!isWide && (
                  <button
                    type="button"
                    disabled={sending}
                    onClick={() => setTablePickerOpen((open) => !open)}
                    aria-expanded={showTablePicker}
                    data-testid="server-app-table-button"
                    className="flex h-12 items-center gap-1.5 whitespace-nowrap rounded-full border border-amber-400 bg-amber-50 px-4 text-sm font-medium text-amber-700 shadow-md transition-colors hover:bg-amber-100 disabled:opacity-50"
                  >
                    <UtensilsCrossed size={14} />
                    {t('selectTable')}
                  </button>
                )}
                {selectedTableId && (
                  <button
                    type="button"
                    onClick={() => setTableQrOpen(true)}
                    aria-label={tTables('guestQrButton')}
                    title={tTables('guestQrButton')}
                    data-testid="server-app-table-qr-button"
                    className="flex size-12 items-center justify-center rounded-full bg-white text-neutral-800 shadow-md"
                  >
                    <QrCode size={17} />
                  </button>
                )}
              </>
            ) : (
              <span
                data-testid="server-app-guest-name"
                className="text-sm font-medium text-white drop-shadow"
              >
                {t('guestLabel')}
              </span>
            )}
            {user ? (
              <button
                onClick={logout}
                aria-label={tNav('logout')}
                title={tNav('logout')}
                data-testid="server-app-session-button"
                className="flex size-12 items-center justify-center rounded-full border border-green-600 bg-white text-green-600 shadow-md"
              >
                <UserRound size={17} />
              </button>
            ) : (
              <StaffSignIn onClick={() => setShowLogin(true)} />
            )}
          </>
        }
      />
      {!user && (
        <GuestOrderHistory
          open={guestHistoryOpen}
          onClose={() => setGuestHistoryOpen(false)}
          order={guestOrder}
          loading={!guestOrderLoaded}
          formatPrice={(amount) => money(amount, regional)}
        />
      )}

      {tablesLoaded && tables.length === 0 ? (
        <div className="flex min-h-[70vh] flex-col items-center justify-center gap-3 px-6 text-center">
          <LayoutGrid size={44} className="text-muted-foreground" />
          <h2 className="text-lg font-semibold">{t('noTablesTitle')}</h2>
          <p className="max-w-sm text-sm text-muted-foreground">{t('noTablesHint')}</p>
        </div>
      ) : (
        <main
          className={`mx-auto grid max-w-6xl min-w-0 gap-3 px-4 py-2 md:p-3 ${showTablePicker ? 'md:grid-cols-[180px_1fr] lg:grid-cols-[220px_1fr_340px]' : 'lg:grid-cols-[1fr_340px]'}`}
        >
          <GuestAlerts api={api} apiPrefix="/api" enabled={!!user} />
          {tableQrOpen && api && selectedTableId && (
            <GuestTableQrDialog
              tableId={selectedTableId}
              api={api}
              apiPrefix="/api"
              onClose={() => setTableQrOpen(false)}
            />
          )}
          {serveConfirmTables.length > 0 && (
            <div
              data-testid="serve-confirm-alerts"
              className="flex flex-wrap gap-2 md:col-span-full"
            >
              {serveConfirmTables.map((table) => (
                <button
                  key={table.id}
                  type="button"
                  data-testid="serve-confirm-alert"
                  onClick={() => {
                    selectTable(table.id);
                    if (!isWide) setTablePickerOpen(false);
                    setOrderedItemsOpen(true);
                  }}
                  className="animate-pulse rounded-lg border-2 border-red-500 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700"
                >
                  {t('serveConfirmRequested', { table: table.name || table.number || '' })}
                </button>
              ))}
            </div>
          )}
          {showTablePicker && (
            <section
              ref={tablePickerRef}
              data-testid="server-app-table-picker"
              className="min-w-0 scroll-mt-20 md:rounded-lg md:border md:border-border md:bg-card md:p-3"
            >
              <h2 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
                {t('tables')}
              </h2>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-1">
                {staffAreaOnly && tablesLoaded && staffTables.length === 0 && (
                  <p className="text-sm text-muted-foreground">{tPos('noTablesFound')}</p>
                )}
                {staffTables.map((table) => {
                  const selected = table.id === selectedTableId;
                  const order = table.activeOrder || table.current_order;
                  // Serving tables are light green, ones waiting to pay amber with a clock, cleaning
                  // ones light yellow, free ones white.
                  const tone = order
                    ? order.serve_confirm_requested_at
                      ? 'confirm'
                      : awaitingPayment(order)
                        ? 'awaiting'
                        : 'serving'
                    : table.status === 'cleaning'
                      ? 'cleaning'
                      : 'available';
                  const toneClass = {
                    serving: 'border-green-300 bg-green-100',
                    confirm: 'animate-pulse border-2 border-red-500 bg-red-50',
                    awaiting: 'border-amber-300 bg-amber-50',
                    cleaning: 'border-yellow-300 bg-yellow-100',
                    available: 'border-gray-200 bg-white',
                  }[tone];
                  return (
                    <button
                      key={table.id}
                      disabled={sending}
                      // A phone folds the list away once a table is picked, leaving the menu.
                      onClick={() => {
                        selectTable(table.id);
                        if (!isWide) setTablePickerOpen(false);
                        if (tone === 'confirm') setOrderedItemsOpen(true);
                        if (reopenCartAfterTableRef.current) {
                          reopenCartAfterTableRef.current = false;
                          if (!isWide) setMobileCartOpen(true);
                        }
                      }}
                      data-table-tone={tone}
                      className={`flex min-h-14 items-center gap-2 rounded-lg border px-2 py-2 text-start text-gray-900 disabled:opacity-50 ${toneClass} ${selected ? 'ring-2 ring-brand' : ''}`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold">
                          {table.name || table.number}
                        </span>
                        <span className="text-xs text-gray-600">
                          {tone === 'confirm' ? (
                            <span className="font-semibold text-red-700">
                              {t('serveConfirmNeeded')}
                            </span>
                          ) : tone === 'awaiting' ? (
                            t('tableAwaitingPayment')
                          ) : order ? (
                            t('openOrder')
                          ) : tone === 'cleaning' ? (
                            tTables('statusCleaning')
                          ) : (
                            tTables('statusAvailable')
                          )}
                          {order?.kitchen_counts && (
                            <Ltr
                              as="span"
                              data-testid="table-kitchen-counts"
                              title={t('kitchenCountsTitle', order.kitchen_counts)}
                              className="ms-1 tabular-nums text-gray-500"
                            >
                              {order.kitchen_counts.waiting}-{order.kitchen_counts.ready}-
                              {order.kitchen_counts.served}
                            </Ltr>
                          )}
                        </span>
                      </span>
                      {tone === 'awaiting' && (
                        <span
                          data-testid="table-awaiting-payment"
                          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-600"
                        >
                          <Clock size={17} />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {/* svh, not dvh: the menu keeps its height while a phone browser's toolbar slides in and out.
              On a phone the menu has no frame of its own, so the photos get the full width. */}
          <section className="flex h-[calc(100svh-5rem)] min-h-96 min-w-0 flex-col md:rounded-lg md:border md:border-border md:bg-card md:p-3">
            {user && !tablePickerOpen && activeTable && !isWide && showKitchenSummary && (
              <div data-testid="server-app-table-actions" className="mb-3">
                <TableKitchenSummary
                  items={(currentOrder?.items ?? []) as OrderedItem[]}
                  onOpenDetails={() => setOrderedItemsOpen(true)}
                />
              </div>
            )}
            {orderingLocked && (
              <div
                data-testid="server-app-awaiting-payment"
                className="mb-3 flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800"
              >
                <Clock size={17} className="shrink-0 text-amber-600" />
                {t('tableAwaitingPaymentLocked')}
              </div>
            )}
            {!user && guestDeliveryStatus && (
              <p role="status" className="mb-3 rounded-lg bg-muted px-3 py-2 text-sm">
                {guestDeliveryStatus.kind === 'received'
                  ? t('guestOrderReceived', { orderNumber: guestDeliveryStatus.orderNumber })
                  : t(
                      guestDeliveryStatus.kind === 'queued'
                        ? 'guestOrderQueued'
                        : guestDeliveryStatus.kind === 'review'
                          ? 'guestOrderNeedsReview'
                          : 'couldNotSendOrder',
                    )}
              </p>
            )}
            <ProductGrid
              categories={categories}
              products={products}
              selectedCategory={selectedCategoryId}
              setSelectedCategory={setSelectedCategoryId}
              search={query}
              setSearch={setQuery}
              currency={regional?.currency || ''}
              categorySort={regional?.category_sort}
              itemSort={regional?.item_sort}
              disabled={sending || orderingLocked}
              onProductClick={(product, quantity) => {
                if (sendInFlightRef.current) return;
                if (productNeedsCustomizer(product)) {
                  openAddonModal(product, quantity, null);
                } else addDraftLine(product, quantity, [], '');
              }}
              onScannedVariant={(product, variant, quantity) => {
                if (sendInFlightRef.current) return;
                if (scannedVariantNeedsCustomizer(product, variant)) {
                  openAddonModal(product, quantity, variant);
                } else addDraftLine(product, quantity, [], '', variant);
              }}
              onScaledProduct={(product, quantity) => {
                if (sendInFlightRef.current) return;
                addDraftLine(product, quantity, [], '');
              }}
              cartQuantities={draftQuantities}
              formatPrice={(amount) => money(amount, regional)}
              showImages={true}
              gridClassName="grid-cols-2"
              searchPlaceholder={t('searchMenu')}
              quickFilters={quickFilters}
              scrollSpy
              loopSections
              flat
            />
          </section>

          <section
            data-testid="server-app-ticket-panel"
            className={`${showTablePicker ? 'md:col-span-2 lg:col-span-1' : ''} hidden min-w-0 rounded-lg border border-border bg-card p-3 pb-0 md:block md:sticky md:top-16 md:max-h-[calc(100dvh-5rem)] md:self-start md:overflow-y-auto`}
          >
            {ticketPanelBody}
          </section>
        </main>
      )}

      {transferMode && activeTable && (
        <TableTransferDialog
          mode={transferMode}
          fromName={activeTable.name ?? String(activeTable.number)}
          fromId={activeTable.id}
          busy={transferring}
          tables={tables.map((table) => ({
            id: table.id,
            name: table.name ?? String(table.number),
            occupied: Boolean(table.activeOrder || table.current_order),
            reserved: table.status === 'reserved',
          }))}
          onConfirm={(target) => void transferOrderTo(transferMode, target)}
          onClose={() => setTransferMode(null)}
        />
      )}

      {orderedItemsOpen && activeTable && (
        <OrderedItemsScreen
          tableName={activeTable.name ?? String(activeTable.number)}
          orderNumber={currentOrder?.order_number}
          items={(currentOrder?.items ?? []) as OrderedItem[]}
          onBack={() => setOrderedItemsOpen(false)}
          onAddItems={() => {
            setOrderedItemsOpen(false);
            setTablePickerOpen(false);
          }}
          addItemsLocked={orderingLocked}
          onTakeaway={(item) => changeSentItem(item.id, 'takeaway')}
          onCancel={(item) => changeSentItem(item.id, 'cancel')}
          onConfirmServed={(item) => changeSentItem(item.id, 'confirm-served')}
          onConfirmServedMany={confirmServedMany}
          serveConfirmRequested={Boolean(currentOrder?.serve_confirm_requested_at)}
          total={currentOrder?.total}
          formatPrice={(amount) => money(amount, regional)}
          imageOf={productImageOf}
          onPrintBill={requestBill}
          onMoveTable={canMoveTable ? () => setTransferMode('move') : undefined}
          onMergeTable={() => setTransferMode('merge')}
        />
      )}

      <Drawer
        open={mobileCartOpen}
        onOpenChange={(open) => {
          // With food waiting and no table yet, the cart button goes straight to the tables.
          if (open && user && !selectedTableId && draftItemCount > 0) chooseTableToSend(true);
          else setMobileCartOpen(open);
        }}
      >
        <DrawerTrigger asChild>
          <button
            data-testid="server-app-cart-button"
            className={`${orderedItemsOpen ? 'hidden' : 'flex'} fixed bottom-5 end-5 z-40 h-14 w-14 items-center justify-center rounded-full bg-brand text-white shadow-lg hover:bg-brand-hover active:bg-brand-hover md:hidden`}
            aria-label={t('currentTicket')}
          >
            <ShoppingCart size={22} />
            {draftItemCount > 0 && (
              <span className="absolute -top-0.5 -end-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-xs font-bold text-white">
                <Ltr>{draftItemCount}</Ltr>
              </span>
            )}
          </button>
        </DrawerTrigger>
        <DrawerContent className="max-h-[85vh] text-foreground">
          <div className="max-h-[80vh] overflow-y-auto px-3 pb-3">{ticketPanelBody}</div>
        </DrawerContent>
      </Drawer>

      {addonModalProduct && (
        <AddonModal
          product={addonModalProduct}
          currency={regional?.currency || ''}
          country={regional?.country}
          initialQuantity={addonModalQuantity}
          initialVariant={addonModalVariant}
          onAdd={(addedProduct, quantity, addons, instructions, variant) => {
            if (sendInFlightRef.current || addonModalSendSeqRef.current !== sendSeqRef.current) {
              return;
            }
            addDraftLine(addedProduct, quantity, addons, instructions, variant);
          }}
          onClose={() => {
            setAddonModalProduct(null);
            setAddonModalQuantity(1);
            setAddonModalVariant(null);
          }}
        />
      )}

      {editingDraftLine && (
        <AddonModal
          product={editingDraftLine.product}
          currency={regional?.currency || ''}
          country={regional?.country}
          mode="edit"
          initialQuantity={editingDraftLine.quantity}
          initialAddons={editingDraftLine.addons}
          initialInstructions={editingDraftLine.special_instructions}
          initialVariant={editingDraftLine.variant}
          onAdd={(_editedProduct, quantity, addons, instructions, variant) => {
            if (sendInFlightRef.current || editingDraftSendSeqRef.current !== sendSeqRef.current) {
              return;
            }
            updateDraftLine(editingDraftLine.id, quantity, addons, instructions, variant);
          }}
          onClose={() => {
            setEditingDraftLine(null);
            if (reopenCartAfterEditRef.current) setMobileCartOpen(true);
            reopenCartAfterEditRef.current = false;
          }}
        />
      )}

      {moveTableModalOpen && activeTable && currentOrder && canMoveTable && (
        <MoveTableModal
          sourceTable={
            {
              ...activeTable,
              activeOrder: currentOrder,
            } as unknown as FullTable
          }
          apiClient={api || undefined}
          formatPrice={(amount) => money(amount, regional)}
          onClose={() => setMoveTableModalOpen(false)}
          onSuccess={async (movedData) => {
            const sourceTableId = String(
              (movedData.sourceTable as Table | undefined)?.id ?? activeTable.id,
            );
            const targetTable = movedData.targetTable as Table;
            const targetTableId = String(targetTable.id);
            const targetTableName = targetTable.name || targetTable.number;
            movePendingSendAttempt(sourceTableId, targetTableId, targetTableName);
            setMoveTableModalOpen(false);
            if (selectedTableIdRef.current === sourceTableId) {
              selectTable(targetTableId);
            }
            await loadAll().catch(() => {});
          }}
        />
      )}
    </div>
  );
}
