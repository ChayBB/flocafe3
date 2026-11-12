import { test, expect, type Page } from '@playwright/test';
import { E2E_BASE_URL, E2E_KDS_BASE_URL, E2E_SERVER_APP_BASE_URL } from './helpers/urls';
import { getE2eToken } from './helpers/test-auth';

type SoundLog = {
  __beeps: number;
  __hums: number;
  __bells: number;
  __spoken: string[];
  __spokenAt: number[];
  __voices: string[];
  __volumes: number[];
};

async function recordSounds(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as SoundLog & Record<string, unknown>;
    w.__beeps = 0;
    w.__hums = 0;
    w.__bells = 0;
    w.__spoken = [];
    w.__spokenAt = [];
    w.__voices = [];
    w.__volumes = [];
    class FakeAudioContext {
      currentTime = 0;
      destination = {};
      state = 'running';
      onstatechange: (() => void) | null = null;
      resume() {
        return Promise.resolve();
      }
      createOscillator() {
        // The quiet sine hum that wakes a speaker is not an alert beep.
        return {
          type: '',
          frequency: { value: 0 },
          connect: (node: unknown) => node,
          start(this: { type: string }) {
            if (this.type === 'sine') w.__hums += 1;
            else w.__beeps += 1;
          },
          stop() {},
        };
      }
      createGain() {
        return { gain: { value: 0 }, connect: (node: unknown) => node };
      }
      decodeAudioData(data: ArrayBuffer) {
        return Promise.resolve({ duration: data.byteLength > 0 ? 0.05 : 0 });
      }
      createBufferSource() {
        return {
          buffer: null,
          onended: null,
          connect: (node: unknown) => node,
          start() {
            w.__bells += 1;
          },
        };
      }
    }
    class FakeUtterance {
      lang = '';
      rate = 1;
      volume = 1;
      voice: unknown = null;
      constructor(public text: string) {}
    }
    w.AudioContext = FakeAudioContext;
    w.SpeechSynthesisUtterance = FakeUtterance;
    const voices = [
      { name: 'Fake Local English', lang: 'en-US', localService: true },
      { name: 'Microsoft Fake Online (Natural) - English', lang: 'en-US', localService: false },
    ];
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        getVoices: () => voices,
        speak: (
          utterance: FakeUtterance & { onend?: () => void; voice: { name: string } | null },
        ) => {
          w.__spoken.push(utterance.text);
          w.__spokenAt.push(Date.now());
          w.__voices.push(utterance.voice?.name ?? '');
          w.__volumes.push(utterance.volume);
          setTimeout(() => utterance.onend?.(), 0);
        },
      },
    });
  });
}

const sounds = (page: Page) => page.evaluate(() => ({ ...(window as unknown as SoundLog) }));

