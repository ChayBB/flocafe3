import { randomBytes } from 'crypto';
import { getCountryCallingCode, type CountryCode } from 'libphonenumber-js';
import bcrypt from 'bcryptjs';
import { getDatabase, now } from '../db';
import { RegionalNotConfiguredError } from '../countries';
import { normalizeOptionalPhone } from '../lib/phone';

function dialCodeFor(country: string | undefined): string {
  if (!country) return '+1';
  try {
    return `+${getCountryCallingCode(country.toUpperCase() as CountryCode)}`;
  } catch {
    return '+1';
  }
}

function insertCategory(
  db: ReturnType<typeof getDatabase>,
  id: string,
  name: string,
  color: string,
  icon: string,
  sortOrder: number,
): void {
  db.prepare(`
    INSERT OR IGNORE INTO categories (id, name, color, icon, sort_order, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).run(id, name, color, icon, sortOrder, now(), now());
}

function insertProduct(
  db: ReturnType<typeof getDatabase>,
  id: string,
  categoryId: string,
  name: string,
  price: number,
  sortOrder: number,
): void {
  db.prepare(`
    INSERT OR IGNORE INTO products (id, category_id, name, price, sort_order, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).run(id, categoryId, name, price, sortOrder, now(), now());
}

function insertTable(
  db: ReturnType<typeof getDatabase>,
  id: string,
  number: string,
  capacity: number,
): void {
  db.prepare(`
    INSERT OR IGNORE INTO tables (id, number, capacity, status, created_at, updated_at)
    VALUES (?, ?, ?, 'available', ?, ?)
  `).run(id, number, capacity, now(), now());
}

function insertCustomer(
  db: ReturnType<typeof getDatabase>,
  id: string,
  name: string,
  rawPhone: string,
  fallbackDialCode: string,
  country = 'IN',
): void {
  const norm = normalizeOptionalPhone(rawPhone, country);
  const finalPhone = norm.valid && norm.e164 ? norm.e164 : rawPhone;
  const finalCountryCode = norm.valid && norm.countryCode ? norm.countryCode : fallbackDialCode;
  db.prepare(`
    INSERT OR IGNORE INTO customers (id, name, phone, country_code, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)
  `).run(id, name, finalPhone, finalCountryCode, now(), now());
}

function insertStaffUser(
  db: ReturnType<typeof getDatabase>,
  id: string,
  name: string,
  email: string,
  role: string,
  password: string,
  isActive = 1,
): void {
  db.prepare(`
    INSERT OR IGNORE INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, email, bcrypt.hashSync(password, 10), role, isActive, now(), now());
}

type SeedLanguage = 'en' | 'th';

function resolveSeedLanguage(language?: string): SeedLanguage {
  return language === 'th' ? 'th' : 'en';
}

function seedExpressRestaurant(
  db: ReturnType<typeof getDatabase>,
  serviceModel: string,
  language?: string,
): void {
  const lang = resolveSeedLanguage(language);
  const labels: Record<SeedLanguage, [string, string, string, string]> = {
    en: ['Food', 'Beverages', 'Meal', 'Tea'],
    th: ['อาหาร', 'เครื่องดื่ม', 'มื้ออาหาร', 'ชา'],
  };
  const [food, beverages, meal, tea] = labels[lang];
  const coffee = lang === 'th' ? 'กาแฟ' : 'Coffee';
  const snack = lang === 'th' ? 'ขนม' : 'Snack';
  insertCategory(db, 'cat-express-food', food, '#F97316', '🍽️', 1);
  insertCategory(db, 'cat-express-beverages', beverages, '#0EA5E9', '🥤', 2);
  insertProduct(db, 'prod-express-meal', 'cat-express-food', meal, 150, 1);
  insertProduct(db, 'prod-express-snack', 'cat-express-food', snack, 80, 2);
  insertProduct(db, 'prod-express-tea', 'cat-express-beverages', tea, 25, 1);
  insertProduct(db, 'prod-express-coffee', 'cat-express-beverages', coffee, 40, 2);

  if (serviceModel === 'finedine') {
    insertTable(db, 'tbl-express-1', 'T1', 4);
    insertTable(db, 'tbl-express-2', 'T2', 4);
    insertTable(db, 'tbl-express-3', 'T3', 6);
  }
}

function seedDemoRestaurant(
  db: ReturnType<typeof getDatabase>,
  serviceModel: string,
  language?: string,
  country?: string,
): void {
  const lang = resolveSeedLanguage(language);

  const cats =
    lang === 'th'
      ? ([
          ['cat-demo-starters', 'อาหารเริ่มต้น', '#FF6B6B', '🍟', 1],
          ['cat-demo-main', 'อาหารหลัก', '#4ECDC4', '🍛', 2],
          ['cat-demo-beverages', 'เครื่องดื่ม', '#45B7D1', '🥤', 3],
          ['cat-demo-desserts', 'ของหวาน', '#96CEB4', '🍰', 4],
        ] as const)
      : ([
          ['cat-demo-starters', 'Starters', '#FF6B6B', '🍔', 1],
          ['cat-demo-main', 'Main Course', '#4ECDC4', '🍛', 2],
          ['cat-demo-beverages', 'Beverages', '#45B7D1', '🥤', 3],
          ['cat-demo-desserts', 'Desserts', '#96CEB4', '🍰', 4],
        ] as const);
  for (const [id, name, color, icon, sort] of cats) insertCategory(db, id, name, color, icon, sort);

  const products =
    lang === 'th'
      ? ([
          ['prod-demo-satay', 'cat-demo-starters', 'สะเต๊ะไก่', 280, 1],
          ['prod-demo-tempeh', 'cat-demo-starters', 'เต้าหู้ทอดกรอบ', 250, 2],
          ['prod-demo-pad-krapow', 'cat-demo-main', 'ผัดกะเพราไก่', 800, 1],
          ['prod-demo-ayam-goreng', 'cat-demo-main', 'ไก่ทอดแกง', 1100, 2],
          ['prod-demo-khao-soi', 'cat-demo-main', 'ข้าวซอย', 1200, 3],
          ['prod-demo-teh-tarik', 'cat-demo-beverages', 'ชาเย็น', 350, 1],
          ['prod-demo-mineral-water', 'cat-demo-beverages', 'น้ำแร่', 200, 2],
          ['prod-demo-mango-sticky-rice', 'cat-demo-desserts', 'ข้าวเหนียวมะม่วง', 400, 1],
        ] as const)
      : ([
          ['prod-demo-paneer-tikka', 'cat-demo-starters', 'Paneer Tikka', 250, 1],
          ['prod-demo-chicken-wings', 'cat-demo-starters', 'Chicken Wings', 280, 2],
          ['prod-demo-butter-chicken', 'cat-demo-main', 'Butter Chicken', 320, 1],
          ['prod-demo-dal-makhani', 'cat-demo-main', 'Dal Makhani', 220, 2],
          ['prod-demo-jeera-rice', 'cat-demo-main', 'Jeera Rice', 150, 3],
          ['prod-demo-cola', 'cat-demo-beverages', 'Cola', 60, 1],
          ['prod-demo-lemon-soda', 'cat-demo-beverages', 'Lemon Soda', 70, 2],
          ['prod-demo-gulab-jamun', 'cat-demo-desserts', 'Gulab Jamun', 80, 1],
        ] as const);
  for (const [id, categoryId, name, price, sort] of products)
    insertProduct(db, id, categoryId, name, price, sort);

  if (serviceModel === 'finedine') {
    const tableLabel = 'T';
    insertTable(db, 'tbl-demo-1', `${tableLabel}1`, 4);
    insertTable(db, 'tbl-demo-2', `${tableLabel}2`, 4);
    insertTable(db, 'tbl-demo-3', `${tableLabel}3`, 6);
    insertTable(db, 'tbl-demo-4', `${tableLabel}4`, 2);
  }

  // country is independent of UI language, but the demo profile needs a real
  // one to seed demo customers with a plausible phone number — the caller
  // (POST /setup/initialize) always supplies the owner's selected country.
  if (!country) throw new RegionalNotConfiguredError(country);
  const demoCountry = country;
  const dialCode = dialCodeFor(demoCountry);
  if (lang === 'th') {
    insertCustomer(db, 'cust-demo-1', 'สมชาย รักดี', '+66812345678', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-2', 'สุดา วงศ์ทอง', '+66812345679', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-3', 'ประเสริฐ ทองดี', '+66812345680', dialCode, demoCountry);
  } else {
    insertCustomer(db, 'cust-demo-1', 'Aarav Sharma', '+919876543210', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-2', 'Maya Iyer', '+919876543211', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-3', 'Kabir Khan', '+919876543212', dialCode, demoCountry);
  }

  const managerName = lang === 'th' ? 'ผู้จัดการสาธิต' : 'Demo Manager';
  const cashierName = lang === 'th' ? 'แคชเชียร์สาธิต' : 'Demo Cashier';
  const chefName = lang === 'th' ? 'เชฟสาธิต' : 'Demo Chef';
  // Demo staff accounts are inactive with random passwords to prevent usable default credentials.
  insertStaffUser(
    db,
    'user-demo-manager',
    managerName,
    'manager@flo.local',
    'manager',
    randomBytes(32).toString('hex'),
    0,
  );
  insertStaffUser(
    db,
    'user-demo-cashier',
    cashierName,
    'cashier@flo.local',
    'cashier',
    randomBytes(32).toString('hex'),
    0,
  );
  insertStaffUser(
    db,
    'user-demo-chef',
    chefName,
    'chef@flo.local',
    'chef',
    randomBytes(32).toString('hex'),
    0,
  );
}

export function seedSetupProfile(
  db: ReturnType<typeof getDatabase>,
  profile: string,
  serviceModel: string,
  language?: string,
  country?: string,
): void {
  if (profile === 'express') {
    seedExpressRestaurant(db, serviceModel, language);
  } else if (profile === 'demo') {
    seedDemoRestaurant(db, serviceModel, language, country);
  }
}
