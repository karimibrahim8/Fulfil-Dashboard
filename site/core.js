// Fulfil dashboard: data loading, filters and the measures from the Power BI model.

function decodeColumns({ answer }) {
  const cols = answer.cols, n = answer.n, names = Object.keys(cols);
  const plain = names.map((c) => (Array.isArray(cols[c]) ? cols[c] : cols[c].i.map((i) => (i == null ? null : cols[c].d[i]))));
  const rows = new Array(n);
  for (let r = 0; r < n; r++) {
    const o = { RefreshedAt: answer.refreshedAt };
    for (let k = 0; k < names.length; k++) o[names[k]] = plain[k][r];
    rows[r] = o;
  }
  return { data: rows, columns: ['RefreshedAt', ...names], meta: answer.meta };
}
dash.loader('orders', { description: 'Unpacks the column-by-column file into one row per Shopify order.', fn: decodeColumns });
dash.loader('parcels', { description: 'Unpacks the column-by-column file into one row per Bosta or Mylerz parcel.', fn: decodeColumns });
dash.loader('attempts', { description: 'Unpacks the column-by-column file into one row per delivery attempt.', fn: decodeColumns });
dash.loader('returns', { description: 'Unpacks the column-by-column file into one row per returned item (E-stebdal, brand OR).', fn: decodeColumns });