test('orders already in the kitchen when the display signs in or switches station are not read out again', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const headers = {
    Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
  };
  const run = Math.random().toString(36).slice(2, 7);
  const categoryName = `Old ${run}`;
  const category = await page.request.post(`${E2E_BASE_URL}/api/categories`, {
    headers,
    data: { name: categoryName },
  });
  expect(category.status()).toBe(201);
  const productName = `Soup ${run}`;
  const product = await page.request.post(`${E2E_BASE_URL}/api/products`, {
    headers,
    data: {
      name: productName,
      category_id: (await category.json()).category.id,
      price: 40,
      tax_category_id: null,
      tax_behavior: 'exempt',
    },
  });
  expect(product.status()).toBe(201);
  const productId = (await product.json()).product.id as string;
  const placeOrder = async (orderNote: string, itemNote?: string) => {
    const order = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
      headers,
      data: {
        type: 'takeaway',
        special_instructions: orderNote,
        items: [{ product_id: productId, quantity: 1, special_instructions: itemNote }],
      },
    });
    expect(order.status()).toBe(201);
    return (await order.json()).order as { order_number: string };
  };
  const old = await placeOrder(`old note ${run}`);

  await recordSounds(page);
  await page.goto(`${E2E_KDS_BASE_URL}/kds-standalone`);
  await expect(
    page.getByTestId('kds-login-form').or(page.getByTestId('kds-workspace')),
  ).toBeVisible();
  if (await page.getByTestId('kds-login-form').isVisible()) {
    await page.getByTestId('kds-login-email').fill('manager@flo.local');
    await page.getByTestId('kds-login-password').fill('E2ePass123!');
    await page.getByTestId('kds-login-submit').click();
  }
  await expect(page.getByTestId('kds-workspace')).toBeVisible();
  await expect(page.getByText(`#${old.order_number}`).first()).toBeVisible({ timeout: 15000 });
  await page.getByTestId('kds-station-select').selectOption({ label: categoryName });
  await page.getByTestId('kds-station-select').selectOption({ index: 0 });
  await page.waitForTimeout(2000);
  const spokenAboutProduct = async () =>
    (await sounds(page)).__spoken.filter((text) => text.includes(productName));
  expect(await spokenAboutProduct()).toEqual([]);

  // A new order is read out once without its order number: "New order", the item 0.6 seconds later,
  // its special instructions 0.7 seconds after that, then the order note once the last item is read.
  const fresh = await placeOrder(`rush ${run}`, 'extra coconut');
  await expect.poll(spokenAboutProduct, { timeout: 15000 }).toHaveLength(1);
  const [spoken] = await spokenAboutProduct();
  expect(spoken).toBe(`1 ${productName}`);
  // After a quiet spell an online browser voice cuts its first sentence short, so a silent
  // first word goes ahead of the order, started while the new-order beep plays.
  const warm = await sounds(page);
  const spokenAt = warm.__spoken.indexOf(spoken);
  expect(warm.__spoken.slice(spokenAt - 2, spokenAt)).toEqual(['New', 'New order']);
  expect(warm.__volumes.slice(spokenAt - 2, spokenAt + 1)).toEqual([0, 1, 1]);
  expect(warm.__spokenAt[spokenAt] - warm.__spokenAt[spokenAt - 1]).toBeGreaterThanOrEqual(550);
  expect(spoken).not.toContain(fresh.order_number);
  await expect
    .poll(async () => (await sounds(page)).__spoken.includes(`Order note: rush ${run}`), {
      timeout: 15000,
    })
    .toBe(true);
  const log = await sounds(page);
  const at = log.__spoken.indexOf(spoken);
  expect(log.__spoken.slice(at, at + 3)).toEqual([
    spoken,
    'extra coconut',
    `Order note: rush ${run}`,
  ]);
  expect(log.__spokenAt[at + 1] - log.__spokenAt[at]).toBeGreaterThanOrEqual(650);
  expect(log.__spokenAt[at + 2] - log.__spokenAt[at + 1]).toBeGreaterThanOrEqual(650);
  expect(log.__spoken.join(' | ')).not.toContain('old note');
  await page.waitForTimeout(1500);
  expect(await spokenAboutProduct()).toHaveLength(1);

  // More than two dishes are read one by one, 30% further apart than the parts of a smaller order.
  const many = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
    headers,
    data: {
      type: 'takeaway',
      items: [1, 2, 3].map((quantity) => ({ product_id: productId, quantity })),
    },
  });
  expect(many.status()).toBe(201);
  await expect.poll(async () => (await spokenAboutProduct()).length, { timeout: 15000 }).toBe(4);
  const spaced = await sounds(page);
  const first = spaced.__spoken.lastIndexOf(`1 ${productName}`);
  expect(spaced.__spoken.slice(first - 1, first + 3)).toEqual([
    'New order',
    `1 ${productName}`,
    `2 ${productName}`,
    `3 ${productName}`,
  ]);
  expect(spaced.__spokenAt[first + 1] - spaced.__spokenAt[first]).toBeGreaterThanOrEqual(880);
  expect(spaced.__spokenAt[first + 2] - spaced.__spokenAt[first + 1]).toBeGreaterThanOrEqual(880);
});

