type Lang = 'th' | 'en';
type Child = Node | string | null | false | undefined;
type H = <K extends keyof HTMLElementTagNameMap>(tag: K, props?: Record<string, unknown>, ...children: Child[]) => HTMLElementTagNameMap[K];
type Api = <T>(path: string, body?: unknown) => Promise<T>;
type Branch = { id: string; name: string };

interface Totals {
  net: number; refunds: number; discounts: number; bills: number; orders: number; cancelled_orders: number; guests: number;
  guests_estimated: boolean; aov: number; table_utilization: number | null; food_cost: number | null; food_cost_coverage: number;
  labor: number; labor_complete: boolean; expenses: number; profit: number | null; margin: number | null; kitchen_timed: number;
  avg_wait_minutes: number | null; avg_prep_minutes: number | null; on_time_rate: number | null; on_time_minutes: number;
  cancel_rate: number; new_members: number; member_visits: number; repeat_members: number; promo_rate: number;
  staff_days: number; sales_per_staff_day: number | null; bills_per_staff_day: number | null;
}
interface Dashboard {
  range: { from: string; to: string; prev_from: string; prev_to: string; days: number };
  currency: string;
  branches: { id: string; name: string; net: number; reported_days: number; last_update: string | null }[];
  current: Totals; previous: Totals; members: number;
  daily: { date: string; net: number; prev_net: number }[];
  hours: { hour: number; sales: number; bills: number; utilization: number | null }[];
  categories: { name: string | null; net: number; qty: number }[];
  items: { name: string; image: string | null; net: number; qty: number }[];
  payments: { method: string; count: number; total: number }[];
  expenses: { name: string; amount: number }[];
  target: { month: string; target: number | null; achieved: number | null } | null;
}

