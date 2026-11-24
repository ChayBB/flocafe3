import { t } from 'elysia';

export const AddonSelection = t.Object({
  id: t.String({ minLength: 1, maxLength: 128 }),
  quantity: t.Integer({ minimum: 1, maximum: 10 }),
});

const groupFields = {
  name: t.String({ minLength: 1, maxLength: 200 }),
  min: t.Integer({ minimum: 0, maximum: 200 }),
  max: t.Union([t.Null(), t.Integer({ minimum: 0, maximum: 10000 })]),
  multiple: t.Boolean(),
};
const option = t.Object({
    id: t.String({ minLength: 1, maxLength: 128 }),
    name: t.String({ minLength: 1, maxLength: 200 }),
    price_satang: t.Integer({ minimum: 0, maximum: 100000000 }),
});
export const AddonGroups = t.Array(t.Union([
  t.Object({
    ...groupFields,
    kitchen_price: t.Literal(true),
    description: t.Optional(t.String({ maxLength: 2000 })),
    options: t.Array(option, { maxItems: 100 }),
  }),
  t.Object({ ...groupFields, options: t.Array(option, { minItems: 1, maxItems: 100 }) }),
]), { maxItems: 20 });

export type AddonGroup = typeof AddonGroups.static[number];
type Selection = typeof AddonSelection.static;

export function resolveCatalogAddons(groups: AddonGroup[], selections: Selection[]) {
  const requested = new Map(selections.map(({ id, quantity }) => [id, quantity]));
  if (requested.size !== selections.length) return null;
  const resolved: (AddonGroup['options'][number] & { quantity: number })[] = [];
  for (const group of groups) {
    let count = 0;
    for (const option of group.options) {
      const quantity = requested.get(option.id);
      if (quantity === undefined) continue;
      if (!group.multiple && quantity > 1) return null;
      count += quantity;
      resolved.push({ ...option, quantity });
      requested.delete(option.id);
    }
    if (count < group.min || (group.max !== null && count > group.max)) return null;
  }
  return requested.size ? null : resolved;
}