test('KDS sound switches turn reading new items aloud and the ready-to-serve announcement on and off', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const headers = {
    Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
  };
  const run = Math.random().toString(36).slice(2, 7);
  const categoryName = `Sounds ${run}`;
  const category = await page.request.post(`${E2E_BASE_URL}/api/categories`, {
    headers,
    data: { name: categoryName },
  });
  expect(category.status()).toBe(201);
  const productName = `Lemonade ${run}`;
  const product = await page.request.post(`${E2E_BASE_URL}/api/products`, {
    headers,
    data: {
      name: productName,
      category_id: (await category.json()).category.id,
      price: 40,
      tax_category_id: null,
      tax_behavior: 'exempt',
    },
  });
  expect(product.status()).toBe(201);
  const productId = (await product.json()).product.id as string;
  const placeOrder = async () => {
    const order = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
      headers,
      data: {
        type: 'takeaway',
        items: [
          { product_id: productId, quantity: 2 },
          { product_id: productId, quantity: 1, special_instructions: 'later' },
        ],
      },
    });
    expect(order.status()).toBe(201);
    return (await order.json()).order as { order_number: string; items: { id: number }[] };
  };
  const markReady = async (itemId: number) => {
    const ready = await page.request.patch(`${E2E_BASE_URL}/api/order-items/${itemId}/status`, {
      headers,
      data: { status: 'ready' },
    });
    expect(ready.ok(), await ready.text()).toBeTruthy();
  };

  // The KDS server hands out both ready bell sounds.
  for (const file of ['kds-ready-bell.wav', 'kds-ready-ding.wav']) {
    const bell = await page.request.get(`${E2E_KDS_BASE_URL}/sounds/${file}`);
    expect(bell.ok()).toBeTruthy();
    expect((await bell.body()).subarray(0, 4).toString()).toBe('RIFF');
  }

  await recordSounds(page);
  await page.goto(`${E2E_KDS_BASE_URL}/kds-standalone`);
  await expect(
    page.getByTestId('kds-login-form').or(page.getByTestId('kds-workspace')),
  ).toBeVisible();
  if (await page.getByTestId('kds-login-form').isVisible()) {
    await page.getByTestId('kds-login-email').fill('manager@flo.local');
    await page.getByTestId('kds-login-password').fill('E2ePass123!');
    await page.getByTestId('kds-login-submit').click();
  }
  await expect(page.getByTestId('kds-workspace')).toBeVisible();
  await page.getByTestId('kds-station-select').selectOption({ label: categoryName });

  await page.getByTestId('kds-settings-button').click();
  const dialog = page.getByTestId('kds-settings-dialog');
  // Settings open on the display tab; sounds sit on their own tab.
  await expect(dialog.getByTestId('kds-settings-tab-display')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(dialog.getByTestId('kds-screen-mode-day')).toBeVisible();
  await expect(dialog.getByTestId('kds-sound-switch-readAloud')).toBeHidden();
  await dialog.getByTestId('kds-settings-tab-sound').click();
  await expect(dialog.getByTestId('kds-screen-mode-day')).toBeHidden();
  for (const setting of ['newOrderAlert', 'readAloud', 'orderReady']) {
    await expect(dialog.getByTestId(`kds-sound-switch-${setting}`)).toHaveAttribute(
      'aria-checked',
      'true',
    );
  }
  await expect(dialog.getByTestId('kds-sound-switch-showBell')).toHaveAttribute(
    'aria-checked',
    'false',
  );
  // Status-change alerts have no switch.
  await expect(dialog.getByRole('switch')).toHaveCount(4);
  await page.keyboard.press('Escape');

  // On by default: a new order is read out, and the bell rings and names the order when a menu
  // item turns ready to serve, even while the rest of the order is still cooking.
  const first = await placeOrder();
  await expect
    .poll(async () => (await sounds(page)).__spoken.join(' | '), { timeout: 15000 })
    .toContain(productName);
  expect((await sounds(page)).__voices.at(-1)).toBe('Microsoft Fake Online (Natural) - English');
  await expect
    .poll(async () => (await sounds(page)).__spoken.includes('later'), { timeout: 15000 })
    .toBe(true);
  const readOut = await sounds(page);
  const readIndex = readOut.__spoken.indexOf(`2 ${productName}, 1 ${productName}`);
  expect(readOut.__spoken[readIndex - 1]).toBe('New order');
  expect(readOut.__spoken[readIndex + 1]).toBe('later');
  const bellsBefore = (await sounds(page)).__bells;
  await markReady(first.items[0].id);
  await expect
    .poll(async () => (await sounds(page)).__bells, { timeout: 15000 })
    .toBe(bellsBefore + 1);
  await expect
    .poll(async () => (await sounds(page)).__spoken.join(' | '), { timeout: 15000 })
    .toContain('An order is ready to serve');
  // The new order is read out first, and the ready announcement waits at least 3 seconds after it.
  const log = await sounds(page);
  const readAt = log.__spokenAt[log.__spoken.indexOf(`2 ${productName}, 1 ${productName}`)];
  const readyAt = log.__spokenAt[log.__spoken.indexOf('An order is ready to serve')];
  expect(readyAt - readAt).toBeGreaterThanOrEqual(2900);
  // The rest of the order turning ready within 10 seconds is not announced again.
  const afterFirst = await sounds(page);
  await markReady(first.items[1].id);
  await expect(
    page.getByTestId('kds-column-ready').or(page.getByTestId('kds-workspace')).first(),
  ).toBeVisible();
  await page.waitForTimeout(1500);
  expect((await sounds(page)).__bells).toBe(afterFirst.__bells);
  expect((await sounds(page)).__spoken).toEqual(afterFirst.__spoken);

  // The display can pick its ready bell; the choice rings as a sample and is kept.
  await page.getByTestId('kds-settings-button').click();
  await dialog.getByTestId('kds-settings-tab-sound').click();
  const bellSelect = dialog.getByTestId('kds-ready-bell-select');
  await expect(bellSelect.locator('option')).toHaveText([
    'Hotel bell',
    'Double ding',
    'No bell (read the table only)',
  ]);
  await expect(bellSelect).toHaveValue('hotel');
  const bellsBeforeSample = (await sounds(page)).__bells;
  await bellSelect.selectOption('ding');
  await expect.poll(async () => (await sounds(page)).__bells).toBe(bellsBeforeSample + 1);
  expect(await page.evaluate(() => localStorage.getItem('flocafe:kds-ready-bell'))).toBe('ding');

  // The repeat delay starts at 10 seconds and is kept per display, within 0 to 300 seconds.
  const repeat = dialog.getByTestId('kds-ready-repeat');
  await expect(repeat).toHaveValue('10');
  await repeat.fill('999');
  await repeat.press('Enter');
  await expect(repeat).toHaveValue('300');
  await repeat.fill('25');
  await repeat.blur();
  expect(await page.evaluate(() => localStorage.getItem('flocafe:kds-ready-repeat'))).toBe('25');
  await repeat.fill('10');
  await repeat.blur();
  // The delay between tables starts at 0 seconds.
  await expect(dialog.getByTestId('kds-ready-gap')).toHaveValue('0');
  await page.keyboard.press('Escape');

  // The display can pick another voice; the choice is read out as a sample.
  await page.getByTestId('kds-settings-button').click();
  await dialog.getByTestId('kds-settings-tab-sound').click();
  const voiceSelect = dialog.getByTestId('kds-voice-select');
  await expect(voiceSelect.locator('option')).toHaveText([
    'Automatic (Edge natural voice when available)',
    'Windows voice on the POS computer',
    'Microsoft Fake Online (Natural) - English · natural, online',
    'Fake Local English',
  ]);
  await expect(voiceSelect.locator('optgroup')).toHaveCount(2);
  await voiceSelect.selectOption('Fake Local English');
  await expect.poll(async () => (await sounds(page)).__voices.at(-1)).toBe('Fake Local English');
  expect((await sounds(page)).__spoken.at(-1)).toBe('Table 5, fried rice, 2');

  // Switched off, and still off after a reload: new orders and ready orders stay silent.
  await dialog.getByTestId('kds-sound-switch-readAloud').click();
  await dialog.getByTestId('kds-sound-switch-orderReady').click();
  // With the ready sound off, its bell and repeat delay settings are dimmed.
  await expect(dialog.getByTestId('kds-ready-bell-select')).toBeDisabled();
  await expect(dialog.getByTestId('kds-ready-repeat')).toBeDisabled();
  await expect(dialog.getByTestId('kds-ready-gap')).toBeDisabled();
  await expect(dialog.getByTestId('kds-sound-switch-readAloud')).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.getByTestId('kds-workspace')).toBeVisible();
  await page.getByTestId('kds-station-select').selectOption({ label: categoryName });
  await page.getByTestId('kds-settings-button').click();
  await dialog.getByTestId('kds-settings-tab-sound').click();
  await expect(dialog.getByTestId('kds-sound-switch-readAloud')).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await expect(dialog.getByTestId('kds-sound-switch-orderReady')).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await page.keyboard.press('Escape');

  const quiet = await sounds(page);
  const second = await placeOrder();
  await expect(page.getByText(`#${second.order_number}`).first()).toBeVisible({ timeout: 15000 });
  await markReady(second.items[0].id);
  await page.waitForTimeout(2000);
  const after = await sounds(page);
  expect(after.__spoken).toEqual(quiet.__spoken);
  expect(after.__bells).toBe(quiet.__bells);
});

