'use strict';

const statusLine = document.querySelector('#status');
const reloadButton = document.querySelector('#reload-menu');
const menuSection = document.querySelector('#menu-section');
const menuList = document.querySelector('#menu');
const checkout = document.querySelector('#checkout');
const summary = document.querySelector('#summary');
const configuredItems = document.querySelector('#configured-items');
const submitButton = document.querySelector('#submit-order');
const qr = new URLSearchParams(location.hash.slice(1));
const tableKey = qr.get('table');
let token = qr.get('table_token');
const money = new Intl.NumberFormat('th-TH', { style: 'currency', currency: 'THB' });
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const cart = new Map();
let menu = [];
let menuRevision = null;
let storageKey;
let pending;
let sending = false;
let sessionExpired = false;

function notify(message) {
  statusLine.textContent = message;
}

function itemKey({ menu_item_id, addons }) {
  if (!addons?.length) return menu_item_id;
  return JSON.stringify([menu_item_id, addons.map(({ id, quantity }) => [id, quantity]).sort()]);
}

function setCartLine(line) {
  const key = itemKey(line);
  const previous = cart.get(key)?.quantity ?? 0;
  const total = [...cart.values()].reduce((sum, item) => sum + item.quantity, 0) - previous + line.quantity;
  if (!Number.isInteger(line.quantity) || line.quantity < 0 || line.quantity > 50 || total > 100 ||
      (line.quantity > 0 && !previous && cart.size >= 30)) {
    notify('เลือกได้สูงสุด 30 รายการ รายการละ 50 ชิ้น รวมไม่เกิน 100 ชิ้น');
    return false;
  }
  if (line.quantity) cart.set(key, line);
  else cart.delete(key);
  renderCheckout();
  return true;
}

