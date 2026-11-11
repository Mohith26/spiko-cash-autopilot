import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Calendar, easterSunday, targetHolidays, addDays, diffDays, weekday, PRODUCTS } from '../core/calendar.js';
import { planWithdrawals, planAsLP } from '../core/plan.js';
import { solveLP } from '../core/lp.js';
import { conformalQuantile, MIN_N, calibrate } from '../core/conformal.js';
import { dailyRates } from '../core/backtest.js';
import { toInvestorApi, forecastsFromPayments, makePlan } from '../core/autopilot.js';
import { generateLedger, makeRng } from '../core/synth.js';

const pub = JSON.parse(readFileSync(new URL('../data/spiko_public.json', import.meta.url)));
const cal = new Calendar(pub.funds);

test('Easter dates (Meeus/Jones/Butcher) match known calendars', () => {
  assert.equal(easterSunday(2024), '2024-03-31');
  assert.equal(easterSunday(2025), '2025-04-20');
  assert.equal(easterSunday(2026), '2026-04-05');
  assert.equal(easterSunday(2027), '2027-03-28');
});

test('computed TARGET2 holidays agree with Spiko\'s published fund calendar for 2026', () => {
  const t = targetHolidays(2026);
  for (const d of t.filter(d => weekday(d) !== 0 && weekday(d) !== 6)) assert.ok(pub.funds.SAFO.nonOperatingDays.includes(d), d);
});

test('cut-off rules: Spiko Euro D+1 at 15:00, T-Bills Euro same day at 11:30, real holidays', () => {
  assert.equal(cal.settleDay('eurSAFO', '2026-11-25', 14 * 60 + 59), '2026-11-26');
  assert.equal(cal.settleDay('eurSAFO', '2026-11-25', 15 * 60 + 1), '2026-11-27');
  assert.equal(cal.settleDay('eurSAFO', '2026-11-27', 16 * 60), '2026-12-01'); // Fri after cut-off -> Tue
  assert.equal(cal.settleDay('EUTBL', '2026-11-12', 11 * 60), '2026-11-12');
  assert.equal(cal.settleDay('EUTBL', '2026-11-12', 12 * 60), '2026-11-13');
  // 11 Nov 2026: the T-Bills fund is closed (Armistice) but Spiko Euro operates, per the public API.
  assert.equal(cal.isFundDay('EUTBL', '2026-11-11'), false);
  assert.equal(cal.isFundDay('SAFO', '2026-11-11'), true);
  assert.equal(cal.settleDay('EUTBL', '2026-11-11', 9 * 60), '2026-11-12');
  // Christmas: order Thu 24 Dec before 15:00 lands Mon 28 Dec (25-27 closed).
  assert.equal(cal.settleDay('eurSAFO', '2026-12-24', 10 * 60), '2026-12-28');
});

test('latestOrderFor is the latest possible order (randomized)', () => {
  const rng = makeRng(5);
  for (let i = 0; i < 300; i++) {
    const now = addDays('2026-01-05', Math.floor(rng.u() * 330));
    const by = addDays(now, 1 + Math.floor(rng.u() * 20));
    for (const pk of ['eurSAFO', 'EUTBL']) {
      const o = cal.latestOrderFor(pk, by, now, 9 * 60);
      if (!o) continue;
      assert.ok(o.settles <= by);
      // any later fund day, ordered just before its cut-off, lands after `by`
      for (let d = addDays(o.day, 1); d <= by; d = addDays(d, 1)) {
        if (!cal.isFundDay(PRODUCTS[pk].fund, d)) continue;
        assert.ok(cal.settleDay(pk, d, PRODUCTS[pk].cutoffMin - 1) > by, `${pk} ${d} ${by}`);
      }
    }
  }
});

function randomInstance(rng) {
  const H = 3 + Math.floor(rng.u() * 12), cap = 5;
  const f = [], U = [], settleable = [], committed = [];
  for (let k = 0; k < H; k++) {
    const x = rng.u() < 0.3 ? 3 + rng.u() * 9 : rng.u() * 2;
    f.push(x); U.push(x * (1 + rng.u() * 0.5)); settleable.push(k > 0 && rng.u() < 0.6); committed.push(rng.u() < 0.1 ? rng.u() * 3 : 0);
  }
  return { B0: rng.u() * 9, floor: rng.u(), f, U, settleable, committed, cap, capUsedToday: rng.u() < 0.2 ? rng.u() * 3 : 0 };
}