const TEXT = {
  th: {
    summary: 'สรุปผลการดำเนินงาน', summaryHint: 'ภาพรวมยอดขาย การดำเนินงาน และประสิทธิภาพของร้าน',
    range: 'ช่วงเวลา', today: 'วันนี้', yesterday: 'เมื่อวาน', last7: '7 วันล่าสุด', thisMonth: 'เดือนนี้', lastMonth: 'เดือนก่อน',
    last30: '30 วันล่าสุด', custom: 'กำหนดเอง', allBranches: 'ทุกสาขา', compare: 'เทียบกับช่วงก่อนหน้า ({from} – {to})',
    refresh: 'รีเฟรช', download: 'ดาวน์โหลด CSV', sales: 'ยอดขายสุทธิ', target: 'เป้าหมายเดือน {month}', setTarget: 'ตั้งเป้า',
    targetPrompt: 'เป้าหมายยอดขายเดือน {month} ของ {branch} (บาท) เว้นว่างเพื่อลบ', targetPickBranch: 'เลือกสาขาเพื่อตั้งเป้า',
    noTarget: 'ยังไม่ตั้งเป้า', bills: 'จำนวนบิล', billsUnit: '{n} บิล', guests: 'ลูกค้า', guestsUnit: '{n} คน', estimated: '(ประมาณ)',
    aov: 'ยอดเฉลี่ยต่อบิล', tableUse: 'อัตราการใช้โต๊ะ', peak: 'ช่วงพีค {value}', margin: 'กำไรขั้นต้น', vsPrev: 'จากช่วงก่อน',
    trend: 'แนวโน้มยอดขาย', daily: 'รายวัน', weekly: 'รายสัปดาห์', monthly: 'รายเดือน', avgPerDay: 'ยอดขายเฉลี่ย/วัน',
    highest: 'สูงสุด', lowest: 'ต่ำสุด', thisPeriod: 'ช่วงนี้', prevPeriod: 'ช่วงก่อน', categories: 'สัดส่วนยอดขายตามหมวดหมู่',
    totalSales: 'รวมยอดขาย', other: 'อื่น ๆ', topItems: 'เมนูขายดี', byRevenue: 'ยอดขาย', byQty: 'จำนวนขาย',
    operations: 'ประสิทธิภาพการดำเนินงาน', waitTime: 'รอเริ่มทำอาหาร', prepTime: 'เวลาเตรียมอาหาร', onTime: 'เสร็จภายใน {n} นาที',
    cancelRate: 'ออเดอร์ยกเลิก', minutesAvg: 'เฉลี่ย {n} นาที', tables: 'การใช้โต๊ะ', tableAvg: 'การใช้โต๊ะเฉลี่ย',
    peakHours: 'ช่วงพีค', customers: 'ลูกค้าและสมาชิก', members: 'สมาชิกสะสม', newMembers: 'สมาชิกใหม่ {n} คน',
    repeat: 'ลูกค้าประจำ (≥ 3 ครั้ง/30 วัน)', repeatShare: '{n} ของสมาชิกที่มา', promo: 'การใช้คูปอง/โปรโมชั่น',
    finance: 'สรุปการเงิน (โดยประมาณ)', foodCost: 'ต้นทุนวัตถุดิบ', labor: 'ค่าแรง', expenses: 'ค่าใช้จ่ายอื่น', profit: 'กำไรขั้นต้น',
    costPartial: 'ต้นทุนคำนวณจากเมนูที่ตั้งสูตรไว้ {n} ของยอดขาย', laborPartial: 'พนักงานบางคนยังไม่ได้ตั้งค่าแรงรายชั่วโมง',
    hourly: 'ยอดขายรายชั่วโมง', staff: 'ประสิทธิภาพพนักงาน', staffDays: 'พนักงานลงเวลา', staffDaysUnit: '{n} คน-วัน',
    salesPerStaff: 'ยอดขายต่อพนักงาน', billsPerStaff: 'บิลต่อพนักงาน', perStaff: '{n} / คน-วัน', payments: 'ช่องทางชำระเงิน',
    insights: 'สรุปและข้อเสนอแนะ', noData: 'ยังไม่มีข้อมูลในช่วงนี้', noReports: 'ยังไม่มีสาขาส่งรายงาน — ต้องใช้ POS เวอร์ชันใหม่ที่จับคู่ Cloud แล้ว',
    branchSales: 'ยอดขายแยกสาขา', lastUpdate: 'อัปเดต {time}', neverReported: 'ยังไม่ส่งรายงาน',
    insightUp: 'ยอดขายเพิ่มขึ้น {n} จากช่วงก่อน', insightDown: 'ยอดขายลดลง {n} จากช่วงก่อน ควรตรวจสอบสาเหตุ',
    insightTarget: 'ทำได้ {n} ของเป้าเดือนนี้ คาดว่าสิ้นเดือนจะได้ {projected}',
    insightPeak: 'ช่วงขายดี {hours} ควรเพิ่มพนักงานและเตรียมวัตถุดิบให้พอ',
    insightCategory: 'หมวด {name} ทำยอดขาย {n} ลองจัดโปรโมชั่นหมวดอื่นเพื่อกระจายยอด',
    insightLowTables: 'การใช้โต๊ะเฉลี่ย {n} ยังมีที่ว่าง ลองโปรโมชั่นช่วงเวลาเงียบ',
    insightHighTables: 'โต๊ะเต็มเกือบตลอดช่วงพีค ({n}) ลองเปิดรับจองล่วงหน้าหรือจัดรอบโต๊ะ',
    insightCancel: 'ออเดอร์ยกเลิก {n} สูงกว่าปกติ ควรตรวจสอบสาเหตุ',
    insightCost: 'ตั้งสูตรต้นทุนเมนูใน POS เพิ่ม เพื่อให้กำไรแม่นยำขึ้น (ตอนนี้ครอบคลุม {n})',
    insightSlow: 'ครัวใช้เวลาเตรียมอาหารเฉลี่ย {n} นาที ลองดูเมนูที่ใช้เวลานาน',
    hourLabel: 'เวลา (น.)', method_cash: 'เงินสด', method_card: 'บัตร', method_promptpay: 'พร้อมเพย์', method_qr: 'QR', method_transfer: 'โอน',
    loading: 'กำลังโหลด…', save: 'บันทึก', cancel: 'ยกเลิก', from: 'ตั้งแต่', to: 'ถึง',
  },
  en: {
    summary: 'Executive summary', summaryHint: 'Sales, operations, and performance at a glance',
    range: 'Period', today: 'Today', yesterday: 'Yesterday', last7: 'Last 7 days', thisMonth: 'This month', lastMonth: 'Last month',
    last30: 'Last 30 days', custom: 'Custom', allBranches: 'All branches', compare: 'Compared with the previous period ({from} – {to})',
    refresh: 'Refresh', download: 'Download CSV', sales: 'Net sales', target: '{month} target', setTarget: 'Set target',
    targetPrompt: 'Sales target for {month} at {branch} (THB). Leave empty to remove.', targetPickBranch: 'Choose a branch to set a target',
    noTarget: 'No target set', bills: 'Bills', billsUnit: '{n} bills', guests: 'Guests', guestsUnit: '{n}', estimated: '(estimated)',
    aov: 'Average bill', tableUse: 'Table use', peak: 'Peak {value}', margin: 'Gross profit', vsPrev: 'vs previous',
    trend: 'Sales trend', daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', avgPerDay: 'Average per day',
    highest: 'Highest', lowest: 'Lowest', thisPeriod: 'This period', prevPeriod: 'Previous', categories: 'Sales by category',
    totalSales: 'Total sales', other: 'Other', topItems: 'Top items', byRevenue: 'Revenue', byQty: 'Quantity',
    operations: 'Operations', waitTime: 'Wait before cooking', prepTime: 'Preparation time', onTime: 'Ready within {n} min',
    cancelRate: 'Cancelled orders', minutesAvg: '{n} min avg', tables: 'Table use', tableAvg: 'Average table use',
    peakHours: 'Peak hours', customers: 'Customers and members', members: 'Members', newMembers: '{n} new',
    repeat: 'Regulars (≥ 3 visits/30 days)', repeatShare: '{n} of member visits', promo: 'Coupon/promotion use',
    finance: 'Finance (estimated)', foodCost: 'Food cost', labor: 'Labor', expenses: 'Other expenses', profit: 'Gross profit',
    costPartial: 'Food cost estimated from items with recipes ({n} of sales)', laborPartial: 'Some staff have no hourly rate',
    hourly: 'Sales by hour', staff: 'Staff productivity', staffDays: 'Staff clocked in', staffDaysUnit: '{n} staff-days',
    salesPerStaff: 'Sales per staff', billsPerStaff: 'Bills per staff', perStaff: '{n} / staff-day', payments: 'Payment methods',
    insights: 'Summary and suggestions', noData: 'No data for this period', noReports: 'No branch has reported yet — the POS needs the new version paired with the Cloud',
    branchSales: 'Sales by branch', lastUpdate: 'Updated {time}', neverReported: 'Not reported yet',
    insightUp: 'Sales are up {n} on the previous period', insightDown: 'Sales are down {n} on the previous period; worth a look',
    insightTarget: '{n} of this month\'s target reached; on track for {projected}',
    insightPeak: 'Busiest hours {hours}: add staff and prepare enough stock',
    insightCategory: '{name} makes {n} of sales; promote other categories to spread revenue',
    insightLowTables: 'Average table use is {n}; try off-peak promotions',
    insightHighTables: 'Tables are nearly full at peak ({n}); consider reservations or table turns',
    insightCancel: 'Cancelled orders at {n} are high; check the causes',
    insightCost: 'Add recipe costs in the POS for a more accurate profit (now {n} covered)',
    insightSlow: 'Kitchen preparation averages {n} min; check slow items',
    hourLabel: 'Hour', method_cash: 'Cash', method_card: 'Card', method_promptpay: 'PromptPay', method_qr: 'QR', method_transfer: 'Transfer',
    loading: 'Loading…', save: 'Save', cancel: 'Cancel', from: 'From', to: 'To',
  },
} as const;
type Key = keyof typeof TEXT.th;

