import { Calendar, addDays, diffDays, weekday, PRODUCTS, INSTANT_CAP } from './core/calendar.js';
import { forecastsFromPayments, makePlan, toInvestorApi } from './core/autopilot.js';
import { bucketKey } from './core/conformal.js';

// ---------------------------------------------------------------- state
const LS = { settings: 'spiko.autopilot.settings.v1', whatif: 'spiko.autopilot.whatif.v1', status: 'spiko.autopilot.status.v1' };
const DEFAULTS = { product: 'eurSAFO', alpha: 0.01, floor: 50000, horizon: 56 };
const S = {
  snap: null, bt: null, cal: null, error: null,
  settings: load(LS.settings, DEFAULTS),
  whatif: load(LS.whatif, { edits: {}, added: [], removed: [] }),
  status: load(LS.status, { state: 'draft', activatedAt: null, activatedPlan: null }),
  view: null, base: null,
};
function load(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v ? { ...d, ...v } : structuredClone(d); } catch { return structuredClone(d); } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } }

const IDS = { accountId: '7c1e2a40-5b8d-4f6e-9a0b-3d2c1f4e5a60', bankAccountId: 'b3f9d2c1-8e7a-4d5b-a6c9-0f1e2d3c4b5a' };

// ---------------------------------------------------------------- formatting
const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const eur = (x) => `${nf2.format(x)} EUR`;
const eur0 = (x) => `€${nf0.format(Math.round(x))}`;
const signed = (x) => (x < 0 ? `- ${eur(-x)}` : `+ ${eur(x)}`);
const pct = (x, d = 2) => `${(x * 100).toFixed(d)}%`;
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dlong = (d) => `${WD[weekday(d)]}, ${+d.slice(8)} ${MO[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}`;
const dshort = (d) => `${WD[weekday(d)]} ${+d.slice(8)} ${MO[+d.slice(5, 7) - 1]}`;
const hm = (min) => `${String(Math.floor((min + 1) / 60)).padStart(2, '0')}:${String((min + 1) % 60).padStart(2, '0')}`;
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (name, cls = '', extra = '') => `<i data-lucide="${name}" class="${cls}" ${extra}></i>`;
// Spiko's own core icons (design-system/src/assets/icons/core): ArrowUpRightCircle and ArrowLeftRightCircle
const upRight = (cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M21.1669 11.9999C21.1669 6.93733 17.0625 2.83295 11.9999 2.83295C6.93731 2.83295 2.83293 6.93733 2.83293 11.9999C2.83293 17.0625 6.93731 21.1669 11.9999 21.1669C17.0625 21.1669 21.1669 17.0626 21.1669 11.9999ZM22.8329 11.9999C22.8329 17.983 17.983 22.8329 11.9999 22.8329C6.01684 22.8329 1.16692 17.983 1.16692 11.9999C1.16692 6.01685 6.01684 1.16693 11.9999 1.16693C17.983 1.16693 22.8329 6.01685 22.8329 11.9999Z" fill="currentColor"/><path d="M9.08664 10.0009C8.66629 9.95835 8.33879 9.60313 8.33879 9.17155C8.33879 8.73998 8.66629 8.38476 9.08664 8.34222L9.17158 8.33877L14.8284 8.33877C15.26 8.33877 15.6152 8.66626 15.6578 9.08662L15.6612 9.17155L15.6612 14.8284L15.6578 14.9133C15.6152 15.3337 15.26 15.6612 14.8284 15.6612C14.3969 15.6612 14.0416 15.3337 13.9991 14.9133L13.9956 14.8284L13.9956 10.0043L9.17158 10.0043L9.08664 10.0009Z" fill="currentColor"/><path d="M15.4175 9.76059L9.7606 15.4174C9.43517 15.7429 8.90799 15.7429 8.58255 15.4174C8.25712 15.092 8.25712 14.5648 8.58255 14.2394L14.2394 8.58254C14.5648 8.2571 15.092 8.2571 15.4175 8.58254C15.7429 8.90798 15.7429 9.43515 15.4175 9.76059Z" fill="currentColor"/></svg>`;
const leftRight = (cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="2" y="2" width="20" height="20" rx="10" stroke="currentColor" stroke-width="1.66667"/><path fill-rule="evenodd" clip-rule="evenodd" d="M10.0945 7.26293C10.3063 7.4535 10.3063 7.76249 10.0945 7.95306L8.85126 9.072H16.2178C16.5172 9.072 16.76 9.29048 16.76 9.56C16.76 9.82951 16.5172 10.048 16.2178 10.048H8.85126L10.0945 11.1669C10.3063 11.3575 10.3063 11.6665 10.0945 11.8571C9.88277 12.0476 9.53945 12.0476 9.3277 11.8571L7.15881 9.90506C6.94706 9.71449 6.94706 9.4055 7.15881 9.21493L9.3277 7.26293C9.53945 7.07235 9.88277 7.07235 10.0945 7.26293Z" fill="currentColor"/><path fill-rule="evenodd" clip-rule="evenodd" d="M13.6655 12.1429C13.8772 11.9524 14.2205 11.9524 14.4323 12.1429L16.6012 14.0949C16.8129 14.2855 16.8129 14.5945 16.6012 14.7851L14.4323 16.7371C14.2205 16.9276 13.8772 16.9276 13.6655 16.7371C13.4537 16.5465 13.4537 16.2375 13.6655 16.0469L14.9087 14.928H7.54222C7.24276 14.928 7 14.7095 7 14.44C7 14.1705 7.24276 13.952 7.54222 13.952H14.9087L13.6655 12.8331C13.4537 12.6425 13.4537 12.3335 13.6655 12.1429Z" fill="currentColor"/></svg>`;

// ---------------------------------------------------------------- data
async function boot() {
  renderSkeleton();
  const logo = await fetch('assets/spiko-logo.svg').then(r => r.text()).catch(() => 'spiko');
  document.getElementById('logo').innerHTML = logo;
  try {
    const [snap, bt] = await Promise.all([fetch('data/snapshot.json').then(ok), fetch('data/backtest.json').then(ok)]);
    S.snap = snap; S.bt = bt; S.cal = new Calendar(snap.funds);
  } catch (e) { S.error = e; }
  window.addEventListener('hashchange', route);
  document.addEventListener('keydown', onKey);
  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  route();
}
function ok(r) { if (!r.ok) throw new Error(`${r.url} ${r.status}`); return r.json(); }

function payments() {
  const w = S.whatif;
  const removed = new Set(w.removed);
  const list = S.snap.payments.filter(p => !removed.has(p.id)).map(p => (w.edits[p.id] ? { ...p, ...w.edits[p.id], cv: 0.002, edited: true } : p));
  return list.concat(w.added.map(a => ({ ...a, cv: 0.002, added: true }))).sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));
}
function computePlan(pays = payments(), settings = S.settings) {
  const { snap, cal } = S;
  const fcs = forecastsFromPayments({ cal, today: snap.today, horizon: settings.horizon, payments: pays, unsched: snap.unsched });
  const committed = new Map((snap.pending || []).map(p => [p.day, p.amount]));
  return makePlan({ cal, productKey: settings.product, today: snap.today, nowMin: snap.nowMin, B0: snap.bank.balance, floor: settings.floor, fcs, calib: snap.calib[String(settings.alpha)], committed });
}
function hasWhatIf() { const w = S.whatif; return Object.keys(w.edits).length || w.added.length || w.removed.length; }

// orders worth a decision (standard withdrawals, pre-funding instants, sweeps); small same-day instants are summarised
function decisionOrders(pl) {
  const out = [];
  pl.orders.forEach((o, i) => {
    const k = diffDays(pl.today, o.day);
    const reason = coverReason(pl, k, o);
    const prefund = o.type === 'instant' ? o.amount - pl.f[k] : 0;
    if (o.type === 'standard' || (o.type === 'instant' && (o.amount >= 100000 || prefund >= 25000)) || (o.type === 'deposit' && o.amount >= 100000)) out.push({ ...o, idx: i, k, reason });
  });
  return out;
}
function coverReason(pl, k, o) {
  // which payment day this move exists for: the next day whose calibrated need exceeds that morning's instant capacity
  const prefund = o.type === 'instant' && o.amount - pl.f[k] >= 25000;
  if (o.type === 'instant' && !prefund) { const top = pl.fcs[k].known.slice().sort((a, b) => b.est - a.est)[0]; return { day: o.day, label: top ? top.item.label : 'Card and unscheduled spend' }; }
  for (let j = (o.type === 'instant' ? k + 1 : k + 1); j < pl.days.length; j++) {
    if (pl.plan.reserveNeed[j] > 0) {
      const top = pl.fcs[j].known.slice().sort((a, b) => b.est - a.est)[0];
      return { day: pl.days[j], label: top ? top.item.label : 'Card and unscheduled spend' };
    }
  }
  return { day: o.day, label: 'Expected spend' };
}
function backtestRow(policy, alpha = null, product = S.settings.product) {
  return S.bt.summary.find(r => r.productKey === product && r.policy === policy && (alpha === null || r.alpha === alpha));
}

// ---------------------------------------------------------------- routing
function parseHash() {
  const h = location.hash.replace(/^#/, '') || '/autopilot';
  const [path, qs] = h.split('?');
  return { parts: path.split('/').filter(Boolean), q: new URLSearchParams(qs || '') };
}
function route() {
  closeDialog(true);
  if (S.error) return renderError();
  const { parts, q } = parseHash();
  const top = parts[0] || 'autopilot';
  document.querySelectorAll('.nav a[data-nav]').forEach(a => a.toggleAttribute('aria-current', false));
  const navKey = ['autopilot', 'account'].includes(top) ? top : 'autopilot';
  const cur = document.querySelector(`.nav a[data-nav="${navKey}"]`);
  if (cur) cur.setAttribute('aria-current', 'page');
  S.base = computePlan(S.snap.payments, S.settings);
  S.view = computePlan();
  if (top === 'account') renderAccount();
  else if (top === 'autopilot' && parts[1] === 'day' && parts[2]) renderDay(parts[2]);
  else if (top === 'autopilot') renderAutopilot(parts[1] || 'plan', q);
  else renderAutopilot('plan', q);
  if (q.get('order') !== null && top === 'autopilot') openOrder(+q.get('order'));
  if (q.get('dialog') === 'activate') openActivate();
  if (q.get('dialog') === 'export') openExport();
  document.title = top === 'account' ? 'Main Euro Account · Spiko' : 'Cash Autopilot · Spiko';
  paintIcons();
}
const go = (h) => { if (location.hash === h) route(); else location.hash = h; };
function paintIcons() { if (window.lucide) window.lucide.createIcons({ attrs: { 'stroke-width': 1.75 } }); else setTimeout(paintIcons, 60); }
const view = () => document.getElementById('view');

// ---------------------------------------------------------------- skeleton / error
function renderSkeleton() {
  view().innerHTML = `<div aria-busy="true" aria-label="Loading">
    <div class="sk" style="height:300px;border-radius:16px"></div>
    <div class="sk mt24" style="height:36px;width:320px"></div>
    ${Array.from({ length: 5 }, () => '<div class="sk mt8" style="height:58px"></div>').join('')}</div>`;
}
function renderError() {
  view().innerHTML = `<div class="alert alert-error" role="alert">${icon('circle-alert')}<div><b>Couldn't load your plan.</b><br>${esc(S.error.message)}. Check your connection and try again.
    <div class="mt12"><button class="btn btn-outline btn-sm" data-act="reload">${icon('rotate-cw')}Retry</button></div></div></div>`;
  paintIcons();
}

// ---------------------------------------------------------------- hero
function hero(pl) {
  const st = S.status.state;
  const ap = backtestRow('autopilot', S.settings.alpha), th = backtestRow('thirty');
  const extra = th.forgone - ap.forgone;
  const next = decisionOrders(pl).find(o => o.type === 'standard') || decisionOrders(pl)[0];
  const P = PRODUCTS[S.settings.product];
  return `<section class="hero" aria-labelledby="hero-title">
    <div class="hero-top">
      <span class="mark" aria-hidden="true">${icon('zap')}</span>
      <h1 id="hero-title">Cash Autopilot</h1>
      <span class="chip ${st === 'active' ? 'chip-active' : 'chip-draft'}" style="margin-left:6px"><span class="dot"></span>${st === 'active' ? 'Active' : 'Draft'}</span>
      <button class="kebab" type="button" aria-label="Keyboard shortcuts" data-act="shortcuts">${icon('ellipsis-vertical', '', 'style="width:18px;height:18px"')}</button>
      <div class="hero-actions">
        ${st === 'active'
    ? `<button class="btn btn-primary" data-act="pause">${icon('circle-pause')}Pause</button>`
    : `<button class="btn btn-primary" data-act="activate" ${pl.plan.feasible ? '' : 'disabled'}>${icon('circle-check')}Activate</button>`}
        <button class="btn btn-primary" data-act="export">${icon('circle-arrow-down')}Export</button>
        <a class="btn btn-outline" href="#/autopilot/settings">${icon('sliders-horizontal')}Rules</a>
      </div>
    </div>
    <div class="balance-box">
      <div class="lbl">Extra interest per year</div>
      <div class="big tnum">${nf2.format(extra)} <span class="cur">EUR</span></div>
      <div class="sub">vs keeping the next 30 days of payments in the bank · 12 months replayed</div>
    </div>
    <div class="tiles">
      <div class="tilegroup">
        <div class="tile"><div class="lbl">Risk target</div><div class="val blue tnum">${pct(S.settings.alpha)} <a href="#/autopilot/backtest" aria-label="How the risk target is calibrated">${icon('circle-help', 'help')}</a></div></div>
        <div class="tile"><div class="lbl">Uncovered payment days</div><div class="val ${ap.uncovered ? 'red' : 'green'} tnum">${ap.uncovered} of ${ap.days}</div></div>
        <div class="tile"><div class="lbl">Cash in bank, avg</div><div class="val tnum">${eur0(ap.avgIdle)} <span class="muted" style="font-size:13px">was ${eur0(th.avgIdle)}</span></div></div>
      </div>
      <div class="tile-accent"><div class="lbl">Next cut-off</div><div class="val tnum">${next ? `${dshort(next.orderDay)} · ${next.type === 'standard' ? hm(next.orderMinute) : 'instant'}` : 'None'}</div></div>
    </div>
  </section>`;
}

function tabsBar(active) {
  const nOrders = decisionOrders(S.view).length;
  const t = [['plan', 'Plan', nOrders], ['payments', 'Payments', payments().length], ['backtest', 'Backtest'], ['settings', 'Rules']];
  return `<div class="section-head" style="margin:40px 0 0"><div class="tabs" role="tablist" aria-label="Autopilot sections">${t.map(([k, l, c]) =>
    `<a role="tab" href="#/autopilot/${k}" aria-selected="${k === active}" data-key="${k}">${l}${c !== undefined ? `<span class="count">${c}</span>` : ''}</a>`).join('')}</div>
    <span class="muted" style="font-size:13px">Plan as of ${dlong(S.snap.today)}, ${hm(S.snap.nowMin - 1)} Paris</span></div>`;
}

// ---------------------------------------------------------------- autopilot page
function renderAutopilot(tab) {
  const pl = S.view;
  let body = '';
  if (tab === 'payments') body = paymentsTab(pl);
  else if (tab === 'backtest') body = backtestTab();
  else if (tab === 'settings') body = settingsTab();
  else body = planTab(pl);
  view().innerHTML = hero(pl) + tabsBar(['plan', 'payments', 'backtest', 'settings'].includes(tab) ? tab : 'plan') + body;
  if (tab === 'plan' || !['payments', 'backtest', 'settings'].includes(tab)) wireChart(pl);
  if (tab === 'backtest') wireBacktestChart();
}

function infeasibleAlert(pl) {
  if (pl.plan.feasible) return '';
  const b = pl.plan.blocking, d = pl.days[b.day];
  return `<div class="alert alert-error mt16" role="alert">${icon('circle-alert')}<div><b>${esc(b.label)} on ${dlong(d)} can't be fully covered.</b>
    ${eur(b.missing)} would still be missing even if every possible withdrawal were placed right now. Move the payment, lower it, or keep more cash in the bank today.
    ${hasWhatIf() ? '<div class="mt8"><button class="btn btn-outline btn-sm" data-act="reset-whatif">Undo what-if changes</button></div>' : ''}</div></div>`;
}
function whatIfBanner(pl) {
  if (!hasWhatIf()) return '';
  const d = pl.plan.idle / pl.days.length - S.base.plan.idle / S.base.days.length;
  const so = (p) => p.orders.filter(o => o.type === 'standard');
  return `<div class="alert alert-info mt16">${icon('flask-conical')}<div><b>What-if changes are applied.</b> Average cash in bank over the plan ${d >= 0 ? 'rises' : 'falls'} by ${eur0(Math.abs(d))}; standard withdrawals: ${so(S.base).length} → ${so(pl).length}.
    <button class="btn btn-ghost btn-sm" data-act="reset-whatif" style="margin-left:6px">Undo all</button></div></div>`;
}

function planTab(pl) {
  const orders = decisionOrders(pl);
  const st = S.status.state;
  const avgSpend = S.snap.unsched.biz.mean;
  const rows = orders.map(o => {
    const isDep = o.type === 'deposit';
    const title = o.type === 'standard' ? 'Standard withdrawal' : o.type === 'instant' ? 'Instant withdrawal' : 'Deposit';
    const when = o.type === 'standard' ? `Ordered by ${dshort(o.orderDay)}, ${hm(o.orderMinute)}` : o.type === 'instant' ? 'Instant, 24/7' : 'Sweep surplus back';
    const status = st === 'active' ? '<span class="chip chip-active">Scheduled</span>' : '<span class="chip chip-muted">Planned</span>';
    return `<div class="row" role="listitem">
      ${isDep ? icon('circle-arrow-down', 'ic ic-in') : upRight('ic ic-out')}
      <div class="t">${title}<small>${PRODUCTS[o.product].name}</small></div>
      <div class="d">${dlong(o.day)}<small class="muted" style="display:block;font-size:12px;line-height:16px">${esc(when)}</small></div>
      <div class="t">For <a href="#/autopilot/day/${o.reason.day}" style="text-decoration:underline;text-underline-offset:3px">${esc(o.reason.label)}</a><small>Due ${dlong(o.reason.day)}</small></div>
      <div class="amt tnum ${isDep ? 'pos' : ''}">${isDep ? '+ ' : '- '}${eur(o.amount)}</div>
      <div class="st">${status}</div>
      <a class="eye" href="#/autopilot/plan?order=${o.idx}" aria-label="View order details">${icon('eye')}</a>
    </div>`;
  }).join('');
  const idleAvg = pl.plan.idle / pl.days.length;
  return `${infeasibleAlert(pl)}${whatIfBanner(pl)}
  <div class="section-head" style="margin-top:28px"><h2>Upcoming orders</h2>
    <select class="filter-btn" data-setting="horizon" aria-label="Planning window">
      <option value="28" ${S.settings.horizon === 28 ? 'selected' : ''}>Next 4 weeks</option>
      <option value="56" ${S.settings.horizon === 56 ? 'selected' : ''}>Next 8 weeks</option>
    </select></div>
  <div class="card chart-card">
    <div class="chart-head"><div><h3 style="font-size:15px;font-weight:600">Bank account, end of day</h3><div class="hint">Average ${eur0(idleAvg)} kept in the bank · ${eur0(INSTANT_CAP)} instant capacity each morning is the reserve</div></div>
      <div class="legend"><span><i style="background:#d4d4d8"></i>Payments due</span><span><i class="line" style="background:var(--core-blue)"></i>Planned balance</span><span><i class="dash"></i>Must already be in the bank</span><span><i style="background:var(--blue-200)"></i>Withdrawal lands</span></div></div>
    <svg class="chart" id="plan-chart" role="img" aria-label="Planned bank balance and payments over the next ${pl.days.length} days"></svg>
  </div>
  <div class="rows" role="list" aria-label="Upcoming orders">
    ${rows || `<div class="empty">${icon('calendar-check')}<div class="mt8">No orders needed in this window. Instant withdrawals cover every payment as it happens.</div></div>`}
    <div class="row summary compact" role="listitem">${icon('zap', 'ic ic-neutral')}<div class="t">Everyday spend</div><div class="d">Every day</div>
      <div class="t" style="grid-column: span 2">Instant withdrawals as card payments clear<small>About ${eur0(avgSpend)} per business day</small></div><div class="st"><span class="chip chip-muted">Automatic</span></div><span></span></div>
  </div>`;
}

function wireChart(pl) {
  const svg = document.getElementById('plan-chart');
  if (!svg) return;
  const W = svg.clientWidth || 900, Hh = 230, padL = 52, padR = 8, padT = 10, padB = 24;
  const n = pl.days.length, bw = (W - padL - padR) / n;
  const out = pl.fcs.map(x => x.scheduled + x.unschedMean);
  const yMax = Math.max(...out, ...pl.plan.bankEnd, ...pl.plan.reserveNeed) * 1.08 || 1;
  const y = (v) => padT + (Hh - padT - padB) * (1 - v / yMax);
  const x = (i) => padL + i * bw;
  const fund = PRODUCTS[S.settings.product].fund;
  let g = '';
  const ticks = 4;
  for (let t = 0; t <= ticks; t++) {
    const v = yMax / 1.08 * t / ticks, yy = y(v);
    g += `<line x1="${padL}" x2="${W - padR}" y1="${yy}" y2="${yy}" stroke="#f0f0f1"/><text x="${padL - 8}" y="${yy + 4}" text-anchor="end">${v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : Math.round(v / 1e3) + 'k'}</text>`;
  }
  pl.days.forEach((d, i) => {
    if (!S.cal.isFundDay(fund, d)) g += `<rect x="${x(i)}" y="${padT}" width="${bw}" height="${Hh - padT - padB}" fill="#fafafa"/>`;
  });
  pl.days.forEach((d, i) => {
    const h = Hh - padB - y(out[i]);
    g += `<rect x="${x(i) + bw * 0.18}" y="${y(out[i])}" width="${bw * 0.64}" height="${Math.max(0, h)}" rx="2" fill="${pl.binding[i] ? '#a1a1aa' : '#d4d4d8'}"/>`;
    if (pl.plan.standard[i] > 0) g += `<rect x="${x(i) + bw * 0.18}" y="${y(pl.plan.standard[i])}" width="${bw * 0.64}" height="${Math.max(0, Hh - padB - y(pl.plan.standard[i]))}" rx="2" fill="#bedbff" opacity=".9"/>`;
    if (+d.slice(8) === 1 || i === 0) g += `<text x="${x(i) + 2}" y="${Hh - 6}">${+d.slice(8)} ${MO[+d.slice(5, 7) - 1]}</text>`;
    else if (weekday(d) === 1 && n <= 30) g += `<text x="${x(i) + 2}" y="${Hh - 6}">${+d.slice(8)}</text>`;
  });
  // reserve requirement (must already be in the bank at the start of that day)
  pl.days.forEach((d, i) => { const r = pl.plan.reserveNeed[i]; if (r > 0) g += `<line x1="${x(i) + 1}" x2="${x(i) + bw - 1}" y1="${y(r)}" y2="${y(r)}" stroke="#ca3500" stroke-width="2" stroke-dasharray="4 3"/>`; });
  // planned balance as a step line (start-of-day -> end-of-day)
  let path = '';
  pl.days.forEach((d, i) => { const a = pl.plan.bankStart[i], b = pl.plan.bankEnd[i]; path += `${i ? 'L' : 'M'}${x(i)},${y(a)} L${x(i) + bw * 0.5},${y(a)} L${x(i) + bw * 0.5},${y(b)} L${x(i + 1)},${y(b)} `; });
  g += `<path d="${path}" fill="none" stroke="#2376fb" stroke-width="2" stroke-linejoin="round"/>`;
  g += `<line id="hover-line" x1="0" x2="0" y1="${padT}" y2="${Hh - padB}" stroke="#18181b" stroke-opacity=".25" visibility="hidden"/>`;
  svg.setAttribute('viewBox', `0 0 ${W} ${Hh}`);
  svg.innerHTML = g;
  const tip = document.createElement('div'); tip.className = 'tooltip'; tip.style.display = 'none'; document.body.appendChild(tip);
  const hl = svg.querySelector('#hover-line');
  const idxAt = (ev) => { const r = svg.getBoundingClientRect(); const px = (ev.clientX - r.left) * W / r.width; return Math.max(0, Math.min(n - 1, Math.floor((px - padL) / bw))); };
  svg.addEventListener('mousemove', (ev) => {
    const i = idxAt(ev), d = pl.days[i], fc = pl.fcs[i];
    hl.setAttribute('x1', x(i) + bw / 2); hl.setAttribute('x2', x(i) + bw / 2); hl.setAttribute('visibility', 'visible');
    const top = fc.known.slice().sort((a, b) => b.est - a.est).slice(0, 2).map(k => `<div class="r"><span>${esc(k.item.label)}</span><span class="tnum">${eur0(k.est)}</span></div>`).join('');
    tip.innerHTML = `<b>${dlong(d)}</b>${S.cal.isFundDay(fund, d) ? '' : ' <span class="muted">· fund closed</span>'}<div class="mt8">${top || '<span class="muted">No scheduled payments</span>'}</div>
      <div class="r mt8"><span class="muted">Calibrated need</span><span class="tnum">${eur0(pl.U[i])}</span></div>
      <div class="r"><span class="muted">In bank at start</span><span class="tnum">${eur0(pl.plan.bankStart[i])}</span></div>
      ${pl.plan.standard[i] ? `<div class="r"><span class="muted">Withdrawal lands</span><span class="tnum">${eur0(pl.plan.standard[i])}</span></div>` : ''}
      <div class="muted mt8">Click for the day breakdown</div>`;
    tip.style.display = 'block';
    const tx = Math.min(window.innerWidth - 240, ev.clientX + 14);
    tip.style.left = tx + 'px'; tip.style.top = (ev.clientY + 14) + 'px';
  });
  svg.addEventListener('mouseleave', () => { tip.style.display = 'none'; hl.setAttribute('visibility', 'hidden'); });
  svg.addEventListener('click', (ev) => { tip.remove(); go(`#/autopilot/day/${pl.days[idxAt(ev)]}`); });
  svg.style.cursor = 'pointer';
  const obs = new MutationObserver(() => { if (!document.body.contains(svg)) { tip.remove(); obs.disconnect(); } });
  obs.observe(view(), { childList: true });
}

// ---------------------------------------------------------------- payments tab (what-if)
function paymentsTab(pl) {
  const pays = payments();
  const { q } = parseHash();
  const filter = q.get('filter') || 'all';
  const heavyDays = new Set(pl.fcs.filter(f => f.cls === 'heavy').map(f => f.day));
  const shown = pays.filter(p => filter === 'all' || (filter === 'heavy' ? heavyDays.has(p.due) : p.cv > 0.002));
  const catIcon = { payroll: 'users', social: 'landmark', vat: 'receipt-euro', rent: 'building-2', cloud: 'server', supplier: 'file-text', tax: 'landmark', manual: 'pencil' };
  const rows = shown.map(p => `<tr class="${p.edited || p.added ? 'hl' : ''}">
      <td style="width:32px">${icon(catIcon[p.cat] || 'file-text', '', 'style="width:16px;height:16px;color:#52525c"')}</td>
      <td>${esc(p.label)}<div class="muted" style="font-size:12px">${esc(p.counterparty || '')}</div></td>
      <td><input type="date" value="${p.due}" min="${S.snap.today}" max="${addDays(S.snap.today, S.settings.horizon - 1)}" data-edit="due" data-id="${p.id}" aria-label="Due date for ${esc(p.label)}"></td>
      <td class="num"><input type="number" step="1000" min="0" value="${Math.round(p.est)}" data-edit="est" data-id="${p.id}" aria-label="Amount for ${esc(p.label)}"></td>
      <td>${p.added ? '<span class="chip chip-info">Added</span>' : p.edited ? '<span class="chip chip-info">Edited</span>' : p.cv <= 0.002 ? '<span class="chip chip-active">Final</span>' : p.cv >= 0.04 ? `<span class="chip chip-muted">Projected ±${(p.cv * 100).toFixed(0)}%</span>` : `<span class="chip chip-warn">Estimate ±${(p.cv * 100).toFixed(1)}%</span>`}</td>
      <td class="num"><button class="btn btn-ghost btn-sm" data-act="remove-payment" data-id="${p.id}" aria-label="Remove ${esc(p.label)}">${icon('trash-2')}</button></td></tr>`).join('');
  return `${infeasibleAlert(pl)}${whatIfBanner(pl)}
  <div class="section-head" style="margin-top:28px"><h2>Scheduled payments</h2>
    <div class="flex"><select class="filter-btn" data-filter="payments" aria-label="Filter payments">
      <option value="all" ${filter === 'all' ? 'selected' : ''}>All payments</option><option value="heavy" ${filter === 'heavy' ? 'selected' : ''}>Payment-heavy days</option><option value="estimate" ${filter === 'estimate' ? 'selected' : ''}>Estimates only</option></select>
      <button class="btn btn-primary" data-act="add-payment">${icon('plus')}Add payment</button></div></div>
  <p class="muted" style="margin:-8px 0 4px">From your connected bank and payroll provider. Change a date or amount to see the plan update instantly; nothing is sent until Autopilot is active.</p>
  ${shown.length ? `<table class="tbl"><thead><tr><th></th><th>Payment</th><th>Due</th><th class="num">Amount (EUR)</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
    : `<div class="empty">${icon('search-x')}<div class="mt8">No payments match this filter.</div></div>`}`;
}

// ---------------------------------------------------------------- backtest tab
function backtestTab() {
  const prod = S.settings.product, a = S.settings.alpha;
  const rows = [
    ['autopilot', a, `Cash Autopilot, ${pct(a, 0)} risk target`, 'Optimal plan with calibrated margins'],
    ['point', null, 'Same planner, no calibrated margin', 'Point forecast plus the minimum balance'],
    ['thirty', null, 'Keep the next 30 days in the bank', 'Common treasury rule of thumb'],
    ['duedate', null, 'Withdraw on the due date', 'Instant withdrawal when each payment falls due'],
  ].map(([p, al, name, sub]) => ({ r: backtestRow(p, al, prod), name, sub, p }));
  const cov = S.bt.coverage;
  const hl = backtestRow('autopilot', a, prod);
  return `<div class="section-head" style="margin-top:28px"><h2>Backtest</h2><span class="muted">${dlong(S.bt.window.from)} to ${dlong(S.bt.window.to)} · ${PRODUCTS[prod].name} cut-offs</span></div>
  <p class="muted" style="margin:-8px 0 0">Each policy replays the same 365 days of payments, receipts and card spend. Autopilot re-plans every morning at 09:00 using only what was known then. Interest is valued at Spiko T-Bills Euro's published NAV returns.</p>
  <table class="tbl mt12"><thead><tr><th>Policy</th><th class="num">Cash in bank, avg</th><th class="num">Interest given up</th><th class="num">Uncovered days</th><th class="num">Standard orders</th></tr></thead><tbody>
  ${rows.map(({ r, name, sub, p }) => `<tr class="${p === 'autopilot' ? 'hl' : ''}"><td><b style="font-weight:600">${name}</b><div class="muted" style="font-size:12px">${sub}</div></td>
    <td class="num">${eur(r.avgIdle)}</td><td class="num">${eur(r.forgone)}</td>
    <td class="num">${r.uncovered ? `<span class="chip chip-error">${r.uncovered} days · ${eur0(r.uncoveredAmt)}</span>` : '<span class="chip chip-active">0</span>'}</td><td class="num">${r.orders.standard}</td></tr>`).join('')}
  </tbody></table>
  <div class="grid2 mt16">
    <div class="card card-pad"><h3>Does the risk target hold?</h3><div class="hint">Share of days whose outflow beat the calibrated need, measured 1 to 3 days ahead (the window in which a withdrawal must already be ordered). Bounds are recalibrated each month on the previous 24 months.</div>
      <table class="tbl mt8"><thead><tr><th>Target</th><th class="num">Payment-heavy days</th><th class="num">Other days</th></tr></thead><tbody>
      ${cov.map(c => `<tr class="${c.alpha === a ? 'hl' : ''}"><td>${pct(c.alpha, 0)}</td><td class="num">${pct(c.heavy.rate, 1)} <span class="muted">(${c.heavy.miss}/${c.heavy.n})</span></td><td class="num">${pct(c.light.rate, 1)} <span class="muted">(${c.light.miss}/${c.light.n})</span></td></tr>`).join('')}
      </tbody></table><div class="hint mt8">At 10% the payment-heavy rate runs above target: payroll grows about 1% a month, so last year's errors understate this year's. Autopilot therefore offers 1 to 5%.</div></div>
    <div class="card card-pad"><h3>Why the due-date rule breaks</h3><div class="hint">Instant withdrawals are capped at €500,000 per day. Payroll, URSSAF and VAT days exceed it, so cash has to be ordered ahead of the cut-off.</div>
      <div class="mt12">${S.bt.daily[`${prod}|duedate`].filter(r => r[6] > 0).slice(0, 6).map(r => `<div class="kv"><span class="k">${dlong(r[0])}</span><span class="v tnum">${eur0(r[1])} due · <span style="color:var(--red-700)">${eur0(r[6])} short</span></span></div>`).join('')}</div></div>
  </div>
  <div class="card card-pad mt16"><h3>Fixed buffer or calibrated margin?</h3><div class="hint">Same planner, Spiko Euro cut-offs. Left: protect payments with a minimum balance only. Right: no minimum balance, calibrated margins at each risk target.</div>
    <table class="tbl mt8"><thead><tr><th>Protection</th><th class="num">Cash in bank, avg</th><th class="num">Interest given up</th><th class="num">Uncovered days</th></tr></thead><tbody>
    ${S.bt.frontier.map(f => `<tr class="${f.kind === 'calibrated' && f.alpha === a ? 'hl' : ''}"><td>${f.kind === 'fixed' ? `Minimum balance ${eur0(f.floor)}, no margin` : `Calibrated margin, ${pct(f.alpha, 0)} target, no minimum`}</td><td class="num">${eur(f.avgIdle)}</td><td class="num">${eur(f.forgone)}</td><td class="num">${f.uncovered ? `<span class="chip chip-error">${f.uncovered} · ${eur0(f.uncoveredAmt)}</span>` : '<span class="chip chip-active">0</span>'}</td></tr>`).join('')}
    </tbody></table><div class="hint mt8">A fixed buffer only works if you guess its size right in advance; the calibrated margin is sized from your own forecast errors and grows only on the days that need it.</div></div>
  <div class="card chart-card mt16"><div class="chart-head"><div><h3 style="font-size:15px;font-weight:600">Cash in bank, end of day</h3><div class="hint">Autopilot keeps ${eur0(hl.avgIdle)} on average; the 30-day rule keeps ${eur0(backtestRow('thirty', null, prod).avgIdle)}.</div></div>
    <div class="legend"><span><i class="line" style="background:var(--core-blue)"></i>Autopilot</span><span><i class="line" style="background:#a1a1aa"></i>30-day rule</span></div></div>
    <svg class="chart" id="bt-chart" role="img" aria-label="Bank balance over the backtest year, Autopilot versus the 30-day rule"></svg></div>`;
}
function wireBacktestChart() {
  const svg = document.getElementById('bt-chart'); if (!svg) return;
  const prod = S.settings.product;
  const A = S.bt.daily[`${prod}|autopilot`], T = S.bt.daily[`${prod}|thirty`];
  const W = svg.clientWidth || 900, Hh = 230, padL = 52, padR = 8, padT = 10, padB = 24, n = A.length;
  const yMax = Math.max(...T.map(r => r[5]), ...A.map(r => r[5])) * 1.05;
  const x = i => padL + (W - padL - padR) * i / (n - 1), y = v => padT + (Hh - padT - padB) * (1 - v / yMax);
  let g = '';
  for (let t = 0; t <= 4; t++) { const v = yMax / 1.05 * t / 4; g += `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" stroke="#f0f0f1"/><text x="${padL - 8}" y="${y(v) + 4}" text-anchor="end">${v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : Math.round(v / 1e3) + 'k'}</text>`; }
  A.forEach((r, i) => { if (r[0].endsWith('-01')) g += `<text x="${x(i)}" y="${Hh - 6}">${MO[+r[0].slice(5, 7) - 1]}</text>`; });
  const line = (rows, c) => `<path d="${rows.map((r, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(r[5]).toFixed(1)}`).join('')}" fill="none" stroke="${c}" stroke-width="1.6"/>`;
  g += line(T, '#a1a1aa') + line(A, '#2376fb');
  svg.setAttribute('viewBox', `0 0 ${W} ${Hh}`); svg.innerHTML = g;
}