window.FX = (() => {
  const isNum = (v) => typeof v === 'number' && !Number.isNaN(v);
  const nums = (rows, f) => rows.map((r) => r[f]).filter(isNum).sort((a, b) => a - b);
  const pctInc = (s, p) => {
    if (!s.length) return null;
    const k = (s.length - 1) * p, lo = Math.floor(k), hi = Math.ceil(k);
    return s[lo] + (s[hi] - s[lo]) * (k - lo);
  };
  const median = (rows, f) => pctInc(nums(rows, f), 0.5);
  const p90 = (rows, f) => pctInc(nums(rows, f), 0.9);
  const avg = (rows, f) => { const s = nums(rows, f); return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null; };
  const div = (a, b) => (b ? a / b : null);
  const count = (rows, pred) => { let n = 0; for (const r of rows) if (pred(r)) n++; return n; };
  const sum = (rows, f) => rows.reduce((a, r) => a + (isNum(r[f]) ? r[f] : 0), 0);
  const day = (s) => (s ? s.slice(0, 10) : null);
  const ms = (s) => (s ? Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), +s.slice(11, 13) || 0, +s.slice(14, 16) || 0) : null);
  const groupBy = (rows, key) => {
    const m = new Map();
    for (const r of rows) { const k = typeof key === 'function' ? key(r) : r[key]; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
    return m;
  };
  const cairoNow = () => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  };
  const addDays = (d, n) => new Date(ms(d) + n * 864e5).toISOString().slice(0, 10);
  const shiftMonth = (d, n) => {
    const y = +d.slice(0, 4), m = +d.slice(5, 7) - 1 + n, dd = +d.slice(8, 10);
    const t = new Date(Date.UTC(y, m, 1)), last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
    return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), Math.min(dd, last))).toISOString().slice(0, 10);
  };

  // ---------- filters ----------
  const params = () => {
    const p = dash.params();
    return { brand: p.brand || '', from: p.from || '', to: p.to || '', courier: p.courier || '', payment: p.payment || '', stat: p.stat || 'Median', q: p.q || '', sel: p.sel || '', cc: p.cc || '', fr: p.fr || '' };
  };
  const orderFilter = (p, from, to) => (o) =>
    (!p.brand || o.Brand === p.brand) && (!p.courier || o.Courier === p.courier) && (!p.payment || o.Payment === p.payment) &&
    (!from || day(o.Created) >= from) && (!to || day(o.Created) <= to);
  const memo = new WeakMap();
  // Orders filter the parcels and attempts that belong to them, as the Power BI relationship did.
  function ctx(orders, parcels, attempts) {
    const p = params(), key = JSON.stringify([p.brand, p.from, p.to, p.courier, p.payment, parcels ? parcels.length : 0, attempts ? attempts.length : 0]);
    let m = memo.get(orders);
    if (m && m.key === key) return m.val;
    const O = orders.filter(orderFilter(p, p.from, p.to));
    const active = p.brand || p.from || p.to || p.courier || p.payment;
    const keys = new Set(O.map((o) => o.OrderKey));
    const P = parcels ? (active ? parcels.filter((r) => keys.has(r.OrderKey)) : parcels) : [];
    const A = attempts ? (active ? attempts.filter((r) => keys.has(r.OrderKey)) : attempts) : [];
    const val = { O, P, A, p };
    memo.set(orders, { key, val });
    return val;
  }
  function lastMonth(orders) {
    const p = params();
    let from = p.from, to = p.to;
    if (!from || !to) {
      const ds = orders.map((o) => day(o.Created)).filter(Boolean).sort();
      from = from || ds[0]; to = to || ds[ds.length - 1];
    }
    if (!from || !to) return [];
    return orders.filter(orderFilter(p, shiftMonth(from, -1), shiftMonth(to, -1)));
  }

  // ---------- order measures ----------
  const notCancelled = (o) => o.Status !== 'Cancelled';
  const M = {
    placed: (O) => O.length,
    cancelled: (O) => count(O, (o) => o.Status === 'Cancelled'),
    toShip: (O) => O.length - M.cancelled(O),
    fulfilledPct: (O) => div(count(O, (o) => o.Status === 'Fulfilled'), M.toShip(O)),
    waitingBrand: (O) => count(O, (o) => o.Stage === '1 Waiting at brand'),
    waitingBrand24: (O) => count(O, (o) => o.Stage === '1 Waiting at brand' && o.H_WaitingNow > 24),
    waitingPickup: (O) => count(O, (o) => o.Stage === '2 Waiting for courier pickup'),
    withCourier: (O) => count(O, (o) => o.Stage === '3 With courier'),
    withCourier10: (O) => count(O, (o) => o.DaysWithCourier >= 10),
    avgDaysWithCourier: (O) => avg(O, 'DaysWithCourier'),
    medReady: (O) => median(O.filter(notCancelled), 'H_OrderToReady'),
    readyShare: (O, label) => div(count(O, (o) => o.ReadyDay === label && notCancelled(o)), M.toShip(O)),
    bosta: (O) => O.filter((o) => o.Courier === 'Bosta'),
    medLabelPickup: (O) => median(M.bosta(O), 'H_ReadyToPickup'),
    medPickupDelivered: (O) => median(M.bosta(O), 'H_PickupToDelivered'),
    medOrderDelivered: (O) => median(M.bosta(O), 'H_OrderToDelivered'),
    delivered: (O) => count(O, (o) => o.BostaResult === 'Delivered' && notCancelled(o)),
    returned: (O) => count(O, (o) => o.BostaResult === 'Returned / failed' && notCancelled(o)),
    closed: (O) => M.delivered(O) + M.returned(O),
    successPct: (O) => div(M.delivered(O), M.closed(O)),
    firstAttemptPct: (O) => div(count(O, (o) => o.BostaResult === 'Delivered' && o.Attempts != null && o.Attempts <= 1), M.delivered(O)),
    onTimePct: (O) => {
      const d = O.filter((o) => o.BostaResult === 'Delivered' && o.Courier === 'Bosta');
      return div(count(d, (o) => o.MissedPromise === 0), d.length);
    },
    nextDayPct: (O) => div(count(O, (o) => o.DeliveryDay === 'Day 1'), count(O, (o) => o.DeliveryDay != null)),
    courierScore: (O) => {
      const s = M.successPct(O), n = M.nextDayPct(O), f = M.firstAttemptPct(O);
      return s == null && n == null && f == null ? null : 0.5 * (s || 0) + 0.25 * (n || 0) + 0.25 * (f || 0);
    },
  };

  // ---------- parcel and attempt measures ----------
  const failed = (r) => r.ParcelOutcome === 'Returned / failed';
  const deliveredP = (r) => r.ParcelOutcome === 'Delivered';
  const PM = {
    delivered: (P) => count(P, deliveredP),
    failed: (P) => count(P, failed),
    successPct: (P) => div(PM.delivered(P), PM.delivered(P) + PM.failed(P)),
    avgAttemptsDelivered: (P) => avg(P.filter(deliveredP), 'Attempts'),
    avgAttemptsFailed: (P) => avg(P.filter(failed), 'Attempts'),
    avgCallsFailed: (P) => avg(P.filter(failed), 'Calls'),
    failedNoCallPct: (P) => div(count(P, (r) => failed(r) && r.Calls === 0), count(P, (r) => failed(r) && r.Calls != null)),
    rescheduledPct: (P) => div(count(P, (r) => r.Reschedules > 0 && (failed(r) || deliveredP(r))), PM.delivered(P) + PM.failed(P)),
    failedBosta: (P) => count(P, (r) => failed(r) && r.Carrier === 'Bosta'),
    suspicious: (P) => count(P, (r) => r.CallCheck === 'No call - suspicious'),
    suspiciousPct: (P) => div(PM.suspicious(P), PM.failedBosta(P)),
    codLost: (P) => sum(P.filter((r) => r.CallCheck === 'No call - suspicious'), 'COD'),
    deliveredNoCallPct: (P) => {
      const d = P.filter((r) => deliveredP(r) && r.Carrier === 'Bosta' && r.Calls != null);
      return div(count(d, (r) => r.Calls === 0), d.length);
    },
    successWhen: (P, called) => {
      const c = P.filter((r) => r.Carrier === 'Bosta' && (failed(r) || deliveredP(r)) && r.Calls != null && (called ? r.Calls > 0 : r.Calls === 0));
      return div(count(c, deliveredP), c.length);
    },
  };
  const AM = {
    bostaFailures: (A) => count(A, (a) => a.ResultGroup !== 'Delivered' && a.Carrier === 'Bosta'),
    fakePct: (A) => div(count(A, (a) => a.FakeAttempt === 1), AM.bostaFailures(A)),
    verifiedPct: (A) => div(count(A, (a) => a.Verified === 1), AM.bostaFailures(A)),
  };

  // ---------- stage times (Bottlenecks) ----------
  const STAGES = [
    { no: 1, name: '1 Waiting at brand', col: 'H_OrderToReady' },
    { no: 2, name: '2 Label → pickup', col: 'H_ReadyToPickup' },
    { no: 3, name: '3 Pickup → hub', col: 'H_PickupToHub' },
    { no: 4, name: '4 Hub → out for delivery', col: 'H_HubToOut' },
    { no: 5, name: '5 Out → delivered', col: 'H_OutToDelivered' },
  ];
  const stageHours = (O, col, stat) => {
    const d = O.filter((o) => o.BostaResult === 'Delivered' && notCancelled(o));
    return stat === 'P90' ? p90(d, col) : stat === 'Average' ? avg(d, col) : median(d, col);
  };

  // ---------- data health ----------
  const hoursBetween = (a, b) => (a && b ? Math.floor((ms(b) - ms(a)) / 36e5) : null);
  const daysBetween = (a, b) => (a && b ? Math.round((ms(day(b)) - ms(day(a))) / 864e5) : null);
  const maxOf = (rows, f) => rows.reduce((m, r) => (r[f] && (!m || r[f] > m) ? r[f] : m), null);
  const minOf = (rows, f) => rows.reduce((m, r) => (r[f] && (!m || r[f] < m) ? r[f] : m), null);

  // ---------- returns (E-stebdal, brand OR) ----------
  // Brand and order-date filters apply: a return counts when its return date is in the range.
  function rctx(returns) {
    const p = params();
    const R = (p.brand && p.brand !== 'OR') ? [] : returns.filter((r) => r.ReturnId &&
      (!p.from || FX_day(r.ReturnDate) >= p.from) && (!p.to || FX_day(r.ReturnDate) <= p.to));
    return { R, A: R.filter((r) => r.Status !== 'Cancelled') };
  }
  const FX_day = day;
  const distinct = (rows, f) => new Set(rows.map((r) => r[f]).filter((v) => v != null)).size;
  const RM = {
    count: (A) => distinct(A, 'ReturnId'),
    items: (A) => sum(A, 'ItemQty'),
    value: (A) => sum(A, 'ItemValue'),
    exchangePct: (A) => div(distinct(A.filter((r) => r.IsExchange === 1), 'ReturnId'), distinct(A, 'ReturnId')),
    refundsPaid: (A) => {
      const seen = new Map();
      A.forEach((r) => { if (r.NetBalance > 0) seen.set(r.ReturnId + '|' + r.NetBalance, r.NetBalance); });
      return [...seen.values()].reduce((a, b) => a + b, 0);
    },
    sizePct: (A) => div(sum(A.filter((r) => r.SizeIssue !== 'Not size'), 'ItemQty'), sum(A, 'ItemQty')),
    medApprove: (A) => median(A, 'HoursToApprove'),
    waitingReview: (R) => distinct(R.filter((r) => r.Status === 'Needs Review'), 'ReturnId'),
  };

  return { isNum, median, p90, avg, div, count, sum, day, ms, groupBy, cairoNow, addDays, shiftMonth, params, ctx, lastMonth, M, PM, AM, STAGES, stageHours, hoursBetween, daysBetween, maxOf, minOf, rctx, distinct, RM };
})();

// ---------------- calculations (each one shows its working in Sources) ----------------
const ALL = ['orders', 'parcels', 'attempts'];

