import { test, expect } from '@playwright/test';
import { E2E_BASE_URL, E2E_KDS_BASE_URL, E2E_SERVER_APP_BASE_URL } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken, setLanguage } from './helpers/test-auth';
import {
  kdsItemLine,
  optionsNote,
  spokenItemName,
  withoutOptionsNote,
} from '../src/lib/item-options-note';
import { itemLine, ticketItemLine } from '../../shared/item-line';
import { detectKdsBoardChanges, kdsItemPlaces } from '../src/lib/kds-messages';
import type { KdsOrder } from '../src/hooks/useKdsConnection';

const TOKEN_KEY = 'flocafe:server-app-token';

test('printed bills and tickets join options into a name that lists choices, and keep rows otherwise', () => {
  const addons = [{ name: 'หมู' }, { name: 'ไข่ดาว', quantity: 2 }];
  expect(
    itemLine('ข้าวผัด หมู/กุ้ง/ไก่/ปลาหมึก', { name: 'จานเล็ก' }, addons, 'จานเล็ก หมู ไข่ดาว ×2', {
      joined: [addons[0]],
    }),
  ).toEqual({ name: 'ข้าวผัดหมู (จานเล็ก)', instructions: '', joinsOptions: true });
  expect(
    itemLine('Rice soup pork/shrimp', null, [{ name: 'Pork' }], '', {
      joined: [{ name: 'Pork', quantity: 2 }],
    }).name,
  ).toBe('Rice soup Pork x2');
  expect(ticketItemLine('ข้าวต้ม หมู/กุ้ง', null, addons, '')).toEqual({
    name: 'ข้าวต้มหมู ไข่ดาว x2',
    instructions: '',
    joinsOptions: true,
  });
  // A name without listed choices keeps its options as rows: a printer drops a row it cannot
  // encode but refuses an item line, so an option must not ride on the name.
  expect(ticketItemLine('ข้าวผัด', null, addons, 'ไม่ใส่ผัก')).toEqual({
    name: 'ข้าวผัด',
    instructions: 'ไม่ใส่ผัก',
    joinsOptions: false,
  });
});

test('the KDS reads the chosen option and size instead of the listed choices and brackets', () => {
  const addons = [{ name: 'หมู' }];
  expect(spokenItemName('ข้าวต้ม หมู/กุ้ง/ไก่/ปลาหมึก', 'จานเล็ก', addons)).toBe('ข้าวต้มหมู จานเล็ก');
  expect(spokenItemName('ข้าวต้ม (หมู/กุ้ง)', 'ชามใหญ่', addons)).toBe('ข้าวต้มหมู ชามใหญ่');
  expect(spokenItemName('ข้าวต้ม หมู/กุ้ง', null, [])).toBe('ข้าวต้ม หมู/กุ้ง');
  // Invisible characters from imported names never reach the voice.
  expect(spokenItemName('ข้าวไข่เจียว\u200B หมู/กุ้ง/ไก่', null, [{ name: 'กุ้ง\uFEFF' }])).toBe(
    'ข้าวไข่เจียวกุ้ง',
  );
  const note = optionsNote('จานเล็ก', addons);
  expect(note).toBe('จานเล็ก หมู');
  expect(withoutOptionsNote('จานเล็ก หมู', note)).toBe('');
  expect(withoutOptionsNote('จานเล็ก หมู | ไม่ใส่ผัก', note)).toBe('ไม่ใส่ผัก');
  expect(withoutOptionsNote('ไม่ใส่ผัก', note)).toBe('ไม่ใส่ผัก');
});

test('the KDS line shows the chosen option on the dish with the size in brackets', () => {
  const line = kdsItemLine({
    product_name: 'ข้าวต้ม หมู/กุ้ง/ไก่/ปลาหมึก',
    variant_selection: JSON.stringify({ name: 'จานเล็ก' }),
    addons: [{ name: 'หมู' }],
    special_instructions: 'จานเล็ก หมู | ไม่ใส่ผัก',
  });
  expect(line).toEqual({ name: 'ข้าวต้มหมู (จานเล็ก)', instructions: 'ไม่ใส่ผัก' });
  expect(
    kdsItemLine({
      product_name: 'ข้าวผัด หมู/กุ้ง',
      addons: [{ name: 'กุ้ง', quantity: 2 }, { name: 'ไข่ดาว' }],
      special_instructions: 'กุ้ง ×2 ไข่ดาว',
    }),
  ).toEqual({ name: 'ข้าวผัดกุ้ง ×2 ไข่ดาว', instructions: '' });
  // Without options the line is the product and its size, as before.
  expect(
    kdsItemLine({
      product_name: 'ข้าวโพดอ่อนผัดกุ้ง (เผ็ด)',
      variant_selection: { name: 'จานใหญ่' },
      special_instructions: 'ไม่เผ็ด',
    }),
  ).toEqual({ name: 'ข้าวโพดอ่อนผัดกุ้ง (เผ็ด) (จานใหญ่)', instructions: 'ไม่เผ็ด' });
});