function renderCheckout() {
  const items = pending?.body.items ?? [...cart.values()];
  const count = items.reduce((sum, item) => sum + item.quantity, 0);
  const products = new Map(menu.map((item) => [item.id, item]));
  configuredItems.replaceChildren();
  let total = 0;
  for (const item of items) {
    const product = products.get(item.menu_item_id);
    const options = product?.addon_groups?.flatMap((group) => group.options) ?? [];
    const addons = (item.addons ?? []).map(({ id, quantity }) => ({ option: options.find((option) => option.id === id), quantity }));
    const addonPrice = addons.reduce((sum, { option, quantity }) => sum + option?.price_satang * quantity, 0);
    total += (product?.price_satang + addonPrice) * item.quantity;
    if (!product?.addon_groups?.length) continue;
    const line = document.createElement('li');
    const choices = addons.map(({ option, quantity }) => `${option?.name ?? 'ตัวเลือกเดิม'} × ${quantity}`);
    line.textContent = `${item.quantity} × ${product.name}${choices.length ? ' · ' + choices.join(', ') : ''}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'ลด 1 ชิ้น';
    remove.disabled = Boolean(pending) || sessionExpired;
    remove.addEventListener('click', () => setCartLine({ ...item, quantity: item.quantity - 1 }));
    line.append(remove);
    configuredItems.append(line);
  }
  summary.textContent = Number.isFinite(total)
    ? `${count} ชิ้น · ยอดตามเมนู ${money.format(total / 100)}`
    : `${count} ชิ้น · รายการที่รอยืนยันผล`;
  checkout.hidden = menu.length === 0 && !pending;
  submitButton.disabled = !count || sending || sessionExpired;
  submitButton.textContent = sending ? 'กำลังส่ง…' : pending ? 'ตรวจผลโดยส่งรายการเดิมอีกครั้ง' : 'ส่งออเดอร์';
  menuList.querySelectorAll('input, button').forEach((input) => { input.disabled = Boolean(pending) || sessionExpired; });
}

function renderAddonControls(product, details) {
  const controls = product.addon_groups.map((group) => {
    const fieldset = document.createElement('fieldset');
    const legend = document.createElement('legend');
    const limit = group.max === null ? '' : ` · สูงสุด ${group.max}`;
    legend.textContent = `${group.name} · ${group.min ? 'เลือกอย่างน้อย ' + group.min : 'เลือกได้ตามต้องการ'}${limit}`;
    fieldset.append(legend);
    const options = group.options.map((option) => {
      const label = document.createElement('label');
      const input = document.createElement('input');
      const price = option.price_satang ? ` (+${money.format(option.price_satang / 100)})` : '';
      label.textContent = option.name + price;
      input.type = group.multiple ? 'number' : 'checkbox';
      if (group.multiple) {
        input.min = '0';
        input.max = String(Math.min(group.max ?? 10, 10));
        input.step = '1';
        input.value = '0';
        input.inputMode = 'numeric';
      }
      label.append(input);
      fieldset.append(label);
      return { id: option.id, input };
    });
    details.append(fieldset);
    return { group, options };
  });
  const add = document.createElement('button');
  add.type = 'button';
  add.textContent = 'เพิ่ม 1 ชิ้นลงตะกร้า';
  add.addEventListener('click', () => {
    const addons = [];
    for (const { group, options } of controls) {
      const choices = options.map(({ id, input }) => ({ id, quantity: group.multiple ? Number(input.value) : Number(input.checked) }));
      const count = choices.reduce((sum, option) => sum + option.quantity, 0);
      if (choices.some(({ quantity }) => !Number.isInteger(quantity) || quantity < 0 || quantity > 10) ||
          count < group.min || (group.max !== null && count > group.max)) {
        notify(`กรุณาตรวจจำนวนตัวเลือกในกลุ่ม ${group.name}`);
        return;
      }
      addons.push(...choices.filter(({ quantity }) => quantity > 0));
    }
    if (addons.length > 20) {
      notify('เลือกได้สูงสุด 20 ตัวเลือกต่อรายการ');
      return;
    }
    const line = { menu_item_id: product.id, quantity: 1, ...(addons.length ? { addons } : {}) };
    line.quantity += cart.get(itemKey(line))?.quantity ?? 0;
    if (setCartLine(line)) notify(`เพิ่ม ${product.name} ลงตะกร้าแล้ว`);
  });
  details.append(add);
}

function renderMenu() {
  menuList.replaceChildren();
  let category;
  for (const item of menu) {
    if (item.category !== category) {
      category = item.category;
      if (category) {
        const heading = document.createElement('li');
        heading.className = 'menu-category';
        heading.textContent = category;
        menuList.append(heading);
      }
    }
    const row = document.createElement('li');
    const details = document.createElement('div');
    const name = document.createElement('p');
    name.textContent = item.name;
    const price = document.createElement('p');
    price.className = 'muted';
    price.textContent = item.price_satang === 0 ? 'สอบถามพนักงาน' : money.format(item.price_satang / 100);
    details.append(name, price);
    row.append(details);
    menuList.append(row);
    if (item.price_satang === 0) continue;
    if (item.addon_groups?.length) {
      row.classList.add('menu-with-options');
      renderAddonControls(item, details);
      continue;
    }

    const label = document.createElement('label');
    label.textContent = 'จำนวน';
    const quantity = document.createElement('input');
    quantity.type = 'number';
    quantity.inputMode = 'numeric';
    quantity.min = '0';
    quantity.max = '50';
    quantity.step = '1';
    quantity.setAttribute('aria-label', `จำนวน ${item.name}`);
    quantity.value = String(cart.get(item.id)?.quantity ?? 0);
    quantity.addEventListener('input', () => {
      const value = Number(quantity.value);
      if (!setCartLine({ menu_item_id: item.id, quantity: value })) quantity.value = String(cart.get(item.id)?.quantity ?? 0);
    });
    label.append(quantity);
    row.append(label);
  }
  menuSection.hidden = menu.length === 0;
  renderCheckout();
}

function api(path, options = {}) {
  return fetch(path, {
    ...options,
    credentials: 'omit',
    mode: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    headers: { ...options.headers, Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
}

async function requestTableSession() {
  const response = await fetch('/api/v1/table-qr/session', {
    method: 'POST',
    credentials: 'omit',
    mode: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ table_key: tableKey }),
  });
  if (response.status === 409) return null;
  if (response.status === 429) throw new Error('มีอุปกรณ์ใช้โต๊ะนี้ครบแล้ว กรุณาติดต่อพนักงาน');
  if (!response.ok) throw new Error('ติดต่อระบบสั่งอาหารไม่ได้ กรุณาลองอีกครั้ง');
  const session = await response.json();
  if (typeof session.table_token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(session.table_token)) {
    throw new Error('เปิดรายการสั่งอาหารไม่ได้ กรุณาติดต่อพนักงาน');
  }
  sessionStorage.setItem(`flocafe-table-session:${tableKey}`, session.table_token);
  return session.table_token;
}

async function loadMenu() {
  reloadButton.hidden = true;
  notify('กำลังโหลดเมนู…');
  try {
    const response = await api('/api/v1/menu');
    if (response.status === 401) {
      sessionExpired = true;
      if (tableKey && !pending) {
        sessionStorage.removeItem(`flocafe-table-session:${tableKey}`);
        reloadButton.hidden = false;
      }
      notify(pending ? 'QR หมดอายุและยังไม่ทราบผล กรุณาให้พนักงานตรวจสอบออเดอร์ก่อนสั่งใหม่' : 'QR นี้หมดอายุหรือใช้ไม่ได้ กรุณาขอ QR ใหม่จากพนักงาน');
      return;
    }
    if (!response.ok) throw new Error();
    const data = await response.json();
    if (!Array.isArray(data.items) || !data.items.every((item) =>
      item && typeof item.id === 'string' && uuid.test(item.id) && typeof item.name === 'string' &&
      Number.isSafeInteger(item.price_satang) && item.price_satang >= 0 &&
      (item.category == null || typeof item.category === 'string'))) throw new Error();
    const previousRevision = menuRevision;
    menu = data.items;
    menuRevision = typeof data.menu_revision === 'string' && uuid.test(data.menu_revision) ? data.menu_revision : null;
    const available = new Map(menu.filter((item) => item.price_satang > 0).map((item) => [item.id, item]));
    for (const [key, line] of cart) {
      const product = available.get(line.menu_item_id);
      if (!product || (previousRevision !== menuRevision && (line.addons?.length || product.addon_groups?.length))) cart.delete(key);
    }
    notify(pending ? 'ยังไม่ทราบผลของรายการก่อนหน้า กดส่งรายการเดิมอีกครั้งเพื่อตรวจผล' :
      menu.length ? 'เลือกจำนวนอาหารที่ต้องการได้เลย' : 'ยังไม่มีเมนูที่เปิดให้สั่ง');
  } catch {
    notify('โหลดเมนูไม่สำเร็จ กรุณาตรวจอินเทอร์เน็ตแล้วลองอีกครั้ง');
    reloadButton.hidden = false;
  } finally {
    renderMenu();
  }
}

async function sendOrder() {
  if (sending || sessionExpired || (!pending && cart.size === 0)) return;
  if (!pending) {
    if (!window.confirm(`ยืนยันส่ง ${summary.textContent} ให้ร้านหรือไม่?`)) return;
    const attempt = {
      key: crypto.randomUUID(),
      body: {
        ...(menuRevision ? { menu_revision: menuRevision } : {}),
        items: [...cart.values()],
      },
    };
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(attempt));
      pending = attempt;
    } catch {
      notify('เบราว์เซอร์บันทึกรายการชั่วคราวไม่ได้ กรุณาสั่งกับพนักงาน');
      return;
    }
  }

  sending = true;
  renderCheckout();
  notify('กำลังส่งรายการให้ร้าน…');
  try {
    const response = await api('/api/v1/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': pending.key },
      body: JSON.stringify(pending.body),
    });
    const result = await response.json();
    if (response.status === 409 && result?.error === 'menu revision changed') {
      sessionStorage.removeItem(storageKey);
      pending = null;
      await loadMenu();
      notify('เมนูหรือราคาเปลี่ยน กรุณาตรวจรายการก่อนส่งอีกครั้ง');
      return;
    }
    if (response.status === 401 || response.status === 409) {
      sessionExpired = true;
      notify('ตรวจผลรายการนี้ไม่ได้ กรุณาให้พนักงานตรวจสอบก่อนสั่งใหม่');
      return;
    }
    if (response.status === 400 && ['invalid menu item', 'ask staff for price', 'invalid menu options'].includes(result.error)) {
      sessionStorage.removeItem(storageKey);
      pending = null;
      if (result.error === 'invalid menu options') cart.clear();
      await loadMenu();
      notify(result.error === 'ask staff for price'
        ? 'เมนูบางรายการต้องสอบถามพนักงาน กรุณาตรวจรายการก่อนส่งอีกครั้ง'
        : result.error === 'invalid menu options'
          ? 'ตัวเลือกเมนูเปลี่ยน กรุณาเลือกใหม่'
          : 'เมนูบางรายการหยุดขาย กรุณาตรวจรายการก่อนส่งอีกครั้ง');
      return;
    }
    if (!response.ok || typeof result?.order_id !== 'string' || !uuid.test(result.order_id)) throw new Error();
    sessionStorage.removeItem(storageKey);
    pending = null;
    cart.clear();
    notify(`ระบบได้รับออเดอร์แล้ว · รหัส ${result.order_id}`);
  } catch {
    notify('ยังไม่ทราบผลการส่ง กรุณากดส่งรายการเดิมอีกครั้งจากแท็บนี้');
  } finally {
    sending = false;
    renderMenu();
  }
}

async function start() {
  reloadButton.hidden = true;
  sessionExpired = false;
  if (tableKey && uuid.test(tableKey)) {
    try {
      token = sessionStorage.getItem(`flocafe-table-session:${tableKey}`) ?? await requestTableSession();
    } catch (error) {
      notify(error instanceof Error && error.message.startsWith('มีอุปกรณ์') ? error.message : 'เปิดโต๊ะไม่ได้ กรุณาตรวจอินเทอร์เน็ตแล้วลองใหม่');
      reloadButton.hidden = false;
      return;
    }
    if (!token) {
      notify('โต๊ะนี้ยังไม่เปิดรับออเดอร์ กรุณาแจ้งพนักงานแล้วกดลองใหม่');
      reloadButton.hidden = false;
      return;
    }
  }
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    notify('กรุณาเปิดหน้านี้ด้วย QR ประจำโต๊ะที่ได้รับจากร้าน');
    return;
  }
  try {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    storageKey = 'flocafe-order:' + Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
    pending = JSON.parse(sessionStorage.getItem(storageKey));
    if (pending) for (const item of pending.body.items) cart.set(itemKey(item), item);
  } catch {
    notify('เปิดรายการสั่งอาหารไม่ได้ กรุณาติดต่อพนักงาน');
    return;
  }
  await loadMenu();
}

reloadButton.addEventListener('click', start);
submitButton.addEventListener('click', sendOrder);
window.addEventListener('hashchange', () => location.reload());
void start();