test('a table with several items turning ready is announced once, and not again for 10 seconds', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const headers = {
    Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
  };
  const run = Math.random().toString(36).slice(2, 7);
  const tableName = `Bell ${run}`;
  const table = await page.request.post(`${E2E_BASE_URL}/api/tables`, {
    headers,
    data: { number: tableName, capacity: 4 },
  });
  expect(table.status()).toBe(201);
  const tableId = (await table.json()).table.id;
  // Two tickets on the same table, as when staff add a second round.
  const tickets: { items: { id: number }[] }[] = [];
  for (const note of ['first round', 'second round']) {
    const order = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
      headers,
      data: {
        type: 'dine_in',
        table_id: tableId,
        items: [
          { product_id: 'e2e-product', quantity: 1, special_instructions: `${note} a` },
          { product_id: 'e2e-product', quantity: 1, special_instructions: `${note} b` },
          { product_id: 'e2e-product', quantity: 1, special_instructions: `${note} c` },
          { product_id: 'e2e-product', quantity: 1, special_instructions: `${note} d` },
        ],
      },
    });
    expect(order.status()).toBe(201);
    tickets.push((await order.json()).order);
  }
  const markReady = async (itemId: number) => {
    const ready = await page.request.patch(`${E2E_BASE_URL}/api/order-items/${itemId}/status`, {
      headers,
      data: { status: 'ready' },
    });
    expect(ready.ok(), await ready.text()).toBeTruthy();
  };
  const announced = async () =>
    (await sounds(page)).__spoken.filter((text) => text === `Table ${tableName} is ready to serve`)
      .length;

  await page.clock.install();
  await recordSounds(page);
  await page.goto(`${E2E_KDS_BASE_URL}/kds-standalone`);
  await expect(
    page.getByTestId('kds-login-form').or(page.getByTestId('kds-workspace')),
  ).toBeVisible();
  if (await page.getByTestId('kds-login-form').isVisible()) {
    await page.getByTestId('kds-login-email').fill('manager@flo.local');
    await page.getByTestId('kds-login-password').fill('E2ePass123!');
    await page.getByTestId('kds-login-submit').click();
  }
  await expect(page.getByTestId('kds-workspace')).toBeVisible();
  await page.getByRole('button', { name: 'Kanban' }).click();
  await expect(page.getByText(`first round a`).first()).toBeVisible({ timeout: 15000 });
  const start = await sounds(page);
  const readyColumn = page.getByTestId('kds-column-ready');

  // Items from both tickets turn ready together: one bell, one announcement for the table.
  await Promise.all([markReady(tickets[0].items[0].id), markReady(tickets[1].items[0].id)]);
  await expect.poll(announced, { timeout: 15000 }).toBe(1);
  await page.waitForTimeout(1500);
  expect(await announced()).toBe(1);
  expect((await sounds(page)).__bells).toBe(start.__bells + 1);

  // More items for the same table within 10 seconds stay quiet, but still move on the screen.
  await page.clock.fastForward(1000);
  await markReady(tickets[0].items[1].id);
  await expect(readyColumn.getByText('first round b')).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(1500);
  expect(await announced()).toBe(1);
  expect((await sounds(page)).__bells).toBe(start.__bells + 1);

  // A skipped item is not announced later when the 10 seconds run out.
  await page.clock.fastForward(6000);
  await page.waitForTimeout(1500);
  expect(await announced()).toBe(1);

  // After the 10 seconds the next item for the table rings and is announced again.
  await markReady(tickets[1].items[1].id);
  await expect.poll(announced, { timeout: 15000 }).toBe(2);
  expect((await sounds(page)).__bells).toBe(start.__bells + 2);

  // A display with no repeat delay rings for the table again straight away.
  await page.evaluate(() => localStorage.setItem('flocafe:kds-ready-repeat', '0'));
  await markReady(tickets[0].items[2].id);
  await expect.poll(announced, { timeout: 15000 }).toBe(3);
  expect((await sounds(page)).__bells).toBe(start.__bells + 3);

  // With a delay between alerts the next one waits its turn rather than being skipped.
  await page.evaluate(() => localStorage.setItem('flocafe:kds-ready-gap', '30'));
  await markReady(tickets[1].items[2].id);
  await expect(readyColumn.getByText('second round c')).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(1500);
  expect(await announced()).toBe(3);
  // A new order arriving meanwhile is read out without waiting for the queued alert.
  const readOut = async () =>
    (await sounds(page)).__spoken.filter((text) => text === `Table ${tableName}`).length;
  const readBefore = await readOut();
  const late = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
    headers,
    data: {
      type: 'dine_in',
      table_id: tableId,
      items: [{ product_id: 'e2e-product', quantity: 1, special_instructions: 'late round' }],
    },
  });
  expect(late.status()).toBe(201);
  const lateNumber = (await late.json()).order.order_number as string;
  await expect(page.getByText(`#${lateNumber}`).first()).toBeVisible({ timeout: 15000 });
  await expect.poll(readOut, { timeout: 15000 }).toBe(readBefore + 1);
  expect(await announced()).toBe(3);
  await page.clock.fastForward(30000);
  await expect.poll(announced, { timeout: 15000 }).toBe(4);
  expect((await sounds(page)).__bells).toBe(start.__bells + 4);

  // A display set to no bell only reads the table.
  await page.evaluate(() => {
    localStorage.setItem('flocafe:kds-ready-gap', '0');
    localStorage.setItem('flocafe:kds-ready-bell', 'none');
  });
  await markReady(tickets[0].items[3].id);
  await expect.poll(announced, { timeout: 15000 }).toBe(5);
  expect((await sounds(page)).__bells).toBe(start.__bells + 4);
});

