import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider, useTranslations } from 'use-intl';
import { Minus, Plus, Send, ShoppingCart, SquarePen, Trash2 } from 'lucide-react';
import toast, { Toaster } from 'react-hot-toast';
import ProductGrid from '@/components/pos/ProductGrid';
import AddonModal from '@/components/pos/AddonModal';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerContent, DrawerTitle, DrawerTrigger } from '@/components/ui/drawer';
import { StaffSignIn } from '@/components/server-app/StaffSignIn';
import { ItemStatusBadge } from '@/components/server-app/ItemStatus';
import { Ltr } from '@/components/layout/Ltr';
import {
  presentCloudMenu,
  type CloudMenuItem,
  type PosMenuPresentation,
} from '@/lib/cloud-menu-presentation';
import { productNeedsCustomizer } from '@/lib/product-variants';
import type { Addon, Product, ProductVariant } from '@/lib/types';
import messages from '@/lib/i18n/messages/th.json';

interface Line {
  menu_item_id: string;
  quantity: number;
  note?: string;
  addons?: { id: string; quantity: number }[];
}

interface Attempt {
  key: string;
  body: { menu_revision?: string; note?: string; items: Line[] };
}

interface SentOrder {
  id: string;
  status: string;
  pos_order_number: string | null;
  items: {
    name: string;
    quantity: number;
    note: string;
    status?: string | null;
    addons: { name: string; quantity: number }[];
  }[];
}

const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const money = new Intl.NumberFormat('th-TH', { style: 'currency', currency: 'THB' });
const assetUrl = (file: string) => new URL(file, import.meta.url).href;
const lineKey = (line: Line) =>
  JSON.stringify([
    line.menu_item_id,
    (line.addons ?? []).map(({ id, quantity }) => [id, quantity]).sort(),
  ]);

function request(path: string, options?: RequestInit) {
  return fetch(path, {
    ...options,
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    mode: 'same-origin',
    signal: AbortSignal.timeout(15_000),
  });
}

async function session() {
  const params = new URLSearchParams(location.hash.slice(1));
  const table = params.get('table');
  const supplied = params.get('table_token');
  if (supplied && tokenPattern.test(supplied)) return { token: supplied, cache: null };
  if (!table || !uuid.test(table)) throw new Error('กรุณาสแกน QR ประจำโต๊ะจากร้าน');
  const cache = `flocafe-table-session:${table}`;
  const cached = sessionStorage.getItem(cache);
  if (cached && tokenPattern.test(cached)) return { token: cached, cache };
  const response = await request('/api/v1/table-qr/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ table_key: table }),
  });
  if (response.status === 409) return null;
  if (response.status === 429) throw new Error('มีอุปกรณ์ใช้โต๊ะนี้ครบแล้ว กรุณาติดต่อพนักงาน');
  if (!response.ok) throw new Error('ติดต่อระบบสั่งอาหารไม่ได้ กรุณาลองอีกครั้ง');
  const { table_token } = await response.json();
  if (!tokenPattern.test(table_token)) throw new Error('เปิดรายการสั่งอาหารไม่ได้ กรุณาติดต่อพนักงาน');
  sessionStorage.setItem(cache, table_token);
  return { token: table_token as string, cache };
}

async function readMenu(
  response: Response,
): Promise<{ items: CloudMenuItem[]; revision?: string }> {
  if (!response.ok) throw new Error('โหลดเมนูไม่สำเร็จ กรุณาลองอีกครั้ง');
  const data = await response.json();
  if (
    !Array.isArray(data.items) ||
    !data.items.every(
      (item: CloudMenuItem) =>
        item &&
        typeof item.id === 'string' &&
        uuid.test(item.id) &&
        typeof item.name === 'string' &&
        Number.isSafeInteger(item.price_satang) &&
        item.price_satang >= 0 &&
        (item.category == null || typeof item.category === 'string'),
    )
  )
    throw new Error('โหลดเมนูไม่สำเร็จ');
  return {
    items: data.items,
    revision: uuid.test(data.menu_revision ?? '') ? data.menu_revision : undefined,
  };
}

