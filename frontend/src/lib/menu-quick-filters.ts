import type { Category, Product } from '@/lib/types';

const DRINK_GROUP = /บาร์\s*น้ำ|เครื่องดื่ม|\b(?:drinks?|beverages?)\b/iu;
const RECOMMENDED_GROUP = /ตามใจ/u;
const POPULAR_SHOWN = 10;

/** Plain rice and rice soup lead the food list and stay out of the best sellers. */
export function isRiceSide(name: string): boolean {
  return ['ข้าวต้ม', 'ข้าวสวย'].includes(name.trim());
}

/** Ice and beer lead the drinks list. */
export function isDrinkStaple(name: string): boolean {
  const trimmed = name.trim();
  return (
    (trimmed.startsWith('น้ำแข็ง') && !trimmed.startsWith('น้ำแข็งไส')) || trimmed.startsWith('เบียร์')
  );
}

export interface MenuQuickFilterLabels {
  food: string;
  foodEmpty: string;
  drinks: string;
  drinksEmpty: string;
  popular: string;
  popularEmpty: string;
  recommended: string;
  recommendedEmpty: string;
  promotion: string;
  promotionEmpty: string;
}

export interface MenuQuickFilter {
  key: string;
  label: string;
  emptyText: string;
  match: (product: Product) => boolean;
  /** Orders the filtered list; lower comes first. */
  rank?: (product: Product) => number;
}

/**
 * The menu's shortcut lists: food and drinks with their staples first and then what sells most,
 * the best-selling food without the rice sides, the "เมนูตามใจฉัน" picks, and promotions.
 * `rankedIds` lists product ids from the most ordered down; null when sales are unknown.
 */
export function buildMenuQuickFilters({
  categories,
  products,
  rankedIds,
  hasTag,
  labels,
}: {
  categories: Pick<Category, 'id' | 'name' | 'parent_id'>[];
  products: Product[];
  rankedIds: string[] | null;
  hasTag: (product: Product, tag: string) => boolean;
  labels: MenuQuickFilterLabels;
}): MenuQuickFilter[] {
  const byId = new Map(categories.map((category) => [String(category.id), category]));
  const inGroup = (product: Product, pattern: RegExp) => {
    const category = byId.get(String(product.category_id ?? ''));
    if (!category) return false;
    if (pattern.test(category.name)) return true;
    const parent = byId.get(String(category.parent_id ?? ''));
    return Boolean(parent && pattern.test(parent.name));
  };
  const isDrink = (product: Product) =>
    isDrinkStaple(product.name) || inGroup(product, DRINK_GROUP);
  const rank = new Map((rankedIds ?? []).map((id, index) => [String(id), index]));
  const sold = (product: Product) => rank.get(String(product.id));
  const bySales = (product: Product) => sold(product) ?? Number.MAX_SAFE_INTEGER;
  const staplesFirst = (staple: (name: string) => boolean) => (product: Product) =>
    staple(product.name) ? -1 : bySales(product);
  const bestFood = new Set(
    products
      .filter((product) => sold(product) !== undefined && !isDrink(product))
      .filter((product) => !isRiceSide(product.name))
      .sort((a, b) => bySales(a) - bySales(b))
      .slice(0, POPULAR_SHOWN)
      .map((product) => String(product.id)),
  );

  return [
    {
      key: 'food',
      label: labels.food,
      emptyText: labels.foodEmpty,
      match: (product) =>
        !isDrink(product) && (isRiceSide(product.name) || sold(product) !== undefined),
      rank: staplesFirst(isRiceSide),
    },
    {
      key: 'drinks',
      label: labels.drinks,
      emptyText: labels.drinksEmpty,
      match: (product) =>
        isDrink(product) && (isDrinkStaple(product.name) || sold(product) !== undefined),
      rank: staplesFirst(isDrinkStaple),
    },
    ...(rankedIds
      ? [
          {
            key: 'popular',
            label: labels.popular,
            emptyText: labels.popularEmpty,
            match: (product: Product) => bestFood.has(String(product.id)),
            rank: bySales,
          },
        ]
      : []),
    {
      key: 'recommended',
      label: labels.recommended,
      emptyText: labels.recommendedEmpty,
      match: (product) => hasTag(product, 'recommended') || inGroup(product, RECOMMENDED_GROUP),
    },
    {
      key: 'promotion',
      label: labels.promotion,
      emptyText: labels.promotionEmpty,
      match: (product) => hasTag(product, 'promotion'),
    },
  ];
}