test('the show-bell switch puts a bell button at the right end of the message bar that rings the ready bell', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await recordSounds(page);
  await page.goto(`${E2E_KDS_BASE_URL}/kds-standalone`);
  await expect(
    page.getByTestId('kds-login-form').or(page.getByTestId('kds-workspace')),
  ).toBeVisible();
  if (await page.getByTestId('kds-login-form').isVisible()) {
    await page.getByTestId('kds-login-email').fill('manager@flo.local');
    await page.getByTestId('kds-login-password').fill('E2ePass123!');
    await page.getByTestId('kds-login-submit').click();
  }
  await expect(page.getByTestId('kds-workspace')).toBeVisible();
  await page.getByRole('button', { name: 'Kanban' }).click();
  await expect(page.getByTestId('kds-bell-button')).toHaveCount(0);

  await page.getByTestId('kds-settings-button').click();
  const dialog = page.getByTestId('kds-settings-dialog');
  await dialog.getByTestId('kds-settings-tab-sound').click();
  await dialog.getByTestId('kds-sound-switch-showBell').click();
  await page.keyboard.press('Escape');

  const bar = page.getByTestId('kds-message-bar');
  const bell = bar.getByTestId('kds-bell-button');
  await expect(bell).toBeVisible();
  const barBox = (await bar.boundingBox())!;
  const bellBox = (await bell.boundingBox())!;
  expect(Math.abs(barBox.x + barBox.width - (bellBox.x + bellBox.width))).toBeLessThan(2);
  await expect(bell).toHaveText('Ring bell');
  const before = (await sounds(page)).__bells;
  await bell.click();
  await expect.poll(async () => (await sounds(page)).__bells).toBe(before + 1);

  // The choice is kept after a reload.
  await page.reload();
  await expect(page.getByTestId('kds-message-bar').getByTestId('kds-bell-button')).toBeVisible();
});

