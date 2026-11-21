import { dashboardView } from './dashboard';
type Lang = 'th' | 'en';
type User = { id: string; email: string; display_name: string; role: 'admin' | 'owner'; tenant_id: string | null };
type Branch = {
  id: string;
  name: string;
  pos: { label: string; paired_at: string; last_seen_at: string | null } | null;
  code_expires_at: string | null;
  modules: Record<ModuleKey, boolean>;
};
type ModuleKey = 'qr_ordering' | 'menu_editing' | 'reports';
const MODULE_KEYS: ModuleKey[] = ['qr_ordering', 'menu_editing', 'reports'];
type Shop = { id: string; name: string; created_at: string; branches: Branch[] };
type PortalAccount = {
  id: string; email: string; display_name: string; role: 'admin' | 'owner'; shop: string | null;
  active: boolean; disabled_at: string | null;
};
type AuditEntry = { created_at: string; action: string; actor: string | null; shop: string | null; branch: string | null; detail: Record<string, unknown> };

const TEXT = {
  th: {
    customerSignIn: 'เข้าสู่ระบบลูกค้า', customerHint: 'หากคุณมีบัญชีอยู่แล้ว สามารถเข้าสู่ระบบด้วยอีเมลของคุณ',
    showPassword: 'แสดงรหัสผ่าน', forgotPassword: 'ลืมรหัสผ่าน?', forgotHint: 'ติดต่อผู้ดูแลระบบเพื่อขอลิงก์ตั้งรหัสผ่านใหม่',
    title: 'FloCafe Portal', email: 'อีเมล', password: 'รหัสผ่าน', signIn: 'เข้าสู่ระบบ', signOut: 'ออกจากระบบ',
    setPassword: 'ตั้งรหัสผ่าน', newPassword: 'รหัสผ่านใหม่ (อย่างน้อย 10 ตัว)', confirmPassword: 'ยืนยันรหัสผ่าน',
    passwordMismatch: 'รหัสผ่านไม่ตรงกัน', shops: 'ร้านและสาขา', users: 'บัญชีผู้ใช้', audit: 'ประวัติการใช้งาน',
    newShop: 'เพิ่มร้านใหม่', shopName: 'ชื่อร้าน', branchName: 'ชื่อสาขา', create: 'สร้าง', addBranch: 'เพิ่มสาขา',
    posNone: 'ยังไม่จับคู่ POS', posOnline: 'POS ออนไลน์', posLastSeen: 'POS ติดต่อล่าสุด {time}', posNever: 'POS จับคู่แล้ว ยังไม่เคยติดต่อ',
    issueCode: 'ออกรหัสจับคู่', newCode: 'ออกรหัสใหม่ (เปลี่ยนเครื่อง POS)', revokePos: 'ยกเลิก POS',
    revokeConfirm: 'ยกเลิก POS ของสาขา {branch}? เครื่องนี้จะรับออเดอร์ QR ไม่ได้จนกว่าจะจับคู่ใหม่',
    codeTitle: 'รหัสจับคู่สำหรับ {branch}', codeHint: 'ใช้ได้ครั้งเดียว หมดอายุ {time} กรอกที่ POS: ตั้งค่า > Cloud QR Ordering',
    codePending: 'มีรหัสที่ยังไม่ใช้ หมดอายุ {time}', close: 'ปิด', copy: 'คัดลอก', copied: 'คัดลอกแล้ว',
    newUser: 'เพิ่มบัญชี', displayName: 'ชื่อที่แสดง', role: 'บทบาท', roleOwner: 'เจ้าของร้าน', roleAdmin: 'ผู้ดูแลระบบ',
    shop: 'ร้าน', chooseShop: 'เลือกร้าน', inviteTitle: 'ลิงก์ตั้งรหัสผ่านสำหรับ {email}',
    inviteHint: 'ส่งลิงก์นี้ให้เจ้าของบัญชีทางช่องทางส่วนตัว ใช้ได้ครั้งเดียวภายใน 7 วัน', resendInvite: 'สร้างลิงก์ใหม่',
    disable: 'ปิดใช้งาน', enable: 'เปิดใช้งาน', statusActive: 'ใช้งานอยู่', statusInvited: 'รอตั้งรหัสผ่าน', statusDisabled: 'ปิดใช้งาน',
    when: 'เวลา', actor: 'ผู้ทำ', action: 'การกระทำ', branches: 'สาขา', yourShop: 'ร้านของคุณ', noShops: 'ยังไม่มีร้าน',
    module_qr_ordering: 'สั่งอาหารผ่าน QR', module_menu_editing: 'แก้เมนูจากเว็บ', module_reports: 'รายงานเจ้าของร้าน',
    modules: 'โมดูล', moduleOff: 'ปิด', moduleConfirmOff: 'ปิด "{module}" ของ {branch}?', noReportBranches: 'ยังไม่มีสาขาที่เปิดโมดูลรายงาน ติดต่อผู้ดูแลระบบ', error_module_disabled: 'สาขานี้ปิดโมดูลนี้อยู่',
    manageMenu: 'จัดการเมนู', dashboard: 'สรุปผู้บริหาร', myShop: 'ร้านและเมนู', back: 'กลับ',
    menuHint: 'แก้ราคาหรือรูปแล้ว POS ของสาขาจะรับไปใช้เองเมื่อออนไลน์ (ภายในประมาณ 1 นาที) ลูกค้า QR เห็นค่าใหม่หลัง POS รับแล้ว',
    menuEmpty: 'สาขานี้ยังไม่ได้เผยแพร่เมนูจาก POS', price: 'ราคา (บาท)', save: 'บันทึก', changePhoto: 'เปลี่ยนรูป', noPhoto: 'ไม่มีรูป',
    changes: 'รายการเปลี่ยนแปลง', pending: 'รอ POS รับ', applied: 'POS ใช้แล้ว', conflict: 'ชนกับ POS', kept_pos: 'ใช้ค่าจาก POS',
    cancelled: 'ยกเลิกแล้ว', failed: 'POS ใช้ไม่ได้', fieldPrice: 'ราคา', fieldImage: 'รูป',
    conflictHint: 'พนักงานแก้ค่านี้ที่ POS แล้ว (ตอนนี้ POS เป็น {pos}) เลือกว่าจะใช้ค่าไหน',
    keepWeb: 'ใช้ค่าจากเว็บ', keepPos: 'ใช้ค่าจาก POS', cancel: 'ยกเลิก', saved: 'ส่งไป POS แล้ว', unchanged: 'ค่าเท่าเดิม ไม่ต้องส่ง',
    photoTooLarge: 'ย่อรูปให้เล็กพอไม่ได้ ลองรูปอื่น', error_image_invalid: 'ไฟล์รูปไม่ถูกต้อง ใช้ JPG, PNG หรือ WebP',
    error_item_not_found: 'ไม่พบเมนูนี้แล้ว โหลดหน้าใหม่', error_change_not_found: 'รายการนี้เปลี่ยนสถานะไปแล้ว โหลดหน้าใหม่',
    error_branch_not_found: 'ไม่พบสาขา',
    error_invalid_credentials: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง', error_too_many_attempts: 'ลองหลายครั้งเกินไป รอ 15 นาที',
    error_invite_invalid: 'ลิงก์นี้ใช้ไม่ได้แล้ว ขอลิงก์ใหม่จากผู้ดูแล', error_password_too_short: 'รหัสผ่านต้องมีอย่างน้อย 10 ตัว',
    error_shop_exists: 'มีร้านชื่อนี้แล้ว', error_email_exists: 'มีบัญชีอีเมลนี้แล้ว', error_email_invalid: 'อีเมลไม่ถูกต้อง',
    error_shop_required: 'เลือกร้านของเจ้าของ', error_pos_not_paired: 'สาขานี้ยังไม่มี POS', error_cannot_disable_self: 'ปิดบัญชีตัวเองไม่ได้',
    error_signed_out: 'หมดเวลาเข้าสู่ระบบ เข้าสู่ระบบใหม่', error_generic: 'ทำรายการไม่สำเร็จ ลองใหม่อีกครั้ง',
  },
  en: {
    customerSignIn: 'Customer sign in', customerHint: 'If you already have an account, sign in with your email.',
    showPassword: 'Show password', forgotPassword: 'Forgot password?', forgotHint: 'Ask the administrator for a new password link.',
    title: 'FloCafe Portal', email: 'Email', password: 'Password', signIn: 'Sign in', signOut: 'Sign out',
    setPassword: 'Set password', newPassword: 'New password (at least 10 characters)', confirmPassword: 'Confirm password',
    passwordMismatch: 'The passwords do not match', shops: 'Shops and branches', users: 'Accounts', audit: 'Activity',
    newShop: 'Add a shop', shopName: 'Shop name', branchName: 'Branch name', create: 'Create', addBranch: 'Add branch',
    posNone: 'No POS paired', posOnline: 'POS online', posLastSeen: 'POS last seen {time}', posNever: 'POS paired, not seen yet',
    issueCode: 'Issue pairing code', newCode: 'New code (replace POS)', revokePos: 'Revoke POS',
    revokeConfirm: 'Revoke the POS of {branch}? It stops receiving QR orders until it is paired again.',
    codeTitle: 'Pairing code for {branch}', codeHint: 'One use, expires {time}. Enter it on the POS: Settings > Cloud QR Ordering.',
    codePending: 'Unused code expires {time}', close: 'Close', copy: 'Copy', copied: 'Copied',
    newUser: 'Add account', displayName: 'Display name', role: 'Role', roleOwner: 'Shop owner', roleAdmin: 'Administrator',
    shop: 'Shop', chooseShop: 'Choose a shop', inviteTitle: 'Password link for {email}',
    inviteHint: 'Send this link privately to the account holder. It works once within 7 days.', resendInvite: 'New link',
    disable: 'Disable', enable: 'Enable', statusActive: 'Active', statusInvited: 'Invited', statusDisabled: 'Disabled',
    when: 'Time', actor: 'By', action: 'Action', branches: 'Branches', yourShop: 'Your shop', noShops: 'No shops yet',
    module_qr_ordering: 'QR ordering', module_menu_editing: 'Web menu editing', module_reports: 'Owner reports',
    modules: 'Modules', moduleOff: 'off', moduleConfirmOff: 'Turn off "{module}" for {branch}?', noReportBranches: 'No branch has the reports module on. Contact your administrator.', error_module_disabled: 'This module is turned off for this branch',
    manageMenu: 'Manage menu', dashboard: 'Executive summary', myShop: 'Shop and menu', back: 'Back',
    menuHint: 'Change a price or photo and the branch POS applies it when online (about a minute). QR guests see the new value after the POS applies it.',
    menuEmpty: 'This branch has not published its menu from the POS yet', price: 'Price (THB)', save: 'Save', changePhoto: 'Change photo', noPhoto: 'No photo',
    changes: 'Changes', pending: 'Waiting for POS', applied: 'Applied by POS', conflict: 'Conflicts with POS', kept_pos: 'Kept POS value',
    cancelled: 'Cancelled', failed: 'POS could not apply', fieldPrice: 'Price', fieldImage: 'Photo',
    conflictHint: 'Staff changed this on the POS (the POS now has {pos}). Choose which value to keep.',
    keepWeb: 'Use web value', keepPos: 'Keep POS value', cancel: 'Cancel', saved: 'Sent to the POS', unchanged: 'Same value, nothing sent',
    photoTooLarge: 'Could not make this photo small enough. Try another.', error_image_invalid: 'Use a JPG, PNG or WebP image',
    error_item_not_found: 'This item is gone. Reload the page.', error_change_not_found: 'This change already moved on. Reload the page.',
    error_branch_not_found: 'Branch not found',
    error_invalid_credentials: 'Wrong email or password', error_too_many_attempts: 'Too many attempts. Wait 15 minutes.',
    error_invite_invalid: 'This link no longer works. Ask the administrator for a new one.', error_password_too_short: 'Use at least 10 characters',
    error_shop_exists: 'A shop with this name exists', error_email_exists: 'An account with this email exists', error_email_invalid: 'Enter a valid email',
    error_shop_required: 'Choose the owner’s shop', error_pos_not_paired: 'This branch has no POS', error_cannot_disable_self: 'You cannot disable yourself',
    error_signed_out: 'Your session ended. Sign in again.', error_generic: 'That did not work. Try again.',
  },
} as const;
type Key = keyof typeof TEXT.th;

