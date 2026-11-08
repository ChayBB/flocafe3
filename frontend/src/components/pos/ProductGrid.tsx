'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { List, Search, SlidersHorizontal } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import toast from 'react-hot-toast';
import type { Category, Product, ProductVariant } from '@/lib/types';
import { useCartStore } from '@/store/cart';
import { usePosSettingsStore } from '@/store/pos-settings';
import { nameToColor } from '@/lib/image-utils';
import TagBadge from './DietaryBadge';
import { productNeedsCustomizer } from '@/lib/product-variants';
import api from '@/lib/api';
import { useTranslations } from 'use-intl';
import { fractionalQuantityStep, parseDbTimestamp } from '@/lib/utils';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { resolveScannedProduct } from '@/lib/scale-barcode';
import { subscribeToQuickSearch } from '@/lib/quick-search';
import { parseQuantitySearch } from '@/lib/quantity-search';
import {
  sortCategories,
  sortProducts,
  type PosCategorySort,
  type PosItemSort,
} from '@/lib/pos-sort';
import CollapsiblePosChoices from './CollapsiblePosChoices';

const FLAT_TAB =
  'max-w-56 shrink-0 truncate border-b-2 px-0.5 py-1.5 text-[15px] whitespace-nowrap transition-colors';
const FLAT_TAB_ACTIVE = 'border-brand font-medium text-foreground';
const FLAT_TAB_IDLE = 'border-transparent text-muted-foreground';

/** The category chip shared by both category row modes. */
function CategoryChip({
  categoryName,
  categoryColor,
  isSelected,
  onSelect,
  flat,
}: {
  categoryName: string;
  categoryColor: string | null;
  isSelected: boolean;
  onSelect: () => void;
  flat: boolean;
}) {
  const colorClasses = getCategoryColorClasses(categoryColor);
  if (flat) {
    return (
      <button
        onClick={onSelect}
        title={categoryName}
        aria-pressed={isSelected}
        className={`${FLAT_TAB} ${isSelected ? FLAT_TAB_ACTIVE : FLAT_TAB_IDLE}`}
      >
        {categoryName}
      </button>
    );
  }
  return (
    <button
      onClick={onSelect}
      title={categoryName}
      aria-pressed={isSelected}
      className={`max-w-56 truncate px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
        isSelected
          ? colorClasses
            ? `${colorClasses.activeBg} ${colorClasses.activeText}`
            : 'bg-brand text-white'
          : colorClasses
            ? `${colorClasses.bg} ${colorClasses.text} border ${colorClasses.border} hover:opacity-80`
            : 'bg-card text-foreground border border-border hover:bg-muted'
      }`}
    >
      {categoryName}
    </button>
  );
}