/** The portal CSP forbids inline style attributes, so dynamic styles go through the CSSOM. */
function paint<T extends HTMLElement>(node: T, property: 'background' | 'width', value: string) {
  node.style[property] = value;
  return node;
}
const PALETTE = ['#ea580c', '#3b82f6', '#22c55e', '#a855f7', '#ec4899', '#94a3b8', '#eab308', '#14b8a6'];
const SVG = 'http://www.w3.org/2000/svg';
function s(tag: string, attrs: Record<string, string | number> = {}, ...children: (Node | string)[]) {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  for (const child of children) node.append(child);
  return node;
}

type Preset = 'today' | 'yesterday' | 'last7' | 'thisMonth' | 'lastMonth' | 'last30' | 'custom';
const state: { preset: Preset; from: string; to: string; branch: string; trend: 'daily' | 'weekly' | 'monthly'; items: 'net' | 'qty' } = {
  preset: 'thisMonth', from: '', to: '', branch: '', trend: 'daily', items: 'net',
};

const bangkokToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
function presetRange(preset: Preset): [string, string] {
  const today = bangkokToday();
  const monthStart = `${today.slice(0, 7)}-01`;
  switch (preset) {
    case 'today': return [today, today];
    case 'yesterday': return [shift(today, -1), shift(today, -1)];
    case 'last7': return [shift(today, -6), today];
    case 'last30': return [shift(today, -29), today];
    case 'lastMonth': { const end = shift(monthStart, -1); return [`${end.slice(0, 7)}-01`, end]; }
    case 'custom': return [state.from || monthStart, state.to || today];
    default: return [monthStart, today];
  }
}