let lang: Lang = localStorage.getItem('flo-portal-lang') === 'en' ? 'en' : 'th';
const tr = (key: Key, vars: Record<string, string> = {}) =>
  TEXT[lang][key].replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? '');
const errorText = (code: string) => (`error_${code}` in TEXT.th ? tr(`error_${code}` as Key) : tr('error_generic'));
const when = (iso: string) =>
  new Intl.DateTimeFormat(lang === 'th' ? 'th-TH' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' }).format(new Date(iso));

type Child = Node | string | null | false | undefined;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: Child[]) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (name.startsWith('on') && typeof value === 'function') node.addEventListener(name.slice(2), value as EventListener);
    else if (name === 'class') node.className = String(value);
    else node.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

class ApiError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/v1/portal${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: { 'x-flo-portal': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(typeof data.code === 'string' ? data.code : 'generic');
  return data as T;
}

const root = document.getElementById('app')!;
let current: User | null = null;
let tab: 'shops' | 'users' | 'audit' = 'shops';
let ownerTab: 'dashboard' | 'myShop' = 'dashboard';

function field(label: string, input: HTMLInputElement | HTMLSelectElement) {
  return h('label', { class: 'field' }, h('span', {}, label), input);
}
function errorLine() {
  return h('p', { class: 'error', role: 'alert' });
}
function showError(line: HTMLElement, error: unknown) {
  line.textContent = errorText(error instanceof ApiError ? error.code : 'generic');
  if (error instanceof ApiError && error.code === 'signed_out') setTimeout(() => void start(), 1500);
}
function copyBox(value: string) {
  const input = h('input', { readonly: true, value, class: 'copy-value' });
  const button = h('button', { type: 'button', class: 'secondary', onclick: async () => {
    await navigator.clipboard.writeText(value).catch(() => input.select());
    button.textContent = tr('copied');
  } }, tr('copy'));
  return h('div', { class: 'copy' }, input, button);
}
function dialog(title: string, ...content: Child[]) {
  const box = h('dialog', { class: 'dialog' }, h('h3', {}, title), ...content,
    h('button', { type: 'button', onclick: () => { box.close(); box.remove(); } }, tr('close')));
  document.body.append(box);
  box.showModal();
}

function header() {
  return h('header', { class: 'top' },
    h('strong', {}, tr('title')),
    h('div', { class: 'top-actions' },
      h('button', { type: 'button', class: 'link', onclick: () => {
        lang = lang === 'th' ? 'en' : 'th';
        localStorage.setItem('flo-portal-lang', lang);
        document.documentElement.lang = lang;
        render();
      } }, lang === 'th' ? 'English' : 'ไทย'),
      current && h('span', { class: 'muted' }, current.display_name),
      current && h('button', { type: 'button', class: 'secondary', onclick: async () => {
        await api('/logout', {}).catch(() => {});
        current = null;
        render();
      } }, tr('signOut'))));
}

const customerEntry = location.pathname.replace(/\/+$/, '').startsWith('/customer');

function loginView() {
  const email = h('input', { type: 'email', required: true, autocomplete: 'username', placeholder: 'email@example.com' });
  const password = h('input', { type: 'password', required: true, autocomplete: 'current-password', placeholder: tr('password') });
  const error = errorLine();
  const hint = h('p', { class: 'muted small', role: 'status' });
  const reveal = h('input', { type: 'checkbox', onchange: () => { password.type = reveal.checked ? 'text' : 'password'; } });
  const extras = h('div', { class: 'login-extras' },
    h('label', { class: 'check' }, reveal, tr('showPassword')),
    h('button', { type: 'button', class: 'link', onclick: () => { hint.textContent = tr('forgotHint'); } }, tr('forgotPassword')));
  const heading = customerEntry
    ? [h('h1', {}, tr('customerSignIn')), h('p', { class: 'muted' }, tr('customerHint'))]
    : [h('h2', {}, tr('signIn'))];
  return h('form', { class: customerEntry ? 'card narrow customer-login' : 'card narrow', onsubmit: async (event: Event) => {
    event.preventDefault();
    error.textContent = '';
    try {
      current = (await api<{ user: User }>('/login', { email: email.value, password: password.value })).user;
      render();
    } catch (failure) {
      showError(error, failure);
    }
  } }, ...heading, field(`${tr('email')} *`, email), field(`${tr('password')} *`, password), extras, hint, error,
  h('button', { type: 'submit' }, tr('signIn')));
}

function inviteView(token: string) {
  const password = h('input', { type: 'password', required: true, minlength: 10, autocomplete: 'new-password' });
  const confirm = h('input', { type: 'password', required: true, minlength: 10, autocomplete: 'new-password' });
  const error = errorLine();
  return h('form', { class: 'card narrow', onsubmit: async (event: Event) => {
    event.preventDefault();
    if (password.value !== confirm.value) {
      error.textContent = tr('passwordMismatch');
      return;
    }
    try {
      current = (await api<{ user: User }>('/invite/accept', { token, password: password.value })).user;
      history.replaceState(null, '', '/portal/');
      render();
    } catch (failure) {
      showError(error, failure);
    }
  } }, h('h2', {}, tr('setPassword')), field(tr('newPassword'), password), field(tr('confirmPassword'), confirm), error,
  h('button', { type: 'submit' }, tr('setPassword')));
}

function posStatus(branch: Branch) {
  if (!branch.pos) return h('span', { class: 'badge' }, tr('posNone'));
  const seen = branch.pos.last_seen_at;
  if (!seen) return h('span', { class: 'badge warn' }, tr('posNever'));
  const online = Date.now() - new Date(seen).getTime() < 3 * 60_000;
  return h('span', { class: online ? 'badge ok' : 'badge warn' }, online ? tr('posOnline') : tr('posLastSeen', { time: when(seen) }));
}

function branchRow(shop: Shop, branch: Branch, admin: boolean, refresh: () => void) {
  const error = errorLine();
  const issue = async () => {
    try {
      const code = await api<{ code: string; expires_at: string }>(`/admin/branches/${branch.id}/pairing-code`, {});
      dialog(tr('codeTitle', { branch: `${shop.name} · ${branch.name}` }),
        h('p', { class: 'code' }, code.code), h('p', { class: 'muted' }, tr('codeHint', { time: when(code.expires_at) })));
      refresh();
    } catch (failure) {
      showError(error, failure);
    }
  };
  const revoke = async () => {
    if (!confirm(tr('revokeConfirm', { branch: `${shop.name} · ${branch.name}` }))) return;
    try {
      await api(`/admin/branches/${branch.id}/revoke-pos`, {});
      refresh();
    } catch (failure) {
      showError(error, failure);
    }
  };
  const moduleLabel = (key: ModuleKey) => tr(`module_${key}` as Key);
  const toggle = (key: ModuleKey) => {
    const box = h('input', { type: 'checkbox', checked: branch.modules?.[key] !== false });
    box.addEventListener('change', async () => {
      if (!box.checked && !confirm(tr('moduleConfirmOff', { module: moduleLabel(key), branch: `${shop.name} · ${branch.name}` }))) {
        box.checked = true;
        return;
      }
      try {
        await api(`/admin/branches/${branch.id}/modules`, { module: key, enabled: box.checked });
        refresh();
      } catch (failure) {
        box.checked = !box.checked;
        showError(error, failure);
      }
    });
    return h('label', { class: 'module-toggle' }, box, h('span', {}, moduleLabel(key)));
  };
  const modules = h('div', { class: 'modules', 'aria-label': tr('modules') }, ...MODULE_KEYS.map((key) => admin
    ? toggle(key)
    : h('span', { class: branch.modules?.[key] === false ? 'badge' : 'badge ok' },
        moduleLabel(key), branch.modules?.[key] === false ? ` · ${tr('moduleOff')}` : '')));
  return h('li', { class: 'branch' },
    h('div', {}, h('strong', {}, branch.name), ' ', posStatus(branch),
      branch.code_expires_at && h('span', { class: 'muted small' }, ' ', tr('codePending', { time: when(branch.code_expires_at) })),
      modules),
    admin && h('div', { class: 'actions' },
      h('button', { type: 'button', onclick: issue }, branch.pos ? tr('newCode') : tr('issueCode')),
      branch.pos && h('button', { type: 'button', class: 'danger', onclick: revoke }, tr('revokePos'))),
    error);
}

async function shopsView(container: HTMLElement) {
  const { shops } = await api<{ shops: Shop[] }>('/admin/shops');
  const refresh = () => void shopsView(container);
  const shopName = h('input', { required: true, maxlength: 100 });
  const branchName = h('input', { required: true, maxlength: 100 });
  const error = errorLine();
  const create = h('form', { class: 'card inline', onsubmit: async (event: Event) => {
    event.preventDefault();
    try {
      await api('/admin/shops', { shop: shopName.value, branch: branchName.value });
      refresh();
    } catch (failure) {
      showError(error, failure);
    }
  } }, h('h3', {}, tr('newShop')), field(tr('shopName'), shopName), field(tr('branchName'), branchName),
  h('button', { type: 'submit' }, tr('create')), error);

  const cards = shops.map((shop) => {
    const name = h('input', { required: true, maxlength: 100, placeholder: tr('branchName') });
    const addError = errorLine();
    return h('section', { class: 'card' },
      h('h3', {}, shop.name),
      h('ul', { class: 'branches' }, ...shop.branches.map((branch) => branchRow(shop, branch, true, refresh))),
      h('form', { class: 'inline', onsubmit: async (event: Event) => {
        event.preventDefault();
        try {
          await api(`/admin/shops/${shop.id}/branches`, { name: name.value });
          refresh();
        } catch (failure) {
          showError(addError, failure);
        }
      } }, name, h('button', { type: 'submit', class: 'secondary' }, tr('addBranch')), addError));
  });
  container.replaceChildren(create, ...(cards.length ? cards : [h('p', { class: 'muted' }, tr('noShops'))]));
}

async function usersView(container: HTMLElement) {
  const [{ users }, { shops }] = await Promise.all([
    api<{ users: PortalAccount[] }>('/admin/users'),
    api<{ shops: Shop[] }>('/admin/shops'),
  ]);
  const refresh = () => void usersView(container);
  const inviteDialog = (email: string, url: string) =>
    dialog(tr('inviteTitle', { email }), copyBox(url), h('p', { class: 'muted' }, tr('inviteHint')));
  const email = h('input', { type: 'email', required: true, maxlength: 200 });
  const name = h('input', { required: true, maxlength: 100 });
  const role = h('select', {}, h('option', { value: 'owner' }, tr('roleOwner')), h('option', { value: 'admin' }, tr('roleAdmin')));
  const shop = h('select', {}, h('option', { value: '' }, tr('chooseShop')),
    ...shops.map((entry) => h('option', { value: entry.id }, entry.name)));
  role.addEventListener('change', () => { shop.disabled = role.value === 'admin'; });
  const error = errorLine();
  const create = h('form', { class: 'card inline', onsubmit: async (event: Event) => {
    event.preventDefault();
    try {
      const created = await api<{ invite_url: string }>('/admin/users', {
        email: email.value, display_name: name.value, role: role.value,
        ...(role.value === 'owner' && shop.value ? { tenant_id: shop.value } : {}),
      });
      inviteDialog(email.value, created.invite_url);
      refresh();
    } catch (failure) {
      showError(error, failure);
    }
  } }, h('h3', {}, tr('newUser')), field(tr('email'), email), field(tr('displayName'), name), field(tr('role'), role),
  field(tr('shop'), shop), h('button', { type: 'submit' }, tr('create')), error);

  const rows = users.map((user) => {
    const rowError = errorLine();
    const status = user.disabled_at ? tr('statusDisabled') : user.active ? tr('statusActive') : tr('statusInvited');
    return h('tr', {},
      h('td', {}, user.display_name, h('div', { class: 'muted small' }, user.email)),
      h('td', {}, user.role === 'admin' ? tr('roleAdmin') : `${tr('roleOwner')} · ${user.shop ?? ''}`),
      h('td', {}, status),
      h('td', { class: 'actions' },
        !user.disabled_at && h('button', { type: 'button', class: 'secondary', onclick: async () => {
          try {
            inviteDialog(user.email, (await api<{ invite_url: string }>(`/admin/users/${user.id}/invite`, {})).invite_url);
          } catch (failure) {
            showError(rowError, failure);
          }
        } }, tr('resendInvite')),
        user.id !== current?.id && h('button', { type: 'button', class: user.disabled_at ? 'secondary' : 'danger', onclick: async () => {
          try {
            await api(`/admin/users/${user.id}/disabled`, { disabled: !user.disabled_at });
            refresh();
          } catch (failure) {
            showError(rowError, failure);
          }
        } }, user.disabled_at ? tr('enable') : tr('disable')), rowError));
  });
  container.replaceChildren(create, h('section', { class: 'card' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, tr('displayName')), h('th', {}, tr('role')), h('th', {}, ''), h('th', {}, ''))),
    h('tbody', {}, ...rows))));
}