test('a one-kind option folds once picked, and the size and option go into the special instructions', async ({
  page,
}) => {
  const headers = {
    Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
  };
  const run = Math.random().toString(36).slice(2, 7);
  const group = await page.request.post(`${E2E_BASE_URL}/api/addon-groups`, {
    headers,
    data: {
      name: `Meat ${run}`,
      min_selection: 0,
      max_selection: 10,
      allow_multiple_quantities: true,
      addons: [
        { name: `Pork ${run}`, price: 0 },
        { name: `Shrimp ${run}`, price: 0 },
        { name: `Squid ${run}`, price: 0 },
      ],
    },
  });
  expect(group.status()).toBe(201);
  const category = await page.request.post(`${E2E_BASE_URL}/api/categories`, {
    headers,
    data: { name: `Soup ${run}` },
  });
  expect(category.status()).toBe(201);
  const productName = `Rice soup ${run}`;
  const product = await page.request.post(`${E2E_BASE_URL}/api/products`, {
    headers,
    data: {
      name: productName,
      category_id: (await category.json()).category.id,
      price: 60,
      tax_category_id: null,
      tax_behavior: 'exempt',
      addon_group_ids: [(await group.json()).addon_group.id],
      variants: [
        { name: 'Small plate', price: 60 },
        { name: 'Large plate', price: 70 },
      ],
    },
  });
  expect(product.status()).toBe(201);
  // Removed afterwards, so later suites that open the first menu card do not get this product's options.
  // Ids are read now: a response body is gone once the page signs in and navigates.
  const productId = (await product.json()).product.id;
  const groupId = (await group.json()).addon_group.id;
  const categoryId = (await category.json()).category.id;
  const cleanup = async () => {
    await page.request.delete(`${E2E_BASE_URL}/api/products/${productId}`, { headers });
    await page.request.delete(`${E2E_BASE_URL}/api/addon-groups/${groupId}`, { headers });
    await page.request.delete(`${E2E_BASE_URL}/api/categories/${categoryId}`, { headers });
  };
  try {
    const table = await page.request.post(`${E2E_BASE_URL}/api/tables`, {
      headers,
      data: { number: `Opt ${run}`, capacity: 2 },
    });
    const tableId = (await table.json()).table.id;

    await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone`);
    await page.evaluate(
      ([key, token]) => {
        localStorage.setItem(key, token);
        const raw = localStorage.getItem('pos-settings');
        const parsed = raw ? JSON.parse(raw) : { state: {} };
        parsed.state = { ...parsed.state, language: 'en' };
        localStorage.setItem('pos-settings', JSON.stringify(parsed));
      },
      [TOKEN_KEY, getE2eToken('e2e-server', 'server@flo.local', 'server')],
    );
    await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone?table=${tableId}`);

    const grid = page.getByTestId('pos-product-grid');
    await grid.getByTestId('pos-product-search').fill(productName);
    await grid.getByTestId('pos-product-card').filter({ hasText: productName }).click();

    await page.getByRole('radio', { name: /Large plate/ }).click();
    const row = (name: string) => page.locator('div.min-h-14').filter({ hasText: name });
    await expect(row(`Shrimp ${run}`)).toBeVisible();
    await row(`Pork ${run}`).getByRole('button').click();
    await expect(row(`Shrimp ${run}`)).toHaveCount(0);
    await expect(row(`Squid ${run}`)).toHaveCount(0);
    // Dialling the pick back to 0 brings the other choices back.
    await row(`Pork ${run}`).getByRole('button').first().click();
    await expect(row(`Shrimp ${run}`)).toBeVisible();
    await row(`Shrimp ${run}`).getByRole('button').click();
    await expect(row(`Pork ${run}`)).toHaveCount(0);

    await page.getByRole('button', { name: /Add to Cart/ }).click();
    await page.getByRole('button', { name: 'Send to kitchen' }).first().click();
    await expect(page.getByText('Order sent').first()).toBeVisible();

    const orders = await (
      await page.request.get(`${E2E_BASE_URL}/api/orders`, {
        headers,
        params: { table_id: tableId, type: 'dine_in', per_page: 1 },
      })
    ).json();
    expect(orders.orders[0].items[0].special_instructions).toBe(`Large plate Shrimp ${run}`);

    // The kitchen screen shows the choice on the dish and the size in brackets, with no repeat below.
    await page.goto(`${E2E_KDS_BASE_URL}/kds-standalone`);
    await expect(
      page.getByTestId('kds-login-form').or(page.getByTestId('kds-workspace')),
    ).toBeVisible();
    if (await page.getByTestId('kds-login-form').isVisible()) {
      await page.getByTestId('kds-login-email').fill('manager@flo.local');
      await page.getByTestId('kds-login-password').fill('E2ePass123!');
      await page.getByTestId('kds-login-submit').click();
    }
    const kdsRow = page.getByTestId('kds-item-row').filter({ hasText: productName });
    await expect(kdsRow).toHaveText(`1×${productName} Shrimp ${run} (Large plate)`);

    // The order screen names the item the same way, without the choice repeated below it.
    await page.goto(`${E2E_BASE_URL}/auth/login`);
    await page.getByLabel('Email').fill('owner@flo.local');
    await page.getByLabel('Password').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Sign In' }).click();
    await page.waitForURL(/\/(pos|orders)/, { timeout: 20000 });
    await setLanguage(page, 'en');
    await page.goto(`${E2E_BASE_URL}/orders`);
    await page.getByText(orders.orders[0].order_number).first().click();
    const item = page.getByTestId('order-detail-item').filter({ hasText: productName });
    await expect(item).toContainText(`${productName} Shrimp ${run} (Large plate)`);
    await expect(item).not.toContainText(`+ Shrimp ${run}`);
    await expect(item).not.toContainText('"');
  } finally {
    await cleanup();
  }
});

