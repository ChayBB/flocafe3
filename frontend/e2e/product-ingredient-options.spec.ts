import { test, expect } from '@playwright/test';
import { E2E_PASSWORD, getE2eToken, setLanguage } from './helpers/test-auth';
import { E2E_BASE_URL as BASE } from './helpers/urls';

test('a product saves a named size group and a required ingredient group from its editor', async ({
  page,
  request,
}, testInfo) => {
  const headers = {
    Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
  };
  const name = `Ingredient plate ${Date.now()}`;
  const categoriesResponse = await request.get(`${BASE}/api/categories`, { headers });
  const categories = (await categoriesResponse.json()).categories;
  const categoryId = categories.find((category: { is_active: boolean }) => category.is_active).id;
  const created = await request.post(`${BASE}/api/products`, {
    headers,
    data: {
      name,
      category_id: categoryId,
      price: 60,
      variants: [
        { name: 'Small plate', price: 60 },
        { name: 'Large plate', price: 70 },
      ],
    },
  });
  expect(created.status()).toBe(201);
  const productId = (await created.json()).product.id;
  let groupId: string | undefined;
  try {
    await setLanguage(page, 'en');
    await page.goto(`${BASE}/auth/login`);
    await page.getByLabel('Email').fill('manager@flo.local');
    await page.getByLabel('Password').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Sign In' }).click();
    await page.waitForURL(/\/(pos|orders)/);
    await page.goto(`${BASE}/products`);
    await page.getByRole('row').filter({ hasText: name }).getByRole('button').first().click();
    await page.getByLabel('Option group name').fill('Plate size');
    const ingredients = page.getByTestId('product-ingredient-options');
    await ingredients
      .getByRole('textbox', { name: 'New option group heading' })
      .fill(`Protein ${name}`);
    await ingredients.getByRole('button', { name: 'Add', exact: true }).click();
    const editor = page.getByTestId('addon-group-editor');
    await expect(editor.getByRole('textbox').first()).toHaveValue(`Protein ${name}`);
    for (const ingredient of ['Pork', 'Fish', 'Shrimp', 'Chicken']) {
      await editor.getByRole('button', { name: '+ Add Addon', exact: true }).click();
      await editor.getByLabel('Name', { exact: true }).last().fill(ingredient);
    }
    await editor.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(ingredients).toContainText('Shrimp');
    await ingredients.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('ingredient-editor.png') });
    await page.getByRole('button', { name: 'Update Product', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Edit Product' })).toHaveCount(0);
    const stored = await request.get(`${BASE}/api/products/${productId}`, { headers });
    const product = (await stored.json()).product;
    expect(product.variant_group_name).toBe('Plate size');
    const group = product.addon_groups.find(
      (candidate: { name: string }) => candidate.name === `Protein ${name}`,
    );
    expect(group).toBeTruthy();
    groupId = group.id;
    expect(Boolean(group.is_required)).toBe(true);
    expect(group.max_selection).toBe(1);
    expect(group.addons.map((addon: { name: string }) => addon.name)).toEqual([
      'Pork',
      'Fish',
      'Shrimp',
      'Chicken',
    ]);
    expect(group.addons.every((addon: { price: number }) => Number(addon.price) === 0)).toBe(true);
    await page.getByRole('row').filter({ hasText: name }).getByRole('button').first().click();
    await expect(page.getByLabel('Option group name')).toHaveValue('Plate size');
    await expect(page.getByTestId('product-ingredient-options')).toContainText('Chicken');
  } finally {
    await request.delete(`${BASE}/api/products/${productId}`, { headers }).catch(() => {});
    if (groupId) await request.delete(`${BASE}/api/addon-groups/${groupId}`, { headers });
  }
});
