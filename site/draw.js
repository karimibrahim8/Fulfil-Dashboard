// Fulfil dashboard: formatting, cards, tables and charts.

window.FMT = (() => {
  const n0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const n1 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const n2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmt = (v, f) => {
    if (v == null || v === '' || (typeof v === 'number' && !isFinite(v))) return '—';
    switch (f) {
      case 'int': return n0.format(v);
      case 'pct': return n1.format(v * 100) + '%';
      case 'pct0': return n0.format(v * 100) + '%';
      case 'h': return n1.format(v) + ' h';
      case 'dec1': return n1.format(v);
      case 'dec2': return n2.format(v);
      case 'egp': return 'EGP ' + n0.format(v);
      case 'dt': return typeof v === 'string' ? `${+v.slice(8, 10)} ${MON[+v.slice(5, 7) - 1]}, ${v.slice(11, 16)}` : String(v);
      case 'd': return typeof v === 'string' ? `${+v.slice(8, 10)} ${MON[+v.slice(5, 7) - 1]}` : String(v);
      case 'stage': return typeof v === 'string' ? v.replace(/^\d+\s/, '') : String(v);
      default: return String(v);
    }
  };
  return { fmt, MON };
})();

// ---------- cards ----------
dash.draw('kpi', (el) => {
  const s = dash.data(el.dataset.source);
  if (s.status === 'loading') return;
  el.classList.remove('dash-skeleton');
  const row = s.status === 'ok' && s.data && s.data[0];
  el.textContent = row ? FMT.fmt(row[el.dataset.field], el.dataset.fmt) : '—';
});

dash.draw('delta', (el) => {
  const s = dash.data(el.dataset.source);
  const row = s.status === 'ok' && s.data && s.data[0];
  el.classList.remove('is-good', 'is-bad');
  if (!row) { el.textContent = '—'; return; }
  const base = el.dataset.field.replace(/ change$/, ''), good = row[base + ' good'];
  el.textContent = row[el.dataset.field] || '—';
  if (good != null) el.classList.add(good ? 'is-good' : 'is-bad');
});

dash.draw('status', (el) => {
  const s = dash.data(el.dataset.source);
  const row = s.status === 'ok' && s.data && s.data[0];
  el.classList.remove('dash-skeleton', 'is-good', 'is-bad');
  if (!row) { el.textContent = '—'; return; }
  el.textContent = row[el.dataset.field];
  el.classList.add(row['Checks Needing Attention'] ? 'is-bad' : 'is-good');
});

// ---------- tables ----------
dash.draw('rows', (tbody) => {
  const table = tbody.closest('table');
  if (!table) return;
  const s = dash.data(table.dataset.source);
  const cols = [...table.querySelectorAll('thead th')].map((th) => ({ f: th.dataset.field, fmt: th.dataset.fmt || '', cls: th.className }));
  const keys = (table.dataset.rowKey || '').split(',').filter(Boolean);
  const limit = +(table.dataset.limit || 1e9);
  tbody.replaceChildren();
  const msg = (t) => { const tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = cols.length; td.className = 'fx-empty'; td.textContent = t; tr.append(td); tbody.append(tr); };
  if (s.status === 'loading') { msg('Loading…'); return; }
  if (s.status !== 'ok') { msg('Failed to load'); return; }
  const rows = s.data || [];
  if (!rows.length) { msg(table.dataset.empty || 'Nothing to show for these filters'); return; }
  const selKey = dash.params().sel;
  for (const r of rows.slice(0, limit)) {
    const tr = document.createElement('tr');
    tr.dataset.key = keys.map((k) => encodeURIComponent(r[k] ?? '')).join(',');
    if (table.dataset.pick && r.OrderKey === selKey) tr.className = 'is-picked';
    for (const c of cols) {
      const td = document.createElement('td');
      td.className = c.cls;
      const v = r[c.f];
      if (c.fmt === 'bar' && typeof v === 'number') {
        const w = document.createElement('span'); w.className = 'fx-cellbar';
        const b = document.createElement('i'); b.style.width = `${Math.max(0, Math.min(1, v)) * 100}%`;
        const t = document.createElement('b'); t.textContent = FMT.fmt(v, 'pct');
        w.append(b, t); td.append(w);
      } else td.textContent = FMT.fmt(v, c.fmt);
      tr.append(td);
    }
    if (table.dataset.pick) {
      tr.tabIndex = 0; tr.classList.add('is-pickable');
      const pick = () => dash.setParams({ sel: r.OrderKey });
      tr.addEventListener('click', pick);
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') pick(); });
    }
    tbody.append(tr);
  }
});