/** The flat row's menu button: All and the quick filters; categories stay in the row. */
function CategoryMenu({
  label,
  allLabel,
  allSelected,
  setSelectedCategory,
  extraChips,
}: {
  label: string;
  allLabel: string;
  allSelected: boolean;
  setSelectedCategory: (id: Category['id'] | null) => void;
  extraChips: { key: string; label: string; active: boolean; onSelect: () => void }[];
}) {
  const itemClass = (active: boolean) =>
    `py-2.5 text-[15px] ${active ? 'font-medium text-brand' : ''}`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="pos-category-menu"
          aria-label={label}
          title={label}
          className="mb-1 flex size-9 shrink-0 items-center justify-center rounded-full bg-muted/60 text-foreground transition-colors hover:bg-muted"
        >
          <List size={18} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[60vh] min-w-44 overflow-y-auto">
        <DropdownMenuItem
          onSelect={() => setSelectedCategory(null)}
          className={itemClass(allSelected)}
        >
          {allLabel}
        </DropdownMenuItem>
        {extraChips.map((chip) => (
          <DropdownMenuItem
            key={`quick:${chip.key}`}
            onSelect={chip.onSelect}
            className={itemClass(chip.active)}
          >
            {chip.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The category row. The cashier POS opts into the measured collapse row; the
 * Server App keeps the horizontal-scroll layout unchanged.
 */
function CategoryRow({
  className,
  collapse,
  categories,
  selectedCategory,
  setSelectedCategory,
  allLabel,
  resetKey,
  flat,
  allSelected = !selectedCategory,
  extraChips = [],
}: {
  className: string;
  collapse: boolean;
  flat: boolean;
  allSelected?: boolean;
  /** Filters shown right after "All", such as the Server App's popular and recommended dishes. */
  extraChips?: { key: string; label: string; active: boolean; onSelect: () => void }[];
  categories: Category[];
  selectedCategory: Category['id'] | null;
  setSelectedCategory: (id: Category['id'] | null) => void;
  allLabel: string;
  resetKey: string | null;
}) {
  const allChip = (
    <button
      data-chip-key="all"
      onClick={() => setSelectedCategory(null)}
      title={collapse ? allLabel : undefined}
      aria-pressed={allSelected}
      className={
        flat
          ? `${FLAT_TAB} ${allSelected ? FLAT_TAB_ACTIVE : FLAT_TAB_IDLE}`
          : `${collapse ? 'min-w-0 truncate ' : ''}px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
              allSelected
                ? 'bg-brand text-white'
                : 'bg-card text-foreground border border-border hover:bg-muted'
            }`
      }
    >
      {allLabel}
    </button>
  );

  const categoryChips = categories
    .filter((cat) => cat.id != null)
    .map((cat) => ({
      key: String(cat.id),
      render: () => (
        <CategoryChip
          categoryName={cat.name}
          categoryColor={cat.color}
          isSelected={selectedCategory != null && String(selectedCategory) === String(cat.id)}
          onSelect={() => setSelectedCategory(cat.id)}
          flat={flat}
        />
      ),
    }));

  if (!collapse) {
    return (
      <div
        data-testid="pos-category-row"
        className={`flex flex-nowrap ${flat ? 'gap-5 [scrollbar-width:none]' : 'gap-2'} ${className} overflow-x-auto`}
      >
        {allChip}
        {extraChips.map((chip) => (
          <button
            key={chip.key}
            type="button"
            data-chip-key={`quick:${chip.key}`}
            data-testid={`pos-quick-filter-${chip.key}`}
            aria-pressed={chip.active}
            onClick={chip.onSelect}
            className={`${FLAT_TAB} ${chip.active ? FLAT_TAB_ACTIVE : FLAT_TAB_IDLE}`}
          >
            {chip.label}
          </button>
        ))}
        {categoryChips.map((chip) => (
          <div key={chip.key} data-chip-key={chip.key}>
            {chip.render()}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className={className}>
      <CollapsiblePosChoices
        data-testid="pos-category-row"
        ariaLabel={allLabel}
        resetKey={resetKey}
        choices={[
          { key: 'all', node: allChip },
          ...categoryChips.map((chip) => ({
            key: chip.key,
            node: chip.render(),
          })),
        ]}
        mandatoryKeys={['all', ...(selectedCategory != null ? [String(selectedCategory)] : [])]}
      />
    </div>
  );
}

function isValidProductQuantity(product: Product, quantity: number): boolean {
  if (!Number.isFinite(quantity) || quantity <= 0) return false;
  if (Number.isInteger(quantity)) return true;
  const step = fractionalQuantityStep(product);
  return step !== null && Math.abs(quantity / step - Math.round(quantity / step)) <= 1e-8;
}

const CATEGORY_COLORS: Record<
  string,
  {
    bg: string;
    text: string;
    border: string;
    activeBg: string;
    activeText: string;
  }
> = {
  red: {
    bg: 'bg-red-50 dark:bg-red-950/40',
    text: 'text-red-700 dark:text-red-300',
    border: 'border-red-200 dark:border-red-800/40',
    activeBg: 'bg-red-500',
    activeText: 'text-white',
  },
  orange: {
    bg: 'bg-orange-50 dark:bg-orange-950/40',
    text: 'text-orange-700 dark:text-orange-300',
    border: 'border-orange-200 dark:border-orange-800/40',
    activeBg: 'bg-orange-500',
    activeText: 'text-white',
  },
  amber: {
    bg: 'bg-amber-50 dark:bg-amber-950/40',
    text: 'text-amber-700 dark:text-amber-300',
    border: 'border-amber-200 dark:border-amber-800/40',
    activeBg: 'bg-amber-500',
    activeText: 'text-white',
  },
  yellow: {
    bg: 'bg-yellow-50 dark:bg-yellow-950/40',
    text: 'text-yellow-700 dark:text-yellow-300',
    border: 'border-yellow-200 dark:border-yellow-800/40',
    activeBg: 'bg-yellow-500',
    activeText: 'text-white',
  },
  lime: {
    bg: 'bg-lime-50 dark:bg-lime-950/40',
    text: 'text-lime-700 dark:text-lime-300',
    border: 'border-lime-200 dark:border-lime-800/40',
    activeBg: 'bg-lime-500',
    activeText: 'text-white',
  },
  green: {
    bg: 'bg-green-50 dark:bg-green-950/40',
    text: 'text-green-700 dark:text-green-300',
    border: 'border-green-200 dark:border-green-800/40',
    activeBg: 'bg-green-500',
    activeText: 'text-white',
  },
  emerald: {
    bg: 'bg-emerald-50 dark:bg-emerald-950/40',
    text: 'text-emerald-700 dark:text-emerald-300',
    border: 'border-emerald-200 dark:border-emerald-800/40',
    activeBg: 'bg-emerald-500',
    activeText: 'text-white',
  },
  teal: {
    bg: 'bg-teal-50 dark:bg-teal-950/40',
    text: 'text-teal-700 dark:text-teal-300',
    border: 'border-teal-200 dark:border-teal-800/40',
    activeBg: 'bg-teal-500',
    activeText: 'text-white',
  },
  cyan: {
    bg: 'bg-cyan-50 dark:bg-cyan-950/40',
    text: 'text-cyan-700 dark:text-cyan-300',
    border: 'border-cyan-200 dark:border-cyan-800/40',
    activeBg: 'bg-cyan-500',
    activeText: 'text-white',
  },
  sky: {
    bg: 'bg-sky-50 dark:bg-sky-950/40',
    text: 'text-sky-700 dark:text-sky-300',
    border: 'border-sky-200 dark:border-sky-800/40',
    activeBg: 'bg-sky-500',
    activeText: 'text-white',
  },
  blue: {
    bg: 'bg-blue-50 dark:bg-blue-950/40',
    text: 'text-blue-700 dark:text-blue-300',
    border: 'border-blue-200 dark:border-blue-800/40',
    activeBg: 'bg-blue-500',
    activeText: 'text-white',
  },
  indigo: {
    bg: 'bg-indigo-50 dark:bg-indigo-950/40',
    text: 'text-indigo-700 dark:text-indigo-300',
    border: 'border-indigo-200 dark:border-indigo-800/40',
    activeBg: 'bg-indigo-500',
    activeText: 'text-white',
  },
  violet: {
    bg: 'bg-violet-50 dark:bg-violet-950/40',
    text: 'text-violet-700 dark:text-violet-300',
    border: 'border-violet-200 dark:border-violet-800/40',
    activeBg: 'bg-violet-500',
    activeText: 'text-white',
  },
  purple: {
    bg: 'bg-purple-50 dark:bg-purple-950/40',
    text: 'text-purple-700 dark:text-purple-300',
    border: 'border-purple-200 dark:border-purple-800/40',
    activeBg: 'bg-purple-500',
    activeText: 'text-white',
  },
  fuchsia: {
    bg: 'bg-fuchsia-50 dark:bg-fuchsia-950/40',
    text: 'text-fuchsia-700 dark:text-fuchsia-300',
    border: 'border-fuchsia-200 dark:border-fuchsia-800/40',
    activeBg: 'bg-fuchsia-500',
    activeText: 'text-white',
  },
  pink: {
    bg: 'bg-pink-50 dark:bg-pink-950/40',
    text: 'text-pink-700 dark:text-pink-300',
    border: 'border-pink-200 dark:border-pink-800/40',
    activeBg: 'bg-pink-500',
    activeText: 'text-white',
  },
  rose: {
    bg: 'bg-rose-50 dark:bg-rose-950/40',
    text: 'text-rose-700 dark:text-rose-300',
    border: 'border-rose-200 dark:border-rose-800/40',
    activeBg: 'bg-rose-500',
    activeText: 'text-white',
  },
};

function getCategoryColorClasses(color: string | null | undefined) {
  if (!color) return null;
  return CATEGORY_COLORS[color.toLowerCase()] || null;
}

interface Props {
  categories: Category[];
  products: Product[];
  selectedCategory: string | null;
  setSelectedCategory: (id: string | null) => void;
  search: string;
  setSearch: (s: string) => void;
  currency: string;
  onProductClick: (product: Product, quantity: number) => void;
  /** A scanned variant goes through the cart customizer, so required add-ons and sold-out gating still apply. */
  onScannedVariant: (product: Product, variant: ProductVariant, quantity: number) => void;
  sidebarOpen?: boolean;
  /** Overrides for hosts that keep their own cart, such as the Server App's tableside draft. */
  cartQuantities?: ReadonlyMap<Product['id'], number>;
  onScaledProduct: (product: Product, quantity: number) => void;
  formatPrice?: (amount: number) => string;
  showImages?: boolean;
  gridClassName?: string;
  searchPlaceholder?: string;
  disabled?: boolean;
  /** Cashier-POS opt-in: measured collapsed category row with a toggle. */
  collapseCategories?: boolean;
  categorySort?: PosCategorySort;
  itemSort?: PosItemSort;
  /**
   * Show every category in one scrolling list under its own heading. The highlighted category
   * follows the scroll position and choosing a category scrolls to it, instead of filtering.
   */
  scrollSpy?: boolean;
  /** With scrollSpy: scrolling past the last category carries on into the first, and back. */
  loopSections?: boolean;
  /** A light, borderless look for the Server App on a phone: text category tabs and edge-to-edge photos. */
  flat?: boolean;
  /** Flat look only: filters after "All" that show just the matching products in one grid. */
  quickFilters?: QuickFilter[];
}

export interface QuickFilter {
  key: string;
  label: string;
  match: (product: Product) => boolean;
  emptyText: string;
}

export default function ProductGrid({
  categories,
  products,
  selectedCategory,
  setSelectedCategory,
  search,
  setSearch,
  onProductClick,
  onScannedVariant,
  sidebarOpen = true,
  cartQuantities: cartQuantitiesOverride,
  onScaledProduct,
  formatPrice,
  showImages,
  gridClassName,
  searchPlaceholder,
  disabled = false,
  collapseCategories = false,
  scrollSpy = false,
  loopSections = false,
  flat = false,
  quickFilters = [],
  categorySort = 'saved',
  itemSort = 'saved',
}: Props) {
  const searchInputRef = useRef<HTMLInputElement>(null);
  const cart = useCartStore();
  const { showProductImages: showProductImagesSetting } = usePosSettingsStore();
  const showProductImages = showImages ?? showProductImagesSetting;
  const t = useTranslations('pos');
  const validateSelectionQuantity = (product: Product, quantity: number) => {
    if (isValidProductQuantity(product, quantity)) return true;
    toast.error(t('orderQuantityInvalid'));
    return false;
  };
  const tenantFmt = useFormatCurrency();
  const fmt = formatPrice ?? tenantFmt;
  const [searchOpen, setSearchOpen] = useState(false);
  // The flat row shows the search as a round magnifier until it is tapped or holds text.
  const searchCollapsed = flat && !searchOpen && !search;
  useEffect(() => {
    const focusSearchInput = () => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    };
    return subscribeToQuickSearch(focusSearchInput);
  }, []);
  const cartStoreQuantities = useMemo(() => {
    const quantities = new Map<Product['id'], number>();
    for (const item of cart.items) {
      quantities.set(item.product.id, (quantities.get(item.product.id) || 0) + item.quantity);
    }
    return quantities;
  }, [cart.items]);
  const cartQuantities = cartQuantitiesOverride ?? cartStoreQuantities;

  const parsedSearch = useMemo(() => parseQuantitySearch(search), [search]);
  const activeQuery = parsedSearch ? parsedSearch.query : search;

  const categoryById = useMemo(
    () => new Map(categories.map((cat) => [String(cat.id), cat])),
    [categories],
  );
  const rootCategories = useMemo(
    () => categories.filter((cat) => cat.is_active !== false && !cat.parent_id),
    [categories],
  );
  const sortedCategories = useMemo(
    () => sortCategories(rootCategories, categorySort),
    [rootCategories, categorySort],
  );
  const selectedCategoryObj = selectedCategory ? categoryById.get(String(selectedCategory)) : null;
  const activeRootId = selectedCategoryObj
    ? selectedCategoryObj.parent_id && categoryById.has(String(selectedCategoryObj.parent_id))
      ? String(selectedCategoryObj.parent_id)
      : String(selectedCategoryObj.id)
    : selectedCategory;
  const activeSubcategoryId =
    selectedCategoryObj?.parent_id && categoryById.has(String(selectedCategoryObj.parent_id))
      ? String(selectedCategoryObj.id)
      : null;

  const activeSubcategories = useMemo(() => {
    if (!activeRootId) return [];
    const children = categories.filter(
      (cat) => cat.is_active !== false && String(cat.parent_id) === String(activeRootId),
    );
    return sortCategories(children, categorySort);
  }, [categories, activeRootId, categorySort]);

  const filterCategoryId = selectedCategory ? activeSubcategoryId || String(activeRootId) : null;

  const sortedProducts = useMemo(() => sortProducts(products, itemSort), [products, itemSort]);

  const [quickKey, setQuickKey] = useState<string | null>(null);
  const quickFilter = quickFilters.find((filter) => filter.key === quickKey) ?? null;
  // A quick filter shows one plain grid, so the category sections and their scroll tracking pause.
  const spying = scrollSpy && !quickFilter;

  const filtered = sortedProducts.filter((p) => {
    const matchCat =
      scrollSpy ||
      quickFilter ||
      filterCategoryId === null ||
      (p.category_id != null && String(p.category_id) === filterCategoryId);
    const matchQuick = !quickFilter || quickFilter.match(p);
    const matchSearch = !activeQuery || p.name.toLowerCase().includes(activeQuery.toLowerCase());
    return matchCat && matchQuick && matchSearch;
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRootRef = useRef<HTMLDivElement>(null);
  const spyPausedUntil = useRef(0);
  const spyFrame = useRef<number | null>(null);

  const sections = useMemo(() => {
    if (!spying) return [];
    const known = new Set(categories.map((category) => category.id));
    const groups = sortCategories(categories, categorySort)
      .map((category) => ({
        id: category.id as string | null,
        name: category.name,
        items: filtered.filter((product) => product.category_id === category.id),
      }))
      .filter((group) => group.items.length > 0);
    const other = filtered.filter(
      (product) => !product.category_id || !known.has(product.category_id),
    );
    if (other.length > 0) groups.push({ id: null, name: '', items: other });
    return groups;
  }, [spying, categories, categorySort, filtered]);

  // Looping moves a whole category from one end of the list to the other once it is out of sight,
  // shifting the scroll position by its height so nothing on screen moves.
  const [rotation, setRotation] = useState(0);
  const looping = spying && loopSections && !activeQuery && sections.length > 1;
  const shownSections = useMemo(() => {
    if (!looping) return sections;
    const start = ((rotation % sections.length) + sections.length) % sections.length;
    return [...sections.slice(start), ...sections.slice(0, start)];
  }, [looping, rotation, sections]);
  const pendingShift = useRef(0);
  const lastScrollTop = useRef(0);
  // A category chosen from the chips scrolls on its own; nothing loops until that scroll settles.
  const chipScrollTimer = useRef<number | null>(null);
  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container || pendingShift.current === 0) return;
    container.scrollTop += pendingShift.current;
    pendingShift.current = 0;
    lastScrollTop.current = container.scrollTop;
  }, [shownSections]);

  const loopSectionsOnScroll = () => {
    const container = scrollRef.current;
    if (!container) return;
    const { scrollTop, clientHeight, scrollHeight } = container;
    const direction = Math.sign(scrollTop - lastScrollTop.current);
    lastScrollTop.current = scrollTop;
    if (chipScrollTimer.current !== null) {
      window.clearTimeout(chipScrollTimer.current);
      chipScrollTimer.current = window.setTimeout(() => (chipScrollTimer.current = null), 200);
      return;
    }
    if (!looping || direction === 0 || pendingShift.current !== 0) return;
    const nodes = Array.from(container.querySelectorAll<HTMLElement>('[data-category-section]'));
    if (nodes.length < 2) return;
    const box = container.getBoundingClientRect();
    const span = (node: HTMLElement) =>
      node.offsetHeight + parseFloat(getComputedStyle(node).marginBottom || '0');
    if (direction > 0 && scrollHeight - scrollTop - clientHeight < clientHeight) {
      const first = nodes[0];
      if (first.getBoundingClientRect().bottom >= box.top) return;
      pendingShift.current = -span(first);
      setRotation((value) => value + 1);
    } else if (direction < 0 && scrollTop < clientHeight) {
      const last = nodes[nodes.length - 1];
      if (last.getBoundingClientRect().top <= box.bottom) return;
      pendingShift.current = span(last);
      setRotation((value) => value - 1);
    }
  };

  const updateActiveCategory = useCallback(() => {
    const container = scrollRef.current;
    if (!container || !spying) return;
    if (performance.now() < spyPausedUntil.current) return;
    const headings = Array.from(
      container.querySelectorAll<HTMLElement>('[data-category-section]'),
    ).filter((node) => node.dataset.categorySection);
    let active: string | null = null;
    if (container.scrollTop > 4 && headings.length > 0) {
      const top = container.getBoundingClientRect().top;
      // A looping list never really ends, so its bottom edge says nothing about the category.
      const atBottom =
        !looping && container.scrollTop + container.clientHeight >= container.scrollHeight - 2;
      if (atBottom) {
        active = headings[headings.length - 1].dataset.categorySection ?? null;
      } else {
        active = headings[0].dataset.categorySection ?? null;
        for (const node of headings) {
          if (node.getBoundingClientRect().top - top <= 12)
            active = node.dataset.categorySection ?? null;
        }
      }
    }
    if (active !== (selectedCategory ?? null)) setSelectedCategory(active);
  }, [spying, looping, selectedCategory, setSelectedCategory]);

  const onCatalogScroll = () => {
    if (loopSections) loopSectionsOnScroll();
    if (!spying || spyFrame.current !== null) return;
    spyFrame.current = requestAnimationFrame(() => {
      spyFrame.current = null;
      updateActiveCategory();
    });
  };

  useEffect(
    () => () => {
      if (spyFrame.current !== null) cancelAnimationFrame(spyFrame.current);
    },
    [],
  );

  // Keep the highlighted category chip in view while the list scrolls.
  useEffect(() => {
    if (!scrollSpy) return;
    const root = gridRootRef.current;
    const row = root?.querySelector<HTMLElement>('[data-testid="pos-category-row"]');
    const chip = row?.querySelector<HTMLElement>(`[data-chip-key="${selectedCategory ?? 'all'}"]`);
    if (!row || !chip) return;
    const left = chip.offsetLeft - row.offsetLeft;
    if (left < row.scrollLeft) row.scrollTo({ left: Math.max(0, left - 8), behavior: 'smooth' });
    else if (left + chip.offsetWidth > row.scrollLeft + row.clientWidth) {
      row.scrollTo({ left: left + chip.offsetWidth - row.clientWidth + 8, behavior: 'smooth' });
    }
  }, [scrollSpy, selectedCategory]);

  const pendingCategory = useRef<string | null | undefined>(undefined);
  const chooseQuickFilter = (key: string) => {
    setQuickKey(key);
    setSelectedCategory(null);
    scrollRef.current?.scrollTo({ top: 0 });
  };

  const chooseCategory = (id: string | null) => {
    if (quickFilter) {
      setQuickKey(null);
      setSelectedCategory(id);
      if (scrollSpy) pendingCategory.current = id;
      return;
    }
    if (!scrollSpy) {
      setSelectedCategory(id);
      return;
    }
    setSelectedCategory(id);
    scrollToCategory(id);
  };

  function scrollToCategory(id: string | null) {
    const container = scrollRef.current;
    if (!container) return;
    spyPausedUntil.current = performance.now() + 800;
    if (chipScrollTimer.current !== null) window.clearTimeout(chipScrollTimer.current);
    chipScrollTimer.current = window.setTimeout(() => (chipScrollTimer.current = null), 200);
    if (id === null) {
      if (rotation !== 0) {
        pendingShift.current = 0;
        setRotation(0);
      }
      container.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    const target = container.querySelector<HTMLElement>(
      `[data-category-section="${CSS.escape(id)}"]`,
    );
    if (target) {
      const offset = target.getBoundingClientRect().top - container.getBoundingClientRect().top;
      container.scrollTo({ top: container.scrollTop + offset, behavior: 'smooth' });
    }
  }

  // Leaving a quick filter brings the sections back; the chosen category is scrolled to once they render.
  useLayoutEffect(() => {
    if (quickFilter || pendingCategory.current === undefined) return;
    const id = pendingCategory.current;
    pendingCategory.current = undefined;
    scrollToCategory(id);
  });

  const renderProductCard = (product: Product) => {
    const inCartQty = cartQuantities.get(product.id) || 0;
    return (
      <button
        key={product.id}
        data-testid="pos-product-card"
        type="button"
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          const quantity = parsedSearch?.quantity ?? 1;
          if (!validateSelectionQuantity(product, quantity)) return;
          onProductClick(product, quantity);
        }}
        className={`${
          flat
            ? 'rounded-xl active:opacity-70'
            : 'min-h-36 bg-card rounded-xl p-2.5 border border-border hover:border-brand/40 active:border-brand active:bg-muted/40 hover:shadow-md'
        } transition-all text-start relative cursor-pointer overflow-hidden touch-manipulation focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50 disabled:cursor-not-allowed`}
      >
        {!!product.track_inventory && (
          <>
            {product.stock_quantity <= 0 ? (
              <span className="absolute top-2 start-2 bg-red-100 dark:bg-red-950/40 text-red-700 dark:text-red-300 text-[10px] font-bold px-2 py-0.5 rounded-full z-10 shadow-sm border border-red-200 dark:border-red-800/40 pointer-events-none">
                {t('outOfStock')}
              </span>
            ) : product.stock_quantity <= (product.low_stock_threshold || 0) ? (
              <span className="absolute top-2 start-2 bg-orange-100 dark:bg-orange-950/40 text-orange-700 dark:text-orange-300 text-[10px] font-bold px-2 py-0.5 rounded-full z-10 shadow-sm border border-orange-200 dark:border-orange-800/40 pointer-events-none">
                {t('lowStock')}
              </span>
            ) : null}
          </>
        )}
        {inCartQty > 0 && (
          <span className="absolute top-0 end-0 bg-brand text-white text-xs w-6 h-6 rounded-es-lg flex items-center justify-center font-bold z-10">
            {inCartQty}
          </span>
        )}

        {showProductImages && (
          <div
            className={`w-full aspect-square relative overflow-hidden ${flat ? 'rounded-xl mb-2' : 'rounded-lg mb-3'}`}
          >
            {/* Always-visible background tile — no flash when image loads */}
            <div
              className="absolute inset-0 flex items-center justify-center"
              style={{ backgroundColor: nameToColor(product.name) }}
            >
              <span className="text-2xl font-bold text-white/80">
                {product.name.substring(0, 2).toUpperCase()}
              </span>
            </div>

            {/* Image overlays the tile when available */}
            {product.has_image && (
              <img
                src={`${api.defaults.baseURL}/products/${product.id}/image?t=${product.updated_at ? parseDbTimestamp(product.updated_at).getTime() : 0}`}
                alt={product.name}
                className="absolute inset-0 w-full h-full object-cover rounded-lg"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            )}

            {product.tags && product.tags.length > 0 && (
              <span className="absolute bottom-1.5 end-1.5 z-10">
                <TagBadge tag={product.tags[0]} />
              </span>
            )}
          </div>
        )}

        <h3
          className={`text-foreground line-clamp-2 leading-snug ${flat ? 'text-[15px] font-normal' : 'font-medium text-sm'}`}
        >
          {product.name}
        </h3>
        <div className="flex items-center justify-between mt-1">
          <p className={flat ? 'text-[15px] text-muted-foreground' : 'text-brand font-bold'}>
            {fmt(Number(product.price))}
          </p>
          <div className="flex items-center gap-1 shrink-0">
            {!showProductImages && product.tags && product.tags.length > 0 && (
              <TagBadge tag={product.tags[0]} />
            )}
            {productNeedsCustomizer(product) && (
              <span
                className="touch-target -me-2 -my-2 rounded-lg text-muted-foreground"
                title={t('customisable')}
                aria-label={t('customisable')}
              >
                <SlidersHorizontal size={16} />
              </span>
            )}
          </div>
        </div>
      </button>
    );
  };

  return (
    <div
      ref={gridRootRef}
      data-testid="pos-product-grid"
      className="flex-1 flex flex-col min-w-0 h-full overflow-hidden"
    >
      <div className={`shrink-0 mb-3 ${flat ? 'flex items-center gap-2' : ''}`}>
        <div
          className={`relative ${flat ? `shrink-0 pb-1 ${searchCollapsed ? 'w-9' : 'w-40'}` : 'mb-2'}`}
        >
          <Search
            size={searchCollapsed ? 18 : 16}
            className={`absolute top-1/2 -translate-y-1/2 pointer-events-none ${searchCollapsed ? 'start-2.5 -mt-0.5 text-foreground' : 'start-3 text-muted-foreground'}`}
          />
          <input
            ref={searchInputRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onFocus={() => setSearchOpen(true)}
            onBlur={() => setSearchOpen(false)}
            onKeyDown={(e) => {
              if (
                e.nativeEvent?.isComposing ||
                (e as { isComposing?: boolean }).isComposing ||
                e.keyCode === 229
              ) {
                return;
              }
              if (e.key !== 'Enter' || disabled) return;
              // Typed or pasted barcode, or multiplier search (e.g. 3*latte)
              const trimmed = search.trim();
              if (!trimmed) return;
              const rawMatch = resolveScannedProduct(trimmed, products);
              const parsedQty = rawMatch ? null : parseQuantitySearch(trimmed);
              const targetCode = parsedQty ? parsedQty.query : trimmed;
              if (!targetCode) return;
              const quantityToAdd = parsedQty ? parsedQty.quantity : 1;
              const match = rawMatch ?? resolveScannedProduct(targetCode, products);
              if (match) {
                if (match.scaleBarcode) {
                  const matchedQuantity = match.quantity * quantityToAdd;
                  if (!validateSelectionQuantity(match.product, matchedQuantity)) return;
                  onScaledProduct(match.product, matchedQuantity);
                } else if (match.variant) {
                  if (!validateSelectionQuantity(match.product, quantityToAdd)) return;
                  onScannedVariant(match.product, match.variant, quantityToAdd);
                } else {
                  if (!validateSelectionQuantity(match.product, quantityToAdd)) return;
                  onProductClick(match.product, quantityToAdd);
                }
                setSearch('');
                return;
              }

              const matchedProduct =
                filtered.find((p) => p.name.toLowerCase() === targetCode.toLowerCase()) ||
                (filtered.length === 1 ? filtered[0] : null);

              if (matchedProduct) {
                if (!validateSelectionQuantity(matchedProduct, quantityToAdd)) return;
                onProductClick(matchedProduct, quantityToAdd);
                setSearch('');
              }
            }}
            placeholder={searchPlaceholder ?? `${t('searchProducts')} [/]`}
            data-testid="pos-product-search"
            className={`w-full py-2 border outline-none transition-colors text-sm ${searchCollapsed ? 'px-0' : 'ps-9 pe-8'} ${
              flat
                ? `bg-muted/60 border-transparent rounded-full focus:border-brand/40 ${searchCollapsed ? 'cursor-pointer placeholder:text-transparent' : ''}`
                : 'bg-card border-border rounded-xl focus:border-brand'
            }`}
          />
          {!search && !flat && (
            <kbd className="hidden sm:inline-flex absolute end-3 top-1/2 -translate-y-1/2 px-1.5 py-0.5 rounded border border-border bg-muted text-[10px] font-mono text-muted-foreground pointer-events-none">
              /
            </kbd>
          )}
        </div>
        {flat && (
          <CategoryMenu
            label={t('categoryMenu')}
            allLabel={t('allCategories')}
            allSelected={!quickFilter && !selectedCategory}
            setSelectedCategory={chooseCategory}
            extraChips={quickFilters.map((filter) => ({
              key: filter.key,
              label: filter.label,
              active: quickKey === filter.key,
              onSelect: () => chooseQuickFilter(filter.key),
            }))}
          />
        )}
        <CategoryRow
          className={`pb-1 ${flat ? 'min-w-0 flex-1 ms-2' : ''}`}
          collapse={collapseCategories}
          categories={scrollSpy ? sortCategories(categories, categorySort) : sortedCategories}
          selectedCategory={quickFilter ? null : scrollSpy ? selectedCategory : activeRootId}
          setSelectedCategory={chooseCategory}
          allLabel={t('allCategories')}
          flat={flat}
          allSelected={!quickFilter && !selectedCategory}
          extraChips={quickFilters.map((filter) => ({
            key: filter.key,
            label: filter.label,
            active: quickKey === filter.key,
            onSelect: () => chooseQuickFilter(filter.key),
          }))}
          resetKey={
            collapseCategories
              ? cart.customer?.id == null
                ? null
                : String(cart.customer.id)
              : null
          }
        />
        {!scrollSpy && activeSubcategories.length > 0 && (
          <div
            data-testid="pos-subcategory-row"
            className="mt-1.5 flex flex-nowrap gap-2 overflow-x-auto pb-1"
          >
            {activeSubcategories.map((sub) => (
              <CategoryChip
                key={sub.id}
                categoryName={sub.name}
                flat={flat}
                categoryColor={sub.color}
                isSelected={activeSubcategoryId === String(sub.id)}
                onSelect={() =>
                  setSelectedCategory(
                    activeSubcategoryId === String(sub.id) ? activeRootId : String(sub.id),
                  )
                }
              />
            ))}
          </div>
        )}
      </div>

      {/* min-h-0 overrides the content-based automatic minimum size, so a long
          catalog scrolls inside the grid instead of growing past the viewport. */}
      <div
        ref={scrollRef}
        onScroll={onCatalogScroll}
        data-testid="pos-catalog-scroll"
        // Looping shifts the scroll itself; the browser's own scroll anchoring would shift it twice.
        className={`flex-1 min-h-0 overflow-y-auto overscroll-contain pb-20 md:pb-0 ${looping ? '[overflow-anchor:none]' : ''}`}
      >
        {quickFilter && filtered.length === 0 ? (
          <p
            data-testid="pos-quick-filter-empty"
            className="py-10 text-center text-sm text-muted-foreground"
          >
            {quickFilter.emptyText}
          </p>
        ) : spying ? (
          shownSections.map((section) => (
            <section
              key={section.id ?? 'other'}
              data-category-section={section.id ?? ''}
              className="mb-4"
            >
              {section.name && (
                <h2
                  className={
                    flat
                      ? 'mb-3 text-lg font-medium text-foreground'
                      : 'mb-2 text-sm font-semibold text-muted-foreground'
                  }
                >
                  {section.name}
                </h2>
              )}
              <div
                className={`grid ${flat ? 'gap-x-3 gap-y-5' : 'gap-3'} ${gridClassName ?? (sidebarOpen ? 'grid-cols-4' : 'grid-cols-5')}`}
              >
                {section.items.map(renderProductCard)}
              </div>
            </section>
          ))
        ) : (
          <div
            className={`grid ${flat ? 'gap-x-3 gap-y-5' : 'gap-3'} ${gridClassName ?? (sidebarOpen ? 'grid-cols-4' : 'grid-cols-5')}`}
          >
            {filtered.map(renderProductCard)}
          </div>
        )}
      </div>
    </div>
  );
}