test('the Server App lists a sent dish by its chosen option, as the KDS does', async ({ page }) => {
  const managerToken = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
  const headers = { Authorization: `Bearer ${managerToken}` };
  const run = Math.random().toString(36).slice(2, 7);
  const group = await page.request.post(`${E2E_BASE_URL}/api/addon-groups`, {
    headers,
    data: {
      name: `Meat ${run}`,
      min_selection: 1,
      max_selection: 1,
      addons: [
        { name: 'หมู', price: 0 },
        { name: 'กุ้ง', price: 0 },
      ],
    },
  });
  expect(group.status()).toBe(201);
  const groupBody = (await group.json()).addon_group;
  const groupId = groupBody.id as string;
  const porkId = (groupBody.addons as { id: string; name: string }[]).find(
    (a) => a.name === 'หมู',
  )!.id;
  const category = await page.request.post(`${E2E_BASE_URL}/api/categories`, {
    headers,
    data: { name: `Rice ${run}` },
  });
  const categoryId = (await category.json()).category.id;
  const productName = `ข้าวผัด${run} หมู/กุ้ง`;
  const product = await page.request.post(`${E2E_BASE_URL}/api/products`, {
    headers,
    data: {
      name: productName,
      category_id: categoryId,
      price: 60,
      tax_category_id: null,
      tax_behavior: 'exempt',
      addon_group_ids: [groupId],
    },
  });
  expect(product.status()).toBe(201);
  const productId = (await product.json()).product.id;
  try {
    const table = await page.request.post(`${E2E_BASE_URL}/api/tables`, {
      headers,
      data: { number: `Named ${run}`, capacity: 2 },
    });
    const tableId = (await table.json()).table.id;
    const order = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
      headers,
      data: {
        type: 'dine_in',
        table_id: tableId,
        items: [{ product_id: productId, quantity: 1, addons: [{ id: porkId, quantity: 1 }] }],
      },
    });
    expect(order.status()).toBe(201);
    const expected = kdsItemLine({ product_name: productName, addons: [{ name: 'หมู' }] }).name;
    expect(expected).not.toContain('/');

    await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone`);
    await page.evaluate(
      ([key, token]) => localStorage.setItem(key, token),
      [TOKEN_KEY, managerToken],
    );
    await page.reload();
    await page
      .getByRole('button', { name: new RegExp(`Named ${run}`) })
      .first()
      .click();
    await page.getByTestId('server-app-ordered-items-button').click();
    const line = page.getByTestId('server-app-ordered-item');
    await expect(line).toHaveCount(1);
    await expect(line).toContainText(expected);
    await expect(line).not.toContainText('หมู/กุ้ง');
  } finally {
    await page.request.delete(`${E2E_BASE_URL}/api/products/${productId}`, { headers });
    await page.request.delete(`${E2E_BASE_URL}/api/addon-groups/${groupId}`, { headers });
    await page.request.delete(`${E2E_BASE_URL}/api/categories/${categoryId}`, { headers });
  }
});

test('a KDS take-away or cancel notice names the dish by its chosen option, shown and spoken', () => {
  const order = (change: string | null) =>
    ({
      id: 1,
      order_number: 'ORD-1',
      table: { name: '26' },
      items: [
        {
          id: 7,
          product_name: 'ข้าวผัด หมู/กุ้ง/ไก่/ปลาหมึก',
          variant_selection: JSON.stringify({ name: 'จานเล็ก' }),
          addons: [{ name: 'หมู' }],
          service_change: change,
        },
      ],
    }) as unknown as KdsOrder;
  const placeOf = () => 'โต๊ะ 26';
  const [takeaway] = detectKdsBoardChanges(
    kdsItemPlaces([order(null)], placeOf),
    kdsItemPlaces([order('takeaway')], placeOf),
  );
  expect(takeaway).toEqual({
    kind: 'takeaway',
    key: 'takeaway:7',
    place: 'โต๊ะ 26',
    item: 'ข้าวผัดหมู (จานเล็ก)',
    spoken: 'ข้าวผัดหมู จานเล็ก',
  });
  const [cancelled] = detectKdsBoardChanges(
    kdsItemPlaces([order(null)], placeOf),
    kdsItemPlaces([order('cancelled')], placeOf),
  );
  expect(cancelled).toMatchObject({ item: 'ข้าวผัดหมู (จานเล็ก)', spoken: 'ข้าวผัดหมู จานเล็ก' });
});
