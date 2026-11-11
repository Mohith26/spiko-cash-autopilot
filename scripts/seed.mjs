// Builds every data file the app reads. Deterministic: same seed + same committed public snapshot => same output.
//   node scripts/seed.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { Calendar, addDays, diffDays, PRODUCTS } from '../core/calendar.js';
import { generateLedger } from '../core/synth.js';
import { Forecaster } from '../core/forecast.js';
import { calibrate, MIN_N } from '../core/conformal.js';
import { scoreTable, runBacktest, dailyRates, coverageCheck } from '../core/backtest.js';

const pub = JSON.parse(readFileSync(new URL('../data/spiko_public.json', import.meta.url)));
const cal = new Calendar(pub.funds);
const TODAY = '2026-11-11';
const FROM = '2025-11-11', TO = '2026-11-10';
const FLOOR = 50000, H = 21;
const ledger = generateLedger(cal, { seed: 20261111, start: '2022-07-01', end: '2027-02-28' });
const fc = new Forecaster(ledger, cal);
const t0 = Date.now();
const table = scoreTable(fc, cal, '2022-11-01', TO, 4);
const rates = dailyRates(pub.shareClasses.EUTBL.nav);
console.log('ledger items', ledger.items.length, 'score rows', table.length, (Date.now() - t0) + 'ms');

const alphas = [0.01, 0.02, 0.05, 0.1];
const results = [];
for (const productKey of ['EUTBL', 'eurSAFO']) {
  for (const policy of ['thirty', 'duedate', 'point']) results.push(runBacktest({ cal, fc, inflows: ledger.inflows, table, productKey, from: FROM, to: TO, policy, floor: FLOOR, H, rates }));
  for (const alpha of alphas) results.push(runBacktest({ cal, fc, inflows: ledger.inflows, table, productKey, from: FROM, to: TO, policy: 'autopilot', alpha, floor: FLOOR, H, rates }));
}
const summ = r => ({ policy: r.policy, alpha: r.policy === 'autopilot' ? r.alpha : null, productKey: r.productKey, days: r.n, avgIdle: Math.round(r.avgIdle), forgone: Math.round(r.forgone),
  uncovered: r.uncovered, uncoveredAmt: Math.round(r.uncoveredAmt), heavyDays: r.heavyDays, bindingDays: r.bindingDays, uncoveredBinding: r.uncoveredBinding,
  orders: { instant: r.nInstant, standard: r.nStandard, deposit: r.nDeposit } });
for (const r of results) console.log(JSON.stringify(summ(r)));
// fixed safety buffer (minimum balance only) vs calibrated margin with no minimum balance
const frontier = [];
for (const fl of [0, 10000, 25000, 50000]) { const r = runBacktest({ cal, fc, inflows: ledger.inflows, table, productKey: 'eurSAFO', from: FROM, to: TO, policy: 'point', floor: fl, H, rates }); frontier.push({ kind: 'fixed', floor: fl, avgIdle: Math.round(r.avgIdle), forgone: Math.round(r.forgone), uncovered: r.uncovered, uncoveredAmt: Math.round(r.uncoveredAmt) }); }
for (const a of [0.01, 0.02, 0.05]) { const r = runBacktest({ cal, fc, inflows: ledger.inflows, table, productKey: 'eurSAFO', from: FROM, to: TO, policy: 'autopilot', alpha: a, floor: 0, H, rates }); frontier.push({ kind: 'calibrated', alpha: a, floor: 0, avgIdle: Math.round(r.avgIdle), forgone: Math.round(r.forgone), uncovered: r.uncovered, uncoveredAmt: Math.round(r.uncoveredAmt) }); }
console.log(JSON.stringify(frontier));
const coverage = alphas.map(alpha => ({ alpha, ...coverageCheck({ fc, table, from: FROM, to: TO, alpha }) }));
console.log(JSON.stringify(coverage));

// ---- state at TODAY 09:00 (continue the autopilot replay one day so bank + pending orders are consistent) ----
const main = results.find(r => r.policy === 'autopilot' && r.alpha === 0.01 && r.productKey === 'eurSAFO');
const last = main.rows.at(-1);
const bankToday = last.bank;
const pending = main.committedAfter;