async function auditView(container: HTMLElement) {
  const { entries } = await api<{ entries: AuditEntry[] }>('/admin/audit');
  container.replaceChildren(h('section', { class: 'card' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, tr('when')), h('th', {}, tr('actor')), h('th', {}, tr('action')), h('th', {}, tr('shop')))),
    h('tbody', {}, ...entries.map((entry) => h('tr', {},
      h('td', {}, when(entry.created_at)), h('td', {}, entry.actor ?? '-'),
      h('td', {}, entry.action, entry.detail.email ? ` · ${String(entry.detail.email)}` : ''),
      h('td', {}, [entry.shop, entry.branch].filter(Boolean).join(' · ') || '-')))))));
}

async function ownerView(container: HTMLElement) {
  const { shop } = await api<{ shop: Shop }>('/owner/shop');
  container.replaceChildren(h('section', { class: 'card' },
    h('p', { class: 'muted' }, tr('yourShop')), h('h2', {}, shop.name), h('h3', {}, tr('branches')),
    h('ul', { class: 'branches' }, ...shop.branches.map((branch) => {
      const row = branchRow(shop, branch, false, () => void ownerView(container));
      if (branch.modules?.menu_editing !== false)
        row.append(h('button', { type: 'button', class: 'secondary', onclick: () => void menuView(container, shop, branch) }, tr('manageMenu')));
      return row;
    }))));
}