dash.calc('ov_kpi', {
  inputs: ['orders'], title: 'Overview headline figures',
  description: 'The Overview cards for the filtered orders, with the same dates one month earlier for comparison.',
  fn: (orders) => {
    const { O } = FX.ctx(orders), L = FX.lastMonth(orders), M = FX.M;
    const row = {
      'Orders To Ship': M.toShip(O), 'Fulfilled %': M.fulfilledPct(O), 'Waiting At Brand': M.waitingBrand(O),
      'Waiting At Brand 24h+': M.waitingBrand24(O), 'Waiting For Courier Pickup': M.waitingPickup(O),
      'Median Order To Ready (h)': M.medReady(O), 'Delivery Success %': M.successPct(O), 'Median Order To Delivered (h)': M.medOrderDelivered(O),
      'Ready Same Day %': M.readyShare(O, 'Same day'),
      'Waiting At Brand Value': FX.sum(O.filter((o) => o.Stage === '1 Waiting at brand'), 'Total'),
      'Waiting At Brand 24h+ Value': FX.sum(O.filter((o) => o.Stage === '1 Waiting at brand' && o.H_WaitingNow >= 24), 'Total'),
      'Orders To Ship (LM)': L.length ? M.toShip(L) : null, 'Fulfilled % (LM)': M.fulfilledPct(L), 'Median Order To Ready (h) (LM)': M.medReady(L),
      'Delivery Success % (LM)': M.successPct(L), 'Median Order To Delivered (h) (LM)': M.medOrderDelivered(L),
      'Data as of': orders.length ? orders[0].RefreshedAt : null,
    };
    // Change vs the same dates last month: "up" = higher is better, "down" = lower is better.
    const change = (f, kind, better) => {
      const cur = row[f], prev = row[f + (f.endsWith(')') ? ' (LM)' : ' (LM)')];
      if (cur == null || prev == null) { row[f + ' change'] = 'No data for the same dates last month'; row[f + ' good'] = null; return; }
      const d = cur - prev, size = kind === 'pct' ? `${Math.abs(d * 100).toFixed(1)} pts` : kind === 'h' ? `${Math.abs(d).toFixed(1)} h` : prev ? `${Math.round(Math.abs(d / prev) * 100)}%` : `${Math.abs(d)}`;
      row[f + ' change'] = `${d >= 0 ? '▲' : '▼'} ${size} vs same dates last month`;
      row[f + ' good'] = better === 'down' ? d <= 0 : d >= 0;
    };
    change('Orders To Ship', 'n', 'up'); change('Fulfilled %', 'pct', 'up'); change('Median Order To Ready (h)', 'h', 'down');
    change('Delivery Success %', 'pct', 'up'); change('Median Order To Delivered (h)', 'h', 'down');
    return [row];
  },
});
dash.calc('ov_daily_stage', {
  inputs: ['orders'], title: 'Orders placed per day by stage', description: 'Count of orders by order date and current stage.',
  fn: (orders) => {
    const out = [];
    for (const [k, g] of FX.groupBy(FX.ctx(orders).O, (o) => FX.day(o.Created) + '|' + o.Stage)) {
      const [d, s] = k.split('|'); out.push({ OrderDate: d, Stage: s, Orders: g.length });
    }
    return out.sort((a, b) => (a.OrderDate < b.OrderDate ? -1 : 1));
  },
});
dash.calc('ov_hour', {
  inputs: ['orders'], title: 'Time to ready by hour ordered', description: 'Median hours from order to ready (label or fulfilment), by the hour the order came in.',
  fn: (orders) => {
    const g = FX.groupBy(FX.ctx(orders).O, (o) => (o.Created ? +o.Created.slice(11, 13) : null));
    const out = [];
    for (let h = 0; h < 24; h++) out.push({ OrderHour: h, 'Median Order To Ready (h)': g.has(h) ? FX.M.medReady(g.get(h)) : null });
    return out;
  },
});
dash.calc('ov_readyday', {
  inputs: ['orders'], title: 'When orders became ready', description: 'Orders by order date and how many working days (Fridays skipped) they took to be ready.',
  fn: (orders) => {
    const out = [];
    for (const [k, g] of FX.groupBy(FX.ctx(orders).O.filter((o) => o.ReadyDay), (o) => FX.day(o.Created) + '|' + o.ReadyDay)) {
      const [d, s] = k.split('|'); out.push({ OrderDate: d, ReadyDay: s, Orders: g.length });
    }
    return out.sort((a, b) => (a.OrderDate < b.OrderDate ? -1 : 1));
  },
});
dash.calc('ov_times', {
  inputs: ['orders'], title: 'Ready and delivery times per day', description: 'Median hours to ready and to delivered (Bosta) for orders placed each day.',
  fn: (orders) => [...FX.groupBy(FX.ctx(orders).O, (o) => FX.day(o.Created))].filter(([d]) => d).sort()
    .map(([d, g]) => ({ OrderDate: d, 'Median Order To Ready (h)': FX.M.medReady(g), 'Median Order To Delivered (h)': FX.M.medOrderDelivered(g) })),
});

dash.calc('al_kpi', {
  inputs: ['orders'], title: 'Action list counts', description: 'Orders waiting at the brand, waiting for pickup, and with the courier.',
  fn: (orders) => {
    const { O } = FX.ctx(orders), M = FX.M;
    return [{ 'Waiting At Brand': M.waitingBrand(O), 'Waiting At Brand 24h+': M.waitingBrand24(O), 'Waiting For Courier Pickup': M.waitingPickup(O),
      'With Courier Now': M.withCourier(O), 'With Courier 10+ Days': M.withCourier10(O), 'Avg Days With Courier': M.avgDaysWithCourier(O) }];
  },
});
dash.calc('al_waiting', {
  inputs: ['orders'], title: 'Orders waiting to move', description: 'Orders still at the brand or waiting for courier pickup, longest wait first. Hours skip Fridays.',
  fn: (orders) => FX.ctx(orders).O.filter((o) => o.Stage === '1 Waiting at brand' || o.Stage === '2 Waiting for courier pickup')
    .sort((a, b) => (b.H_WaitingNow ?? -1) - (a.H_WaitingNow ?? -1))
    .map((o) => ({ OrderKey: o.OrderKey, Brand: o.Brand, Order: o.Order, Created: o.Created, Stage: o.Stage, 'Hours Waiting': o.H_WaitingNow, Courier: o.Courier,
      AwbCreated: o.AwbCreated, TrackingNumbers: o.TrackingNumbers, City: o.City, Governorate: o.Governorate, Total: o.Total, Payment: o.Payment, FulfilledFrom: o.FulfilledFrom })),
});
dash.calc('al_courier', {
  inputs: ['orders'], title: 'Orders with the courier', description: 'Orders picked up and not yet delivered or returned, oldest first.',
  fn: (orders) => FX.ctx(orders).O.filter((o) => o.DaysWithCourier != null).sort((a, b) => b.DaysWithCourier - a.DaysWithCourier)
    .map((o) => ({ OrderKey: o.OrderKey, Brand: o.Brand, Order: o.Order, Courier: o.Courier, TrackingNumbers: o.TrackingNumbers, Governorate: o.Governorate,
      PickedUp: o.PickedUp, 'Days With Courier': o.DaysWithCourier, Attempts: o.Attempts, LastException: o.LastException,
      CourierRiskLevel: o.CourierRiskLevel, CourierIssues: o.CourierIssues, CourierCallsVsAttempts: o.CourierCallsVsAttempts })),
});
dash.calc('al_accountability', {
  inputs: ['orders'], title: 'Who is responsible for each problem order',
  description: 'Bosta and Mylerz orders still with the courier or returned, that the courier analysis flagged. Riskiest first. Who to talk to is worked out from the courier’s reason, calls and flags.',
  fn: (orders) => {
    const rank = { High: 1, Medium: 2, Low: 3 };
    return FX.ctx(orders).O.filter((o) => (o.Courier === 'Bosta' || o.Courier === 'Mylerz') && (o.Stage === '3 With courier' || o.Stage === '5 Returned / failed') && o.CourierRiskLevel)
      .sort((a, b) => (rank[a.CourierRiskLevel] - rank[b.CourierRiskLevel]) || ((b.PickedUp || '') > (a.PickedUp || '') ? 1 : -1))
      .map((o) => ({ OrderKey: o.OrderKey, Brand: o.Brand, Order: o.Order, Courier: o.Courier, TrackingNumbers: o.TrackingNumbers, Stage: o.Stage,
        CourierRiskLevel: o.CourierRiskLevel, CourierCallsVsAttempts: o.CourierCallsVsAttempts, CourierLastReason: o.CourierLastReason,
        CourierIssues: o.CourierIssues, CourierCalls: o.CourierCalls, CourierAnswered: o.CourierAnswered, CourierTalkSeconds: o.CourierTalkSeconds,
        CourierLastCall: o.CourierLastCall, CourierResponsible: o.CourierResponsible, CourierWhy: o.CourierWhy, CourierTalkTo: o.CourierTalkTo }));
  },
});