test('an item switched to take-away still rings the ready bell and is announced when it turns ready', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const headers = {
    Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
  };
  const serverHeaders = {
    Authorization: `Bearer ${getE2eToken('e2e-server', 'server@flo.local', 'server')}`,
  };
  const run = Math.random().toString(36).slice(2, 7);
  const tableName = `Pack ${run}`;
  const table = await page.request.post(`${E2E_BASE_URL}/api/tables`, {
    headers,
    data: { number: tableName, capacity: 4 },
  });
  expect(table.status()).toBe(201);
  const order = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
    headers,
    data: {
      type: 'dine_in',
      table_id: (await table.json()).table.id,
      items: [
        { product_id: 'e2e-product', quantity: 1, special_instructions: `to go ${run}` },
        { product_id: 'e2e-product', quantity: 1, special_instructions: `stays ${run}` },
      ],
    },
  });
  expect(order.status()).toBe(201);
  const created = (await order.json()).order as { id: number; items: { id: number }[] };
  const announced = async () =>
    (await sounds(page)).__spoken.filter((text) => text === `Table ${tableName} is ready to serve`)
      .length;

  await recordSounds(page);
  await page.goto(`${E2E_KDS_BASE_URL}/kds-standalone`);
  await expect(
    page.getByTestId('kds-login-form').or(page.getByTestId('kds-workspace')),
  ).toBeVisible();
  if (await page.getByTestId('kds-login-form').isVisible()) {
    await page.getByTestId('kds-login-email').fill('manager@flo.local');
    await page.getByTestId('kds-login-password').fill('E2ePass123!');
    await page.getByTestId('kds-login-submit').click();
  }
  await expect(page.getByTestId('kds-workspace')).toBeVisible();
  await page.getByRole('button', { name: 'Kanban' }).click();
  await expect(page.getByText(`to go ${run}`).first()).toBeVisible({ timeout: 15000 });

  const takeaway = await page.request.patch(
    `${E2E_SERVER_APP_BASE_URL}/api/orders/${created.id}/items/${created.items[0].id}/takeaway`,
    { headers: serverHeaders },
  );
  expect(takeaway.status()).toBe(200);
  await expect(page.getByTestId('kds-message-bar')).toContainText(`Table ${tableName}:`, {
    timeout: 15000,
  });
  const start = await sounds(page);

  const ready = await page.request.patch(
    `${E2E_BASE_URL}/api/order-items/${created.items[0].id}/status`,
    {
      headers,
      data: { status: 'ready' },
    },
  );
  expect(ready.ok(), await ready.text()).toBeTruthy();
  await expect.poll(announced, { timeout: 15000 }).toBe(1);
  expect((await sounds(page)).__bells).toBe(start.__bells + 1);
});

