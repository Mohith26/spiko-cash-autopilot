// Point forecast + scale for a day's outflows, using only what was known at `asOf` (morning, before payments).
//   f     = sum of scheduled payments known by asOf (latest estimate) + expected unscheduled spend (trailing 120 days)
//   sigma = sqrt(sum (cv_i * est_i)^2 + variance of unscheduled spend)   (a scale, not a promise: conformal calibrates it)
// The planner never counts on receipts that have not arrived, so inflows are not forecast.

import { addDays, diffDays } from './calendar.js';

export const HEAVY_THRESHOLD = 150000;

export class Forecaster {
  constructor(ledger, cal, { trailingDays = 120 } = {}) {
    this.cal = cal;
    this.trailing = trailingDays;
    this.byDue = new Map();
    for (const it of ledger.items) { if (!this.byDue.has(it.due)) this.byDue.set(it.due, []); this.byDue.get(it.due).push(it); }
    this.start = ledger.start;
    this.unscheduled = ledger.unscheduled;
    // prefix sums of unscheduled spend split by SEPA business day / other day
    const n = diffDays(ledger.start, ledger.end) + 1;
    this.n = n;
    this.pre = { b: [new Float64Array(n + 1), new Float64Array(n + 1), new Float64Array(n + 1)], o: [new Float64Array(n + 1), new Float64Array(n + 1), new Float64Array(n + 1)] };
    for (let i = 0; i < n; i++) {
      const d = addDays(ledger.start, i), x = ledger.unscheduled[d] || 0, biz = cal.isSepaDay(d);
      for (const [key, on] of [['b', biz], ['o', !biz]]) {
        const [c, s, s2] = this.pre[key];
        c[i + 1] = c[i] + (on ? 1 : 0); s[i + 1] = s[i] + (on ? x : 0); s2[i + 1] = s2[i] + (on ? x * x : 0);
      }
    }
  }
  idx(d) { return diffDays(this.start, d); }
  unschedStats(day, asOf) {
    const key = this.cal.isSepaDay(day) ? 'b' : 'o';
    const hi = Math.max(0, Math.min(this.n, this.idx(asOf))); // days strictly before asOf
    const lo = Math.max(0, hi - this.trailing);
    const [c, s, s2] = this.pre[key];
    const cnt = c[hi] - c[lo];
    if (cnt < 5) return { mean: 0, var: 0 };
    const mean = (s[hi] - s[lo]) / cnt;
    const v = Math.max(0, (s2[hi] - s2[lo]) / cnt - mean * mean) * cnt / Math.max(1, cnt - 1);
    return { mean, var: v };
  }
  static estimate(item, asOf) {
    let cur = null;
    for (const [from, est, cv] of item.est) if (from <= asOf) cur = { est, cv, from };
    return cur;
  }
  dayForecast(day, asOf) {
    const known = [];
    let sched = 0, varS = 0;
    for (const it of this.byDue.get(day) || []) {
      const e = Forecaster.estimate(it, asOf);
      if (!e) continue;
      known.push({ item: it, est: e.est, cv: e.cv, final: e.cv <= 0.002 });
      sched += e.est; varS += (e.cv * e.est) ** 2;
    }
    const u = this.unschedStats(day, asOf);
    const f = sched + u.mean;
    const sigma = Math.sqrt(varS + u.var);
    return { day, asOf, f, sigma, scheduled: sched, unschedMean: u.mean, unschedSd: Math.sqrt(u.var), cls: sched >= HEAVY_THRESHOLD ? 'heavy' : 'light', known };
  }
  actual(day) {
    let a = this.unscheduled[day] || 0;
    for (const it of this.byDue.get(day) || []) a += it.amount;
    return a;
  }
  scheduledActual(day) { let a = 0; for (const it of this.byDue.get(day) || []) a += it.amount; return a; }
}