dash.calc('pf_kpi', {
  inputs: ['orders'], title: '3PL performance figures', description: 'Delivery results and times. Times are for Bosta orders; hours skip Fridays.',
  fn: (orders) => {
    const { O } = FX.ctx(orders), M = FX.M;
    return [{ 'Delivered Orders': M.delivered(O), 'Returned Orders': M.returned(O), 'Delivery Success %': M.successPct(O), 'First Attempt %': M.firstAttemptPct(O),
      'On Time %': M.onTimePct(O), 'Median Label To Pickup (h)': M.medLabelPickup(O), 'Median Pickup To Delivered (h)': M.medPickupDelivered(O),
      'Median Order To Delivered (h)': M.medOrderDelivered(O), 'Next Day Delivery %': M.nextDayPct(O) }];
  },
});
dash.calc('pf_exceptions', {
  inputs: ['orders'], title: 'Why orders came back', description: 'Returned or failed orders by the courier’s last recorded problem.',
  fn: (orders) => [...FX.groupBy(FX.ctx(orders).O.filter((o) => o.BostaResult === 'Returned / failed' && o.LastException), 'LastException')]
    .map(([k, g]) => ({ LastException: k, Orders: g.length })).sort((a, b) => b.Orders - a.Orders),
});
dash.calc('pf_trend', {
  inputs: ['orders'], title: 'Success and on-time rate per day', description: 'Delivery success and Bosta on-time rate for orders placed each day.',
  fn: (orders) => [...FX.groupBy(FX.ctx(orders).O, (o) => FX.day(o.Created))].filter(([d]) => d).sort()
    .map(([d, g]) => ({ OrderDate: d, 'Delivery Success %': FX.M.successPct(g), 'On Time %': FX.M.onTimePct(g) })),
});
dash.calc('pf_failed', {
  inputs: ['orders', 'parcels'], title: 'Failed parcels to follow up', description: 'Parcels returned or failed, with the customer’s contact and whether the courier called.',
  fn: (orders, parcels) => FX.ctx(orders, parcels).P.filter((r) => r.ParcelOutcome === 'Returned / failed')
    .sort((a, b) => ((b.Cancelled || '') > (a.Cancelled || '') ? 1 : -1))
    .map((r) => ({ Brand: r.Brand, Order: r.Order, Carrier: r.Carrier, CourierName: r.CourierName, Tracking: r.Tracking, CustomerName: r.CustomerName,
      CustomerPhone: r.CustomerPhone, LastException: r.LastException, FailReasonGroup: r.FailReasonGroup, Attempts: r.Attempts, Calls: r.Calls, CallCheck: r.CallCheck })),
});
dash.calc('pf_gov', {
  inputs: ['orders'], title: 'Bosta results by governorate', description: 'Orders, success rate and delivery times for Bosta orders in each governorate.',
  fn: (orders) => [...FX.groupBy(FX.ctx(orders).O.filter((o) => o.Courier === 'Bosta'), (o) => o.Governorate || '(blank)')]
    .map(([k, g]) => ({ Governorate: k, 'Orders Placed': g.length, 'Delivery Success %': FX.M.successPct(g), 'Median Pickup To Delivered (h)': FX.M.medPickupDelivered(g),
      'Median Order To Delivered (h)': FX.M.medOrderDelivered(g) })).sort((a, b) => b['Orders Placed'] - a['Orders Placed']),
});
dash.calc('pf_dday', {
  inputs: ['orders'], title: 'Delivery day by order date', description: 'Delivered orders by order date and working days to delivery (Fridays skipped).',
  fn: (orders) => [...FX.groupBy(FX.ctx(orders).O.filter((o) => o.DeliveryDay), (o) => FX.day(o.Created))].sort()
    .map(([d, g]) => ({ OrderDate: d, 'Day 1': FX.count(g, (o) => o.DeliveryDay === 'Day 1'), 'Day 2': FX.count(g, (o) => o.DeliveryDay === 'Day 2'),
      'More than 2 days': FX.count(g, (o) => o.DeliveryDay === 'More than 2 days'), Total: g.length })),
});
dash.calc('pf_dday_share', {
  inputs: ['orders'], title: 'Delivery day mix by courier and brand', description: 'Share of delivered orders reaching the customer on day 1, day 2 or later.',
  fn: (orders) => {
    const out = [];
    for (const [k, g] of FX.groupBy(FX.ctx(orders).O.filter((o) => o.DeliveryDay), (o) => o.Courier + ' · ' + o.Brand))
      for (const dd of ['Day 1', 'Day 2', 'More than 2 days']) out.push({ Group: k, DeliveryDay: dd, 'Delivery Day %': FX.count(g, (o) => o.DeliveryDay === dd) / g.length, Orders: g.length });
    return out.sort((a, b) => (a.Group < b.Group ? -1 : 1));
  },
});