test('planner is optimal: matches an independent simplex LP on 400 random instances', () => {
  const rng = makeRng(42);
  let compared = 0;
  for (let i = 0; i < 400; i++) {
    const inst = randomInstance(rng);
    const p = planWithdrawals(inst);
    const L = planAsLP(inst);
    const r = solveLP(L.c, L.rows);
    if (p.infeasible) { assert.equal(r.status, 'infeasible'); continue; }
    assert.equal(r.status, 'optimal');
    assert.ok(Math.abs(r.obj + L.const0 - p.idle) <= 1e-6 * Math.max(1, Math.abs(p.idle)));
    compared++;
  }
  assert.ok(compared > 250);
});

test('every plan satisfies its constraints (midday, end of day, next-day coverage, caps, settle days)', () => {
  const rng = makeRng(7);
  for (let i = 0; i < 400; i++) {
    const x = randomInstance(rng);
    const p = planWithdrawals(x);
    if (p.infeasible) continue;
    let bank = x.B0;
    for (let k = 0; k < x.f.length; k++) {
      const cap = k === 0 ? x.cap - x.capUsedToday : x.cap;
      assert.ok(p.instant[k] >= -1e-9 && p.instant[k] <= cap + 1e-6);
      if (!x.settleable[k]) assert.ok(p.standard[k] <= 1e-6);
      bank += p.instant[k] - x.f[k];
      assert.ok(bank >= x.floor - 1e-6, 'midday');
      bank += p.standard[k] + x.committed[k] - p.deposit[k];
      assert.ok(Math.abs(bank - p.bankEnd[k]) < 1e-6);
      const reserve = k + 1 < x.f.length ? Math.max(0, x.U[k + 1] - x.cap) : 0;
      assert.ok(bank >= x.floor + reserve - 1e-6, 'coverage');
    }
  }
});

test('infeasible case is reported with the payment that causes it', () => {
  const p = planWithdrawals({ B0: 0, floor: 0, f: [0, 11], U: [0, 12], settleable: [false, false], cap: 5, labels: ['-', 'Net salaries'] });
  assert.equal(p.infeasible, true);
  assert.equal(p.blocking.day, 1);
  assert.equal(p.blocking.label, 'Net salaries');
  assert.ok(Math.abs(p.blocking.missing - 2) < 1e-9); // needs 12 - 5 (tomorrow's instant) = 7 tonight, only 5 can arrive today
});

test('raising any calibrated bound never lowers idle cash (randomized monotonicity)', () => {
  const rng = makeRng(3);
  for (let i = 0; i < 200; i++) {
    const x = randomInstance(rng);
    const a = planWithdrawals(x);
    const k = Math.floor(rng.u() * x.f.length);
    const U2 = x.U.slice(); U2[k] += rng.u() * 3;
    const b = planWithdrawals({ ...x, U: U2 });
    if (a.infeasible || b.infeasible) continue;
    assert.ok(b.idle >= a.idle - 1e-9);
  }
});

test('split-conformal quantile: finite-sample index, and infinite when n is too small', () => {
  const s = Array.from({ length: 99 }, (_, i) => i + 1); // 1..99
  assert.equal(conformalQuantile(s, 0.01), 99);              // ceil(100*0.99)=99
  assert.equal(conformalQuantile(s, 0.1), 90);               // ceil(100*0.9)=90
  assert.equal(conformalQuantile(s.slice(0, 98), 0.01), Infinity);
  assert.equal(MIN_N(0.01), 99);
  assert.equal(MIN_N(0.05), 19);
});

test('conformal bounds keep the miss rate at or below alpha on exchangeable heavy-tailed data (randomized)', () => {
  const rng = makeRng(11);
  for (const alpha of [0.02, 0.05, 0.1]) {
    let miss = 0, trials = 4000;
    for (let t = 0; t < trials; t++) {
      const cal = Array.from({ length: 200 }, () => Math.exp(rng.normal()) * (rng.u() < 0.05 ? 5 : 1));
      const q = conformalQuantile(cal, alpha);
      const y = Math.exp(rng.normal()) * (rng.u() < 0.05 ? 5 : 1);
      if (y > q) miss++;
    }
    const rate = miss / trials;
    assert.ok(rate <= alpha + 3 * Math.sqrt(alpha * (1 - alpha) / trials), `alpha=${alpha} rate=${rate}`);
    assert.ok(rate >= alpha - 0.02, `not wildly conservative: ${rate}`);
  }
});