// ---------------------------------------------------------------- settings (rules) tab
function settingsTab() {
  const s = S.settings;
  const prodCard = (k) => { const p = S.snap.products[k]; return `<div class="radio-card" role="radio" tabindex="0" aria-checked="${s.product === k}" data-product="${k}">
    <span class="rc-dot"></span><div><div style="font-weight:500">${p.name} <span class="muted" style="font-weight:400">· ${pct(p.yield.monthly)} current yield</span></div>
    <div class="muted" style="font-size:13px;line-height:18px;margin-top:2px">${k === 'eurSAFO' ? 'Standard withdrawals ordered before 15:00 land the next business day.' : 'Standard withdrawals ordered before 11:30 land the same day.'} Instant withdrawals up to €500,000 a day, 24/7.</div></div></div>`; };
  const calib = S.snap.calib[String(s.alpha)];
  const k = bucketKey('heavy', 2);
  return `<div class="section-head" style="margin-top:28px"><h2>Rules</h2><span class="muted">Saved automatically</span></div>
  <div class="card card-pad">
    <div class="field"><div><div class="lbl">Withdraw from</div><div class="desc">Autopilot moves cash between this product and your operating account.</div></div><div role="radiogroup" aria-label="Source product">${prodCard('eurSAFO')}${prodCard('EUTBL')}</div></div>
    <div class="field"><div><div class="lbl">Risk target</div><div class="desc">Largest share of payment days on which a payment could exceed the cash already in the bank plus that day's instant capacity.</div></div>
      <div><div class="seg" role="group" aria-label="Risk target">${[0.01, 0.02, 0.05].map(a => `<button type="button" aria-pressed="${s.alpha === a}" data-alpha="${a}">${pct(a, 0)}</button>`).join('')}</div>
      <div class="muted mt8" style="font-size:13px">At ${pct(s.alpha, 0)}, a 2-day-ahead forecast on a payment-heavy day gets a margin of ${calib[k].q.toFixed(2)}σ (${calib[k].method === 'conformal' ? `split-conformal quantile of ${calib[k].n} past days` : 'Chebyshev fallback, not enough history'}).</div></div></div>
    <div class="field"><div><div class="lbl">Minimum balance</div><div class="desc">Cash that always stays in the operating account.</div></div>
      <div class="flex"><input class="input tnum" type="number" min="0" step="5000" value="${s.floor}" data-setting="floor" aria-label="Minimum balance in EUR" style="width:160px"><span class="muted">EUR</span></div></div>
    <div class="field"><div><div class="lbl">Approvals</div><div class="desc">Four-eyes mode still applies: withdrawals above your approval threshold wait for a second approver before the cut-off.</div></div>
      <div class="muted" style="font-size:13px;line-height:18px">Autopilot submits each standard withdrawal on its last possible business day, so approvers get the whole morning before the ${hm(PRODUCTS[s.product].cutoffMin - 1)} cut-off.</div></div>
    <div class="field"><div><div class="lbl">Reset</div><div class="desc">Restore default rules and remove what-if changes.</div></div><div><button class="btn btn-outline" data-act="reset-all">${icon('rotate-ccw')}Reset to defaults</button></div></div>
  </div>`;
}