function readSentOrders(data: unknown): SentOrder[] | null {
  const orders = (data as { orders?: unknown })?.orders;
  if (!Array.isArray(orders)) return null;
  return orders.every(
    (order: SentOrder) =>
      order &&
      typeof order.id === 'string' &&
      typeof order.status === 'string' &&
      Array.isArray(order.items) &&
      order.items.every(
        (item) =>
          item &&
          typeof item.name === 'string' &&
          Number.isSafeInteger(item.quantity) &&
          Array.isArray(item.addons),
      ),
  )
    ? orders
    : null;
}

function SentStatus({ status }: { status: string }) {
  if (status === 'created' || status === 'sent_to_pos') {
    return (
      <span className="shrink-0 whitespace-nowrap rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-300">
        รอร้านรับออเดอร์
      </span>
    );
  }
  return <ItemStatusBadge status={status === 'pos_accepted' ? 'pending' : status} />;
}

function staffAreaUrl(address: string) {
  const url = new URL(address);
  url.searchParams.set('staff', 'area');
  return url.href;
}

function Ordering() {
  const t = useTranslations('serverApp');
  const tCommon = useTranslations('common');
  const tPos = useTranslations('pos');
  const [menu, setMenu] = useState<CloudMenuItem[]>([]);
  const [snapshot, setSnapshot] = useState<PosMenuPresentation>();
  const [category, setCategory] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [cart, setCart] = useState<Line[]>([]);
  const [customize, setCustomize] = useState<{
    product: Product;
    quantity: number;
    variant?: ProductVariant;
  }>();
  const [editing, setEditing] = useState<{
    key: string;
    product: Product;
    line: Line;
    variant?: ProductVariant;
    addons: Addon[];
  }>();
  const [orderNote, setOrderNote] = useState('');
  const [sent, setSent] = useState<SentOrder[]>([]);
  const announced = useRef(new Map<string, string | null>());
  const [pending, setPending] = useState<Attempt>();
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [expired, setExpired] = useState(false);
  const [status, setStatus] = useState('กำลังตรวจสอบ QR ของโต๊ะ…');
  const [canReload, setCanReload] = useState(false);
  const [ready, setReady] = useState(false);
  const flight = useRef(false);
  const context = useRef<{ token: string; storageKey: string; revision?: string } | null>(null);
  const presentation = useMemo(() => presentCloudMenu(menu, snapshot), [menu, snapshot]);

  const load = useCallback(async () => {
    try {
      const current = await session();
      const browse = async () => {
        const table = new URLSearchParams(location.hash.slice(1)).get('table');
        if (!table || !uuid.test(table)) throw new Error('กรุณาสแกน QR ประจำโต๊ะจากร้าน');
        const data = await readMenu(
          await request('/api/v1/menu', { headers: { 'X-Flo-Table-Key': table } }),
        );
        context.current = null;
        setMenu(data.items);
        setReady(true);
        setExpired(true);
        setCanReload(true);
        setStatus('ดูเมนูได้ โต๊ะนี้ยังไม่เปิดรับออเดอร์ กรุณาแจ้งพนักงาน');
      };
      if (!current) {
        await browse();
        return;
      }
      const { token, cache } = current;
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
      const storageKey =
        'flocafe-order:' +
        Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
      const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') as Attempt | null;
      context.current = { token, storageKey };
      setPending(saved ?? undefined);
      if (saved) setOpen(true);
      const response = await request('/api/v1/menu', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.status === 401) {
        if (cache && !saved) sessionStorage.removeItem(cache);
        setExpired(true);
        if (saved) throw new Error('QR หมดอายุและยังไม่ทราบผล กรุณาให้พนักงานตรวจสอบออเดอร์');
        if (cache) {
          await browse();
          return;
        }
        throw new Error('QR หมดอายุ กรุณาลองใหม่หรือขอ QR จากพนักงาน');
      }
      const data = await readMenu(response);
      context.current.revision = data.revision;
      setMenu(data.items);
      setReady(true);
      setCanReload(false);
      setExpired(false);
      setStatus(saved ? 'ยังไม่ทราบผลของรายการก่อนหน้า กดส่งรายการเดิมอีกครั้งเพื่อตรวจผล' : '');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'เปิดรายการสั่งอาหารไม่ได้ กรุณาลองใหม่');
      setCanReload(true);
    }
  }, []);

  const refreshSent = useCallback(async () => {
    const current = context.current;
    if (!current) return;
    try {
      const response = await request('/api/v1/table-session/orders', {
        headers: { Authorization: `Bearer ${current.token}` },
      });
      if (!response.ok) return;
      const orders = readSentOrders(await response.json());
      if (!orders) return;
      const seen = announced.current;
      for (const order of orders) {
        order.items.forEach((item, index) => {
          const key = `${order.id}:${index}`;
          const status = item.status ?? null;
          const before = seen.get(key);
          seen.set(key, status);
          if (before === undefined || before === status) return;
          if (status === 'preparing' || status === 'ready' || status === 'served') {
            const label =
              status === 'preparing'
                ? t('statusPreparing')
                : status === 'ready'
                  ? t('statusReady')
                  : t('statusServed');
            toast(`${item.name} · ${label}`, {
              icon: status === 'ready' ? '🔔' : undefined,
              duration: 6000,
            });
            if (status === 'ready') navigator.vibrate?.([200, 100, 200]);
          }
        });
      }
      setSent(orders);
    } catch {
      // The sent list is informational; ordering keeps working without it.
    }
  }, [t]);

  useEffect(() => {
    if (ready && !expired) void refreshSent();
  }, [ready, expired, refreshSent]);

  const cooking = sent.some(
    (order) =>
      order.status !== 'cancelled' &&
      order.items.some((item) => item.status !== 'served' && item.status !== 'cancelled'),
  );
  useEffect(() => {
    if (!(open || cooking) || !ready || expired) return;
    void refreshSent();
    const timer = window.setInterval(() => void refreshSent(), 15_000);
    return () => window.clearInterval(timer);
  }, [open, cooking, ready, expired, refreshSent]);

  useEffect(() => {
    void Promise.resolve().then(load);
    void request(assetUrl('./menu-presentation.json'))
      .then(async (response) => {
        if (!response.ok) return;
        const data = await response.json();
        if (
          Array.isArray(data.categories) &&
          Array.isArray(data.products) &&
          Array.isArray(data.popular)
        )
          setSnapshot(data);
      })
      .catch(() => {});
    const refresh = () => location.reload();
    window.addEventListener('hashchange', refresh);
    return () => window.removeEventListener('hashchange', refresh);
  }, [load]);

  const lines = pending?.body.items ?? cart;
  const count = lines.reduce((total, line) => total + line.quantity, 0);
  const total = lines.reduce((sum, line) => {
    const item = presentation.itemById.get(line.menu_item_id);
    if (!item) return NaN;
    const options = item.addon_groups?.flatMap((group) => group.options) ?? [];
    return (
      sum +
      line.quantity *
        (item.price_satang +
          (line.addons ?? []).reduce(
            (extra, addon) =>
              extra +
              addon.quantity *
                (options.find((option) => option.id === addon.id)?.price_satang ?? 0),
            0,
          ))
    );
  }, 0);
  const lineInfo = (line: Line) => {
    const item = presentation.itemById.get(line.menu_item_id);
    const product =
      presentation.products.find((candidate) =>
        candidate.variants?.some((variant) => variant.id === line.menu_item_id),
      ) ??
      presentation.products.find(
        (candidate) => presentation.orderItemIds.get(candidate.id) === line.menu_item_id,
      );
    const variant = product?.variants?.find((candidate) => candidate.id === line.menu_item_id);
    const name = product
      ? variant
        ? `${product.name} (${variant.name})`
        : product.name
      : (item?.name ?? 'รายการที่รอยืนยัน');
    return { product, variant, name };
  };
  const limitError = () => toast.error('จำนวนรายการหรือตัวเลือกเกินขีดจำกัด กรุณาลดจำนวนแล้วลองใหม่');
  const changeQty = (key: string, delta: number) => {
    const line = cart.find((item) => lineKey(item) === key);
    if (!line) return;
    const quantity = line.quantity + delta;
    if (quantity > 50 || count + delta > 100) return limitError();
    setCart(
      quantity < 1
        ? cart.filter((item) => lineKey(item) !== key)
        : cart.map((item) => (lineKey(item) === key ? { ...item, quantity } : item)),
    );
  };
  const openEdit = (line: Line) => {
    const { product, variant } = lineInfo(line);
    if (!product) return;
    const all = product.addon_groups?.flatMap((group) => group.addons ?? []) ?? [];
    const addons = (line.addons ?? []).flatMap((selected) => {
      const addon = all.find((candidate) => candidate.id === selected.id);
      return addon ? [{ ...addon, quantity: selected.quantity }] : [];
    });
    setOpen(false);
    setEditing({ key: lineKey(line), product, line, variant, addons });
  };
  const toLine = (
    product: Product,
    quantity: number,
    addons: Addon[],
    note: string,
    variant?: ProductVariant | null,
  ): Line => ({
    menu_item_id: variant?.id ?? presentation.orderItemIds.get(product.id)!,
    quantity,
    ...(note && { note: Array.from(note).slice(0, 160).join('') }),
    ...(addons.length > 0 && {
      addons: addons.map((addon) => ({ id: addon.id, quantity: addon.quantity ?? 1 })),
    }),
  });
  const quantities = new Map<string, number>();
  for (const product of presentation.products) {
    const ids = new Set([product.id, ...(product.variants?.map((variant) => variant.id) ?? [])]);
    // POS presentation IDs differ from Cloud IDs for products without variants.
    const cloudId = presentation.orderItemIds.get(product.id);
    if (cloudId) ids.add(cloudId);
    quantities.set(
      product.id,
      lines
        .filter((line) => ids.has(line.menu_item_id))
        .reduce((sum, line) => sum + line.quantity, 0),
    );
  }

  function add(line: Line) {
    if (pending || flight.current || expired) return;
    const key = lineKey(line);
    const index = cart.findIndex((item) => lineKey(item) === key);
    const quantity = (cart[index]?.quantity ?? 0) + line.quantity;
    if (
      !Number.isInteger(quantity) ||
      quantity > 50 ||
      count + line.quantity > 100 ||
      (index < 0 && cart.length >= 30) ||
      (line.addons?.length ?? 0) > 20 ||
      line.addons?.some(
        (addon) => !Number.isInteger(addon.quantity) || addon.quantity < 1 || addon.quantity > 10,
      )
    ) {
      limitError();
      return;
    }
    setStatus('');
    setCart(
      index < 0
        ? [...cart, line]
        : cart.map((item, i) => (i === index ? { ...line, quantity } : item)),
    );
  }

  async function send() {
    const current = context.current;
    if (!current || flight.current || expired || !lines.length) return;
    let attempt = pending;
    if (!attempt) {
      if (!window.confirm(`ยืนยันส่ง ${count} ชิ้นให้ร้านหรือไม่?`)) return;
      const note = orderNote.trim();
      attempt = {
        key: crypto.randomUUID(),
        body: { menu_revision: current.revision, ...(note && { note }), items: cart },
      };
      try {
        sessionStorage.setItem(current.storageKey, JSON.stringify(attempt));
      } catch {
        setStatus('เบราว์เซอร์บันทึกรายการชั่วคราวไม่ได้ กรุณาสั่งกับพนักงาน');
        return;
      }
      setPending(attempt);
    }
    flight.current = true;
    setSending(true);
    try {
      const response = await request('/api/v1/orders', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${current.token}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': attempt.key,
        },
        body: JSON.stringify(attempt.body),
      });
      const result = await response.json();
      if (
        (response.status === 409 && result.error === 'menu revision changed') ||
        (response.status === 400 &&
          ['invalid menu item', 'ask staff for price', 'invalid menu options'].includes(
            result.error,
          ))
      ) {
        sessionStorage.removeItem(current.storageKey);
        setPending(undefined);
        setCart([]);
        setOrderNote('');
        await load();
        setStatus('เมนูหรือตัวเลือกเปลี่ยน กรุณาเลือกใหม่ก่อนส่งออเดอร์');
        return;
      }
      if (response.status === 401 || response.status === 409) {
        setExpired(true);
        setStatus('ตรวจผลรายการนี้ไม่ได้ กรุณาให้พนักงานตรวจสอบก่อนสั่งใหม่');
        return;
      }
      if (!response.ok || !uuid.test(result.order_id ?? '')) throw new Error();
      sessionStorage.removeItem(current.storageKey);
      setPending(undefined);
      setCart([]);
      setOrderNote('');
      setStatus('ระบบได้รับออเดอร์แล้ว รอร้านยืนยัน');
      void refreshSent();
    } catch {
      setStatus('ยังไม่ทราบผลการส่ง กรุณากดส่งรายการเดิมอีกครั้งจากแท็บนี้');
    } finally {
      flight.current = false;
      setSending(false);
    }
  }

  const quickFilters = [
    {
      key: 'popular',
      label: t('menuPopular'),
      emptyText: t('menuPopularEmpty'),
      match: (product: Product) => Boolean(snapshot?.popular.includes(product.id)),
    },
    {
      key: 'recommended',
      label: t('menuRecommended'),
      emptyText: t('menuRecommendedEmpty'),
      match: (product: Product) => Boolean(product.tags?.includes('recommended')),
    },
    {
      key: 'promotion',
      label: t('menuPromotion'),
      emptyText: t('menuPromotionEmpty'),
      match: (product: Product) => Boolean(product.tags?.includes('promotion')),
    },
  ];
  const disabled = Boolean(pending) || expired || sending;
  return (
    <main className="mx-auto flex h-dvh max-w-5xl flex-col bg-background px-3 text-foreground">
      {snapshot?.staffUrl && (
        <header className="flex shrink-0 justify-end py-2">
          <StaffSignIn href={staffAreaUrl(snapshot.staffUrl)} label="พนักงาน" />
        </header>
      )}
      {status && (
        <p className="my-2 rounded-lg bg-muted px-3 py-2 text-sm break-all" role="status">
          {status}
        </p>
      )}
      {canReload && (
        <Button className="self-start" variant="outline" onClick={() => void load()}>
          ลองใหม่
        </Button>
      )}
      {ready && (
        <div className="flex min-h-0 flex-1 flex-col">
          <ProductGrid
            categories={presentation.categories}
            products={presentation.products}
            selectedCategory={category}
            setSelectedCategory={setCategory}
            search={search}
            setSearch={setSearch}
            currency="THB"
            showImages
            imageOf={(product) => {
              const file = presentation.images.get(product.id);
              return file && /^menu-images\/[a-f0-9]{64}\.(webp|png|jpeg|gif)$/.test(file)
                ? assetUrl(file)
                : undefined;
            }}
            gridClassName="grid-cols-2"
            formatPrice={(amount) => money.format(amount)}
            quickFilters={quickFilters}
            cartQuantities={quantities}
            searchPlaceholder={t('searchMenu')}
            flat
            flingScale={0.5}
            scrollSpy
            loopSections
            disabled={disabled}
            onProductClick={(product, quantity) => {
              if (productNeedsCustomizer(product)) setCustomize({ product, quantity });
              else add({ menu_item_id: presentation.orderItemIds.get(product.id)!, quantity });
            }}
            onScannedVariant={(product, variant, quantity) =>
              setCustomize({ product, variant, quantity })
            }
            onScaledProduct={() => {}}
          />
        </div>
      )}
      {((ready && !expired) || pending) && (
        <Drawer open={open} onOpenChange={setOpen}>
          <DrawerTrigger asChild>
            <button
              type="button"
              aria-label={t('currentTicket')}
              className="fixed bottom-5 end-5 z-40 flex size-14 items-center justify-center rounded-full bg-brand text-white shadow-lg hover:bg-brand-hover"
            >
              <ShoppingCart size={22} />
              {count > 0 && (
                <span className="absolute -top-0.5 -end-0.5 flex size-5 items-center justify-center rounded-full bg-red-500 text-xs font-bold">
                  {count}
                </span>
              )}
            </button>
          </DrawerTrigger>
          <DrawerContent className="max-h-[90vh] text-foreground">
            <div className="max-h-[85vh] overflow-y-auto px-3">
              <DrawerTitle className="py-3 text-sm font-semibold">{t('currentTicket')}</DrawerTitle>
              {status && (
                <p role="status" className="mb-2 rounded-lg bg-muted p-2 text-sm">
                  {status}
                </p>
              )}
              <div className="border-t border-border pt-3">
                <p className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
                  {t('newItems')}
                </p>
                {lines.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    {t('emptyDraft')}
                  </p>
                ) : (
                  <div className="space-y-3">
                    {lines.map((line) => {
                      const key = lineKey(line);
                      const info = lineInfo(line);
                      return (
                        <div key={key} className="rounded-lg border border-border p-2">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium">
                                {info.name}
                              </span>
                              {line.note && (
                                <p className="mt-0.5 truncate text-xs italic text-muted-foreground">
                                  {line.note}
                                </p>
                              )}
                            </div>
                            <button
                              type="button"
                              disabled={disabled}
                              aria-label={tCommon('removeItem')}
                              onClick={() => setCart(cart.filter((item) => lineKey(item) !== key))}
                              className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-red-500 disabled:opacity-50"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                          <div className="mt-2 flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                disabled={disabled}
                                aria-label="-1"
                                onClick={() => changeQty(key, -1)}
                                className="rounded-md border border-border bg-card p-1 disabled:opacity-50"
                              >
                                <Minus size={14} />
                              </button>
                              <span className="w-6 text-center text-sm font-semibold">
                                <Ltr>{line.quantity}</Ltr>
                              </span>
                              <button
                                type="button"
                                disabled={disabled}
                                aria-label="+1"
                                onClick={() => changeQty(key, 1)}
                                className="rounded-md border border-border bg-card p-1 disabled:opacity-50"
                              >
                                <Plus size={14} />
                              </button>
                            </div>
                            <button
                              type="button"
                              disabled={disabled || !info.product}
                              onClick={() => openEdit(line)}
                              className="flex items-center gap-1 rounded-full bg-amber-100 px-2 py-1 text-xs font-medium text-amber-700 hover:bg-amber-200 disabled:opacity-50 dark:bg-amber-950/40 dark:text-amber-300 dark:hover:bg-amber-950/60"
                            >
                              <SquarePen size={12} />
                              {tCommon('edit')}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {lines.length > 0 && (
                <div className="mt-3">
                  <textarea
                    value={pending ? (pending.body.note ?? '') : orderNote}
                    disabled={disabled}
                    onChange={(event) => setOrderNote(event.target.value)}
                    placeholder={tPos('orderNotesPlaceholder')}
                    rows={2}
                    maxLength={200}
                    className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-brand focus:outline-none disabled:opacity-50"
                  />
                  <p className="mt-0.5 text-end text-xs text-muted-foreground">
                    <Ltr>{(pending ? (pending.body.note ?? '') : orderNote).length}/200</Ltr>
                  </p>
                </div>
              )}

              {sent.some((order) => order.items.length > 0) && (
                <div className="mt-4 border-t border-border pt-3">
                  <p className="mb-2 flex flex-wrap items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
                    <span>{t('sentToKitchen')}</span>
                    {[
                      ...new Set(
                        sent.flatMap((order) =>
                          order.pos_order_number ? [order.pos_order_number] : [],
                        ),
                      ),
                    ].map((number) => (
                      <Ltr
                        key={number}
                        as="span"
                        className="rounded bg-muted px-1.5 py-0.5 font-mono normal-case text-foreground"
                      >
                        #{number}
                      </Ltr>
                    ))}
                  </p>
                  <ul className="divide-y divide-border">
                    {sent
                      .flatMap((order) =>
                        order.items.map((item, index) => ({
                          order,
                          item,
                          key: `${order.id}:${index}`,
                        })),
                      )
                      .map(({ order, item, key }) => (
                        <li key={key} className="flex items-start justify-between gap-2 py-3">
                          <div className="min-w-0">
                            <p className="text-sm font-medium">{item.name}</p>
                            {item.note && (
                              <p className="text-xs italic text-muted-foreground">{item.note}</p>
                            )}
                            <p className="text-xs text-muted-foreground">
                              <Ltr>x {item.quantity}</Ltr>
                            </p>
                          </div>
                          <SentStatus status={item.status ?? order.status} />
                        </li>
                      ))}
                  </ul>
                </div>
              )}

              <div className="sticky bottom-0 z-10 -mx-3 mt-4 bg-background px-3 pb-3">
                <div className="flex items-center justify-between border-t border-border pt-3">
                  <span className="text-sm text-muted-foreground">{t('draftTotal')}</span>
                  <span className="text-lg font-bold">
                    <Ltr>{Number.isFinite(total) ? money.format(total / 100) : '-'}</Ltr>
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => void send()}
                  disabled={!count || sending || expired}
                  className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-brand font-semibold text-white disabled:opacity-50"
                >
                  <Send size={17} />
                  {sending
                    ? t('sending')
                    : pending
                      ? 'ตรวจผลโดยส่งรายการเดิมอีกครั้ง'
                      : sent.length
                        ? t('addToOrder')
                        : t('sendToKitchen')}
                </button>
              </div>
            </div>
          </DrawerContent>
        </Drawer>
      )}
      {customize && (
        <AddonModal
          product={customize.product}
          initialQuantity={customize.quantity}
          initialVariant={customize.variant}
          currency="THB"
          country="TH"
          onClose={() => setCustomize(undefined)}
          onAdd={(product, quantity, addons, note, variant) =>
            add(toLine(product, quantity, addons, note, variant))
          }
        />
      )}
      {editing && (
        <AddonModal
          product={editing.product}
          mode="edit"
          initialQuantity={editing.line.quantity}
          initialAddons={editing.addons}
          initialInstructions={editing.line.note ?? ''}
          initialVariant={editing.variant}
          currency="THB"
          country="TH"
          onClose={() => {
            setEditing(undefined);
            setOpen(true);
          }}
          onAdd={(product, quantity, addons, note, variant) => {
            if (pending || flight.current || expired) return;
            const next = toLine(product, quantity, addons, note, variant);
            const rest = cart.filter((item) => lineKey(item) !== editing.key);
            const merge = rest.findIndex((item) => lineKey(item) === lineKey(next));
            const updated =
              merge < 0
                ? [...rest, next]
                : rest.map((item, index) =>
                    index === merge ? { ...next, quantity: item.quantity + next.quantity } : item,
                  );
            if (
              updated.some((item) => item.quantity > 50) ||
              updated.reduce((sum, item) => sum + item.quantity, 0) > 100
            ) {
              limitError();
              return;
            }
            setCart(updated);
          }}
        />
      )}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <IntlProvider locale="th-TH" messages={messages} timeZone="Asia/Bangkok">
    <Ordering />
    <Toaster containerStyle={{ zIndex: 2147483647 }} />
  </IntlProvider>,
);