async function ownerDashboard(container: HTMLElement) {
  const { shop } = await api<{ shop: Shop }>('/owner/shop');
  const branches = shop.branches.filter((branch) => branch.modules?.reports !== false);
  if (!branches.length) {
    container.replaceChildren(h('section', { class: 'card' }, h('p', {}, tr('noReportBranches'))));
    return;
  }
  await dashboardView(container, { h, api, lang, branches });
}

type MenuItem = { id: string; name: string; category: string | null; price_satang: number; image: string | null };
type MenuChange = {
  id: string; menu_item_id: string; field: 'price' | 'image'; base_value: string | null; new_value: string;
  status: 'pending' | 'applied' | 'conflict' | 'kept_pos' | 'cancelled' | 'failed'; pos_value: string | null;
  created_at: string; item_name: string;
};
const baht = (satang: number) =>
  (satang / 100).toLocaleString(lang === 'th' ? 'th-TH' : 'en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const imageUrl = (name: string) => `/api/v1/menu-images/${name}`;

/** Re-encodes a photo until it fits the POS limit, shrinking it when quality alone is not enough. */
async function shrinkPhoto(file: File): Promise<string | null> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const node = new Image();
      node.onload = () => resolve(node);
      node.onerror = reject;
      node.src = url;
    });
    for (const edge of [960, 800, 640, 480, 360]) {
      const scale = Math.min(1, edge / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.85, 0.7, 0.55]) {
        let blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', quality));
        if (blob?.type !== 'image/webp') blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
        if (blob && blob.size <= 95_000) {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let binary = '';
          for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          return btoa(binary);
        }
      }
    }
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function changeValue(change: MenuChange, value: string | null): Child {
  if (change.field === 'price') return value === null ? '-' : `฿${baht(Number(value))}`;
  return value ? h('img', { class: 'thumb', src: imageUrl(value), alt: '' }) : tr('noPhoto');
}

