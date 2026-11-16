(() => {
  const entry = new URL('./order.js', document.currentScript.src);
  const recovery = document.getElementById('menu-recovery');
  const message = document.getElementById('menu-recovery-message');
  const codeLabel = document.getElementById('menu-recovery-code');
  const root = document.getElementById('root');
  let failed = false;
  const fail = (code) => {
    if (failed) return;
    failed = true;
    clearTimeout(timer);
    root.hidden = true;
    recovery.hidden = false;
    message.textContent = 'เปิดเมนูไม่สำเร็จ กรุณากดโหลดใหม่ หรือติดต่อพนักงาน';
    codeLabel.textContent = `รหัสข้อผิดพลาด: ${code}`;
    console.error('[FloCafe menu]', code, entry.pathname);
  };
  const timer = setTimeout(() => fail('MENU_START_TIMEOUT'), 30000);
  window.addEventListener(
    'flo-menu-mounted',
    () => {
      clearTimeout(timer);
      if (!failed) recovery.hidden = true;
    },
    { once: true },
  );
  window.addEventListener('flo-menu-render-error', () => fail('MENU_RENDER_FAILED'));
  const retry = document.getElementById('menu-retry');
  retry.hidden = false;
  retry.addEventListener('click', (event) => {
    event.preventDefault();
    const url = new URL(location.href);
    url.searchParams.set('reload', String(Date.now()));
    location.replace(url.href);
  });
  import(entry.href).catch(() => fail('MENU_SCRIPT_FAILED'));
})();