dash.draw('rowcount', (el) => {
  const s = dash.data(el.dataset.source);
  if (s.status !== 'ok') { el.textContent = '—'; return; }
  const n = (s.data || []).length, lim = +(el.dataset.limit || 1e9);
  el.textContent = n > lim ? `Showing ${FMT.fmt(lim, 'int')} of ${FMT.fmt(n, 'int')}` : `${FMT.fmt(n, 'int')} ${n === 1 ? 'row' : 'rows'}`;
});

// ---------- filter choices ----------
dash.draw('choices', (sel) => {
  const s = dash.data('filter_choices'), row = s.status === 'ok' && s.data && s.data[0];
  const key = sel.dataset.param, list = row ? row[sel.dataset.list] || [] : [];
  sel.replaceChildren(new Option(sel.dataset.all, ''), ...list.map((v) => new Option(v, v)));
  sel.value = dash.params()[key] || '';
  sel.onchange = () => dash.setParams({ [key]: sel.value || null });
});
dash.draw('daterange', (el) => {
  const s = dash.data('filter_choices'), row = s.status === 'ok' && s.data && s.data[0];
  el.textContent = row && row.first ? `Data covers ${FMT.fmt(row.first, 'd')} – ${FMT.fmt(row.last, 'd')} ${row.last.slice(0, 4)}` : '—';
});

