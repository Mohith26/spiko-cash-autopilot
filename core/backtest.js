// Day-by-day replay of a treasury policy over realized flows. Every policy sees the same payments, receipts and
// unscheduled spend; it only differs in how it moves cash between the bank account and the Spiko fund.
// Idle cash = bank balance at end of day; its cost = sum over calendar days of idle x the fund's realized daily return
// (from published NAVs). A day is "uncovered" when that morning's payments exceed bank cash plus the instant
// withdrawal capacity left that day.

import { addDays, diffDays, INSTANT_CAP, PRODUCTS } from './calendar.js';
import { makePlan } from './autopilot.js';
import { calibrate } from './conformal.js';

// NAV series [[day, nav]] -> Map(calendar day -> daily return), spreading each NAV-to-NAV return over the calendar days.
export function dailyRates(navs) {
  const m = new Map();
  for (let i = 1; i < navs.length; i++) {
    const [d0, v0] = navs[i - 1], [d1, v1] = navs[i];
    const gap = diffDays(d0, d1);
    if (gap <= 0) continue;
    const r = Math.pow(v1 / v0, 1 / gap) - 1;
    for (let j = 0; j < gap; j++) m.set(addDays(d0, j), r);
  }
  return m;
}

export function scoreTable(fc, cal, from, to, maxH = 6) {
  const rows = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const a = fc.actual(d);
    for (let h = 0; h <= maxH; h++) {
      const x = fc.dayForecast(d, addDays(d, -h));
      if (x.sigma <= 0) continue;
      rows.push({ d, h, cls: x.cls, s: (a - x.f) / x.sigma });
    }
  }
  return rows;
}

export function runBacktest({ cal, fc, inflows, table, productKey = 'EUTBL', from, to, alpha = 0.01, policy = 'autopilot', floor = 50000, H = 21, rates, B0 = 400000, windowDays = 1095 }) {
  const P = PRODUCTS[productKey];
  let bank = B0;
  const committed = new Map();
  const rows = [];
  let uncovered = 0, uncoveredAmt = 0, forgone = 0, nInstant = 0, nStandard = 0, nDeposit = 0, idleSum = 0, heavyDays = 0, bindingDays = 0, uncoveredBinding = 0;
  let calib = null, calibMonth = null;
  for (let t = from; t <= to; t = addDays(t, 1)) {
    // ---- 09:00 decision ----
    let plannedInstant = 0, eodTarget = floor;
    let isBinding = false;
    if (policy === 'autopilot' || policy === 'point') {
      if (policy === 'autopilot' && calibMonth !== t) { calib = calibrate(table, t, alpha, { minDay: addDays(t, -windowDays) }); calibMonth = t; }
      const fcs = []; for (let k = 0; k < H; k++) fcs.push(fc.dayForecast(addDays(t, k), t));
      const pl = makePlan({ cal, productKey, today: t, B0: bank, floor, fcs, calib: calib || {}, committed, useMargin: policy === 'autopilot' });
      isBinding = pl.binding[0];
      plannedInstant = pl.plan.instant[0];
      for (const o of pl.orders) if (o.type === 'standard' && o.orderDay === t) { committed.set(o.day, (committed.get(o.day) || 0) + o.amount); nStandard++; }
      eodTarget = Math.max(floor, pl.plan.bankEnd[0]);
    } else if (policy === 'thirty') {
      // keep the next 30 days of known scheduled outflows in the bank; top up with a same-day standard order
      let need = floor;
      for (let k = 1; k <= 30; k++) need += fc.dayForecast(addDays(t, k), t).scheduled;
      const today = fc.dayForecast(t, t).scheduled + fc.dayForecast(t, t).unschedMean;
      let pending = 0; for (const [d, a] of committed) if (d >= t) pending += a;
      if (cal.isFundDay(P.fund, t) && bank + pending - today < need) {
        const amt = need - (bank + pending - today);
        const s = cal.settleDay(productKey, t, 9 * 60);
        committed.set(s, (committed.get(s) || 0) + amt); nStandard++;
      }
      eodTarget = need;
    } else if (policy === 'duedate') {
      eodTarget = floor; // literal "withdraw what's needed when payments fall due", instant only
    }
    // ---- morning payments ----
    const out = fc.actual(t);
    if (fc.dayForecast(t, t).cls === 'heavy') heavyDays++;
    if (isBinding) bindingDays++;
    const need = out + floor - bank;
    const inst = Math.min(INSTANT_CAP, Math.max(plannedInstant, need, 0));
    if (inst > 0.5) nInstant++;
    bank += inst - out;
    let short = 0;
    if (bank < -0.5) { short = -bank; uncovered++; uncoveredAmt += short; if (isBinding) uncoveredBinding++; bank = 0; }
    // ---- afternoon: standard withdrawals land, receipts arrive ----
    const arr = committed.get(t) || 0; committed.delete(t);
    bank += arr + (inflows[t] || 0);
    // ---- end of day sweep ----
    let dep = 0;
    if (bank > eodTarget + 0.5) { dep = bank - eodTarget; bank = eodTarget; nDeposit++; }
    const r = rates.get(t) || 0;
    forgone += bank * r;
    idleSum += bank;
    rows.push({ d: t, out: Math.round(out), inst: Math.round(inst), arr: Math.round(arr), dep: Math.round(dep), bank: Math.round(bank), short: Math.round(short) });
  }
  const n = rows.length;
  const committedAfter = [...committed].filter(([d]) => d > to).sort().map(([d, a]) => ({ day: d, amount: Math.round(a * 100) / 100 }));
  return { committedAfter, policy, alpha, productKey, n, avgIdle: idleSum / n, forgone, uncovered, uncoveredAmt, nInstant, nStandard, nDeposit, heavyDays, bindingDays, uncoveredBinding, rows };
}

// Online validity check of the calibrated bounds at each horizon: fraction of days whose outflow exceeded f + q*sigma.
export function coverageCheck({ fc, table, from, to, alpha, windowDays = 1095, horizons = [1, 2, 3] }) {
  const res = {};
  for (const cls of ['heavy', 'light', 'all']) res[cls] = { n: 0, miss: 0 };
  let month = null, calib = null;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (month !== d.slice(0, 7)) { calib = calibrate(table, d.slice(0, 7) + '-01', alpha, { minDay: addDays(d.slice(0, 7) + '-01', -windowDays) }); month = d.slice(0, 7); }
    const a = fc.actual(d);
    for (const h of horizons) {
      const x = fc.dayForecast(d, addDays(d, -h));
      const b = calib[`${x.cls}|${Math.min(h, 4)}`];
      const U = x.f + Math.max(0, b.q * x.sigma);
      for (const k of [x.cls, 'all']) { res[k].n++; if (a > U) res[k].miss++; }
    }
  }
  for (const k of Object.keys(res)) res[k].rate = res[k].n ? res[k].miss / res[k].n : null;
  return res;
}
