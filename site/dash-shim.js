// Small stand-in for the Claude Dashboard runtime, so the same page code runs on any static host.
// Provides: dash.loader / calc / data / draw / onData / params / setParams / resetParams / setLink / colors,
// and claude.use('downloads') for CSV exports.
(() => {
  const DATASETS = { orders: 'data/orders.json', parcels: 'data/parcels.json', attempts: 'data/attempts.json', returns: 'data/returns.json' };
  const DEFAULTS = { brand: '', from: '', to: '', courier: '', payment: '', stat: 'Median', q: '', sel: '', cc: '', fr: '' };

  const loaders = {}, calcs = {}, draws = {}, onDataFns = [];
  const store = {}; // id -> {status, data, columns, meta}
  let params = { ...DEFAULTS }, version = 0, scheduled = false;
  const calcCache = new Map();

  function load(id) {
    if (store[id]) return;
    store[id] = { status: 'loading', data: [] };
    fetch(DATASETS[id] + '?v=' + Date.now(), { cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error(r.status + ' ' + r.statusText); return r.json(); })
      .then((answer) => {
        const out = loaders[id] ? loaders[id].fn({ answer }) : answer;
        const data = Array.isArray(out) ? out : out.data;
        store[id] = { status: 'ok', data, columns: out.columns || Object.keys(data[0] || {}), meta: out.meta };
      })
      .catch((e) => { store[id] = { status: 'error', data: [], message: String(e) }; console.error(id, e); })
      .finally(() => { version++; schedule(); });
  }

  function data(id) {
    if (DATASETS[id]) { load(id); return store[id]; }
    const c = calcs[id];
    if (!c) return { status: 'missing', data: [] };
    const inputs = c.inputs.map(data);
    const bad = inputs.find((s) => s.status !== 'ok');
    if (bad) return { status: bad.status === 'loading' ? 'loading' : 'error', data: null };
    const key = id + '|' + version + '|' + JSON.stringify(params);
    if (!calcCache.has(key)) {
      try { calcCache.set(key, { status: 'ok', data: c.fn(...inputs.map((s) => s.data)) }); }
      catch (e) { console.error(id, e); calcCache.set(key, { status: 'error', data: null, message: String(e) }); }
    }
    return calcCache.get(key);
  }

  function render() {
    scheduled = false;
    if (calcCache.size > 400) calcCache.clear();
    onDataFns.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
    for (const [name, fn] of Object.entries(draws)) {
      document.querySelectorAll(`[data-draw="${name}"]`).forEach((el) => {
        if (el.closest('[hidden]')) return;
        try { fn(el); } catch (e) { console.error(name, e); }
      });
    }
  }
  // A plain timer, not requestAnimationFrame: rAF can stall (background tabs, embedded views),
  // which left the page showing "—" and ignoring filters.
  function schedule() { if (!scheduled) { scheduled = true; setTimeout(render, 0); } }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(); });

  window.dash = {
    colors: ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)', 'var(--series-6)', 'var(--series-7)', 'var(--series-8)', 'var(--series-9)'],
    loader: (id, o) => { loaders[id] = o; },
    calc: (id, o) => { calcs[id] = o; },
    data,
    draw: (name, fn) => { if (fn) { draws[name] = fn; schedule(); } else schedule(); },
    onData: (fn) => { onDataFns.push(fn); try { fn(); } catch (e) { console.error(e); } },
    params: () => ({ ...params }),
    setParams: (p) => {
      for (const [k, v] of Object.entries(p)) { if (v == null) params[k] = DEFAULTS[k] ?? ''; else params[k] = v; }
      schedule();
    },
    resetParams: () => { params = { ...DEFAULTS }; schedule(); },
    setLink: (id) => { try { history.replaceState(null, '', '#' + id); } catch (e) { /* ignore */ } schedule(); },
    refresh: () => {},
  };

  let rt;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(schedule, 150); });

  // CSV downloads for the Export buttons
  window.claude = {
    use: async (name) => name === 'downloads' ? {
      save: async ({ filename, data }) => {
        const blob = data instanceof Blob ? data : new Blob([data]);
        const url = URL.createObjectURL(blob), a = document.createElement('a');
        a.href = url; a.download = filename; document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        return { status: 'saved' };
      },
    } : null,
  };
})();