async function menuView(container: HTMLElement, shop: Shop, branch: Branch) {
  const { items, changes } = await api<{ items: MenuItem[]; changes: MenuChange[] }>(`/owner/branches/${branch.id}/menu`);
  const top = errorLine();
  const notice = h('p', { class: 'notice', role: 'status' });
  const reload = (message = '') =>
    void menuView(container, shop, branch).then(() => {
      const fresh = container.querySelector('.notice');
      if (fresh) fresh.textContent = message;
    }).catch((failure) => showError(top, failure));
  const open = new Map(changes.filter((c) => c.status === 'pending' || c.status === 'conflict').map((c) => [`${c.menu_item_id}:${c.field}`, c]));
  const send = async (line: HTMLElement, path: string, body: unknown) => {
    line.textContent = '';
    try {
      const result = await api<{ unchanged?: boolean }>(path, body);
      reload(result.unchanged ? tr('unchanged') : tr('saved'));
    } catch (failure) {
      showError(line, failure);
    }
  };

  const changeRows = changes.map((change) => {
    const line = errorLine();
    const tone = change.status === 'applied' ? 'badge ok' : change.status === 'conflict' || change.status === 'failed' ? 'badge warn' : 'badge';
    const posValue = change.field === 'price' && change.pos_value !== null ? `฿${baht(Number(change.pos_value))}` : tr('fieldImage');
    return h('li', { class: 'change' },
      h('div', {}, h('strong', {}, change.item_name), ' · ', change.field === 'price' ? tr('fieldPrice') : tr('fieldImage'), ' ',
        h('span', { class: tone }, tr(change.status)), h('span', { class: 'muted small' }, ' ', when(change.created_at))),
      h('div', { class: 'values' }, changeValue(change, change.base_value), ' → ', changeValue(change, change.new_value)),
      change.status === 'conflict' && h('p', { class: 'small' }, tr('conflictHint', { pos: posValue })),
      change.status === 'conflict' && h('div', { class: 'actions' },
        h('button', { type: 'button', onclick: () => send(line, `/owner/changes/${change.id}/resolve`, { keep: 'web' }) }, tr('keepWeb')),
        h('button', { type: 'button', class: 'secondary', onclick: () => send(line, `/owner/changes/${change.id}/resolve`, { keep: 'pos' }) }, tr('keepPos'))),
      change.status === 'pending' && h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'secondary', onclick: () => send(line, `/owner/changes/${change.id}/cancel`, {}) }, tr('cancel'))),
      line);
  });

  let category: string | null | undefined;
  const itemRows: HTMLElement[] = [];
  for (const item of items) {
    if (item.category !== category) {
      category = item.category;
      itemRows.push(h('h4', { class: 'category' }, category ?? '-'));
    }
    const line = errorLine();
    const price = h('input', {
      type: 'number', min: '0', step: '0.01', inputmode: 'decimal', value: String(item.price_satang / 100),
      class: 'price-input', 'aria-label': `${tr('price')} ${item.name}`,
    });
    const file = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', class: 'hidden-file' });
    file.addEventListener('change', async () => {
      const picked = file.files?.[0];
      file.value = '';
      if (!picked) return;
      const data = await shrinkPhoto(picked).catch(() => null);
      if (!data) {
        line.textContent = tr('photoTooLarge');
        return;
      }
      await send(line, `/owner/branches/${branch.id}/menu/${item.id}/image`, { data });
    });
    const pendingPrice = open.get(`${item.id}:price`);
    const pendingImage = open.get(`${item.id}:image`);
    itemRows.push(h('div', { class: 'menu-item' },
      item.image ? h('img', { class: 'thumb', src: imageUrl(item.image), alt: '' }) : h('div', { class: 'thumb empty' }, tr('noPhoto')),
      h('div', { class: 'menu-name' }, h('strong', {}, item.name), h('div', { class: 'muted small' }, `฿${baht(item.price_satang)}`),
        pendingPrice && h('span', { class: pendingPrice.status === 'conflict' ? 'badge warn' : 'badge' }, `${tr('fieldPrice')}: ${tr(pendingPrice.status)}`),
        pendingImage && h('span', { class: pendingImage.status === 'conflict' ? 'badge warn' : 'badge' }, `${tr('fieldImage')}: ${tr(pendingImage.status)}`)),
      h('form', { class: 'actions', onsubmit: (event: Event) => {
        event.preventDefault();
        const satang = Math.round(Number(price.value) * 100);
        if (!Number.isFinite(satang) || satang < 0) return;
        void send(line, `/owner/branches/${branch.id}/menu/${item.id}/price`, { price_satang: satang });
      } }, price, h('button', { type: 'submit' }, tr('save')),
        h('button', { type: 'button', class: 'secondary', onclick: () => file.click() }, tr('changePhoto')), file),
      line));
  }

  container.replaceChildren(
    h('button', { type: 'button', class: 'link', onclick: () => void ownerView(container) }, `← ${tr('back')}`),
    h('section', { class: 'card' }, h('h2', {}, `${shop.name} · ${branch.name}`), h('p', { class: 'muted' }, tr('menuHint')), notice, top,
      changeRows.length ? h('div', {}, h('h3', {}, tr('changes')), h('ul', { class: 'changes' }, ...changeRows)) : null),
    h('section', { class: 'card' }, ...(itemRows.length ? itemRows : [h('p', { class: 'muted' }, tr('menuEmpty'))])));
}

