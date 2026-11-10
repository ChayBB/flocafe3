const status = document.querySelector('#status');
const table = document.querySelector('#table-name');
const menu = document.querySelector('#menu');
const currency = new Intl.NumberFormat('th-TH', { style: 'currency', currency: 'THB' });

async function load() {
  const key = location.hash.slice(1);
  if (!key) {
    status.textContent = 'กรุณาสแกน QR สำหรับดูเมนูของโต๊ะทดสอบ';
    return;
  }
  try {
    const response = await fetch('/api/v1/menu-preview', {
      headers: { Authorization: `Bearer ${key}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
    if (response.status === 401) {
      status.textContent = 'QR นี้ใช้ไม่ได้หรือหมดอายุ กรุณาขอ QR ใหม่จากพนักงาน';
      return;
    }
    if (!response.ok) throw new Error('Menu unavailable');
    const data = await response.json();
    table.textContent = data.table_name;
    for (const item of data.items) {
      const row = document.createElement('li');
      const name = document.createElement('span');
      const price = document.createElement('span');
      name.textContent = item.name;
      price.textContent = item.price_satang === 0 ? 'สอบถามพนักงาน' : currency.format(item.price_satang / 100);
      row.append(name, price);
      menu.append(row);
    }
    status.textContent = data.items.length ? '' : 'ยังไม่มีรายการอาหารที่เปิดขาย';
  } catch {
    status.textContent = 'โหลดเมนูไม่สำเร็จ กรุณาตรวจการเชื่อมต่อแล้วโหลดหน้าใหม่';
  }
}

void load();
window.addEventListener('hashchange', () => location.reload());
