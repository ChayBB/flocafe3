import { parseVariantSelection } from '@/lib/printer/item-heading';
import { cleanItemText, itemLine, joinedDish, type NamedOption } from '../../../shared/item-line';

export { NOTE_SEPARATOR, optionsNote, withoutOptionsNote } from '../../../shared/item-line';

/**
 * The menu name to read aloud, built from what was chosen rather than from the displayed name:
 * bracketed text is dropped, and once options are chosen a listed choice such as "หมู/กุ้ง/ไก่"
 * gives way to the chosen one joined onto the dish ("ข้าวต้มหมู"), followed by the size.
 */
export function spokenItemName(
  productName: string,
  variantName: string | null | undefined,
  addons: NamedOption[] | null | undefined,
): string {
  const chosen = (addons ?? []).map((addon) => cleanItemText(addon.name)).filter(Boolean);
  return [
    joinedDish(productName, chosen[0]),
    ...chosen.slice(1),
    cleanItemText(String(variantName ?? '')),
  ]
    .filter(Boolean)
    .join(' ');
}

interface KdsLineItem {
  product_name: string;
  variant_selection?: unknown;
  addons?: NamedOption[] | null;
  special_instructions?: string | null;
}

/** The menu line a kitchen screen shows; see itemLine. */
export function kdsItemLine(item: KdsLineItem): { name: string; instructions: string } {
  const { name, instructions } = itemLine(
    item.product_name,
    parseVariantSelection(item.variant_selection),
    item.addons,
    item.special_instructions,
  );
  return { name, instructions };
}