// ---------- charts ----------
window.CH = (() => {
  const css = (n) => `var(${n})`;
  const color = (i) => dash.colors[i % dash.colors.length];
  function frame(el, h) {
    el.replaceChildren();
    const W = Math.max(280, el.clientWidth || 600);
    const svg = d3.select(el).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${h}`).attr('role', 'img').attr('aria-label', el.dataset.label || 'Chart');
    const tip = d3.select(el).append('div').attr('class', 'fx-tip').attr('hidden', '');
    return { W, svg, tip };
  }
  function showTip(el, tip, ev, html) {
    const box = el.getBoundingClientRect();
    tip.attr('hidden', null).selectAll('*').remove();
    html.forEach(([k, v], i) => { const line = tip.append('div'); if (i === 0) line.attr('class', 'fx-tip-h').text(k); else { line.append('span').text(k); line.append('b').text(v); } });
    const x = ev.clientX - box.left, y = ev.clientY - box.top, tw = tip.node().offsetWidth;
    tip.style('left', `${Math.min(Math.max(0, x + 12), box.width - tw - 4)}px`).style('top', `${Math.max(0, y - 10)}px`);
  }
  const hideTip = (tip) => tip.attr('hidden', '');
  function textWidth(svg, strings, cls) {
    const t = svg.append('text').attr('class', cls || 'fx-tick');
    let w = 0;
    for (const s of strings) { t.text(s); w = Math.max(w, t.node().getComputedTextLength()); }
    t.remove();
    return w;
  }
  function legend(el, names, colorOf, fmtName) {
    const lg = d3.select(el).insert('div', ':first-child').attr('class', 'fx-legend');
    names.forEach((n) => { const it = lg.append('span'); it.append('i').style('background', colorOf(n)); it.append('span').text(fmtName ? fmtName(n) : n); });
  }
  const pivot = (rows, x, s, y) => {
    const xs = [...new Set(rows.map((r) => r[x]))], m = new Map();
    for (const r of rows) { if (!m.has(r[x])) m.set(r[x], {}); m.get(r[x])[r[s]] = (m.get(r[x])[r[s]] || 0) + (r[y] || 0); }
    return { xs, m };
  };

  // Vertical columns: stacked (series), 100% stacked, or one series.
  function columns(el, rows, o) {
    const h = +(el.dataset.h || 260), { W, svg, tip } = frame(el, h);
    const series = o.series ? (o.order || [...new Set(rows.map((r) => r[o.series]))]) : [o.y];
    const present = series.filter((s) => !o.series || rows.some((r) => r[o.series] === s));
    const { xs, m } = o.series ? pivot(rows, o.x, o.series, o.y) : { xs: rows.map((r) => r[o.x]), m: new Map(rows.map((r) => [r[o.x], { [o.y]: r[o.y] }])) };
    const tot = (x) => present.reduce((a, s) => a + (m.get(x)[s] || 0), 0);
    const maxY = o.percent ? 1 : d3.max(xs, tot) || 1;
    const y = d3.scaleLinear().domain([0, maxY]).nice().range([h - 26, 10]);
    const tf = o.percent ? (v) => FMT.fmt(v, 'pct0') : (v) => FMT.fmt(v, o.fmt === 'h' ? 'dec1' : 'int');
    const left = textWidth(svg, y.ticks(4).map(tf)) + 10;
    const x = d3.scaleBand().domain(xs).range([left, W - 6]).padding(0.18);
    svg.append('g').attr('class', 'fx-grid').selectAll('line').data(y.ticks(4)).join('line').attr('x1', left).attr('x2', W - 6).attr('y1', y).attr('y2', y);
    svg.append('g').attr('class', 'fx-axis').attr('transform', `translate(${left - 6},0)`).selectAll('text').data(y.ticks(4)).join('text').attr('class', 'fx-tick').attr('text-anchor', 'end').attr('dy', '0.32em').attr('y', y).text(tf);
    const lab = o.xfmt ? (v) => FMT.fmt(v, o.xfmt) : String;
    const lw = textWidth(svg, xs.map(lab)) + 8, every = Math.max(1, Math.ceil((xs.length * lw) / (W - left)));
    svg.append('g').selectAll('text').data(xs.filter((_, i) => i % every === 0)).join('text').attr('class', 'fx-tick').attr('text-anchor', 'middle').attr('x', (d) => x(d) + x.bandwidth() / 2).attr('y', h - 8).text(lab);
    const colorOf = (s) => (o.colors && o.colors[s]) || color(series.indexOf(s));
    const g = svg.append('g');
    for (const xv of xs) {
      let acc = 0; const t = tot(xv) || 1;
      for (const s of present) {
        const v = m.get(xv)[s] || 0; if (!v) continue;
        const v0 = o.percent ? acc / t : acc, v1 = o.percent ? (acc + v) / t : acc + v; acc += v;
        g.append('rect').attr('x', x(xv)).attr('width', x.bandwidth()).attr('y', y(v1)).attr('height', Math.max(0, y(v0) - y(v1))).style('fill', colorOf(s))
          .on('pointermove', (ev) => showTip(el, tip, ev, [[lab(xv)], [o.series ? (o.sfmt ? FMT.fmt(s, o.sfmt) : s) : o.y, o.percent ? `${FMT.fmt(v / t, 'pct')} (${FMT.fmt(v, 'int')})` : FMT.fmt(v, o.fmt || 'int')], ...(o.series && !o.percent ? [['Total', FMT.fmt(tot(xv), 'int')]] : [])]))
          .on('pointerleave', () => hideTip(tip));
      }
    }
    if (o.series) legend(el, present, colorOf, o.sfmt ? (s) => FMT.fmt(s, o.sfmt) : null);
  }

  // Horizontal bars: one series, or stacked 100% by series.
  function hbars(el, rows, o) {
    const series = o.series ? (o.order || [...new Set(rows.map((r) => r[o.series]))]) : [o.y];
    const present = series.filter((s) => !o.series || rows.some((r) => r[o.series] === s));
    const { xs, m } = o.series ? pivot(rows, o.x, o.series, o.y) : { xs: rows.map((r) => r[o.x]), m: new Map(rows.map((r) => [r[o.x], { [o.y]: r[o.y] }])) };
    const bh = 22, h = xs.length * (bh + 8) + 24;
    const { W, svg, tip } = frame(el, h);
    const labW = Math.min(W * 0.45, textWidth(svg, xs.map(String)) + 12);
    const tot = (xv) => present.reduce((a, s) => a + (m.get(xv)[s] || 0), 0);
    const maxV = o.percent ? 1 : d3.max(xs, tot) || 1;
    const valW = o.percent ? 0 : textWidth(svg, [FMT.fmt(maxV, o.fmt || 'int')]) + 10;
    const x = d3.scaleLinear().domain([0, o.max || maxV]).range([labW, W - valW - 6]);
    const yb = d3.scaleBand().domain(xs).range([4, h - 20]).padding(0.25);
    const colorOf = (s) => (o.colors && o.colors[s]) || color(series.indexOf(s));
    svg.append('g').selectAll('text').data(xs).join('text').attr('class', 'fx-tick fx-cat').attr('x', labW - 8).attr('y', (d) => yb(d) + yb.bandwidth() / 2).attr('dy', '0.32em').attr('text-anchor', 'end')
      .text((d) => { const s = String(d); return s.length > 48 ? s.slice(0, 46) + '…' : s; });
    for (const xv of xs) {
      let acc = 0; const t = tot(xv) || 1;
      for (const s of present) {
        const v = m.get(xv)[s] || 0; if (!v) continue;
        const v0 = o.percent ? acc / t : acc, v1 = o.percent ? (acc + v) / t : acc + v; acc += v;
        svg.append('rect').attr('x', x(v0)).attr('width', Math.max(0, x(v1) - x(v0))).attr('y', yb(xv)).attr('height', yb.bandwidth()).style('fill', colorOf(s))
          .on('pointermove', (ev) => showTip(el, tip, ev, [[String(xv)], [o.series ? s : o.y, o.percent ? `${FMT.fmt(v / t, 'pct')} (${FMT.fmt(v, 'int')})` : FMT.fmt(v, o.fmt || 'int')]]))
          .on('pointerleave', () => hideTip(tip));
        if (o.percent && v / t >= 0.08) svg.append('text').attr('class', 'fx-inbar').attr('x', (x(v0) + x(v1)) / 2).attr('y', yb(xv) + yb.bandwidth() / 2).attr('dy', '0.32em').attr('text-anchor', 'middle').text(FMT.fmt(v / t, 'pct0'));
      }
      if (!o.percent) svg.append('text').attr('class', 'fx-tick fx-val').attr('x', x(tot(xv)) + 6).attr('y', yb(xv) + yb.bandwidth() / 2).attr('dy', '0.32em').text(FMT.fmt(tot(xv), o.fmt || 'int'));
    }
    if (o.series) legend(el, present, colorOf);
  }

  // Grouped horizontal bars (one bar per series inside each category).
  function hgroup(el, rows, o) {
    const cats = [...new Set(rows.map((r) => r[o.x]))], series = o.order || [...new Set(rows.map((r) => r[o.series]))];
    const per = series.length, bh = 14, h = cats.length * (per * bh + 12) + 24;
    const { W, svg, tip } = frame(el, h);
    const labW = Math.min(W * 0.4, textWidth(svg, cats.map(String)) + 12), valW = textWidth(svg, ['100.0%']) + 10;
    const x = d3.scaleLinear().domain([0, o.max || d3.max(rows, (r) => r[o.y]) || 1]).range([labW, W - valW]);
    const yb = d3.scaleBand().domain(cats).range([4, h - 20]).paddingInner(0.2);
    const ys = d3.scaleBand().domain(series).range([0, yb.bandwidth()]).padding(0.1);
    const colorOf = (s) => (o.colors && o.colors[s]) || color(series.indexOf(s));
    svg.append('g').selectAll('text').data(cats).join('text').attr('class', 'fx-tick fx-cat').attr('x', labW - 8).attr('y', (d) => yb(d) + yb.bandwidth() / 2).attr('dy', '0.32em').attr('text-anchor', 'end').text(String);
    for (const r of rows) {
      const y0 = yb(r[o.x]) + ys(r[o.series]);
      svg.append('rect').attr('x', labW).attr('width', Math.max(0, x(r[o.y]) - labW)).attr('y', y0).attr('height', ys.bandwidth()).style('fill', colorOf(r[o.series]))
        .on('pointermove', (ev) => showTip(el, tip, ev, [[r[o.x]], [r[o.series], FMT.fmt(r[o.y], o.fmt)], ...(o.extra ? [[o.extra, FMT.fmt(r[o.extra], 'int')]] : [])]))
        .on('pointerleave', () => hideTip(tip));
      svg.append('text').attr('class', 'fx-tick fx-val').attr('x', x(r[o.y]) + 5).attr('y', y0 + ys.bandwidth() / 2).attr('dy', '0.32em').text(FMT.fmt(r[o.y], o.fmt));
    }
    legend(el, series, colorOf);
  }

  // Lines over dates, one per measure.
  function lines(el, rows, o) {
    const h = +(el.dataset.h || 260), { W, svg, tip } = frame(el, h);
    const ys = o.ys, xs = rows.map((r) => r[o.x]);
    const all = rows.flatMap((r) => ys.map((k) => r[k])).filter((v) => typeof v === 'number');
    const y = d3.scaleLinear().domain([o.percent ? Math.min(0.5, d3.min(all) || 0) : 0, d3.max(all) || 1]).nice().range([h - 26, 10]);
    const tf = (v) => FMT.fmt(v, o.percent ? 'pct0' : 'dec1');
    const left = textWidth(svg, y.ticks(4).map(tf)) + 10;
    const x = d3.scalePoint().domain(xs).range([left + 6, W - 10]);
    svg.append('g').attr('class', 'fx-grid').selectAll('line').data(y.ticks(4)).join('line').attr('x1', left).attr('x2', W - 6).attr('y1', y).attr('y2', y);
    svg.append('g').selectAll('text').data(y.ticks(4)).join('text').attr('class', 'fx-tick').attr('text-anchor', 'end').attr('dy', '0.32em').attr('x', left - 6).attr('y', y).text(tf);
    const lw = textWidth(svg, xs.map((d) => FMT.fmt(d, 'd'))) + 10, every = Math.max(1, Math.ceil((xs.length * lw) / (W - left)));
    svg.append('g').selectAll('text').data(xs.filter((_, i) => i % every === 0)).join('text').attr('class', 'fx-tick').attr('text-anchor', 'middle').attr('x', x).attr('y', h - 8).text((d) => FMT.fmt(d, 'd'));
    ys.forEach((k, i) => {
      const pts = rows.filter((r) => typeof r[k] === 'number');
      svg.append('path').datum(pts).attr('fill', 'none').style('stroke', color(i)).attr('stroke-width', 2).attr('d', d3.line().x((r) => x(r[o.x])).y((r) => y(r[k])));
      const last = pts[pts.length - 1];
      if (last) svg.append('circle').attr('cx', x(last[o.x])).attr('cy', y(last[k])).attr('r', 3.5).style('fill', color(i));
    });
    const guide = svg.append('line').attr('class', 'fx-guide').attr('y1', 10).attr('y2', h - 26).style('display', 'none');
    svg.append('rect').attr('x', left).attr('width', W - left).attr('y', 0).attr('height', h - 20).attr('fill', 'transparent')
      .on('pointermove', (ev) => {
        const [mx] = d3.pointer(ev), i = Math.max(0, Math.min(xs.length - 1, Math.round((mx - left - 6) / ((W - left - 16) / Math.max(1, xs.length - 1)))));
        const r = rows[i]; guide.style('display', null).attr('x1', x(r[o.x])).attr('x2', x(r[o.x]));
        showTip(el, tip, ev, [[FMT.fmt(r[o.x], 'd')], ...ys.map((k) => [k, FMT.fmt(r[k], o.percent ? 'pct' : o.fmt)])]);
      })
      .on('pointerleave', () => { hideTip(tip); guide.style('display', 'none'); });
    legend(el, ys, (k) => color(ys.indexOf(k)));
  }

  function donut(el, rows, o) {
    const h = +(el.dataset.h || 260), { W, svg, tip } = frame(el, h);
    const total = d3.sum(rows, (r) => r[o.y]) || 1, R = Math.min(h / 2 - 8, W / 4);
    const colorOf = (k) => (o.colors && o.colors[k]) || color(rows.findIndex((r) => r[o.x] === k));
    const g = svg.append('g').attr('transform', `translate(${R + 8},${h / 2})`);
    const arcs = d3.pie().sort(null).value((r) => r[o.y])(rows);
    g.selectAll('path').data(arcs).join('path').attr('d', d3.arc().innerRadius(R * 0.58).outerRadius(R)).style('fill', (a) => colorOf(a.data[o.x])).style('stroke', css('--color-bg')).attr('stroke-width', 2)
      .on('pointermove', (ev, a) => showTip(el, tip, ev, [[a.data[o.x]], ['Parcels', FMT.fmt(a.data[o.y], 'int')], ['Share', FMT.fmt(a.data[o.y] / total, 'pct')]]))
      .on('pointerleave', () => hideTip(tip));
    g.append('text').attr('class', 'fx-donut-n').attr('text-anchor', 'middle').attr('dy', '0.1em').text(FMT.fmt(total, 'int'));
    g.append('text').attr('class', 'fx-tick').attr('text-anchor', 'middle').attr('dy', '1.6em').text(o.unit || 'total');
    const lx = 2 * R + 32;
    rows.forEach((r, i) => {
      const yy = h / 2 - (rows.length * 40) / 2 + i * 40 + 14;
      svg.append('rect').attr('x', lx).attr('y', yy - 9).attr('width', 10).attr('height', 10).attr('rx', 2).style('fill', colorOf(r[o.x]));
      svg.append('text').attr('class', 'fx-leg-name').attr('x', lx + 16).attr('y', yy).text(r[o.x]);
      svg.append('text').attr('class', 'fx-tick').attr('x', lx + 16).attr('y', yy + 16).text(`${FMT.fmt(r[o.y] / total, 'pct')} · ${FMT.fmt(r[o.y], 'int')}`);
    });
  }

  function waterfall(el, rows, o) {
    const h = +(el.dataset.h || 280), { W, svg, tip } = frame(el, h);
    const cats = [...rows.map((r) => r[o.x]), 'Total'];
    let acc = 0;
    const segs = rows.map((r) => { const v = r[o.y] || 0, s = { k: r[o.x], v0: acc, v1: acc + v, v }; acc += v; return s; });
    segs.push({ k: 'Total', v0: 0, v1: acc, v: acc, total: true });
    const y = d3.scaleLinear().domain([0, acc || 1]).nice().range([h - 30, 18]);
    const left = textWidth(svg, y.ticks(4).map((v) => FMT.fmt(v, 'dec1'))) + 10;
    const x = d3.scaleBand().domain(cats).range([left, W - 6]).padding(0.25);
    svg.append('g').attr('class', 'fx-grid').selectAll('line').data(y.ticks(4)).join('line').attr('x1', left).attr('x2', W - 6).attr('y1', y).attr('y2', y);
    svg.append('g').selectAll('text').data(y.ticks(4)).join('text').attr('class', 'fx-tick').attr('text-anchor', 'end').attr('dy', '0.32em').attr('x', left - 6).attr('y', y).text((v) => FMT.fmt(v, 'dec1'));
    const short = (s) => FMT.fmt(s, 'stage');
    const tooNarrow = textWidth(svg, cats.map(short)) > x.bandwidth() + 8;
    svg.append('g').selectAll('text').data(cats).join('text').attr('class', 'fx-tick').attr('text-anchor', 'middle').attr('x', (d) => x(d) + x.bandwidth() / 2).attr('y', h - 10)
      .text((d, i) => (tooNarrow ? (d === 'Total' ? 'Total' : String(i + 1)) : short(d)));
    segs.forEach((s, i) => {
      svg.append('rect').attr('x', x(s.k)).attr('width', x.bandwidth()).attr('y', y(s.v1)).attr('height', Math.max(1, y(s.v0) - y(s.v1)))
        .style('fill', s.total ? css('--cds-chart-muted') : color(0))
        .on('pointermove', (ev) => showTip(el, tip, ev, [[s.total ? 'Total journey' : short(s.k)], [`${o.stat} hours`, FMT.fmt(s.v, 'h')], ['Share of total', FMT.fmt(acc ? s.v / acc : null, 'pct')]]))
        .on('pointerleave', () => hideTip(tip));
      svg.append('text').attr('class', 'fx-tick fx-val').attr('text-anchor', 'middle').attr('x', x(s.k) + x.bandwidth() / 2).attr('y', y(s.v1) - 5).text(FMT.fmt(s.v, 'h'));
      if (!s.total && i < segs.length - 2) svg.append('line').attr('class', 'fx-guide').attr('x1', x(s.k) + x.bandwidth()).attr('x2', x(segs[i + 1].k)).attr('y1', y(s.v1)).attr('y2', y(s.v1));
    });
  }

  return { columns, hbars, hgroup, lines, donut, waterfall };
})();

// One drawing for every chart; the chart's settings sit on its element.
const STAGE_ORDER = ['0 Cancelled', '1 Waiting at brand', '2 Waiting for courier pickup', '3 With courier', '3 With Mylerz (no tracking)', '3 Shipped - other courier', '4 Delivered', '5 Returned / failed'];
const CHARTS = {
  ov_daily_stage: (el, d) => CH.columns(el, d, { x: 'OrderDate', series: 'Stage', y: 'Orders', order: STAGE_ORDER, xfmt: 'd', sfmt: 'stage',
    colors: { '0 Cancelled': 'var(--cds-chart-muted)', '5 Returned / failed': 'var(--cds-chart-status-critical)' } }),
  ov_hour: (el, d) => CH.columns(el, d.filter((r) => r['Median Order To Ready (h)'] != null), { x: 'OrderHour', y: 'Median Order To Ready (h)', fmt: 'h', xfmt: '' }),
  ov_readyday: (el, d) => CH.columns(el, d, { x: 'OrderDate', series: 'ReadyDay', y: 'Orders', percent: true, order: ['Same day', 'Next working day', '2+ working days'], xfmt: 'd' }),
  ov_times: (el, d) => CH.lines(el, d, { x: 'OrderDate', ys: ['Median Order To Ready (h)', 'Median Order To Delivered (h)'], fmt: 'h' }),
  pf_exceptions: (el, d) => CH.hbars(el, d.slice(0, 12), { x: 'LastException', y: 'Orders' }),
  pf_trend: (el, d) => CH.lines(el, d, { x: 'OrderDate', ys: ['Delivery Success %', 'On Time %'], percent: true }),
  pf_dday_share: (el, d) => CH.hbars(el, d, { x: 'Group', series: 'DeliveryDay', y: 'Orders', percent: true, order: ['Day 1', 'Day 2', 'More than 2 days'] }),
  dd_attempt_mix: (el, d) => CH.columns(el, d, { x: 'AttemptNo', series: 'ResultGroup', y: 'Attempts', percent: true,
    order: ['Delivered', 'Postponed / rescheduled', 'Refused', 'Wants to open', 'Customer not reachable', 'Wrong address / phone', 'Still out for delivery', 'Other', 'Unknown'] }),
  dd_calls: (el, d) => CH.hbars(el, d, { x: 'CallsBucket', series: 'ParcelOutcome', y: 'Parcels', percent: true, order: ['Delivered', 'Returned / failed'],
    colors: { 'Returned / failed': 'var(--cds-chart-status-critical)' } }),
  dd_confirm: (el, d) => CH.hbars(el, d, { x: 'ConfirmStatus', y: 'Parcel Success %', fmt: 'pct', max: 1 }),
  bn_stages: (el, d) => CH.waterfall(el, d, { x: 'Stage', y: 'Hours', stat: (d[0] && d[0].Stat) || 'Median' }),
  cz_bars: (el, d) => CH.hgroup(el, d, { x: 'Governorate', series: 'Courier', y: 'Delivery Success %', fmt: 'pct', max: 1, order: ['Bosta', 'Mylerz'], extra: 'Closed' }),
  nc_callcheck: (el, d) => CH.donut(el, d, { x: 'CallCheck', y: 'Parcels', unit: 'failed parcels',
    colors: { 'No call - suspicious': 'var(--cds-chart-status-critical)', Called: 'var(--cds-chart-muted)' } }),
  nc_reasons: (el, d) => CH.hbars(el, d, { x: 'FailReasonGroup', series: 'CallCheck', y: 'Parcels', percent: true,
    order: ['Called', 'No call - customer verified', 'No call - refused at door', 'No call - suspicious'],
    colors: { 'No call - suspicious': 'var(--cds-chart-status-critical)', Called: 'var(--cds-chart-muted)' } }),
};
dash.draw('chart', (el) => {
  const id = el.dataset.source, s = dash.data(id);
  if (s.status === 'loading') { if (!el.querySelector('svg')) el.textContent = ''; return; }
  if (s.status !== 'ok') { el.replaceChildren(); const p = document.createElement('p'); p.className = 'fx-empty'; p.textContent = 'Failed to load'; el.append(p); return; }
  const d = s.data || [];
  if (!d.length || !CHARTS[id]) { el.replaceChildren(); const p = document.createElement('p'); p.className = 'fx-empty'; p.textContent = 'Nothing to show for these filters'; el.append(p); return; }
  CHARTS[id](el, d);
});