function render() {
  const invite = new URLSearchParams(location.hash.slice(1)).get('invite');
  const body = h('div', { class: 'content' });
  root.replaceChildren(header(), body);
  if (invite && !current) return body.append(inviteView(invite));
  if (!current) return body.append(loginView());
  const view = h('div', {});
  const failed = errorLine();
  const load = (run: (container: HTMLElement) => Promise<void>) => run(view).catch((failure) => showError(failed, failure));
  if (current.role === 'owner') {
    const ownerTabs = h('nav', { class: 'tabs' }, ...(['dashboard', 'myShop'] as const).map((name) =>
      h('button', { type: 'button', class: ownerTab === name ? 'tab active' : 'tab', onclick: () => { ownerTab = name; render(); } }, tr(name))));
    if (ownerTab === 'dashboard') body.classList.add('wide');
    body.append(ownerTabs, failed, view);
    return void load(ownerTab === 'dashboard' ? ownerDashboard : ownerView);
  }
  const tabs = h('nav', { class: 'tabs' }, ...(['shops', 'users', 'audit'] as const).map((name) =>
    h('button', { type: 'button', class: tab === name ? 'tab active' : 'tab', onclick: () => { tab = name; render(); } }, tr(name))));
  body.append(tabs, failed, view);
  void load(tab === 'shops' ? shopsView : tab === 'users' ? usersView : auditView);
}

async function start() {
  document.documentElement.lang = lang;
  current = await api<{ user: User }>('/me').then((data) => data.user, () => null);
  render();
}

void start();