const HZ = 56;
const payments = [];
for (const it of ledger.items) {
  if (it.due < TODAY || diffDays(TODAY, it.due) >= HZ) continue;
  const e = Forecaster.estimate(it, TODAY);
  if (!e) continue;
  payments.push({ id: it.id, due: it.due, est: e.est, cv: e.cv, label: it.label, cat: it.cat, counterparty: it.counterparty, estimatedSince: e.from });
}
const us = (biz) => { const d = biz ? '2026-11-12' : '2026-11-14'; const s = fc.unschedStats(d, TODAY); return { mean: Math.round(s.mean), sd: Math.round(Math.sqrt(s.var)) }; };
const calibToday = Object.fromEntries(alphas.map(a => [a, calibrate(table, TODAY, a, { minDay: addDays(TODAY, -1095) })]));

// recent account history for the Account page (last 30 days of the replay)
const history = main.rows.slice(-30);

const snapshot = {
  generatedAt: new Date().toISOString(), seed: 20261111,
  company: { name: 'Nordlys SAS', kind: 'Business account', employees: 152, sector: 'B2B software, Paris', user: 'camille.roux@nordlys.example' },
  today: TODAY, nowMin: 9 * 60, floor: FLOOR,
  bank: { name: 'Operating account', iban: 'FR76 •••• •••• 4821', balance: bankToday },
  fund: { eurSAFO: 9842316.4, EUTBL: 1250000 },
  pending,
  payments, unsched: { biz: us(true), other: us(false) },
  calib: calibToday, minN: Object.fromEntries(alphas.map(a => [a, MIN_N(a)])),
  products: Object.fromEntries(Object.entries(PRODUCTS).map(([k, p]) => [k, { ...p, shareClassId: pub.shareClasses[k].id, isin: pub.shareClasses[k].isin, yield: pub.shareClasses[k].yield, nav: pub.shareClasses[k].nav.at(-1) }])),
  funds: pub.funds, publicFetchedAt: pub.fetchedAt,
  history,
};
writeFileSync(new URL('../data/snapshot.json', import.meta.url), JSON.stringify(snapshot));
const keepRows = (r) => r.rows.map(x => [x.d, x.out, x.inst, x.arr, x.dep, x.bank, x.short]);
const backtest = {
  window: { from: FROM, to: TO }, floor: FLOOR, horizon: H, valuedWith: 'Spiko T-Bills Euro (EUTBL) realized NAV returns',
  summary: results.map(summ), coverage, frontier,
  headline: (() => {
    const g = (p, a = null) => results.find(r => r.productKey === 'eurSAFO' && r.policy === p && (a === null || r.alpha === a));
    const ap = g('autopilot', 0.01), th = g('thirty'), dd = g('duedate');
    return { product: 'eurSAFO', alpha: 0.01, extraInterest: Math.round(th.forgone) - Math.round(ap.forgone), forgoneAutopilot: Math.round(ap.forgone), forgoneThirty: Math.round(th.forgone),
      avgIdleAutopilot: Math.round(ap.avgIdle), avgIdleThirty: Math.round(th.avgIdle), uncoveredAutopilot: ap.uncovered, uncoveredThirty: th.uncovered,
      uncoveredDueDate: dd.uncovered, uncoveredDueDateAmt: Math.round(dd.uncoveredAmt), standardOrders: ap.nStandard, bindingDays: ap.bindingDays,
      coverage1: coverage.find(c => c.alpha === 0.01) };
  })(),
  daily: Object.fromEntries(results.filter(r => (r.policy !== 'autopilot' || r.alpha === 0.01)).map(r => [`${r.productKey}|${r.policy}`, keepRows(r)])),
};
writeFileSync(new URL('../data/backtest.json', import.meta.url), JSON.stringify(backtest));
console.log('bank today', bankToday, 'pending', pending, 'payments', payments.length, 'unsched', snapshot.unsched);