/** Owner executive dashboard: one call to the report API, drawn with plain SVG. */
export async function dashboardView(container: HTMLElement, ctx: { h: H; api: Api; lang: Lang; branches: Branch[] }) {
  const { h, api, lang } = ctx;
  const tr = (key: Key, vars: Record<string, string | number> = {}) =>
    TEXT[lang][key].replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ''));
  const locale = lang === 'th' ? 'th-TH' : 'en-GB';
  const moneyFmt = new Intl.NumberFormat(locale, { style: 'currency', currency: 'THB', maximumFractionDigits: 0 });
  const baht = (value: number) => moneyFmt.format(value || 0);
  const shortBaht = (value: number) => (Math.abs(value) >= 1000 ? `${Math.round(value / 1000)}K` : String(Math.round(value)));
  const pct = (value: number | null, digits = 1) => (value === null ? '–' : `${(value * 100).toFixed(digits)}%`);
  const num = (value: number) => new Intl.NumberFormat(locale).format(value);
  const dateLabel = (date: string, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }) =>
    new Intl.DateTimeFormat(locale, { ...opts, timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
  const hourLabel = (hour: number) => `${String(hour).padStart(2, '0')}:00`;
  const methodName = (method: string) => {
    const key = `method_${method.toLowerCase()}` as Key;
    return key in TEXT.th ? tr(key) : method;
  };
  const delta = (now: number | null, before: number | null, opts: { lowerBetter?: boolean; points?: boolean } = {}) => {
    if (now === null || before === null) return null;
    const change = opts.points ? (now - before) * 100 : before ? ((now - before) / Math.abs(before)) * 100 : null;
    if (change === null || !Number.isFinite(change)) return null;
    const shown = Math.round(change * 10) / 10 || 0;
    const good = opts.lowerBetter ? shown <= 0 : shown >= 0;
    const text = `${shown >= 0 ? '▲' : '▼'} ${shown >= 0 ? '+' : ''}${shown.toFixed(1)}${opts.points ? (lang === 'th' ? ' จุด' : ' pts') : '%'}`;
    return h('span', { class: `delta ${good ? 'up' : 'down'}` }, text);
  };

  [state.from, state.to] = presetRange(state.preset);
  const presetSelect = h('select', { 'aria-label': tr('range') },
    ...(['today', 'yesterday', 'last7', 'thisMonth', 'lastMonth', 'last30', 'custom'] as const).map((p) =>
      h('option', { value: p, selected: state.preset === p }, tr(p))));
  const fromInput = h('input', { type: 'date', value: state.from, 'aria-label': tr('from') });
  const toInput = h('input', { type: 'date', value: state.to, 'aria-label': tr('to') });
  const customBox = h('span', { class: state.preset === 'custom' ? 'custom-range' : 'custom-range hidden' }, fromInput, '–', toInput);
  const branchSelect = h('select', { 'aria-label': tr('allBranches') },
    h('option', { value: '' }, tr('allBranches')),
    ...ctx.branches.map((b) => h('option', { value: b.id, selected: state.branch === b.id }, b.name)));
  const body = h('div', { class: 'dash-body' }, h('p', { class: 'muted' }, tr('loading')));
  const failure = h('p', { class: 'error', role: 'alert' });
  let data: Dashboard | null = null;
  const reload = () => void dashboardView(container, ctx);
  presetSelect.addEventListener('change', () => {
    state.preset = presetSelect.value as Preset;
    if (state.preset !== 'custom') reload();
    else customBox.classList.remove('hidden');
  });
  for (const input of [fromInput, toInput]) input.addEventListener('change', () => {
    if (fromInput.value && toInput.value && fromInput.value <= toInput.value) {
      state.from = fromInput.value;
      state.to = toInput.value;
      reload();
    }
  });
  branchSelect.addEventListener('change', () => { state.branch = branchSelect.value; reload(); });
  const download = h('button', { type: 'button', class: 'secondary', onclick: () => data && downloadCsv(data) }, tr('download'));
  const compareLine = h('span', { class: 'muted small' });

  container.replaceChildren(h('div', { class: 'dash' },
    h('div', { class: 'dash-head' },
      h('div', {}, h('h2', {}, tr('summary')), h('p', { class: 'muted small' }, tr('summaryHint'))),
      h('div', { class: 'dash-controls' },
        h('label', { class: 'control' }, h('span', {}, tr('range')), presetSelect), customBox, branchSelect,
        h('button', { type: 'button', class: 'secondary', onclick: reload }, tr('refresh')), download)),
    compareLine, failure, body));

  try {
    const query = new URLSearchParams({ from: state.from, to: state.to, ...(state.branch ? { branch: state.branch } : {}) });
    data = await api<Dashboard>(`/owner/reports?${query}`);
  } catch (error) {
    body.replaceChildren();
    failure.textContent = String((error as Error).message ?? error);
    return;
  }
  const d = data;
  const c = d.current;
  const p = d.previous;
  compareLine.textContent = tr('compare', { from: dateLabel(d.range.prev_from), to: dateLabel(d.range.prev_to) });
  const card = (cls: string, title: string, ...content: Child[]) =>
    h('section', { class: `dash-card ${cls}` }, h('h3', {}, title), ...content);

  if (!d.branches.some((b) => b.last_update)) {
    body.replaceChildren(h('section', { class: 'dash-card' }, h('p', {}, tr('noReports'))));
    return;
  }

  const peakHours = topHours(d.hours, 'sales');
  const peakUse = d.hours.filter((x) => x.utilization !== null).sort((a, b) => (b.utilization ?? 0) - (a.utilization ?? 0))[0];

  const target = d.target;
  const targetBox = target
    ? h('div', { class: 'target' },
        h('div', { class: 'small muted' }, tr('target', { month: dateLabel(`${target.month}-01`, { month: 'long', year: 'numeric' }) })),
        h('strong', {}, target.target ? baht(target.target) : tr('noTarget')),
        target.target ? progress((target.achieved ?? 0) / target.target) : null,
        state.branch
          ? h('button', { type: 'button', class: 'link small', onclick: async () => {
              const branch = ctx.branches.find((b) => b.id === state.branch)!;
              const answer = prompt(tr('targetPrompt', { month: target.month, branch: branch.name }), target.target ? String(target.target) : '');
              if (answer === null) return;
              const value = answer.trim() === '' ? null : Number(answer.replace(/[,\s]/g, ''));
              if (value !== null && !(value >= 0)) return;
              await api(`/owner/branches/${branch.id}/target`, { month: target.month, target: value });
              reload();
            } }, tr('setTarget'))
          : h('span', { class: 'small muted' }, tr('targetPickBranch')))
    : null;

  const kpi = (tone: string, icon: string, label: string, value: string, sub: Child) =>
    h('section', { class: `kpi tone-${tone}` }, h('span', { class: 'kpi-icon', 'aria-hidden': 'true' }, icon),
      h('div', {}, h('div', { class: 'kpi-label' }, label), h('div', { class: 'kpi-value' }, value), sub));

  const kpis = h('div', { class: 'kpis' },
    h('section', { class: 'kpi kpi-main tone-green' }, h('span', { class: 'kpi-icon', 'aria-hidden': 'true' }, '฿'),
      h('div', {}, h('div', { class: 'kpi-label' }, tr('sales')), h('div', { class: 'kpi-value big' }, baht(c.net)),
        h('div', { class: 'small' }, delta(c.net, p.net), ' ', h('span', { class: 'muted' }, tr('vsPrev')))), targetBox),
    kpi('purple', '🧾', tr('bills'), tr('billsUnit', { n: num(c.bills) }), delta(c.bills, p.bills)),
    kpi('blue', '👥', `${tr('guests')} ${c.guests_estimated ? tr('estimated') : ''}`, tr('guestsUnit', { n: num(c.guests) }), delta(c.guests, p.guests)),
    kpi('orange', '💳', tr('aov'), baht(c.aov), delta(c.aov, p.aov)),
    kpi('pink', '🍽', tr('tableUse'), pct(c.table_utilization),
      peakUse?.utilization ? h('span', { class: 'delta warn' }, tr('peak', { value: pct(peakUse.utilization) })) : null),
    kpi('teal', '📈', `${tr('margin')} ${tr('estimated')}`, pct(c.margin), delta(c.margin, p.margin, { points: true })));

  const trendRows = groupTrend(d.daily, state.trend);
  const avgPerDay = d.range.days ? c.net / d.range.days : 0;
  const trendTabs = h('div', { class: 'seg' }, ...(['daily', 'weekly', 'monthly'] as const).map((mode) =>
    h('button', { type: 'button', class: state.trend === mode ? 'active' : '', onclick: () => { state.trend = mode; reload(); } }, tr(mode))));
  const trend = card('span-5', tr('trend'), trendTabs,
    h('div', { class: 'trend-head' }, h('span', { class: 'muted small' }, tr('avgPerDay')), h('strong', {}, baht(avgPerDay)), delta(avgPerDay, p.net / d.range.days)),
    lineChart(trendRows),
    h('div', { class: 'legend' }, h('span', { class: 'swatch line' }), tr('thisPeriod'), h('span', { class: 'swatch dashed' }), tr('prevPeriod')));

  const cats = topWithOther(d.categories.map((x) => ({ label: x.name ?? tr('other'), value: x.net })), 5);
  const categories = card('span-4', tr('categories'), cats.length ? h('div', { class: 'donut-wrap' }, donut(cats, c.net),
    h('ul', { class: 'legend-list' }, ...cats.map((cat, i) => h('li', {},
      paint(h('span', { class: 'dot' }), 'background', PALETTE[i % PALETTE.length]), h('span', {}, cat.label),
      h('strong', {}, pct(c.net ? cat.value / c.net : 0)))))) : empty());

  const sortedItems = [...d.items].sort((a, b) => (state.items === 'net' ? b.net - a.net : b.qty - a.qty)).slice(0, 5);
  const itemTabs = h('div', { class: 'seg' }, ...(['net', 'qty'] as const).map((mode) =>
    h('button', { type: 'button', class: state.items === mode ? 'active' : '', onclick: () => { state.items = mode; reload(); } }, tr(mode === 'net' ? 'byRevenue' : 'byQty'))));
  const items = card('span-3', tr('topItems'), itemTabs, sortedItems.length ? h('ol', { class: 'top-items' }, ...sortedItems.map((item, i) =>
    h('li', {}, h('span', { class: `rank r${i + 1}` }, String(i + 1)),
      item.image ? h('img', { class: 'item-thumb', src: `/api/v1/menu-images/${item.image}`, alt: '' }) : h('span', { class: 'item-thumb' }),
      h('span', { class: 'item-name' }, item.name),
      h('strong', {}, state.items === 'net' ? baht(item.net) : num(item.qty)),
      h('span', { class: 'muted small' }, state.items === 'net' ? pct(c.net ? item.net / c.net : 0) : '')))) : empty());

  const metric = (label: string, value: string, change: Child) =>
    h('div', { class: 'metric' }, h('div', { class: 'small muted' }, label), h('strong', {}, value), change);
  const operations = card('span-5', tr('operations'), h('div', { class: 'metrics' },
    metric(tr('waitTime'), c.avg_wait_minutes === null ? '–' : tr('minutesAvg', { n: c.avg_wait_minutes }), delta(c.avg_wait_minutes, p.avg_wait_minutes, { lowerBetter: true })),
    metric(tr('prepTime'), c.avg_prep_minutes === null ? '–' : tr('minutesAvg', { n: c.avg_prep_minutes }), delta(c.avg_prep_minutes, p.avg_prep_minutes, { lowerBetter: true })),
    metric(tr('onTime', { n: c.on_time_minutes }), pct(c.on_time_rate), delta(c.on_time_rate, p.on_time_rate, { points: true })),
    metric(tr('cancelRate'), pct(c.cancel_rate), delta(c.cancel_rate, p.cancel_rate, { points: true, lowerBetter: true }))));

  const peaksUse = topHours(d.hours, 'utilization');
  const tables = card('span-3', tr('tables'), h('div', { class: 'gauge-wrap' }, gauge(c.table_utilization ?? 0, tr('tableAvg'), pct(c.table_utilization)),
    h('div', { class: 'peak-box' }, h('div', { class: 'small muted' }, tr('peakHours')),
      ...peaksUse.map((x) => h('div', { class: 'peak-row' }, h('span', {}, x.label), h('strong', {}, pct(x.value)))))));

  const customers = card('span-4', tr('customers'), h('div', { class: 'metrics three' },
    metric(tr('members'), num(d.members), h('span', { class: 'small muted' }, tr('newMembers', { n: num(c.new_members) }))),
    metric(tr('repeat'), num(c.repeat_members), h('span', { class: 'small muted' }, tr('repeatShare', { n: pct(c.member_visits ? c.repeat_members / c.member_visits : 0) }))),
    metric(tr('promo'), pct(c.promo_rate), delta(c.promo_rate, p.promo_rate, { points: true }))));

  const financeRow = (label: string, value: number | null, before: number | null, lowerBetter = false, strong = false) =>
    h('div', { class: strong ? 'fin-row total' : 'fin-row' }, h('span', {}, label),
      h('strong', {}, value === null ? '–' : baht(value)), delta(value, before, { lowerBetter }));
  const finance = card('span-3', tr('finance'),
    financeRow(tr('sales'), c.net, p.net),
    financeRow(`${tr('foodCost')}${c.food_cost !== null && c.net ? ` ${pct(c.food_cost / c.net)}` : ''}`, c.food_cost, p.food_cost, true),
    financeRow(`${tr('labor')}${c.net ? ` ${pct(c.labor / c.net)}` : ''}`, c.labor, p.labor, true),
    financeRow(`${tr('expenses')}${c.net ? ` ${pct(c.expenses / c.net)}` : ''}`, c.expenses, p.expenses, true),
    financeRow(`${tr('profit')} ${pct(c.margin)}`, c.profit, p.profit, false, true),
    c.food_cost_coverage < 0.95 ? h('p', { class: 'small muted' }, tr('costPartial', { n: pct(c.food_cost_coverage, 0) })) : null,
    !c.labor_complete ? h('p', { class: 'small muted' }, tr('laborPartial')) : null);

  const hourly = card('span-3', tr('hourly'), barChart(d.hours, peakHours.flatMap((x) => x.hours)), h('div', { class: 'small muted center' }, tr('hourLabel')));

  const staff = card('span-3', tr('staff'),
    h('div', { class: 'fin-row' }, h('span', {}, tr('staffDays')), h('strong', {}, tr('staffDaysUnit', { n: num(c.staff_days) }))),
    h('div', { class: 'fin-row' }, h('span', {}, tr('salesPerStaff')), h('strong', {}, c.sales_per_staff_day === null ? '–' : tr('perStaff', { n: baht(c.sales_per_staff_day) })), delta(c.sales_per_staff_day, p.sales_per_staff_day)),
    h('div', { class: 'fin-row' }, h('span', {}, tr('billsPerStaff')), h('strong', {}, c.bills_per_staff_day === null ? '–' : tr('perStaff', { n: c.bills_per_staff_day })), delta(c.bills_per_staff_day, p.bills_per_staff_day)),
    h('h3', { class: 'sub' }, tr('payments')),
    ...d.payments.slice(0, 5).map((pay) => h('div', { class: 'fin-row' }, h('span', {}, methodName(pay.method)),
      h('strong', {}, baht(pay.total)), h('span', { class: 'muted small' }, pct(c.net ? pay.total / c.net : 0)))));

  const insights = card('span-3', tr('insights'), h('ul', { class: 'insights' }, ...buildInsights().map((text) => h('li', {}, text))));

  const branchCard = ctx.branches.length > 1 && !state.branch
    ? card('span-12', tr('branchSales'), h('div', { class: 'branch-bars' }, ...d.branches.map((b) =>
        h('div', { class: 'branch-bar' }, h('span', {}, b.name),
          progress(c.net ? b.net / c.net : 0, false), h('strong', {}, baht(b.net)),
          h('span', { class: 'muted small' }, b.last_update ? tr('lastUpdate', { time: new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Bangkok' }).format(new Date(b.last_update)) }) : tr('neverReported'))))))
    : null;

  body.replaceChildren(kpis, h('div', { class: 'dash-grid' }, trend, categories, items, operations, tables, customers, finance, hourly, staff, insights, branchCard));

  function buildInsights() {
    const list: string[] = [];
    if (p.net > 0) {
      const change = (c.net - p.net) / p.net;
      list.push(tr(change >= 0 ? 'insightUp' : 'insightDown', { n: pct(Math.abs(change)) }));
    }
    if (target?.target && target.achieved !== null) {
      const today = bangkokToday();
      const daysInMonth = new Date(Date.UTC(Number(target.month.slice(0, 4)), Number(target.month.slice(5, 7)), 0)).getUTCDate();
      const elapsed = today.startsWith(target.month) ? Number(today.slice(8, 10)) : daysInMonth;
      list.push(tr('insightTarget', { n: pct(target.achieved / target.target), projected: baht((target.achieved / elapsed) * daysInMonth) }));
    }
    if (peakHours.length) list.push(tr('insightPeak', { hours: peakHours.map((x) => x.label).join(', ') }));
    if (cats[0] && c.net && cats[0].value / c.net > 0.4) list.push(tr('insightCategory', { name: cats[0].label, n: pct(cats[0].value / c.net) }));
    if (c.table_utilization !== null && c.table_utilization < 0.5) list.push(tr('insightLowTables', { n: pct(c.table_utilization) }));
    if (peakUse?.utilization && peakUse.utilization > 0.85) list.push(tr('insightHighTables', { n: pct(peakUse.utilization) }));
    if (c.cancel_rate > 0.03) list.push(tr('insightCancel', { n: pct(c.cancel_rate) }));
    if (c.avg_prep_minutes !== null && c.avg_prep_minutes > c.on_time_minutes) list.push(tr('insightSlow', { n: c.avg_prep_minutes }));
    if (c.food_cost_coverage < 0.6) list.push(tr('insightCost', { n: pct(c.food_cost_coverage, 0) }));
    return list.length ? list : [tr('noData')];
  }

  function empty() {
    return h('p', { class: 'muted small' }, tr('noData'));
  }

  function progress(ratio: number, label = true) {
    const clamped = Math.max(0, Math.min(1, ratio || 0));
    return h('div', { class: 'progress' }, h('span', { class: 'bar' }, paint(h('span', { class: 'fill' }), 'width', `${(clamped * 100).toFixed(1)}%`)),
      label ? h('span', { class: 'small' }, pct(ratio)) : null);
  }

  function topHours(hours: Dashboard['hours'], key: 'sales' | 'utilization') {
    const ranked = hours.filter((x) => (x[key] ?? 0) > 0).sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0)).slice(0, 2);
    const spans: { hour: number; end: number; value: number }[] = [];
    for (const x of ranked.sort((a, b) => a.hour - b.hour)) {
      const last = spans[spans.length - 1];
      if (last && last.end === x.hour) { last.end = x.hour + 1; last.value = Math.max(last.value, x[key] ?? 0); }
      else spans.push({ hour: x.hour, end: x.hour + 1, value: x[key] ?? 0 });
    }
    return spans.map((x) => ({ hour: x.hour, hours: Array.from({ length: x.end - x.hour }, (_, i) => x.hour + i), label: `${hourLabel(x.hour)}–${hourLabel(x.end % 24)}`, value: x.value }));
  }

  function topWithOther(list: { label: string; value: number }[], keep: number) {
    const positive = list.filter((x) => x.value > 0);
    if (positive.length <= keep + 1) return positive;
    const rest = positive.slice(keep).reduce((acc, x) => acc + x.value, 0);
    return [...positive.slice(0, keep), { label: tr('other'), value: rest }];
  }

  function groupTrend(rows: Dashboard['daily'], mode: 'daily' | 'weekly' | 'monthly') {
    if (mode === 'daily') return rows.map((r) => ({ label: dateLabel(r.date), net: r.net, prev: r.prev_net }));
    const groups = new Map<string, { label: string; net: number; prev: number }>();
    rows.forEach((r, index) => {
      const key = mode === 'monthly' ? r.date.slice(0, 7) : String(Math.floor(index / 7));
      const label = mode === 'monthly' ? dateLabel(`${key}-01`, { month: 'short', year: '2-digit' }) : dateLabel(r.date);
      const group = groups.get(key) ?? { label, net: 0, prev: 0 };
      group.net += r.net;
      group.prev += r.prev_net;
      groups.set(key, group);
    });
    return [...groups.values()];
  }

  function lineChart(rows: { label: string; net: number; prev: number }[]) {
    const W = 560, H = 220, L = 46, R = 12, T = 16, B = 28;
    const max = Math.max(1, ...rows.map((r) => Math.max(r.net, r.prev))) * 1.15;
    const x = (i: number) => L + (rows.length > 1 ? (i * (W - L - R)) / (rows.length - 1) : (W - L - R) / 2);
    const y = (v: number) => T + (H - T - B) * (1 - v / max);
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img' });
    for (let i = 0; i <= 4; i += 1) {
      const v = (max / 4) * i;
      svg.append(s('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'grid' }), s('text', { x: L - 6, y: y(v) + 4, class: 'axis', 'text-anchor': 'end' }, shortBaht(v)));
    }
    const path = (pick: (r: (typeof rows)[number]) => number) => rows.map((r, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(pick(r)).toFixed(1)}`).join(' ');
    if (rows.length) {
      svg.append(s('path', { d: `${path((r) => r.net)} L${x(rows.length - 1)},${y(0)} L${x(0)},${y(0)} Z`, class: 'area' }));
      svg.append(s('path', { d: path((r) => r.prev), class: 'line-prev' }), s('path', { d: path((r) => r.net), class: 'line-main' }));
    }
    const step = Math.max(1, Math.ceil(rows.length / 7));
    rows.forEach((r, i) => {
      if (rows.length <= 31) svg.append(s('circle', { cx: x(i), cy: y(r.net), r: 3, class: 'pt' }, s('title', {}, `${r.label}: ${baht(r.net)}`)));
      if (i % step === 0) svg.append(s('text', { x: x(i), y: H - 8, class: 'axis', 'text-anchor': 'middle' }, r.label));
    });
    const positive = rows.filter((r) => r.net > 0);
    if (positive.length > 1) {
      const hi = rows.indexOf(positive.reduce((a, b) => (b.net > a.net ? b : a)));
      const lo = rows.indexOf(positive.reduce((a, b) => (b.net < a.net ? b : a)));
      const tag = (i: number, text: string, cls: string, dy: number) => {
        const label = `${text}: ${baht(rows[i].net)}`;
        const width = label.length * 6.4 + 14;
        const left = Math.min(Math.max(x(i) - width / 2, L), W - R - width);
        svg.append(s('g', { class: cls }, s('rect', { x: left, y: y(rows[i].net) + dy - 13, width, height: 20, rx: 10 }),
          s('text', { x: left + width / 2, y: y(rows[i].net) + dy + 1, 'text-anchor': 'middle' }, label)));
      };
      tag(hi, tr('highest'), 'tag-hi', -14);
      if (lo !== hi) tag(lo, tr('lowest'), 'tag-lo', 24);
    }
    return svg;
  }

  function donut(slices: { label: string; value: number }[], total: number) {
    const size = 180, r = 70, stroke = 30, circ = 2 * Math.PI * r;
    const sum = slices.reduce((acc, x) => acc + x.value, 0) || 1;
    const svg = s('svg', { viewBox: `0 0 ${size} ${size}`, class: 'donut', role: 'img' });
    let offset = 0;
    slices.forEach((slice, i) => {
      const length = (slice.value / sum) * circ;
      svg.append(s('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', stroke: PALETTE[i % PALETTE.length], 'stroke-width': stroke,
        'stroke-dasharray': `${length} ${circ - length}`, 'stroke-dashoffset': -offset, transform: `rotate(-90 ${size / 2} ${size / 2})` },
        s('title', {}, `${slice.label}: ${baht(slice.value)}`)));
      offset += length;
    });
    svg.append(s('text', { x: size / 2, y: size / 2 - 2, 'text-anchor': 'middle', class: 'donut-value' }, baht(total)),
      s('text', { x: size / 2, y: size / 2 + 16, 'text-anchor': 'middle', class: 'axis' }, tr('totalSales')));
    return svg;
  }

  function gauge(ratio: number, label: string, value: string) {
    const r = 70, cx = 90, cy = 90, clamped = Math.max(0, Math.min(1, ratio));
    const arc = (to: number) => {
      const angle = Math.PI * (1 - to);
      return `M${cx - r},${cy} A${r},${r} 0 0 1 ${(cx + r * Math.cos(angle)).toFixed(1)},${(cy - r * Math.sin(angle)).toFixed(1)}`;
    };
    return s('svg', { viewBox: '0 0 180 110', class: 'gauge', role: 'img' },
      s('path', { d: arc(1), class: 'gauge-track' }), clamped > 0 ? s('path', { d: arc(clamped), class: 'gauge-fill' }) : '',
      s('text', { x: cx, y: cy - 8, 'text-anchor': 'middle', class: 'donut-value' }, value),
      s('text', { x: cx, y: cy + 12, 'text-anchor': 'middle', class: 'axis' }, label));
  }

  function barChart(hours: Dashboard['hours'], peaks: number[]) {
    const active = hours.filter((x) => x.bills > 0 || x.sales !== 0);
    const first = active.length ? Math.min(...active.map((x) => x.hour)) : 8;
    const last = active.length ? Math.max(...active.map((x) => x.hour)) : 22;
    const shown = hours.slice(first, last + 1);
    const W = 520, H = 220, L = 42, R = 8, T = 12, B = 24;
    const max = Math.max(1, ...shown.map((x) => x.sales)) * 1.15;
    const band = (W - L - R) / Math.max(1, shown.length);
    const y = (v: number) => T + (H - T - B) * (1 - Math.max(0, v) / max);
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img' });
    for (let i = 0; i <= 4; i += 1) {
      const v = (max / 4) * i;
      svg.append(s('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'grid' }), s('text', { x: L - 6, y: y(v) + 4, class: 'axis', 'text-anchor': 'end' }, shortBaht(v)));
    }
    shown.forEach((slot, i) => {
      const x = L + i * band;
      if (peaks.includes(slot.hour)) svg.append(s('rect', { x, y: T, width: band, height: H - T - B, class: 'peak-band' }));
      svg.append(s('rect', { x: x + band * 0.18, y: y(slot.sales), width: band * 0.64, height: Math.max(0, y(0) - y(slot.sales)), rx: 2, class: 'bar' },
        s('title', {}, `${hourLabel(slot.hour)}: ${baht(slot.sales)} · ${slot.bills}`)));
      svg.append(s('text', { x: x + band / 2, y: H - 8, class: 'axis', 'text-anchor': 'middle' }, String(slot.hour)));
    });
    return svg;
  }

  function downloadCsv(report: Dashboard) {
    const quote = (value: unknown) => {
      const text = String(value ?? '');
      const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
      return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const lines = [
      ['date', 'net_sales', 'previous_period_net_sales'], ...report.daily.map((r) => [r.date, r.net, r.prev_net]), [],
      ['item', 'quantity', 'net_sales'], ...report.items.map((i) => [i.name, i.qty, i.net]), [],
      ['category', 'quantity', 'net_sales'], ...report.categories.map((x) => [x.name ?? '', x.qty, x.net]), [],
      ['payment_method', 'count', 'total'], ...report.payments.map((x) => [x.method, x.count, x.total]),
    ];
    const blob = new Blob([`﻿${lines.map((line) => line.map(quote).join(',')).join('\n')}`], { type: 'text/csv;charset=utf-8' });
    const link = h('a', { href: URL.createObjectURL(blob), download: `flocafe-report-${report.range.from}-${report.range.to}.csv` });
    document.body.append(link);
    link.click();
    link.remove();
  }
}