dash.calc('os_results', {
  inputs: ['orders'], title: 'Order search results', description: 'Orders whose number or tracking number contains the search text.',
  fn: (orders) => {
    const p = FX.params(), q = p.q.trim().toLowerCase().replace(/^#/, '');
    if (!q) return [];
    return orders.filter((o) => (!p.brand || o.Brand === p.brand) && (((o.Order || '').toLowerCase().replace('#', '').includes(q)) || (o.TrackingNumbers || '').toLowerCase().includes(q)))
      .slice(0, 200).map((o) => ({ OrderKey: o.OrderKey, Brand: o.Brand, Order: o.Order, Created: o.Created, Status: o.Status, Stage: o.Stage, Courier: o.Courier,
        TrackingNumbers: o.TrackingNumbers, Payment: o.Payment, Total: o.Total, City: o.City, Governorate: o.Governorate, DeliveryDay: o.DeliveryDay, Attempts: o.Attempts, LastException: o.LastException }));
  },
});
dash.calc('os_timeline', {
  inputs: ['orders', 'parcels'], title: 'Order timeline', description: 'Every step of the selected order, from Shopify and the courier.',
  fn: (orders, parcels) => {
    const key = FX.params().sel, o = orders.find((r) => r.OrderKey === key);
    if (!o) return [];
    const egp = (n) => (n == null ? '' : Math.round(n).toLocaleString('en-US'));
    const steps = [{ StepNo: 1, Step: 'Order placed', When: o.Created, Parcel: '', Detail: `${o.Payment || ''} · ${egp(o.Total)} EGP` }];
    if (o.FirstFulfilled) steps.push({ StepNo: 2, Step: 'Fulfilled in Shopify', When: o.FirstFulfilled, Parcel: '', Detail: o.FulfilledFrom || '' });
    const ship = parcels.filter((r) => r.OrderKey === key && r.IsTransfer !== 1);
    for (const r of ship) {
      const pc = `${r.Carrier} ${r.Tracking}`;
      if (r.Type === 'Send' || r.Type === 'Return to Origin') {
        steps.push({ StepNo: 3, Step: 'Label created', When: r.Created, Parcel: pc, Detail: '' });
        if (r.PickedUp) steps.push({ StepNo: 4, Step: 'Picked up by courier', When: r.PickedUp, Parcel: pc, Detail: '' });
        if (r.ReceivedAtHub) steps.push({ StepNo: 5, Step: 'Arrived at courier hub', When: r.ReceivedAtHub, Parcel: pc, Detail: '' });
        if (r.OutForDelivery) steps.push({ StepNo: 6, Step: 'Out for delivery (last attempt)', When: r.OutForDelivery, Parcel: pc, Detail: `Attempts: ${r.Attempts ?? ''}${r.LastException ? ' · Last problem: ' + r.LastException : ''}` });
        if (r.Delivered) steps.push({ StepNo: 7, Step: 'Delivered', When: r.Delivered, Parcel: pc, Detail: '' });
        if (r.Type === 'Return to Origin' && r.Cancelled) steps.push({ StepNo: 7, Step: 'Delivery failed', When: r.Cancelled, Parcel: pc, Detail: r.LastException || '' });
        if (r.ReturnedToBusiness) steps.push({ StepNo: 8, Step: 'Returned to brand', When: r.ReturnedToBusiness, Parcel: pc, Detail: '' });
      } else if (r.Type === 'Customer Return Pickup') steps.push({ StepNo: 10, Step: 'Customer return pickup', When: r.Created, Parcel: pc, Detail: r.State || '' });
    }
    if (o.Cancelled) steps.push({ StepNo: 9, Step: 'Order cancelled', When: o.Cancelled, Parcel: '', Detail: '' });
    return steps.sort((a, b) => ((a.When || '') < (b.When || '') ? -1 : (a.When || '') > (b.When || '') ? 1 : a.StepNo - b.StepNo)).map((s, i) => ({ Key: String(i + 1), ...s }));
  },
});
dash.calc('os_detail', {
  inputs: ['orders'], title: 'Selected order', description: 'The order picked in the search results.',
  fn: (orders) => {
    const o = orders.find((r) => r.OrderKey === FX.params().sel);
    return o ? [{ Order: o.Order, Brand: o.Brand, Status: o.Status, Stage: o.Stage, Courier: o.Courier, Total: o.Total, Payment: o.Payment, Governorate: o.Governorate, City: o.City }] : [];
  },
});

dash.calc('dd_kpi', {
  inputs: ALL, title: '3PL deep dive figures', description: 'Parcel results, attempts and calls, from the courier data.',
  fn: (orders, parcels, attempts) => {
    const { P, A } = FX.ctx(orders, parcels, attempts), PM = FX.PM, AM = FX.AM;
    return [{ 'Parcel Success %': PM.successPct(P), 'Avg Attempts (Delivered)': PM.avgAttemptsDelivered(P), 'Avg Attempts (Failed)': PM.avgAttemptsFailed(P),
      'Avg Calls (Failed)': PM.avgCallsFailed(P), 'Failed With No Call %': PM.failedNoCallPct(P), 'Fake Attempt %': AM.fakePct(A),
      'Verified Failures %': AM.verifiedPct(A), 'Rescheduled Parcels %': PM.rescheduledPct(P) }];
  },
});
dash.calc('dd_attempt_mix', {
  inputs: ALL, title: 'What happened on each attempt', description: 'Delivery attempts by attempt number and result.',
  fn: (orders, parcels, attempts) => {
    const out = [];
    for (const [k, g] of FX.groupBy(FX.ctx(orders, parcels, attempts).A.filter((a) => a.AttemptType === 'delivery'), (a) => a.AttemptNo + '|' + a.ResultGroup)) {
      const [n, rg] = k.split('|'); out.push({ AttemptNo: 'Attempt ' + n, N: +n, ResultGroup: rg, Attempts: g.length });
    }
    return out.sort((a, b) => a.N - b.N);
  },
});
dash.calc('dd_stars', {
  inputs: ['orders', 'parcels'], title: 'Results by delivery agent', description: 'Delivered and failed parcels for each courier agent, busiest first.',
  fn: (orders, parcels) => [...FX.groupBy(FX.ctx(orders, parcels).P.filter((r) => r.CourierName), (r) => r.Carrier + '|' + r.CourierName)]
    .map(([k, g]) => {
      const [c, n] = k.split('|'), PM = FX.PM;
      return { Carrier: c, CourierName: n, 'Parcels Delivered': PM.delivered(g), 'Parcels Failed': PM.failed(g), 'Parcel Success %': PM.successPct(g),
        'Avg Attempts (Delivered)': PM.avgAttemptsDelivered(g), 'Avg Calls (Failed)': PM.avgCallsFailed(g) };
    }).filter((r) => r['Parcels Delivered'] + r['Parcels Failed'] > 0)
    .sort((a, b) => b['Parcels Delivered'] + b['Parcels Failed'] - a['Parcels Delivered'] - a['Parcels Failed']),
});
dash.calc('dd_calls', {
  inputs: ['orders', 'parcels'], title: 'Calls before the result', description: 'Delivered and failed Bosta parcels by how many times the courier called.',
  fn: (orders, parcels) => {
    const out = [];
    for (const [k, g] of FX.groupBy(FX.ctx(orders, parcels).P.filter((r) => r.CallsBucket && (r.ParcelOutcome === 'Delivered' || r.ParcelOutcome === 'Returned / failed')), (r) => r.CallsBucket + '|' + r.ParcelOutcome)) {
      const [b, o] = k.split('|'); out.push({ CallsBucket: b, ParcelOutcome: o, Parcels: g.length });
    }
    return out.sort((a, b) => (a.CallsBucket < b.CallsBucket ? -1 : 1));
  },
});
dash.calc('dd_confirm', {
  inputs: ['orders', 'parcels'], title: 'Success by confirmation status', description: 'Parcel success rate by whether the customer confirmed the order.',
  fn: (orders, parcels) => [...FX.groupBy(FX.ctx(orders, parcels).P.filter((r) => r.ConfirmStatus), 'ConfirmStatus')]
    .map(([k, g]) => ({ ConfirmStatus: k, 'Parcel Success %': FX.PM.successPct(g), Parcels: FX.PM.delivered(g) + FX.PM.failed(g) }))
    .filter((r) => r['Parcel Success %'] != null).sort((a, b) => b['Parcel Success %'] - a['Parcel Success %']),
});
dash.calc('dd_outcomes', {
  inputs: ALL, title: 'Failed attempt reasons by attempt number', description: 'Attempts that did not deliver, by the courier’s reason and attempt number.',
  fn: (orders, parcels, attempts) => {
    const A = FX.ctx(orders, parcels, attempts).A.filter((a) => a.ResultGroup !== 'Delivered' && a.ResultGroup !== 'Other');
    return [...FX.groupBy(A, 'Outcome')].map(([k, g]) => {
      const r = { Outcome: k || '(none)', Total: g.length };
      for (let n = 1; n <= 4; n++) r['Attempt ' + n] = FX.count(g, (a) => a.AttemptNo === n);
      r['Attempt 5+'] = FX.count(g, (a) => a.AttemptNo >= 5);
      return r;
    }).sort((a, b) => b.Total - a.Total);
  },
});

dash.calc('bn_stages', {
  inputs: ['orders'], title: 'Hours spent in each stage', description: 'For delivered orders: hours in each step of the journey, as median, P90 or average (picked on the page). Fridays skipped.',
  fn: (orders) => {
    const { O, p } = FX.ctx(orders);
    return FX.STAGES.map((s) => ({ StageNo: s.no, Stage: s.name, Hours: FX.stageHours(O, s.col, p.stat), Stat: p.stat }));
  },
});
dash.calc('bn_courier', {
  inputs: ['orders'], title: 'Stage hours by courier and brand', description: 'Hours in each stage for delivered Bosta and Mylerz orders.',
  fn: (orders) => {
    const { O, p } = FX.ctx(orders);
    return [...FX.groupBy(O.filter((o) => o.Courier === 'Bosta' || o.Courier === 'Mylerz'), (o) => o.Courier + '|' + o.Brand)].sort()
      .map(([k, g]) => { const [c, b] = k.split('|'), r = { Key: k, Courier: c, Brand: b }; FX.STAGES.forEach((s) => { r[s.name] = FX.stageHours(g, s.col, p.stat); }); return r; });
  },
});
dash.calc('bn_location', {
  inputs: ['orders'], title: 'Brand-side hours by fulfilment location', description: 'Hours to ready and label-to-pickup for the 10 locations with most orders.',
  fn: (orders) => {
    const { O, p } = FX.ctx(orders);
    return [...FX.groupBy(O.filter((o) => o.FulfilledFrom), 'FulfilledFrom')].sort((a, b) => b[1].length - a[1].length).slice(0, 10)
      .map(([k, g]) => ({ FulfilledFrom: k, Orders: g.length, [FX.STAGES[0].name]: FX.stageHours(g, FX.STAGES[0].col, p.stat), [FX.STAGES[1].name]: FX.stageHours(g, FX.STAGES[1].col, p.stat) }));
  },
});

dash.calc('cz_table', {
  inputs: ['orders'], title: 'Best courier per governorate', description: 'Bosta vs Mylerz per governorate. Score = 50% success + 25% next-day + 25% first attempt; at least 20 closed orders each to recommend.',
  fn: (orders) => {
    const { O } = FX.ctx(orders), M = FX.M;
    const ds = O.map((o) => FX.day(o.Created)).filter(Boolean).sort();
    const days = ds.length ? FX.daysBetween(ds[0], ds[ds.length - 1]) + 1 : 1;
    return [...FX.groupBy(O, (o) => o.Governorate || '(blank)')].map(([gov, g]) => {
      const b = g.filter((o) => o.Courier === 'Bosta'), m = g.filter((o) => o.Courier === 'Mylerz');
      const nb = M.closed(b), nm = M.closed(m), sb = M.successPct(b), sm = M.successPct(m);
      const rec = nb === 0 && nm === 0 ? null : nm === 0 ? 'Bosta only' : nb === 0 ? 'Mylerz only' : nb < 20 || nm < 20 ? 'Not enough data' : M.courierScore(b) >= M.courierScore(m) ? 'Bosta' : 'Mylerz';
      const real = rec === 'Bosta' || rec === 'Mylerz';
      const gain = real ? Math.abs((sb || 0) - (sm || 0)) * 100 : null;
      const avoided = real ? Math.round((rec === 'Bosta' ? nm : nb) * Math.abs((sb || 0) - (sm || 0)) * 30 / days) : null;
      return { Governorate: gov, 'Bosta Closed': nb, 'Mylerz Closed': nm, 'Bosta Success (Zone)': sb, 'Mylerz Success (Zone)': sm,
        'Bosta Score': M.courierScore(b), 'Mylerz Score': M.courierScore(m), 'Recommended Courier': rec, 'Success Gain (pts)': gain, 'Returns Avoided / Month': avoided,
        Recommendation: real ? `Use ${rec}: +${gain.toFixed(1)} pts success, ~${avoided} fewer returns/month` : rec };
    }).filter((r) => r['Recommended Courier']).sort((a, b) => (b['Returns Avoided / Month'] ?? -1) - (a['Returns Avoided / Month'] ?? -1) || b['Bosta Closed'] + b['Mylerz Closed'] - a['Bosta Closed'] - a['Mylerz Closed']);
  },
});
dash.calc('cz_bars', {
  inputs: ['orders'], title: 'Success rate by governorate and courier', description: 'Delivery success for each courier in each governorate with at least 20 closed orders.',
  fn: (orders) => {
    const out = [];
    for (const [gov, g] of FX.groupBy(FX.ctx(orders).O, (o) => o.Governorate || '(blank)'))
      for (const c of ['Bosta', 'Mylerz']) { const s = g.filter((o) => o.Courier === c); if (FX.M.closed(s) >= 20) out.push({ Governorate: gov, Courier: c, 'Delivery Success %': FX.M.successPct(s), Closed: FX.M.closed(s) }); }
    return out;
  },
});

dash.calc('nc_kpi', {
  inputs: ['orders', 'parcels'], title: 'No-call failure figures', description: 'Failed Bosta parcels where the courier never called the customer.',
  fn: (orders, parcels) => {
    const { P } = FX.ctx(orders, parcels), PM = FX.PM;
    return [{ 'Failed With No Call %': PM.failedNoCallPct(P), 'Suspicious No-Call %': PM.suspiciousPct(P), 'Suspicious No-Call Failures': PM.suspicious(P),
      'COD Lost (Suspicious)': PM.codLost(P), 'Delivered With No Call %': PM.deliveredNoCallPct(P), 'Success When Not Called': PM.successWhen(P, false), 'Success When Called': PM.successWhen(P, true) }];
  },
});
dash.calc('nc_callcheck', {
  inputs: ['orders', 'parcels'], title: 'Failed parcels by call check', description: 'Failed Bosta parcels: called, not called but explained, or not called with no explanation.',
  fn: (orders, parcels) => [...FX.groupBy(FX.ctx(orders, parcels).P.filter((r) => r.CallCheck), 'CallCheck')].map(([k, g]) => ({ CallCheck: k, Parcels: g.length })).sort((a, b) => b.Parcels - a.Parcels),
});
dash.calc('nc_reasons', {
  inputs: ['orders', 'parcels'], title: 'Call check by failure reason', description: 'For each failure reason, how many parcels had a call.',
  fn: (orders, parcels) => {
    const out = [];
    for (const [k, g] of FX.groupBy(FX.ctx(orders, parcels).P.filter((r) => r.CallCheck && r.FailReasonGroup), (r) => r.FailReasonGroup + '|' + r.CallCheck)) {
      const [f, c] = k.split('|'); out.push({ FailReasonGroup: f, CallCheck: c, Parcels: g.length });
    }
    return out;
  },
});

dash.calc('dh_brands', {
  inputs: ['orders', 'parcels'], title: 'Shopify data checks by brand', description: 'How fresh and complete each brand’s order data is, and how many shipped orders were found at the courier. Ignores the page filters.',
  fn: (orders, parcels) => {
    const now = FX.cairoNow(), today = now.slice(0, 10);
    return [...FX.groupBy(orders.filter((o) => o.Brand), 'Brand')].sort().map(([b, g]) => {
      const yest = FX.addDays(today, -1), from7 = FX.addDays(today, -8), to7 = FX.addDays(today, -2);
      const y = FX.count(g, (o) => FX.day(o.Created) === yest), a7 = FX.count(g, (o) => FX.day(o.Created) >= from7 && FX.day(o.Created) <= to7) / 7;
      const shipped = FX.count(g, (o) => ['Bosta', 'Mylerz', 'Other'].includes(o.Courier) && o.Status !== 'Cancelled');
      const notFound = FX.count(g, (o) => o.Courier === 'Other' && o.Status !== 'Cancelled'), mz = FX.count(g, (o) => o.Stage === '3 With Mylerz (no tracking)');
      return { Brand: b, 'Hours Since Last Order': FX.hoursBetween(FX.maxOf(g, 'Created'), now), 'Shopify Coverage Days': FX.daysBetween(FX.minOf(g, 'Created'), now),
        'Orders Yesterday': y, 'Avg Orders / Day (7d)': a7, 'Volume vs Normal %': FX.div(y, a7), 'Shipped Not Found At Courier': notFound, 'Mylerz Not Found': mz,
        'Courier Match %': FX.div(shipped - notFound - mz, shipped) };
    });
  },
});
dash.calc('dh_parcels', {
  inputs: ['parcels'], title: 'Courier data checks', description: 'Parcels loaded per brand and courier, how fresh they are, and how many matched a Shopify order.',
  fn: (parcels) => {
    const now = FX.cairoNow();
    return [...FX.groupBy(parcels.filter((r) => r.Brand), (r) => r.Brand + '|' + r.Carrier)].sort().map(([k, g]) => {
      const [b, c] = k.split('|'), m = g.filter((r) => ['Matched', 'No order reference', 'Order not found'].includes(r.MatchIssue));
      return { Key: k, Brand: b, Carrier: c, 'Parcels Loaded': g.length, 'Hours Since Last Parcel': FX.hoursBetween(FX.maxOf(g, 'Created'), now),
        'Courier Coverage Days': FX.daysBetween(FX.minOf(g, 'Created'), now), 'Parcels Matched %': FX.div(FX.count(m, (r) => r.MatchIssue === 'Matched'), m.length) };
    });
  },
});
dash.calc('dh_kpi', {
  inputs: ['dh_brands', 'dh_parcels', 'orders', 'parcels', 'attempts'], title: 'Data health summary',
  description: 'Five checks: orders older than 12 h, parcels older than 24 h, yesterday under half of normal, orders with data issues, attempts the page could not read.',
  fn: (brands, couriers, orders, parcels, attempts) => {
    const stale = brands.some((b) => b['Hours Since Last Order'] > 12), staleP = couriers.some((c) => c['Hours Since Last Parcel'] > 24);
    const low = brands.some((b) => b['Volume vs Normal %'] != null && b['Volume vs Normal %'] < 0.5);
    const issues = FX.count(orders, (o) => o.DataIssue), unparsed = FX.count(attempts, (a) => a.ResultGroup === 'Unknown');
    const n = [stale, staleP, low, issues > 0, unparsed > 0].filter(Boolean).length;
    return [{ 'Data Health Status': n === 0 ? 'All checks OK' : `${n} ${n === 1 ? 'check needs' : 'checks need'} attention`, 'Checks Needing Attention': n,
      'Unmatched Parcels': FX.count(parcels, (r) => r.MatchIssue === 'No order reference' || r.MatchIssue === 'Order not found'),
      'Orders With Data Issues': issues, 'Unparsed Attempts': unparsed }];
  },
});
dash.calc('dh_issues', {
  inputs: ['orders'], title: 'Orders with data issues', description: 'Orders whose data looks wrong or incomplete, and why.',
  fn: (orders) => orders.filter((o) => o.DataIssue).sort((a, b) => ((b.Created || '') > (a.Created || '') ? 1 : -1))
    .map((o) => ({ OrderKey: o.OrderKey, Brand: o.Brand, Order: o.Order, DataIssue: o.DataIssue, Status: o.Status, Courier: o.Courier, TrackingNumbers: o.TrackingNumbers,
      Created: o.Created, AwbCreated: o.AwbCreated, PickedUp: o.PickedUp, Delivered: o.Delivered })),
});

dash.calc('nc_list', {
  inputs: ['orders', 'parcels'], title: 'Failed Bosta parcels (filtered)',
  description: 'Every failed Bosta parcel in the current filters, with the call check and failure reason picked above the table. Newest failure first.',
  fn: (orders, parcels) => {
    const { P, p } = FX.ctx(orders, parcels);
    const byKey = new Map(orders.map((o) => [o.OrderKey, o]));
    return P.filter((r) => r.CallCheck && (!p.cc || r.CallCheck === p.cc) && (!p.fr || r.FailReasonGroup === p.fr))
      .sort((a, b) => ((b.Cancelled || '') > (a.Cancelled || '') ? 1 : -1))
      .map((r) => {
        const o = byKey.get(r.OrderKey) || {};
        return { Brand: r.Brand, Order: r.Order, Tracking: r.Tracking, FailedAt: r.Cancelled, CourierName: r.CourierName, CustomerName: r.CustomerName,
          CustomerPhone: r.CustomerPhone, CustomerPhone2: r.CustomerPhone2, City: o.City, Governorate: o.Governorate, COD: r.COD, Attempts: r.Attempts,
          Calls: r.Calls, CallCheck: r.CallCheck, FailReasonGroup: r.FailReasonGroup, LastException: r.LastException, ConfirmStatus: r.ConfirmStatus };
      });
  },
});

dash.calc('rt_kpi', {
  inputs: ['orders', 'returns'], title: 'Returns headline figures',
  description: 'OR returns from E-stebdal, cancelled returns left out. Return rate = orders with a return ÷ delivered OR orders.',
  fn: (orders, returns) => {
    const { R, A } = FX.rctx(returns), RM = FX.RM;
    const delivered = FX.M.delivered(FX.ctx(orders).O.filter((o) => o.Brand === 'OR'));
    return [{ 'Returns Count': RM.count(A), 'Returned Items': RM.items(A), 'Return Rate %': FX.div(FX.distinct(A, 'OrderKey'), delivered),
      'Exchange %': RM.exchangePct(A), 'Refunds Paid (EGP)': RM.refundsPaid(A), 'Size Issue %': RM.sizePct(A),
      'Median Hours To Approve': RM.medApprove(A), 'Waiting Review': RM.waitingReview(R), 'Returned Item Value': RM.value(A) }];
  },
});
dash.calc('rt_reasons', {
  inputs: ['returns'], title: 'Returned items by reason', description: 'Returned items (not cancelled) by the reason the customer gave.',
  fn: (returns) => [...FX.groupBy(FX.rctx(returns).A.filter((r) => r.ItemReason), 'ItemReason')]
    .map(([k, g]) => ({ ItemReason: k, 'Returned Items': FX.sum(g, 'ItemQty') })).sort((a, b) => b['Returned Items'] - a['Returned Items']),
});
dash.calc('rt_types', {
  inputs: ['returns'], title: 'Size problems by product type', description: 'Returned items per product type, split by too small, too large or not a size issue.',
  fn: (returns) => [...FX.groupBy(FX.rctx(returns).A, (r) => r.ItemProductType || '(blank)')].map(([k, g]) => {
    const s = (lab) => FX.sum(g.filter((r) => r.SizeIssue === lab), 'ItemQty');
    return { ItemProductType: k, 'Too small': s('Too small'), 'Too large': s('Too large'), 'Not size': s('Not size'), Total: FX.sum(g, 'ItemQty') };
  }).sort((a, b) => b.Total - a.Total),
});
dash.calc('rt_review', {
  inputs: ['returns'], title: 'Returns waiting for review', description: 'Returned items whose return is still Needs Review in E-stebdal, oldest first.',
  fn: (returns) => FX.rctx(returns).R.filter((r) => r.Status === 'Needs Review').sort((a, b) => ((a.ReturnDate || '') < (b.ReturnDate || '') ? -1 : 1))
    .map((r, i) => ({ Key: String(i + 1), ReturnNumber: r.ReturnNumber, OrderNumber: r.OrderNumber, ReturnDate: r.ReturnDate, ItemProduct: r.ItemProduct,
      ItemReason: r.ItemReason, ItemNote: r.ItemNote, Status: r.Status })),
});
dash.calc('rt_products', {
  inputs: ['returns'], title: 'Most returned products', description: 'Returned items and value per product, with the share returned for size.',
  fn: (returns) => [...FX.groupBy(FX.rctx(returns).A.filter((r) => r.ItemProduct), (r) => r.ItemProduct + '|' + (r.ItemSku || ''))].map(([k, g]) => {
    const [p, s] = k.split('|');
    return { Key: k, ItemProduct: p, ItemSku: s, 'Returned Items': FX.sum(g, 'ItemQty'), 'Returned Item Value': FX.sum(g, 'ItemValue'), 'Size Issue %': FX.RM.sizePct(g) };
  }).sort((a, b) => b['Returned Items'] - a['Returned Items']),
});
dash.calc('rt_mix', {
  inputs: ['returns'], title: 'Exchanges vs refunds', description: 'Returns (not cancelled) that became an exchange or a refund.',
  fn: (returns) => [...FX.groupBy(FX.rctx(returns).A, 'ReturnType')].map(([k, g]) => ({ ReturnType: k, Returns: FX.distinct(g, 'ReturnId') })).sort((a, b) => b.Returns - a.Returns),
});
dash.calc('rt_all', {
  inputs: ['returns'], title: 'All returns', description: 'Every returned item (not cancelled), newest first, with the Bosta pickup that brings it back.',
  fn: (returns) => FX.rctx(returns).A.slice().sort((a, b) => ((b.ReturnDate || '') > (a.ReturnDate || '') ? 1 : -1))
    .map((r, i) => ({ Key: String(i + 1), ReturnNumber: r.ReturnNumber, OrderNumber: r.OrderNumber, ReturnDate: r.ReturnDate, Status: r.Status, ReturnType: r.ReturnType,
      RefundMethod: r.RefundMethod, OrderTotal: r.OrderTotal, ItemProduct: r.ItemProduct, ItemSize: r.ItemSize, ItemValue: r.ItemValue, ItemReason: r.ItemReason,
      OutgoingSkus: r.OutgoingSkus, OutgoingSizes: r.OutgoingSizes, NetBalance: r.NetBalance, BostaReturnTracking: r.BostaReturnTracking,
      BostaReturnStatus: r.BostaReturnStatus, BostaPickedUp: r.BostaPickedUp, CustomerName: r.CustomerName, CustomerPhone: r.CustomerPhone,
      ItemNote: r.ItemNote, ReturnNotes: r.ReturnNotes, ProofOfRefund: r.ProofOfRefund, RefundProvider: r.RefundProvider,
      RefundAccountNumber: r.RefundAccountNumber, RefundAccountName: r.RefundAccountName })),
});
dash.calc('dh_estebdal', {
  inputs: ['returns'], title: 'E-stebdal connection', description: 'Whether the last refresh could read returns from E-stebdal.',
  fn: (returns) => [{ 'E-stebdal Status': (returns.find((r) => r.ApiStatus) || {}).ApiStatus || 'No data', 'Returns Loaded': FX.distinct(returns, 'ReturnId') }],
});

dash.calc('filter_choices', {
  inputs: ['orders'], title: 'Filter choices', description: 'Brands, couriers, payment methods and dates found in the orders.',
  fn: (orders) => {
    const uniq = (f) => [...new Set(orders.map((o) => o[f]).filter(Boolean))].sort();
    const ds = orders.map((o) => FX.day(o.Created)).filter(Boolean).sort();
    return [{ brands: uniq('Brand'), couriers: uniq('Courier'), payments: uniq('Payment'), first: ds[0] || null, last: ds[ds.length - 1] || null }];
  },
});
