// Fulfil dashboard: tabs and the filter controls. Only listens and sets values/hidden here.
(() => {
  const PAGES = ['overview', 'action-list', 'performance', 'order-search', 'deep-dive', 'bottlenecks', 'courier-by-zone', 'no-call', 'data-health'];
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  function show(id) {
    if (!PAGES.includes(id)) id = 'overview';
    $$('.fx-page').forEach((s) => { s.hidden = s.id !== id; });
    $$('.fx-tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === id)));
    dash.setLink(id);
  }
  $$('.fx-tab').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
  show((location.hash || '').slice(1));
  window.addEventListener('hashchange', () => show((location.hash || '').slice(1)));

  // Dates
  const syncInputs = () => {
    const p = dash.params();
    $$('#f-from').forEach((el) => { if (document.activeElement !== el) el.value = p.from || ''; });
    $$('#f-to').forEach((el) => { if (document.activeElement !== el) el.value = p.to || ''; });
    $$('#f-stat').forEach((el) => { el.value = p.stat || 'Median'; });
    $$('#f-search').forEach((el) => { if (document.activeElement !== el) el.value = p.q || ''; });
  };
  const whole = (el) => el.value && el.validity.valid;
  [['#f-from', 'from'], ['#f-to', 'to']].forEach(([sel, key]) => $$(sel).forEach((el) => {
    el.addEventListener('change', () => { if (!el.value) dash.setParams({ [key]: null }); else if (whole(el)) dash.setParams({ [key]: el.value }); });
    el.addEventListener('blur', syncInputs);
  }));
  const lastDay = () => {
    const s = dash.data('filter_choices');
    return s.status === 'ok' && s.data[0] ? s.data[0].last : null;
  };
  $$('[data-range]').forEach((b) => b.addEventListener('click', () => {
    const r = b.dataset.range, last = lastDay();
    if (r === 'all' || !last) dash.setParams({ from: null, to: null });
    else dash.setParams({ from: FX.addDays(last, -(+r - 1)), to: last });
    syncInputs();
  }));
  $$('#f-reset').forEach((b) => b.addEventListener('click', () => { dash.resetParams(); syncInputs(); }));

  // Bottlenecks statistic
  $$('#f-stat').forEach((el) => el.addEventListener('change', () => dash.setParams({ stat: el.value })));

  // Order search (waits for typing to pause)
  let t;
  $$('#f-search').forEach((el) => el.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => dash.setParams({ q: el.value.trim() || null, sel: null }), 300);
  }));

  // Export any table, chart or headline figures as CSV (full rows, not only those on screen)
  const RAW = { orders: 'O', parcels: 'P', attempts: 'A' };
  const ready = (id) => new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = () => {
      const s = dash.data(id);
      if (s.status === 'ok') res(s);
      else if (s.status !== 'loading' || Date.now() - t0 > 90000) rej(new Error(s.status));
      else setTimeout(tick, 400);
    };
    tick();
  });
  const cell = (v) => {
    if (v == null) return '';
    if (Array.isArray(v)) v = v.join(', ');
    if (typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(v)) v = v.replace('T', ' ');
    v = String(v);
    return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  async function rowsFor(btn) {
    const id = btn.dataset.export;
    if (btn.dataset.filtered && RAW[id]) {
      const [o, p, a] = await Promise.all(['orders', 'parcels', 'attempts'].map(ready));
      const c = FX.ctx(o.data, p.data, a.data);
      const rows = c[RAW[id]], src = { orders: o, parcels: p, attempts: a }[id];
      return { rows, cols: (src.columns || Object.keys(rows[0] || {})).map((f) => [f, f]) };
    }
    const s = await ready(id), rows = Array.isArray(s.data) ? s.data : [];
    const table = [...document.querySelectorAll('table[data-source]')].find((t) => t.dataset.source === id);
    let cols = table ? [...table.querySelectorAll('thead th')].map((th) => [th.dataset.field, th.textContent.trim()]) : null;
    if (!cols) {
      const keys = [];
      rows.forEach((r) => Object.keys(r).forEach((k) => { if (!keys.includes(k)) keys.push(k); }));
      cols = keys.map((k) => [k, k]);
    }
    return { rows, cols };
  }
  $$('.fx-export').forEach((btn) => btn.addEventListener('click', async () => {
    btn.classList.remove('is-saved', 'is-failed');
    btn.classList.add('is-busy'); btn.disabled = true;
    try {
      const downloads = await claude.use('downloads');
      if (!downloads) throw new Error('unavailable');
      const { rows, cols } = await rowsFor(btn);
      const csv = '\uFEFF' + [cols.map((c) => cell(c[1])).join(','), ...rows.map((r) => cols.map((c) => cell(r[c[0]])).join(','))].join('\r\n');
      const day = FX.cairoNow().slice(0, 10);
      await downloads.save({ filename: `fulfilment-${btn.dataset.name}-${day}.csv`, data: new Blob([csv], { type: 'text/csv' }) });
      btn.classList.add('is-saved');
    } catch (e) {
      if (!(e && e.code === 'declined')) btn.classList.add('is-failed');
    } finally {
      btn.classList.remove('is-busy'); btn.disabled = false;
    }
  }));
  claude.use('downloads').then((d) => { if (!d) $$('.fx-export, #raw-export').forEach((el) => { el.hidden = true; }); });

  syncInputs();
  dash.onData(() => syncInputs());
  window.addEventListener('beforeprint', () => $$('.fx-page').forEach((s) => { s.hidden = false; }));
  window.addEventListener('afterprint', () => show((location.hash || '').slice(1)));
})();
