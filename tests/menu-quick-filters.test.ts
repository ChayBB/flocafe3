/** Menu shortcut lists: food and drinks lead with their staples, best sellers skip the rice sides. */
import assert from 'node:assert/strict';
import { buildMenuQuickFilters } from '../frontend/src/lib/menu-quick-filters';
import type { Product } from '../frontend/src/lib/types';

const categories = [
  { id: 'food', name: 'อาหารจานเดียว', parent_id: null },
  { id: 'drinks', name: 'เครื่องดื่ม', parent_id: null },
  { id: 'soft', name: 'น้ำอัดลม', parent_id: 'drinks' },
  { id: 'pick', name: 'เมนูตามใจฉัน', parent_id: null },
];
const product = (id: string, name: string, category_id: string, tags: string[] = []) =>
  ({ id, name, category_id, tags, price: 10 }) as unknown as Product;
const products = [
  product('kp', 'กะเพราหมู', 'food'),
  product('rice', 'ข้าวสวย', 'food'),
  product('congee', 'ข้าวต้ม', 'food'),
  product('shrimp', 'ข้าวต้มกุ้ง', 'food'),
  product('fried', 'ไก่ทอด', 'food'),
  product('cold', 'ยำวุ้นเส้น', 'food'),
  product('ice', 'น้ำแข็ง', 'drinks'),
  product('beer', 'เบียร์ช้าง', 'drinks'),
  product('pepsi', 'เป๊ปซี่', 'soft'),
  product('shaved', 'น้ำแข็งไส', 'food'),
  product('tea', 'ชาเย็น', 'drinks'),
  product('special', 'ปลาทอดน้ำปลา', 'pick'),
  product('tagged', 'ไข่เจียว', 'food', ['recommended']),
];
const rankedIds = ['rice', 'pepsi', 'fried', 'kp', 'shrimp', 'tea', 'shaved'];
const filters = buildMenuQuickFilters({
  categories,
  products,
  rankedIds,
  hasTag: (p, tag) => Boolean(p.tags?.includes(tag)),
  labels: {
    food: 'อาหาร',
    foodEmpty: '',
    drinks: 'เครื่องดื่ม',
    drinksEmpty: '',
    popular: 'เมนูยอดนิยม',
    popularEmpty: '',
    recommended: 'เมนูตามใจฉัน',
    recommendedEmpty: '',
    promotion: 'โปรโมชั่น',
    promotionEmpty: '',
  },
});
const list = (key: string) => {
  const filter = filters.find((f) => f.key === key)!;
  const shown = products.filter(filter.match);
  return (filter.rank ? [...shown].sort((a, b) => filter.rank!(a) - filter.rank!(b)) : shown).map(
    (p) => p.id,
  );
};

assert.deepEqual(
  filters.map((f) => f.label),
  ['อาหาร', 'เครื่องดื่ม', 'เมนูยอดนิยม', 'เมนูตามใจฉัน', 'โปรโมชั่น'],
);
assert.deepEqual(list('food'), ['rice', 'congee', 'fried', 'kp', 'shrimp', 'shaved']);
assert.deepEqual(list('drinks'), ['ice', 'beer', 'pepsi', 'tea']);
assert.deepEqual(list('popular'), ['fried', 'kp', 'shrimp', 'shaved']);
assert.deepEqual(list('recommended'), ['special', 'tagged']);
const unsold = buildMenuQuickFilters({
  categories,
  products,
  rankedIds: null,
  hasTag: () => false,
  labels: Object.fromEntries(Object.keys(filters).map(() => ['', ''])) as never,
});
assert.equal(
  unsold.some((f) => f.key === 'popular'),
  false,
  'without sales the best-seller list is left out',
);
console.log('Menu quick filters: staples first, then best sellers; popular food skips rice sides.');