test('daily rates from published NAVs compound back to the NAV ratio', () => {
  const navs = pub.shareClasses.EUTBL.nav;
  const r = dailyRates(navs);
  const a = navs[100], b = navs[300];
  let g = 1; for (let d = a[0]; d < b[0]; d = addDays(d, 1)) g *= 1 + r.get(d);
  assert.ok(Math.abs(g - b[1] / a[1]) < 1e-9);
});

test('exports are valid Spiko Investor API request bodies', () => {
  const ids = { accountId: '00000000-0000-4000-8000-000000000001', shareClassId: pub.shareClasses.eurSAFO.id, bankAccountId: '00000000-0000-4000-8000-000000000002' };
  const w = toInvestorApi({ type: 'standard', amount: 458180.123 }, ids);
  assert.equal(w.endpoint, 'POST /v1/withdrawal-orders/');
  assert.deepEqual(Object.keys(w.body).sort(), ['accountId', 'destination', 'quantity', 'shareClassId']);
  assert.equal(w.body.destination.type, 'bank-transfer');
  assert.equal(w.body.quantity.amount.value, '458180.12');
  assert.equal(toInvestorApi({ type: 'instant', amount: 1 }, ids).body.destination.type, 'instant-bank-transfer');
  assert.deepEqual(toInvestorApi({ type: 'deposit', amount: 5 }, ids).body.amount, { value: '5.00', currency: 'EUR' });
});

test('synthetic payment calendar follows the French rules it claims', () => {
  const l = generateLedger(cal, { seed: 1, start: '2025-01-01', end: '2026-12-31' });
  for (const it of l.items) {
    assert.ok(cal.isSepaDay(it.due), it.label + ' on ' + it.due);
    if (it.cat === 'social') { const d = +it.due.slice(8); assert.ok(d >= 5 && d <= 8, it.due); }
    if (it.cat === 'payroll' && !it.label.includes('December')) { const d = +it.due.slice(8); assert.ok(d <= 28 && d >= 25, it.due); }
  }
});

test('headline: committed backtest results reproduce from the seed', async () => {
  const committed = JSON.parse(readFileSync(new URL('../data/backtest.json', import.meta.url)));
  const { Forecaster } = await import('../core/forecast.js');
  const { scoreTable, runBacktest } = await import('../core/backtest.js');
  const ledger = generateLedger(cal, { seed: 20261111, start: '2022-07-01', end: '2027-02-28' });
  const fc = new Forecaster(ledger, cal);
  const table = scoreTable(fc, cal, '2022-11-01', committed.window.to, 4);
  const rates = dailyRates(pub.shareClasses.EUTBL.nav);
  const run = (policy, alpha) => runBacktest({ cal, fc, inflows: ledger.inflows, table, productKey: 'eurSAFO', from: committed.window.from, to: committed.window.to, policy, alpha, floor: committed.floor, H: committed.horizon, rates });
  const ap = run('autopilot', 0.01), th = run('thirty'), dd = run('duedate');
  const c = (p, a = null) => committed.summary.find(s => s.productKey === 'eurSAFO' && s.policy === p && s.alpha === a);
  assert.equal(Math.round(ap.forgone), c('autopilot', 0.01).forgone);
  assert.equal(Math.round(th.forgone), c('thirty').forgone);
  assert.equal(ap.uncovered, 0);
  assert.equal(dd.uncovered, c('duedate').uncovered);
  assert.ok(dd.uncovered > 10, 'the literal due-date rule breaks on the EUR 500k instant cap');
  assert.equal(committed.headline.extraInterest, Math.round(th.forgone) - Math.round(ap.forgone));
  assert.ok(committed.headline.extraInterest > 20000);
});

test('browser path (snapshot -> forecasts -> plan) produces a feasible plan for today', () => {
  const snap = JSON.parse(readFileSync(new URL('../data/snapshot.json', import.meta.url)));
  const c2 = new Calendar(snap.funds);
  const fcs = forecastsFromPayments({ cal: c2, today: snap.today, horizon: 56, payments: snap.payments, unsched: snap.unsched });
  const pl = makePlan({ cal: c2, productKey: 'eurSAFO', today: snap.today, B0: snap.bank.balance, floor: snap.floor, fcs, calib: snap.calib['0.01'] });
  assert.equal(pl.plan.feasible, true);
  for (const o of pl.orders.filter(o => o.type === 'standard')) {
    assert.ok(o.orderDay && o.orderDay <= o.day);
    assert.equal(c2.settleDay('eurSAFO', o.orderDay, o.orderMinute), o.day);
  }
});
