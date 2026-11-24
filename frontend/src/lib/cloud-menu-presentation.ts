import type { AddonGroup, Category, Product, ProductVariant } from '@/lib/types';

export interface CloudMenuItem {
  id: string;
  name: string;
  category: string | null;
  price_satang: number;
  price_unit?: 'kg' | null;
  image?: string;
  addon_groups?: {
    name: string;
    kitchen_price?: true;
    description?: string;
    min: number;
    max: number | null;
    multiple: boolean;
    options: { id: string; name: string; price_satang: number }[];
  }[];
}

export interface PosMenuPresentation {
  staffUrl?: string;
  categories: Category[];
  products: {
    id: string;
    name: string;
    categoryId: string | null;
    image?: string;
    tags: string[];
    variants: { name: string; sortOrder: number }[];
  }[];
  popular: string[];
}

export function presentCloudMenu(items: CloudMenuItem[], snapshot?: PosMenuPresentation) {
  const categories = [...(snapshot?.categories ?? [])];
  const byName = new Map(categories.map((category) => [category.name, category.id]));
  const candidates = new Map<string, CloudMenuItem[]>();
  const key = (category: string | null, name: string) => JSON.stringify([category, name]);
  const names = new Map(categories.map((category) => [category.id, category.name]));
  const images = new Map<string, string>();
  const orderItemIds = new Map<string, string>();
  const itemById = new Map(items.map((item) => [item.id, item]));
  const products: Product[] = [];
  const used = new Set<string>();
  const claimed = new Map<string, number>();
  const add = (
    id: string,
    name: string,
    categoryId: string | null,
    lines: CloudMenuItem[],
    presentation?: PosMenuPresentation['products'][number],
  ) => {
    const base = lines.find((item) => item.price_satang > 0) ?? lines[0];
    const variants: ProductVariant[] =
      lines.length > 1 || base.name !== name
        ? lines.map((item, sort_order) => ({
            id: item.id,
            product_id: id,
            name: item.name.slice(name.length + 3) || item.name,
            price: item.price_satang / 100,
            sort_order,
            is_active: true,
            track_inventory: false,
            stock_quantity: 0,
            sku: null,
            barcode: null,
            online_price: null,
            cost_price: null,
            low_stock_threshold: null,
            inventory_product_id: null,
            inventory_deduction_quantity: null,
            recipe_multiplier: 1,
          }))
        : [];
    const addon_groups: AddonGroup[] = (base.addon_groups ?? []).map((group, sort_order) => {
      const groupId = `${base.id}:${sort_order}`;
      return {
        id: groupId,
        name: group.name,
        description: group.description ?? null,
        kitchen_price: group.kitchen_price ?? false,
        is_required: group.min > 0,
        min_selection: group.min,
        max_selection: group.max ?? 0,
        allow_multiple_quantities: group.multiple,
        sort_order,
        is_active: true,
        addons: group.options.map((option, sort_order) => ({
          id: option.id,
          addon_group_id: groupId,
          name: option.name,
          price: option.price_satang / 100,
          is_active: true,
          sort_order,
          track_inventory: false,
          stock_quantity: 0,
          low_stock_threshold: 0,
        })),
      };
    });
    const cloudImage = lines.find((item) => item.image)?.image;
    const image = cloudImage ? `/api/v1/menu-images/${cloudImage}` : presentation?.image;
    if (image) images.set(id, image);
    orderItemIds.set(id, base.id);
    products.push({
      id,
      name,
      category_id: categoryId,
      price: base.price_satang / 100,
      price_unit: base.price_unit ?? null,
      variants,
      addon_groups,
      tags: presentation?.tags ?? null,
      has_image: Boolean(image),
      is_active: true,
      sale_unit: 'each',
      allow_fractional_quantity: false,
      weight_precision: 0,
      sku: null,
      barcode: null,
      description: null,
      cost: null,
      tax_type: 'none',
      tax_rate: 0,
      track_inventory: false,
      stock_quantity: 0,
      low_stock_threshold: null,
      available_online: true,
      updated_at: '',
      modifiers: null,
      sort_order: products.length,
    });
  };

  for (const item of items) {
    const match = key(item.category ?? null, item.name);
    const group = candidates.get(match) ?? [];
    group.push(item);
    candidates.set(match, group);
    if (item.category && !byName.has(item.category)) {
      const id = `cloud:${item.category}`;
      byName.set(item.category, id);
      categories.push({
        id,
        name: item.category,
        slug: id,
        description: null,
        parent_id: null,
        sort_order: categories.length,
        is_active: true,
        color: null,
        icon: null,
      });
    }
  }
  // The Cloud names a variant "Product – Variant"; a snapshot older than the variant still groups it.
  const variantKeys = (category: string | null, name: string) =>
    items
      .filter((item) => (item.category ?? null) === category && item.name.startsWith(`${name} – `))
      .map((item) => key(category, item.name));
  const entries = (product: PosMenuPresentation['products'][number]) => {
    const category = names.get(product.categoryId ?? '') ?? null;
    if (product.variants.length)
      return product.variants.map((variant) => key(category, `${product.name} – ${variant.name}`));
    const plain = key(category, product.name);
    if (candidates.has(plain)) return [plain];
    const variants = variantKeys(category, product.name);
    return variants.length ? [...new Set(variants)] : [plain];
  };
  for (const product of snapshot?.products ?? []) {
    for (const match of entries(product)) claimed.set(match, (claimed.get(match) ?? 0) + 1);
  }
  for (const product of snapshot?.products ?? []) {
    const lines = entries(product).flatMap((match) => {
      const found = candidates.get(match);
      return found?.length === 1 && claimed.get(match) === 1 ? found : [];
    });
    if (!lines.length) continue;
    const groups = new Set(
      lines
        .filter((item) => item.price_satang > 0)
        .map((item) => JSON.stringify(item.addon_groups ?? [])),
    );
    if (groups.size > 1) continue;
    lines.forEach((item) => used.add(item.id));
    add(product.id, product.name, product.categoryId, lines, product);
  }
  // Dishes missing from the snapshot group their variants by the "Product – Variant" name.
  const leftover = new Map<string, CloudMenuItem[]>();
  for (const item of items) {
    if (used.has(item.id)) continue;
    const cut = item.name.indexOf(' – ');
    const base = cut > 0 ? item.name.slice(0, cut) : item.name;
    const match = key(item.category ?? null, base);
    leftover.set(match, [...(leftover.get(match) ?? []), item]);
  }
  for (const [match, lines] of leftover) {
    const [category, base] = JSON.parse(match) as [string | null, string];
    const groups = new Set(
      lines
        .filter((item) => item.price_satang > 0)
        .map((item) => JSON.stringify(item.addon_groups ?? [])),
    );
    const grouped =
      lines.length > 1 && lines.every((item) => item.name !== base) && groups.size <= 1;
    for (const line of grouped ? [lines] : lines.map((item) => [item]))
      add(line[0].id, grouped ? base : line[0].name, byName.get(category ?? '') ?? null, line);
  }
  return { categories, products, images, itemById, orderItemIds };
}
