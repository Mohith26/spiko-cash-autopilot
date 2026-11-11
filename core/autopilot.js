// Glue shared by the browser app and the backtest: forecasts -> calibrated bounds -> optimal plan -> dated orders.
import { addDays, diffDays, PRODUCTS, INSTANT_CAP } from './calendar.js';
import { planWithdrawals, ordersFromPlan } from './plan.js';
import { upperBound } from './conformal.js';
import { HEAVY_THRESHOLD } from './forecast.js';

// Forecasts from a snapshot of known payments (what the browser app has).
// payments: [{ id, due, est, cv, label, cat, counterparty }], unsched: { biz: {mean, sd}, other: {mean, sd} }
export function forecastsFromPayments({ cal, today, horizon, payments, unsched }) {
  const byDay = new Map();
  for (const p of payments) { if (!byDay.has(p.due)) byDay.set(p.due, []); byDay.get(p.due).push(p); }
  const out = [];
  for (let i = 0; i < horizon; i++) {
    const day = addDays(today, i);
    const known = (byDay.get(day) || []).map(p => ({ item: p, est: p.est, cv: p.cv, final: p.cv <= 0.002 }));
    let sched = 0, v = 0;
    for (const k of known) { sched += k.est; v += (k.cv * k.est) ** 2; }
    const u = cal.isSepaDay(day) ? unsched.biz : unsched.other;
    out.push({ day, asOf: today, f: sched + u.mean, sigma: Math.sqrt(v + u.sd * u.sd), scheduled: sched, unschedMean: u.mean, unschedSd: u.sd,
      cls: sched >= HEAVY_THRESHOLD ? 'heavy' : 'light', known });
  }
  return out;
}

// committed: Map(day -> amount) of standard withdrawals already ordered and not yet landed.
export function makePlan({ cal, productKey, today, nowMin = 9 * 60, B0, floor, fcs, calib, committed = new Map(), capUsedToday = 0, useMargin = true }) {
  const H = fcs.length;
  const days = fcs.map(x => x.day);
  const settleMap = cal.settleOptions(productKey, today, nowMin, H);
  const bounds = fcs.map((fc, k) => (useMargin ? upperBound(fc, diffDays(today, fc.day), calib) : { U: fc.f, margin: 0, q: 0, n: 0, method: 'none' }));
  const f = fcs.map(x => x.f), U = bounds.map(b => b.U);
  const settleable = days.map(d => settleMap.has(d));
  const com = days.map(d => committed.get(d) || 0);
  const labels = fcs.map(fc => (fc.known.length ? fc.known.slice().sort((a, b) => b.est - a.est)[0].item.label : 'Card and unscheduled spend'));
  const plan = planWithdrawals({ B0, floor, f, U, settleable, committed: com, capUsedToday, labels });
  const orders = ordersFromPlan(plan, days, settleMap, productKey);
  // A day "relies on pre-positioning" when its calibrated need exceeds what instant withdrawals alone can bring that morning.
  const binding = fcs.map((fc, k) => U[k] + floor > INSTANT_CAP);
  return { days, fcs, bounds, f, U, settleable, settleMap, plan, orders, binding, productKey, today, B0, floor };
}

// Investor API request bodies (POST https://investor-api.spiko.io/v1/withdrawal-orders/ and /deposit-orders/).
export function toInvestorApi(order, { accountId, shareClassId, bankAccountId }) {
  const value = (Math.round(order.amount * 100) / 100).toFixed(2);
  if (order.type === 'deposit') return { endpoint: 'POST /v1/deposit-orders/', body: { accountId, shareClassId, amount: { value, currency: 'EUR' } } };
  return {
    endpoint: 'POST /v1/withdrawal-orders/',
    body: { accountId, shareClassId, destination: { type: order.type === 'instant' ? 'instant-bank-transfer' : 'bank-transfer', bankAccountId }, quantity: { mode: 'amount', amount: { value, currency: 'EUR' } } },
  };
}

export { PRODUCTS, INSTANT_CAP };
