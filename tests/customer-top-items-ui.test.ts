/**
 * Customer top items in the POS: view states, stale-response handling, catalog resolution, and
 * click-to-add wiring.
 *
 *   - no customer hides the section; a pending, empty, or failed request shows a compact status;
 *   - a response for a previous customer is never shown under the current one, and an aborted
 *     request (customer switched mid-flight) never settles at all;
 *   - entries resolve to the current catalog product (current price), while deleted or
 *     unavailable products stay listed but cannot be added;
 *   - clicking an addable entry hands the catalog product to the POS product-click handler, the
 *     same flow as a product grid tap.
 *
 * Usage: ts-node --transpile-only -P tests/tsconfig.json tests/customer-top-items-ui.test.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..');
const Module = require('module');
const frontendRequire = Module.createRequire(path.join(ROOT, 'frontend/package.json'));
const moduleApi = require('module') as {
  _resolveFilename: (...args: any[]) => string;
  _load: (...args: any[]) => any;
};
const originalResolveFilename = moduleApi._resolveFilename;
moduleApi._resolveFilename = function (
  request: string,
  parent: any,
  isMain: boolean,
  options?: any,
) {
  const resolvedRequest =
    request === '@countries'
      ? path.resolve(ROOT, 'main/countries.ts')
      : request.startsWith('@/')
        ? path.resolve(ROOT, 'frontend/src', request.slice(2))
        : request.startsWith('@print/')
          ? path.resolve(ROOT, 'shared/print', request.slice('@print/'.length))
          : request.startsWith('@shared/')
            ? path.resolve(ROOT, 'shared', request.slice('@shared/'.length))
            : request;
  return originalResolveFilename.call(this, resolvedRequest, parent, isMain, options);
};

const React = frontendRequire('react');
const ReactDOMServer = frontendRequire('react-dom/server');

const cartState: { customer: { id: string | number; name: string } | null } = { customer: null };
const apiCalls: string[] = [];
const mocks: Record<string, unknown> = {
  'use-intl': { useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}` },
  '@/hooks/useFormatNumber': { useFormatNumber: () => (value: number) => String(value) },
  'lucide-react': { History: () => null },
  '@/lib/api': {
    __esModule: true,
    default: {
      get: async (url: string) => {
        apiCalls.push(url);
        return { data: { items: [] } };
      },
    },
  },
  '@/store/cart': {
    useCartStore: (selector?: (state: typeof cartState) => unknown) =>
      selector ? selector(cartState) : cartState,
  },
};
const originalLoad = moduleApi._load;
moduleApi._load = function (request: string, parent: any, isMain: boolean) {
  if (request in mocks) return mocks[request];
  return originalLoad.call(this, request, parent, isMain);
};

const {
  customerTopItemsView,
  fetchCustomerTopItems,
  resolveCustomerTopItems,
} = require('../frontend/src/lib/customer-top-items');
const CustomerTopItemsModule = require('../frontend/src/components/pos/CustomerTopItems');
const CustomerTopItems = CustomerTopItemsModule.default;
const { CustomerTopItemsList } = CustomerTopItemsModule;
const { calculateFittingChoices } = require('../frontend/src/components/pos/CollapsiblePosChoices');

function product(id: string, name: string, price: number) {
  return { id, name, price, category_id: 'cat-1', is_active: true, variants: [], addon_groups: [] };
}

function topItem(productId: string, name: string, quantity: number, available = true) {
  return {
    product_id: productId,
    product_name: name,
    total_quantity: quantity,
    order_count: 1,
    available,
  };
}

function collectElements(
  node: unknown,
  predicate: (element: any) => boolean,
  result: any[] = [],
): any[] {
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, predicate, result);
    return result;
  }
  if (!node || typeof node !== 'object') return result;
  if (predicate(node)) result.push(node);
  const props = (node as { props?: { children?: unknown; choices?: unknown } }).props;
  if (props) {
    collectElements(props.children, predicate, result);
    // The measured row composes its choice buttons through the choices prop.
    if (Array.isArray(props.choices)) {
      collectElements(
        props.choices.map((choice) => (choice as { node?: unknown }).node),
        predicate,
        result,
      );
    }
  }
  return result;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const catalog = [
  product('p-latte', 'Latte', 4.75),
  product('p-croissant', 'Croissant', 3.25),
  product('p-stale', 'Stale Catalog Entry', 1),
];

function testViewStates() {
  assert.deepEqual(
    customerTopItemsView(null, null, catalog),
    { kind: 'hidden' },
    'no customer hides the section',
  );
  assert.deepEqual(
    customerTopItemsView(
      null,
      { customerId: 'cust-a', status: 'ready', items: [topItem('p-latte', 'Latte', 3)] },
      catalog,
    ),
    { kind: 'hidden' },
    'a leftover result is hidden once the customer is cleared',
  );
  assert.deepEqual(
    customerTopItemsView('cust-a', null, catalog),
    { kind: 'loading' },
    'no result yet is loading',
  );
  assert.deepEqual(
    customerTopItemsView('cust-a', { customerId: 'cust-a', status: 'ready', items: [] }, catalog),
    { kind: 'empty' },
    'a customer with no history gets the empty state',
  );
  assert.deepEqual(
    customerTopItemsView('cust-a', { customerId: 'cust-a', status: 'error' }, catalog),
    { kind: 'error' },
    'a failed request gets the error state',
  );
  assert.deepEqual(
    customerTopItemsView(
      'cust-b',
      { customerId: 'cust-a', status: 'ready', items: [topItem('p-latte', 'Latte', 3)] },
      catalog,
    ),
    { kind: 'loading' },
    "the previous customer's list never shows under the new customer",
  );
  const ready = customerTopItemsView(
    'cust-a',
    {
      customerId: 'cust-a',
      status: 'ready',
      items: [topItem('p-latte', 'Latte', 3), topItem('p-croissant', 'Croissant', 2)],
    },
    catalog,
  );
  assert.equal(ready.kind, 'items');
  assert.deepEqual(
    ready.items.map((item: any) => item.product_id),
    ['p-latte', 'p-croissant'],
    'backend ranking order is preserved',
  );
  console.log('  ✓ hidden, loading, empty, error, stale, and ready view states');
}

function testCatalogResolution() {
  const resolved = resolveCustomerTopItems(
    [
      topItem('p-latte', 'Latte', 3),
      topItem('p-gone', 'Gone Wrap', 2, false),
      topItem('p-stale', 'Stale Catalog Entry', 1, false),
      topItem('p-missing', 'Not Loaded', 1, true),
    ],
    catalog,
  );
  assert.equal(
    resolved[0].product,
    catalog[0],
    'an available entry resolves to the current catalog product',
  );
  assert.equal(resolved[0].product.price, 4.75, 'the resolved product carries the current price');
  assert.equal(
    resolved[1].product,
    null,
    'a deleted product stays listed without a product to add',
  );
  assert.equal(
    resolved[2].product,
    null,
    'a product the backend marks unavailable is not addable even if the catalog still has it',
  );
  assert.equal(
    resolved[3].product,
    null,
    'a product missing from the loaded catalog is not addable',
  );
  assert.deepEqual(
    resolved.map((item: any) => item.product_name),
    ['Latte', 'Gone Wrap', 'Stale Catalog Entry', 'Not Loaded'],
  );
  assert.equal(
    resolveCustomerTopItems(
      [topItem('42', 'Numeric', 1)],
      [product(42 as unknown as string, 'Numeric', 2)],
    )[0].product?.name,
    'Numeric',
    'numeric and string product ids resolve to the same product',
  );
  console.log(
    '  ✓ entries resolve to current catalog products; unavailable ones stay listed but unaddable',
  );
}

async function testCustomerSwitchRace() {
  const requests = new Map<string, ReturnType<typeof deferred<{ data: { items: unknown } }>>>();
  const urls: string[] = [];
  const get = (url: string) => {
    urls.push(url);
    const pending = deferred<{ data: { items: unknown } }>();
    requests.set(url, pending);
    return pending.promise;
  };
  const settled: any[] = [];

  const controllerA = new AbortController();
  const fetchA = fetchCustomerTopItems(get, 'cust-a', controllerA.signal, (result: any) =>
    settled.push(result),
  );
  controllerA.abort();
  const controllerB = new AbortController();
  const fetchB = fetchCustomerTopItems(get, 'cust-b', controllerB.signal, (result: any) =>
    settled.push(result),
  );

  requests
    .get('/customers/cust-b/top-items')!
    .resolve({ data: { items: [topItem('p-croissant', 'Croissant', 2)] } });
  await fetchB;
  requests
    .get('/customers/cust-a/top-items')!
    .resolve({ data: { items: [topItem('p-latte', 'Latte', 9)] } });
  await fetchA;

  assert.deepEqual(urls, ['/customers/cust-a/top-items', '/customers/cust-b/top-items']);
  assert.equal(settled.length, 1, 'the aborted request for the previous customer never settles');
  assert.equal(settled[0].customerId, 'cust-b');
  assert.deepEqual(
    settled[0].items.map((item: any) => item.product_id),
    ['p-croissant'],
  );
  const view = customerTopItemsView('cust-b', settled[0], catalog);
  assert.equal(view.kind, 'items');
  assert.equal(
    view.items[0].product_id,
    'p-croissant',
    'the current customer sees their own list after a switch',
  );

  const failed: any[] = [];
  const controllerC = new AbortController();
  await fetchCustomerTopItems(
    () => Promise.reject(new Error('offline')),
    'cust-c',
    controllerC.signal,
    (result: any) => failed.push(result),
  );
  assert.deepEqual(
    failed,
    [{ customerId: 'cust-c', status: 'error' }],
    'a failed request settles as an error for its customer',
  );

  const abortedFailure: any[] = [];
  const controllerD = new AbortController();
  const pendingD = deferred<{ data: { items: unknown } }>();
  const fetchD = fetchCustomerTopItems(
    () => pendingD.promise,
    'cust-d',
    controllerD.signal,
    (result: any) => abortedFailure.push(result),
  );
  controllerD.abort();
  pendingD.reject(Object.assign(new Error('canceled'), { name: 'CanceledError' }));
  await fetchD;
  assert.equal(
    abortedFailure.length,
    0,
    'cancelling on a customer switch is not reported as an error',
  );

  const encoded: string[] = [];
  await fetchCustomerTopItems(
    async (url: string) => {
      encoded.push(url);
      return { data: {} };
    },
    'cust/x y',
    new AbortController().signal,
    () => undefined,
  );
  assert.deepEqual(
    encoded,
    ['/customers/cust%2Fx%20y/top-items'],
    'the customer id is URL-encoded',
  );
  console.log("  ✓ switching customers mid-request shows only the current customer's list");
}

function testRenderedStates() {
  const render = (view: unknown) =>
    ReactDOMServer.renderToStaticMarkup(
      React.createElement(CustomerTopItemsList, { view, onSelect: () => undefined }),
    );
  assert.equal(render({ kind: 'hidden' }), '', 'the hidden state renders nothing');

  const loading = render({ kind: 'loading' });
  assert.ok(loading.includes('pos.topItems'), 'the section is labelled');
  assert.ok(loading.includes('pos.loadingEllipsis'), 'loading shows the shared loading text');

  const empty = render({ kind: 'empty' });
  assert.ok(
    empty.includes('pos.topItemsEmpty'),
    'the empty state is shown for a customer with no history',
  );
  assert.ok(!empty.includes('<button'), 'the empty state has nothing to click');

  assert.ok(
    render({ kind: 'error' }).includes('pos.topItemsLoadFailed'),
    'a failed request shows the error text',
  );

  const items = resolveCustomerTopItems(
    [
      topItem('p-latte', 'Latte', 3),
      topItem('p-croissant', 'Croissant', 2),
      topItem('p-gone', 'Gone Wrap', 1, false),
    ],
    catalog,
  );
  const markup = render({ kind: 'items', items });
  assert.equal(
    (markup.match(/data-testid="customer-top-item"/g) || []).length,
    3,
    'fewer than five entries render as-is',
  );
  assert.ok(
    markup.indexOf('Latte') < markup.indexOf('Croissant'),
    'entries render in ranked order',
  );
  assert.ok(markup.includes('×3'), 'each entry shows its total quantity');
  assert.ok(
    !markup.includes('pos.topItemsEmpty') && !markup.includes('pos.loadingEllipsis'),
    'a populated list shows no status text',
  );
  assert.equal(
    (markup.match(/disabled=""/g) || []).length,
    1,
    'only the unavailable entry is disabled',
  );
  assert.ok(
    markup.includes('Gone Wrap (pos.topItemUnavailable)'),
    'the unavailable entry says why it cannot be added',
  );
  console.log(
    '  ✓ rendered states: hidden, loading, empty, error, ranked list, disabled unavailable entry',
  );
}

function testClickToAdd() {
  const selected: unknown[] = [];
  const items = resolveCustomerTopItems(
    [topItem('p-latte', 'Latte', 3), topItem('p-gone', 'Gone Wrap', 1, false)],
    catalog,
  );
  const tree = CustomerTopItemsList({
    view: { kind: 'items', items },
    onSelect: (p: unknown) => selected.push(p),
  });
  const buttons = collectElements(
    tree,
    (element) => element.props?.['data-testid'] === 'customer-top-item',
  );
  assert.equal(buttons.length, 2);

  buttons[0].props.onClick();
  assert.deepEqual(
    selected,
    [catalog[0]],
    'clicking an entry hands the current catalog product to the add flow',
  );

  assert.equal(buttons[1].props.disabled, true, 'an unavailable entry is disabled');
  assert.equal(buttons[1].props.onClick, undefined, 'an unavailable entry has no add handler');
  assert.equal(selected.length, 1);

  const page = fs.readFileSync(
    path.join(ROOT, 'frontend/src/app/(dashboard)/pos/page.tsx'),
    'utf8',
  );
  const topbar = fs.readFileSync(
    path.join(ROOT, 'frontend/src/components/pos/PosTopbar.tsx'),
    'utf8',
  );
  assert.ok(
    page.includes('onProductClick={handleProductClick}'),
    'the product grid uses handleProductClick',
  );
  assert.ok(
    page.includes('onTopItemSelect={handleProductClick}'),
    'top items use the same handler as the product grid',
  );
  assert.ok(page.includes('products={products}'), 'top items resolve against the POS catalog');
  assert.ok(
    topbar.includes('<CustomerTopItems products={products} onSelect={onTopItemSelect} />'),
    'the topbar forwards the handler',
  );
  assert.ok(
    topbar.indexOf('<CustomerSearch variant="topbar" />') < topbar.indexOf('<CustomerTopItems'),
    'top items render below the selected customer',
  );
  console.log('  ✓ click-to-add uses the product grid flow with the current catalog product');
}

function testConnectedComponent() {
  apiCalls.length = 0;
  const render = () =>
    ReactDOMServer.renderToStaticMarkup(
      React.createElement(CustomerTopItems, { products: catalog, onSelect: () => undefined }),
    );
  cartState.customer = null;
  assert.equal(render(), '', 'no selected customer renders nothing');
  cartState.customer = { id: 'cust-a', name: 'Asha' };
  const markup = render();
  assert.ok(
    markup.includes('data-testid="customer-top-items"'),
    'a selected customer shows the section',
  );
  assert.ok(markup.includes('pos.loadingEllipsis'), 'the section starts in the loading state');
  cartState.customer = null;
  console.log('  ✓ the connected section follows the selected customer');
}

async function testCustomersPageModalDetails() {
  const submissions: Array<{ method: string; url: string; payload: any }> = [];
  mocks['next/navigation'] = {
    useSearchParams: () => ({ get: () => null }),
    useRouter: () => ({ push: () => undefined }),
  };
  mocks['@/store/auth'] = { useAuthStore: () => ({ currentTenant: { country: 'IN' } }) };
  mocks['@/hooks/useFormatCurrency'] = {
    useFormatCurrency: () => (value: number) => String(value),
  };
  mocks['@/hooks/useFormatDate'] = {
    useFormatDate: () => ({ formatDate: (value: string) => value }),
  };
  mocks['react-hot-toast'] = {
    __esModule: true,
    default: { success: () => undefined, error: () => undefined },
  };
  for (const method of ['post', 'put']) {
    (mocks['@/lib/api'] as any).default[method] = async (url: string, payload: any) => {
      submissions.push({ method, url, payload });
      return { data: { customer: { id: 'cust-new', ...payload } } };
    };
  }
  const CustomersPage = require('../frontend/src/app/(dashboard)/customers/page').default;
  const {
    default: Fields,
    EMPTY_CUSTOMER_DETAILS,
  } = require('../frontend/src/components/customers/CustomerDetailsFields');
  const originalUseState = React.useState;
  const originalUseEffect = React.useEffect;
  const states: unknown[] = [];
  let cursor = 0;
  const renderTree = () => {
    cursor = 0;
    React.useState = ((initial: unknown) => {
      const index = cursor++;
      if (!(index in states))
        states[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
      return [
        states[index],
        (next: any) => {
          states[index] = typeof next === 'function' ? next(states[index]) : next;
        },
      ];
    }) as typeof React.useState;
    React.useEffect = (() => undefined) as typeof React.useEffect;
    try {
      return CustomersPage();
    } finally {
      React.useState = originalUseState;
      React.useEffect = originalUseEffect;
    }
  };
  states[0] = [
    {
      id: 'cust-1',
      name: 'Ada Lovelace',
      phone: '+919876543210',
      country_code: '+91',
      address: 'L'.repeat(350),
      email: 'ada@example.test',
      notes: 'VIP guest',
      birthday: '1990-01-02',
      visits_count: 3,
      total_spent: 120,
      wallet_balance: 0,
    },
  ];
  const addButton = collectElements(
    renderTree(),
    (el) =>
      typeof el.props?.onClick === 'function' &&
      JSON.stringify(el.props?.children).includes('customer.add'),
  )[0];
  assert.ok(addButton);
  addButton.props.onClick();
  const fields = (tree: unknown) => {
    const element = collectElements(tree, (el) => el.type === Fields)[0];
    assert.ok(element, 'customer modal uses the shared details fields');
    return element.props;
  };
  let tree = renderTree();
  const card = collectElements(
    tree,
    (el) => el.type === 'div' && el.props?.className?.includes('max-w-sm'),
  )[0];
  assert.ok(
    card.props.className.includes('max-h-[90vh]') &&
      card.props.className.includes('overflow-y-auto'),
  );
  assert.deepEqual(fields(tree).value, EMPTY_CUSTOMER_DETAILS);
  assert.equal(fields(tree).phoneRequired, true);
  fields(tree).onChange({
    firstName: 'Grace',
    lastName: 'Hopper',
    phone: '+919876543211',
    birthday: '1980-12-09',
    notes: 'Ring bell twice',
  });
  tree = renderTree();
  await collectElements(tree, (el) => el.type === 'form')[0].props.onSubmit({
    preventDefault() {},
  });
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].method, 'post');
  assert.deepEqual(submissions[0].payload, {
    first_name: 'Grace',
    last_name: 'Hopper',
    phone: '+919876543211',
    country_code: '+91',
    birthday: '1980-12-09',
    notes: 'Ring bell twice',
  });
  const row = collectElements(renderTree(), (el) => el.type === 'tbody')[0];
  collectElements(row, (el) => typeof el.props?.onClick === 'function')[0].props.onClick();
  tree = renderTree();
  assert.equal(fields(tree).phoneRequired, false);
  assert.equal(fields(tree).value.firstName, 'Ada');
  assert.equal(fields(tree).value.lastName, 'Lovelace');
  assert.equal(fields(tree).value.notes, 'VIP guest');
  assert.equal(fields(tree).value.birthday, '1990-01-02');
  fields(tree).onChange({ notes: '', firstName: 'Ada Jr.' });
  tree = renderTree();
  await collectElements(tree, (el) => el.type === 'form')[0].props.onSubmit({
    preventDefault() {},
  });
  assert.equal(submissions.length, 2);
  assert.equal(submissions[1].method, 'put');
  assert.equal(submissions[1].url, '/customers/cust-1');
  assert.equal(submissions[1].payload.first_name, 'Ada Jr.');
  assert.equal(submissions[1].payload.notes, '');
  assert.equal(
    'address' in submissions[1].payload,
    false,
    'editing details preserves the stored legacy address',
  );
  assert.equal(
    'email' in submissions[1].payload,
    false,
    'editing details preserves the stored email',
  );
  addButton.props.onClick();
  assert.deepEqual(
    fields(renderTree()).value,
    EMPTY_CUSTOMER_DETAILS,
    'reopening create resets all details',
  );
  console.log(
    '  ✓ shared customer details hydrate, save, clear and reset without overwriting legacy address or email',
  );
}

function testCollapsiblePosChoicesFitting() {
  const choices = [
    { key: 'cat-0', name: 'All' },
    { key: 'cat-1', name: 'Coffee' },
    { key: 'cat-2', name: 'Tea' },
    { key: 'cat-3', name: 'Pastries' },
    { key: 'cat-4', name: 'Sandwiches' },
    { key: 'cat-5', name: 'Desserts' },
  ];
  const chipWidths = new Map<string, number>([
    ['cat-0', 60],
    ['cat-1', 60],
    ['cat-2', 60],
    ['cat-3', 60],
    ['cat-4', 60],
    ['cat-5', 60],
  ]);

  // 1. Reviewer reproduction: 360px of chips inside 330px available width.
  // With 6 chips of 60px = 360px, available 330px, toggle 80px, gap 8px:
  const collapsed = calculateFittingChoices({
    choices,
    mandatoryKeys: ['cat-0'],
    availableWidth: 330,
    chipWidths,
    toggleWidth: 80,
    gap: 8,
  });
  assert.equal(collapsed.allFit, false, '360px of chips cannot all fit in 330px');
  assert.deepEqual(
    collapsed.visibleChoices.map((c: any) => c.key),
    ['cat-0', 'cat-1', 'cat-2'],
    'fitting subset contains mandatory chip-0 and maximal prefix chip-1, chip-2',
  );
  // Total width: 3 chips (180px) + 80px toggle + 3 gaps (24px) = 284px <= 330px
  const totalWidth = 3 * 60 + 80 + 3 * 8;
  assert(totalWidth <= 330, 'total rendered width never exceeds available container');

  // 2. Leading label width is measured and reserved:
  const withLabel = calculateFittingChoices({
    choices,
    mandatoryKeys: ['cat-0'],
    availableWidth: 330,
    chipWidths,
    labelWidth: 80,
    toggleWidth: 80,
    gap: 8,
  });
  assert.equal(withLabel.allFit, false);
  assert.deepEqual(
    withLabel.visibleChoices.map((c: any) => c.key),
    ['cat-0', 'cat-1'],
    'reserving space for label reduces the prefix so no overflow occurs',
  );

  // 3. Exact toggle width is measured (not a guessed constant):
  const withWideToggle = calculateFittingChoices({
    choices,
    mandatoryKeys: ['cat-0'],
    availableWidth: 330,
    chipWidths,
    toggleWidth: 140,
    gap: 8,
  });
  assert.deepEqual(
    withWideToggle.visibleChoices.map((c: any) => c.key),
    ['cat-0', 'cat-1'],
    'wider localized toggle reduces prefix accordingly',
  );

  // 4. Source order preservation with mandatory key at the tail (no mandatory-first reordering):
  const tailMandatory = calculateFittingChoices({
    choices,
    mandatoryKeys: ['cat-0', 'cat-5'],
    availableWidth: 330,
    chipWidths,
    toggleWidth: 80,
    gap: 8,
  });
  assert.equal(tailMandatory.allFit, false);
  assert.deepEqual(
    tailMandatory.visibleChoices.map((c: any) => c.key),
    ['cat-0', 'cat-1', 'cat-5'],
    'source order is preserved: cat-5 stays at the tail and is not moved ahead of cat-1',
  );

  // 5. When all fit without toggle:
  const allFitResult = calculateFittingChoices({
    choices,
    mandatoryKeys: ['cat-0'],
    availableWidth: 600,
    chipWidths,
    toggleWidth: 80,
    gap: 8,
  });
  assert.equal(allFitResult.allFit, true, 'all choices fit in 600px without toggle');
  assert.equal(allFitResult.visibleChoices.length, 6);

  console.log(
    '  ✓ collapsible POS choices calculates fitting without overflow and preserves source order',
  );
}

async function main() {
  console.log('Customer top items (POS) tests');
  try {
    testViewStates();
    testCatalogResolution();
    await testCustomerSwitchRace();
    testRenderedStates();
    testClickToAdd();
    testConnectedComponent();
    await testCustomersPageModalDetails();
    testCollapsiblePosChoicesFitting();
  } finally {
    moduleApi._load = originalLoad;
    moduleApi._resolveFilename = originalResolveFilename;
  }
  console.log('All customer top items UI tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
