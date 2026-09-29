(() => {
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let preference;
  try { preference = localStorage.getItem('lan-theme'); } catch {}
  function apply(theme) {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#15141d' : '#f6f7f9';
    const button = document.getElementById('theme-toggle');
    if (button) {
      const dark = theme === 'dark';
      button.textContent = dark ? '☀ Light mode' : '☾ Dark mode';
      button.setAttribute('aria-label', dark ? 'เปลี่ยนเป็น Light mode' : 'เปลี่ยนเป็น Dark mode');
      button.title = dark ? 'เปลี่ยนเป็นโหมดสว่าง' : 'เปลี่ยนเป็นโหมดมืด';
    }
  }
  const current = () => preference === 'light' || preference === 'dark' ? preference : system.matches ? 'dark' : 'light';
  apply(current());
  document.addEventListener('DOMContentLoaded', () => {
    apply(current());
    document.getElementById('theme-toggle').addEventListener('click', () => {
      preference = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem('lan-theme', preference); } catch {}
      apply(preference);
    });
  });
  system.addEventListener('change', () => apply(current()));
  window.addEventListener('storage', event => {
    if (event.key === 'lan-theme' || event.key === null) {
      preference = event.newValue;
      apply(current());
    }
  });
})();