// ---------------------------------------------------------------- day drill-down
function renderDay(day) {
  const pl = S.view;
  const k = pl.days.indexOf(day);
  if (k < 0) {
    view().innerHTML = `<div class="crumbs"><a href="#/autopilot">Autopilot</a>${icon('chevron-right')}<span>${esc(day)}</span></div>
      <div class="alert alert-warn">${icon('triangle-alert')}<div><b>This day is outside the planning window.</b> Plans cover ${dlong(pl.days[0])} to ${dlong(pl.days.at(-1))}. <a href="#/autopilot" style="text-decoration:underline">Back to the plan</a></div></div>`;
    return;
  }
  const fc = pl.fcs[k], b = pl.bounds[k], P = PRODUCTS[S.settings.product];
  const cap = INSTANT_CAP, floor = S.settings.floor;
  const reserve = pl.plan.reserveNeed[k];
  const start = pl.plan.bankStart[k];
  const heavyIdx = pl.days.map((d, i) => i).filter(i => pl.fcs[i].scheduled > 0);
  const prev = [...heavyIdx].reverse().find(i => i < k), next = heavyIdx.find(i => i > k);
  // where the morning cash comes from: the latest standard arrival(s) before this day
  const arrivals = pl.orders.filter(o => o.type === 'standard' && o.day < day && diffDays(o.day, day) <= 7);
  const instantsBefore = pl.orders.filter(o => o.type === 'instant' && o.day < day && diffDays(o.day, day) <= 4 && o.amount >= 50000);
  const h = diffDays(S.snap.today, day);
  const weekStart = addDays(day, -((weekday(day) + 6) % 7));
  const week = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const status = reserve > 0 ? (start + 1e-6 >= reserve ? ['chip-active', 'Covered by pre-positioned cash'] : ['chip-error', 'Not covered']) : ['chip-muted', 'Instant withdrawals are enough'];
  const scale = Math.max(fc.f, b.U + floor, start + cap) || 1;
  view().innerHTML = `
  <div class="crumbs"><a href="#/autopilot">Autopilot</a>${icon('chevron-right')}<span style="color:var(--zinc-900)">${dlong(day)}</span>
    <span style="margin-left:auto" class="flex"><span class="kbd">←</span><span class="kbd">→</span><span class="muted" style="font-size:12px">payment days</span>
    <a class="icon-btn" href="${prev !== undefined ? `#/autopilot/day/${pl.days[prev]}` : '#/autopilot'}" aria-label="Previous payment day">${icon('chevron-left')}</a>
    <a class="icon-btn" href="${next !== undefined ? `#/autopilot/day/${pl.days[next]}` : '#/autopilot'}" aria-label="Next payment day">${icon('chevron-right')}</a></span></div>
  <section class="hero" style="padding:24px 26px">
    <div class="hero-top"><span class="mark" aria-hidden="true">${icon('calendar-days')}</span><h1>${dlong(day)}</h1><span class="chip ${status[0]}" style="margin-left:6px">${status[1]}</span>
      <div class="hero-actions"><a class="btn btn-outline" href="#/autopilot/payments">${icon('pencil')}Edit payments</a></div></div>
    <div class="tiles" style="margin-top:22px">
      <div class="tilegroup">
        <div class="tile"><div class="lbl">Expected outflow</div><div class="val tnum">${eur(fc.f)}</div></div>
        <div class="tile"><div class="lbl">Calibrated need (${pct(S.settings.alpha, 0)} risk)</div><div class="val blue tnum">${eur(b.U)}</div></div>
        <div class="tile"><div class="lbl">Must already be in the bank</div><div class="val tnum">${eur(reserve)}</div></div>
      </div>
      <div class="tile-accent"><div class="lbl">In the bank that morning</div><div class="val tnum">${eur0(start)}</div></div>
    </div>
  </section>
  <div class="grid2 mt24">
    <div class="card card-pad"><h3>Payments due</h3>
      ${fc.known.length ? fc.known.slice().sort((a, c) => c.est - a.est).map(x => `<div class="kv"><span class="k" style="color:var(--zinc-900)">${esc(x.item.label)}<div class="muted" style="font-size:12px">${x.final ? 'Final amount' : x.cv >= 0.04 ? `Projected from past months, ±${(x.cv * 100).toFixed(0)}%` : `Estimate, ±${(x.cv * 100).toFixed(1)}%`}</div></span><span class="v tnum">${eur(x.est)}</span></div>`).join('') : '<div class="hint mt8">No scheduled payments.</div>'}
      <div class="kv"><span class="k">Card spend and direct debits (expected)</span><span class="v tnum">${eur(fc.unschedMean)}</span></div>
    </div>
    <div class="card card-pad"><h3>How the need is calibrated</h3>
      <div class="kv"><span class="k">Forecast</span><span class="v tnum">${eur(fc.f)}</span></div>
      <div class="kv"><span class="k">Scale σ (estimate spread + card spend)</span><span class="v tnum">${eur(fc.sigma)}</span></div>
      <div class="kv"><span class="k">Multiplier q (${fc.cls === 'heavy' ? 'payment-heavy' : 'ordinary'} day, ${Math.min(h, 4)}${h >= 4 ? '+' : ''} days ahead)</span><span class="v tnum">${b.q.toFixed(2)}</span></div>
      <div class="kv"><span class="k">Calibrated on</span><span class="v">${b.method === 'conformal' ? `${b.n} past days, split-conformal` : 'Chebyshev fallback'}</span></div>
      <div class="kv"><span class="k">Margin q × σ</span><span class="v tnum">${eur(b.margin)}</span></div>
      <div class="kv"><span class="k"><b>Calibrated need</b></span><span class="v tnum"><b>${eur(b.U)}</b></span></div>
    </div>
  </div>
  <div class="card card-pad mt16"><h3>How it is covered</h3>
    <div class="hint">That morning the bank needs the calibrated need plus the ${eur0(floor)} minimum. Instant withdrawals bring up to ${eur0(cap)} within minutes; the rest has to be in the account already.</div>
    <div class="waterfall" aria-hidden="true"><div style="width:${100 * Math.min(start, scale) / scale}%;background:#2376fb"></div><div style="width:${100 * Math.min(cap, scale - Math.min(start, scale)) / scale}%;background:#bedbff"></div></div>
    <div class="flex" style="font-size:12px;color:var(--zinc-600);gap:16px"><span class="flex"><i style="width:10px;height:10px;border-radius:2px;background:#2376fb;display:inline-block"></i>Already in the bank ${eur0(start)}</span><span class="flex"><i style="width:10px;height:10px;border-radius:2px;background:#bedbff;display:inline-block"></i>Instant capacity ${eur0(cap)}</span><span>Need ${eur0(b.U + floor)}</span></div>
    ${arrivals.length || instantsBefore.length ? `<div class="mt12">${arrivals.map(o => `<div class="kv"><span class="k">Standard withdrawal lands ${dshort(o.day)}, ordered ${dshort(o.orderDay)} before ${hm(o.orderMinute)}</span><span class="v tnum">${eur(o.amount)}</span></div>`).join('')}${instantsBefore.map(o => `<div class="kv"><span class="k">Instant withdrawal on ${dshort(o.day)} (${S.cal.isFundDay(P.fund, o.day) ? 'cheaper than landing it a day earlier' : 'fund closed, instant still runs 24/7'})</span><span class="v tnum">${eur(o.amount)}</span></div>`).join('')}</div>` : ''}
  </div>
  <div class="card card-pad mt16"><h3>Week calendar · ${P.name}</h3><div class="hint">Hatched days: the fund does not process withdrawals (weekends and the fund's published non-operating days).</div>
    <div class="week">${week.map(d => {
      const open = S.cal.isFundDay(P.fund, d), sepa = S.cal.isSepaDay(d);
      const ev = [];
      pl.orders.filter(o => o.type === 'standard' && o.orderDay === d).forEach(o => ev.push(`<span style="color:var(--orange-700)">Order by ${hm(o.orderMinute)}</span>`));
      pl.orders.filter(o => o.type === 'standard' && o.day === d).forEach(o => ev.push(`<span style="color:var(--blue-700)">${eur0(o.amount)} lands</span>`));
      const i = pl.days.indexOf(d);
      if (i >= 0 && pl.fcs[i].scheduled > 0) ev.push(`${eur0(pl.fcs[i].scheduled)} due`);
      return `<div class="wd ${open ? '' : 'closed'} ${d === day ? 'sel' : ''}"><div class="dn">${WD[weekday(d)]} ${+d.slice(8)}</div><div class="ev">${open ? 'Fund open' : 'Fund closed'}${sepa ? '' : ' · no SEPA'}</div>${ev.map(e => `<div class="ev">${e}</div>`).join('')}</div>`;
    }).join('')}</div>
  </div>`;
}

// ---------------------------------------------------------------- account page (existing screen)
function renderAccount() {
  const s = S.snap, p = s.products.eurSAFO;
  const bal = s.fund.eurSAFO;
  const navs = p.nav; const interest = bal * (1 - 1 / navs[1]);
  const st = S.status.state;
  const rows = [];
  const hist = s.history.slice().reverse();
  const daily = p.yield.daily / 365;
  for (const r of hist.slice(0, 12)) {
    const [d, , inst, arr, dep] = [r.d, r.out, r.inst, r.arr, r.dep];
    if (inst > 0) rows.push(['Withdrawal', d, -inst, 'out']);
    if (arr > 0) rows.push(['Withdrawal', d, -arr, 'out']);
    if (dep > 0) rows.push(['Deposit', d, dep, 'in']);
    rows.push(['Yield', d, bal * daily, 'yield']);
  }
  const secs = 24 * 3600 - s.nowMin * 60; // next accrual at midnight Paris
  const cd = [Math.floor(secs / 3600), Math.floor(secs / 60) % 60, secs % 60].map(v => String(v).padStart(2, '0')).join(' : ');
  view().innerHTML = `<section class="hero" aria-labelledby="acc-title">
    <div class="hero-top"><img src="assets/spiko-token.svg" alt="" width="30" height="30"><h1 id="acc-title">Main Euro Account</h1>
      <button class="kebab" type="button" aria-label="Account options">${icon('ellipsis-vertical', '', 'style="width:18px;height:18px"')}</button>
      <a class="chip ${st === 'active' ? 'chip-active' : 'chip-info'}" href="#/autopilot" style="margin-left:2px">${icon('zap', '', 'style="width:12px;height:12px"')}Autopilot ${st === 'active' ? 'on' : 'available'}</a>
      <div class="hero-actions"><button class="btn btn-primary" data-act="noop">${icon('circle-arrow-down')}Deposit</button><button class="btn btn-primary" data-act="noop">${upRight()}Withdraw</button><button class="btn btn-outline" data-act="noop">${leftRight()}Transfer</button></div></div>
    <div class="balance-box"><div class="lbl">Balance</div><div class="big tnum">${nf2.format(bal)} <span class="cur">EUR</span></div></div>
    <div class="tiles"><div class="tilegroup"><div class="tile"><div class="lbl">Current Yield</div><div class="val blue tnum">${pct(p.yield.daily)} ${icon('circle-help', 'help')}</div></div>
      <div class="tile"><div class="lbl">Interest earned</div><div class="val green tnum">+ €${nf2.format(interest)}</div></div></div>
      <div class="tile-accent"><div class="lbl">Next accrual</div><div class="val tnum">${cd}</div></div></div>
  </section>
  <div class="section-head"><h2>Transactions</h2><button class="filter-btn" type="button">${icon('list-filter')}<span style="margin-left:auto">Filters</span>${icon('chevron-down')}</button></div>
  <div class="rows" role="list">${rows.slice(0, 14).map(([t, d, a, k]) => `<div class="row acct" role="listitem">
    ${k === 'out' ? upRight('ic ic-out') : icon(k === 'in' ? 'circle-arrow-down' : 'circle-plus', `ic ${k === 'in' ? 'ic-in' : 'ic-yield'}`)}
    <div class="t">${t}</div><div class="d">${dlong(d)}</div><div class="amt tnum ${k === 'yield' ? 'pos' : ''}">${signed(a)}</div><span></span>
    ${k === 'yield' ? '<span></span>' : `<button class="eye" aria-label="View transaction">${icon('eye')}</button>`}</div>`).join('')}</div>`;
}

// ---------------------------------------------------------------- dialogs
function openDialog(html, cls = '') {
  closeDialog(true);
  const o = document.createElement('div'); o.className = 'overlay'; o.id = 'overlay';
  o.innerHTML = `<div class="dialog ${cls}" role="dialog" aria-modal="true" aria-labelledby="dlg-title">${html}</div>`;
  o.addEventListener('mousedown', (e) => { if (e.target === o) closeDialog(); });
  document.body.appendChild(o); paintIcons();
  const f = o.querySelector('[data-autofocus]') || o.querySelector('button, input, a'); if (f) f.focus();
}
function closeDialog(silent) {
  const o = document.getElementById('overlay'); if (!o) return;
  o.remove();
  if (!silent) { const { parts, q } = parseHash(); if (q.has('order') || q.has('dialog')) { q.delete('order'); q.delete('dialog'); const s = q.toString(); history.replaceState(null, '', `#/${parts.join('/')}${s ? '?' + s : ''}`); } }
}
function openOrder(idx) {
  const pl = S.view, o = pl.orders[idx];
  if (!o) return toast('Order not found', 'That order is no longer part of the plan.', 'circle-alert');
  const api = toInvestorApi(o, { ...IDS, shareClassId: S.snap.products[o.product].shareClassId });
  const reason = coverReason(pl, diffDays(pl.today, o.day), o);
  openDialog(`<button class="x" data-act="close" aria-label="Close">${icon('x')}</button><h2 id="dlg-title">${o.type === 'standard' ? 'Standard withdrawal' : o.type === 'instant' ? 'Instant withdrawal' : 'Deposit'} · ${eur(o.amount)}</h2>
    <div class="desc">${PRODUCTS[o.product].name} → ${esc(S.snap.bank.name)} (${esc(S.snap.bank.iban)})</div>
    <div class="mt16">
      ${o.type === 'standard' ? `<div class="kv"><span class="k">Submitted</span><span class="v">${dlong(o.orderDay)}, before ${hm(o.orderMinute)} Paris</span></div><div class="kv"><span class="k">Cash lands</span><span class="v">${dlong(o.day)}, afternoon (SEPA)</span></div>` : `<div class="kv"><span class="k">Executed</span><span class="v">${dlong(o.day)}</span></div>`}
      <div class="kv"><span class="k">Covers</span><span class="v"><a href="#/autopilot/day/${reason.day}" style="text-decoration:underline">${esc(reason.label)}</a>, ${dshort(reason.day)}</span></div>
      <div class="kv"><span class="k">Status</span><span class="v">${S.status.state === 'active' ? '<span class="chip chip-active">Scheduled</span>' : '<span class="chip chip-muted">Planned (Autopilot is in draft)</span>'}</span></div>
    </div>
    <div class="mt16" style="font-weight:500">Investor API request</div><div class="hint muted" style="font-size:12px">${api.endpoint} · placeholder account IDs, real share class ID</div>
    <pre class="code">${esc(JSON.stringify(api.body, null, 2))}</pre>
    <div class="foot"><button class="btn btn-outline" data-act="copy-json" data-idx="${idx}">${icon('copy')}Copy</button><button class="btn btn-primary" data-act="close" data-autofocus>Done</button></div>`);
}
function openActivate() {
  const pl = S.view, ords = decisionOrders(pl), std = ords.filter(o => o.type === 'standard');
  if (!pl.plan.feasible) return toast('Plan needs attention', 'Resolve the uncovered payment before activating.', 'circle-alert');
  openDialog(`<button class="x" data-act="close" aria-label="Close">${icon('x')}</button><h2 id="dlg-title">Activate Cash Autopilot</h2>
    <div class="desc">Autopilot will place withdrawals and sweeps on your behalf, within these rules. You can pause it at any time.</div>
    <div class="mt16">
      <div class="kv"><span class="k">Withdraw from</span><span class="v">${PRODUCTS[S.settings.product].name}</span></div>
      <div class="kv"><span class="k">Risk target</span><span class="v">${pct(S.settings.alpha, 0)} of payment days</span></div>
      <div class="kv"><span class="k">Minimum balance</span><span class="v">${eur(S.settings.floor)}</span></div>
      <div class="kv"><span class="k">Orders in the next ${pl.days.length / 7} weeks</span><span class="v">${std.length} standard, ${ords.length - std.length} large instant</span></div>
      ${std[0] ? `<div class="kv"><span class="k">First order</span><span class="v">${eur(std[0].amount)} on ${dshort(std[0].orderDay)} before ${hm(std[0].orderMinute)}</span></div>` : ''}
    </div>
    <label class="flex mt16" style="align-items:flex-start;font-size:13px;line-height:18px"><input type="checkbox" id="ack" style="margin-top:2px"> I understand withdrawals above our approval threshold still need a second approver (four-eyes mode).</label>
    <div class="foot"><button class="btn btn-outline" data-act="close">Cancel</button><button class="btn btn-primary" data-act="confirm-activate" id="confirm-activate" disabled>${icon('circle-check')}Activate</button></div>`);
}
function openExport() {
  const pl = S.view;
  const rows = csvRows(pl);
  openDialog(`<button class="x" data-act="close" aria-label="Close">${icon('x')}</button><h2 id="dlg-title">Export plan</h2>
    <div class="desc">${pl.orders.length} orders over ${pl.days.length} days, ${PRODUCTS[S.settings.product].name}, ${pct(S.settings.alpha, 0)} risk target.</div>
    <pre class="code" style="max-height:220px">${esc(rows.slice(0, 8).map(r => r.join(',')).join('\n'))}${rows.length > 8 ? '\n…' : ''}</pre>
    <div class="foot"><button class="btn btn-outline" data-act="download-json">${icon('braces')}Investor API JSON</button><button class="btn btn-primary" data-act="download-csv" data-autofocus>${icon('file-spreadsheet')}Download CSV</button></div>`, 'wide');
}
function openShortcuts() {
  openDialog(`<button class="x" data-act="close" aria-label="Close">${icon('x')}</button><h2 id="dlg-title">Keyboard shortcuts</h2>
    <div class="mt16">${[['1 – 4', 'Plan, Payments, Backtest, Rules'], ['← / →', 'Previous / next payment day (day view)'], ['e', 'Export plan'], ['a', 'Activate or pause'], ['?', 'This list'], ['Esc', 'Close dialog']]
    .map(([k, v]) => `<div class="kv"><span class="k">${v}</span><span class="v"><span class="kbd">${k}</span></span></div>`).join('')}</div>
    <div class="foot"><button class="btn btn-primary" data-act="close" data-autofocus>Close</button></div>`);
}
function openAddPayment() {
  const d = addDays(S.snap.today, 7);
  openDialog(`<button class="x" data-act="close" aria-label="Close">${icon('x')}</button><h2 id="dlg-title">Add a payment</h2>
    <div class="desc">A one-off outflow, for example a large supplier invoice or a tax installment.</div>
    <form id="add-form" class="mt16">
      <label class="field" style="grid-template-columns:140px 1fr;padding:10px 0"><span class="lbl">Label</span><input class="input" name="label" required value="Hardware purchase" data-autofocus></label>
      <label class="field" style="grid-template-columns:140px 1fr;padding:10px 0"><span class="lbl">Due date</span><input class="input" name="due" type="date" required min="${S.snap.today}" max="${addDays(S.snap.today, S.settings.horizon - 1)}" value="${d}"></label>
      <label class="field" style="grid-template-columns:140px 1fr;padding:10px 0"><span class="lbl">Amount (EUR)</span><input class="input" name="est" type="number" min="1" step="any" required value="250000"></label>
      <div id="add-err" class="alert alert-error" style="display:none" role="alert"></div>
      <div class="foot"><button type="button" class="btn btn-outline" data-act="close">Cancel</button><button type="submit" class="btn btn-primary">${icon('plus')}Add and re-plan</button></div>
    </form>`);
  document.getElementById('add-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target), est = +f.get('est'), due = f.get('due'), label = String(f.get('label')).trim();
    const err = document.getElementById('add-err');
    if (!label || !(est > 0) || !due || due < S.snap.today || diffDays(S.snap.today, due) >= S.settings.horizon) {
      err.style.display = 'flex'; err.textContent = `Enter a label, a positive amount and a date between ${dlong(S.snap.today)} and ${dlong(addDays(S.snap.today, S.settings.horizon - 1))}.`; return;
    }
    S.whatif.added.push({ id: 'u' + Date.now().toString(36), due, est, label, cat: 'manual', counterparty: 'Added manually' });
    save(LS.whatif, S.whatif); closeDialog(); toast('Payment added', `${label}, ${eur(est)} on ${dshort(due)}. The plan was re-optimised.`); route();
  });
}