test('the POS voice wakes the speaker and reads new items when the browser voice stalls', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const headers = {
    Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
  };
  const run = Math.random().toString(36).slice(2, 7);
  const category = await page.request.post(`${E2E_BASE_URL}/api/categories`, {
    headers,
    data: { name: `Lead ${run}` },
  });
  expect(category.status()).toBe(201);
  const product = await page.request.post(`${E2E_BASE_URL}/api/products`, {
    headers,
    data: {
      name: `Rice ${run}`,
      category_id: (await category.json()).category.id,
      price: 40,
      tax_category_id: null,
      tax_behavior: 'exempt',
    },
  });
  expect(product.status()).toBe(201);

  await recordSounds(page);
  await page.addInitScript(() => {
    const w = window as unknown as {
      __starts: number[];
      AudioContext: { prototype: Record<string, unknown> };
    };
    w.__starts = [];
    localStorage.setItem('flocafe:kds-voice', 'server:e2e-voice');
    // The new-order beep itself wakes the speaker; this checks the hum used when nothing has played.
    localStorage.setItem('flocafe:kds-sound-settings', JSON.stringify({ newOrderAlert: false }));
    w.AudioContext.prototype.createBufferSource = function (this: { currentTime: number }) {
      const currentTime = () => this.currentTime;
      const source = {
        buffer: null,
        onended: null as null | (() => void),
        connect: (node: unknown) => node,
        start(when = 0) {
          w.__starts.push(when - currentTime());
          setTimeout(() => source.onended?.(), 10);
        },
      };
      return source;
    };
  });
  await page.route('**/api/kds/speech', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 200,
          contentType: 'audio/wav',
          body: Buffer.from('RIFF-e2e-audio'),
        })
      : route.fulfill({
          json: { engine: 'system', voices: [] },
        }),
  );

  await page.goto(`${E2E_KDS_BASE_URL}/kds-standalone`);
  await expect(
    page.getByTestId('kds-login-form').or(page.getByTestId('kds-workspace')),
  ).toBeVisible();
  if (await page.getByTestId('kds-login-form').isVisible()) {
    await page.getByTestId('kds-login-email').fill('manager@flo.local');
    await page.getByTestId('kds-login-password').fill('E2ePass123!');
    await page.getByTestId('kds-login-submit').click();
  }
  await expect(page.getByTestId('kds-workspace')).toBeVisible();
  const starts = () => page.evaluate(() => (window as unknown as { __starts: number[] }).__starts);
  // Let anything the display reads on sign-in finish, then stay quiet long enough to count as idle.
  let seen = -1;
  while (seen !== (await starts()).length) {
    seen = (await starts()).length;
    await page.waitForTimeout(2500);
  }

  const humsBefore = (await sounds(page)).__hums;
  const order = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
    headers,
    data: {
      type: 'takeaway',
      items: [{ product_id: (await product.json()).product.id, quantity: 1 }],
    },
  });
  expect(order.status()).toBe(201);
  // "New order", then the dish 0.6 seconds later, both in the POS voice.
  await expect.poll(async () => (await starts()).length, { timeout: 15000 }).toBe(seen + 2);
  expect((await starts())[seen]).toBeGreaterThanOrEqual(0.7);
  // A quiet hum plays during that lead, since silence alone does not wake a sleeping speaker.
  expect((await sounds(page)).__hums).toBe(humsBefore + 1);

  await page.clock.install();
  await page.evaluate(() => {
    localStorage.removeItem('flocafe:kds-voice');
    window.speechSynthesis.speak = (utterance) => {
      if (utterance.volume > 0) {
        (window as unknown as SoundLog).__spoken.push(utterance.text);
      } else {
        utterance.onend?.(new Event('end') as SpeechSynthesisEvent);
      }
    };
    window.speechSynthesis.cancel = () => {};
  });
  const nextOrder = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
    headers,
    data: {
      type: 'takeaway',
      items: [{ product_id: (await product.json()).product.id, quantity: 2 }],
    },
  });
  expect(nextOrder.status()).toBe(201);
  const announcement = 'New order';
  await expect.poll(async () => (await sounds(page)).__spoken).toContain(announcement);
  const fallback = page.waitForRequest(
    (request) =>
      request.url().endsWith('/api/kds/speech') &&
      request.method() === 'POST' &&
      request.postDataJSON().text === announcement,
  );
  await page.clock.fastForward(20_000);
  await fallback;
  await expect.poll(async () => (await starts()).length).toBe(seen + 3);
});