// ---------------------------------------------------------------- export
function csvRows(pl) {
  const head = ['order_type', 'product', 'share_class_id', 'submit_by_date', 'submit_by_time_paris', 'cash_lands', 'amount_eur', 'covers_payment', 'covers_date'];
  return [head].concat(pl.orders.map(o => { const r = coverReason(pl, diffDays(pl.today, o.day), o); return [o.type, PRODUCTS[o.product].name, S.snap.products[o.product].shareClassId, o.orderDay || '', o.type === 'standard' ? hm(o.orderMinute) : '', o.day, o.amount.toFixed(2), `"${r.label.replace(/"/g, '""')}"`, r.day]; }));
}
function download(name, text, type) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

// ---------------------------------------------------------------- toasts
function toast(title, msg, ic = 'circle-check') {
  const t = document.createElement('div'); t.className = 'toast';
  t.innerHTML = `${icon(ic)}<div><b>${esc(title)}</b>${esc(msg)}</div>`;
  document.getElementById('toasts').appendChild(t); paintIcons();
  setTimeout(() => t.remove(), 4200);
}

// ---------------------------------------------------------------- events
function onClick(e) {
  const el = e.target.closest('[data-act], [data-alpha], [data-product]');
  if (!el) return;
  if (el.dataset.alpha) { S.settings.alpha = +el.dataset.alpha; save(LS.settings, S.settings); toast('Risk target updated', `Plans now target ${pct(S.settings.alpha, 0)} of payment days.`); return route(); }
  if (el.dataset.product) { S.settings.product = el.dataset.product; save(LS.settings, S.settings); toast('Source product updated', `Withdrawals now come from ${PRODUCTS[S.settings.product].name}.`); return route(); }
  const act = el.dataset.act;
  if (act === 'close') return closeDialog();
  if (act === 'activate') return openActivate();
  if (act === 'export') return openExport();
  if (act === 'shortcuts') return openShortcuts();
  if (act === 'add-payment') return openAddPayment();
  if (act === 'reload') return location.reload();
  if (act === 'noop') return toast('Not part of this demo', 'Only Autopilot is interactive in this concept.', 'info');
  if (act === 'confirm-activate') {
    const std = S.view.orders.filter(o => o.type === 'standard');
    S.status = { state: 'active', activatedAt: new Date().toISOString(), activatedPlan: { product: S.settings.product, alpha: S.settings.alpha, orders: std.length } };
    save(LS.status, S.status); closeDialog(); toast('Autopilot activated', `${std.length} standard withdrawals scheduled. First one: ${std[0] ? dshort(std[0].orderDay) : 'none'}.`); return route();
  }
  if (act === 'pause') { S.status = { state: 'draft', activatedAt: null, activatedPlan: null }; save(LS.status, S.status); toast('Autopilot paused', 'No orders will be placed until you activate it again.', 'circle-pause'); return route(); }
  if (act === 'download-csv') { download(`spiko-autopilot-plan-${S.snap.today}.csv`, csvRows(S.view).map(r => r.join(',')).join('\n'), 'text/csv'); return toast('CSV downloaded', `${S.view.orders.length} orders exported.`); }
  if (act === 'download-json') {
    const body = S.view.orders.map(o => ({ submitBy: o.orderDay, submitByTimeParis: o.type === 'standard' ? hm(o.orderMinute) : null, ...toInvestorApi(o, { ...IDS, shareClassId: S.snap.products[o.product].shareClassId }) }));
    download(`spiko-autopilot-orders-${S.snap.today}.json`, JSON.stringify(body, null, 2), 'application/json'); return toast('JSON downloaded', 'Investor API request bodies, one per order.');
  }
  if (act === 'copy-json') { const o = S.view.orders[+el.dataset.idx]; navigator.clipboard?.writeText(JSON.stringify(toInvestorApi(o, { ...IDS, shareClassId: S.snap.products[o.product].shareClassId }).body, null, 2)); return toast('Copied', 'Request body copied to the clipboard.'); }
  if (act === 'remove-payment') {
    const id = el.dataset.id;
    if (id.startsWith('u')) S.whatif.added = S.whatif.added.filter(a => a.id !== id); else S.whatif.removed.push(id);
    save(LS.whatif, S.whatif); toast('Payment removed', 'The plan was re-optimised.'); return route();
  }
  if (act === 'reset-whatif') { S.whatif = { edits: {}, added: [], removed: [] }; save(LS.whatif, S.whatif); toast('What-if cleared', 'Back to your scheduled payments.'); return route(); }
  if (act === 'reset-all') { S.settings = structuredClone(DEFAULTS); S.whatif = { edits: {}, added: [], removed: [] }; save(LS.settings, S.settings); save(LS.whatif, S.whatif); toast('Rules reset', 'Defaults restored.'); return route(); }
}
function onChange(e) {
  const el = e.target;
  if (el.id === 'ack') { const b = document.getElementById('confirm-activate'); if (b) b.disabled = !el.checked; return; }
  if (el.dataset.setting === 'horizon') { S.settings.horizon = +el.value; save(LS.settings, S.settings); return route(); }
  if (el.dataset.setting === 'floor') {
    const v = Math.max(0, Math.round(+el.value || 0)); S.settings.floor = v; save(LS.settings, S.settings); toast('Minimum balance updated', eur(v)); return route();
  }
  if (el.dataset.filter === 'payments') { location.hash = `#/autopilot/payments${el.value === 'all' ? '' : '?filter=' + el.value}`; return; }
  if (el.dataset.edit) {
    const id = el.dataset.id, field = el.dataset.edit;
    const val = field === 'est' ? Math.max(0, +el.value) : el.value;
    if (field === 'due' && (!val || val < S.snap.today || diffDays(S.snap.today, val) >= S.settings.horizon)) { toast('Date outside the plan', 'Pick a date inside the planning window.', 'circle-alert'); return route(); }
    if (id.startsWith('u')) { const a = S.whatif.added.find(x => x.id === id); if (a) a[field] = val; }
    else { const orig = S.snap.payments.find(p => p.id === id); S.whatif.edits[id] = { ...(S.whatif.edits[id] || { est: orig.est, due: orig.due }), [field]: val }; }
    save(LS.whatif, S.whatif); route();
  }
}
function onKey(e) {
  if (e.target instanceof Element && e.target.matches('input, select, textarea')) return;
  if (e.key === 'Escape') return closeDialog();
  if (document.getElementById('overlay')) return;
  const { parts } = parseHash();
  if (parts[0] === 'autopilot' && parts[1] === 'day' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    const a = document.querySelectorAll('.crumbs .icon-btn')[e.key === 'ArrowLeft' ? 0 : 1]; if (a) location.hash = a.getAttribute('href'); return;
  }
  const tabs = { 1: 'plan', 2: 'payments', 3: 'backtest', 4: 'settings' };
  if (tabs[e.key]) { location.hash = `#/autopilot/${tabs[e.key]}`; return; }
  if (e.key === 'e') return openExport();
  if (e.key === 'a') return S.status.state === 'active' ? onClick({ target: Object.assign(document.createElement('button'), { dataset: { act: 'pause' } }) }) : openActivate();
  if (e.key === '?') return openShortcuts();
}

boot();
