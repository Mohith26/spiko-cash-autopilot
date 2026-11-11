// Payment-aware withdrawal planner.
//
// Timeline: every day k has a MORNING slot (payments leave the bank; instant withdrawals, capped per day, land within
// minutes, 24/7) and an AFTERNOON slot (standard withdrawals land on settle days; surplus is swept back into the fund).
// Let G be the cumulative net cash moved from the fund into the bank, so the bank balance is B0 + G + committed - outflows.
// Constraints (f = expected outflow, U = calibrated upper bound, cap = instant capacity of the day):
//   midday k   (expected payments paid):        B0 + G_m[k] + C_{<k}  - F_{<=k}               >= floor
//   end of day k, and COVERAGE of day k+1:       B0 + G_a[k] + C_{<=k} - F_{<=k} >= floor + max(0, U_{k+1} - cap_{k+1})
//     (tomorrow's real-time instant capacity is the reserve; only what exceeds it must already sit in the bank)
//   today:                                        B0 + cap_0 >= U_0 + floor   (otherwise today's payments are at risk)
//   moves:  0 <= G_m[k] - G_a[k-1] <= cap_k,   G_a[k] - G_m[k] <= (settle day ? +inf : 0)  (deposits always allowed)
// Idle cash = sum_k bank at end of day k = sum_k G_a[k] + const. A backward pass gives, for every slot, the smallest
// value any feasible plan can have there (G_{s-1} >= Req_{s-1} and G_{s-1} >= G_s - upper_s). A forward pass then
// lifts morning slots to respect "instant withdrawals are not negative" without touching afternoon slots, so the plan
// attains the lower bound on every afternoon slot and is optimal. test/plan.test.js checks this against an LP solver.

import { INSTANT_CAP, addDays } from './calendar.js';

export function planWithdrawals({
  B0, floor = 0, f, U, settleable, committed = [], cap = INSTANT_CAP, capUsedToday = 0, labels = [],
}) {
  const H = f.length;
  if (U.length !== H || settleable.length !== H) throw new Error('length mismatch');
  for (let k = 0; k < H; k++) if (!(U[k] >= f[k] - 1e-9)) throw new Error(`U[${k}] < f[${k}]`);
  const capOf = (k) => Math.max(0, k === 0 ? cap - capUsedToday : cap);
  const S = 2 * H; // slot 2k = morning k, 2k+1 = afternoon k
  const req = new Float64Array(S), upper = new Float64Array(S), reqWhy = new Int32Array(S).fill(-1);
  let cumF = 0, cumC = 0;
  for (let k = 0; k < H; k++) {
    cumF += f[k];
    req[2 * k] = floor + cumF - B0 - cumC;           // midday, before today's committed arrivals
    upper[2 * k] = capOf(k);
    cumC += committed[k] || 0;
    const reserve = k + 1 < H ? Math.max(0, U[k + 1] - capOf(k + 1)) : 0;
    req[2 * k + 1] = floor + cumF - B0 - cumC + reserve;
    if (reserve > 0) reqWhy[2 * k + 1] = k + 1;
    upper[2 * k + 1] = settleable[k] ? Infinity : 0;
  }
  const todayAtRisk = B0 + capOf(0) < U[0] + floor - 1e-6;
  const G = new Float64Array(S), src = new Int32Array(S);
  G[S - 1] = req[S - 1]; src[S - 1] = S - 1;
  for (let s = S - 1; s >= 1; s--) {
    const pushed = G[s] - upper[s];
    if (req[s - 1] >= pushed) { G[s - 1] = req[s - 1]; src[s - 1] = s - 1; } else { G[s - 1] = pushed; src[s - 1] = src[s]; }
  }
  if (G[0] < 0) G[0] = 0; // nothing has moved before the first slot
  for (let k = 1; k < H; k++) if (G[2 * k] < G[2 * k - 1]) G[2 * k] = G[2 * k - 1]; // instant withdrawals are >= 0
  const infeasible = G[0] > upper[0] + 1e-6;
  let blocking = null;
  if (infeasible) {
    const s = src[0], day = reqWhy[s] >= 0 ? reqWhy[s] : Math.floor(s / 2);
    blocking = { day, missing: G[0] - upper[0], label: labels[day] };
  } else if (todayAtRisk) blocking = { day: 0, missing: U[0] + floor - B0 - capOf(0), label: labels[0] };
  const instant = new Float64Array(H), standard = new Float64Array(H), deposit = new Float64Array(H);
  const bankStart = new Float64Array(H), bankEnd = new Float64Array(H), reserveNeed = new Float64Array(H);
  let prev = 0; cumF = 0; cumC = 0;
  for (let k = 0; k < H; k++) {
    const gm = Math.min(G[2 * k], prev + upper[2 * k]);
    instant[k] = Math.max(0, gm - prev);
    bankStart[k] = B0 + prev + cumC - cumF; // in the bank before today's payments (after yesterday's arrivals/sweep)
    reserveNeed[k] = Math.max(0, U[k] + floor - capOf(k));
    cumF += f[k]; cumC += committed[k] || 0;
    let x = G[2 * k + 1] - gm;
    if (x > upper[2 * k + 1]) x = upper[2 * k + 1]; // only reachable when infeasible: never invent a withdrawal that cannot land
    if (x > 1e-6) standard[k] = x; else if (x < -1e-6) deposit[k] = -x;
    prev = gm + x;
    bankEnd[k] = B0 + prev + cumC - cumF;
  }
  let idle = 0;
  for (let k = 0; k < H; k++) idle += bankEnd[k];
  return { feasible: !infeasible && !todayAtRisk, infeasible, todayAtRisk, blocking, instant, standard, deposit, bankStart, bankEnd, reserveNeed, idle, G };
}

// Generic LP for the same problem (used only to verify optimality in tests).
export function planAsLP({ B0, floor = 0, f, U, settleable, committed = [], cap = INSTANT_CAP, capUsedToday = 0 }) {
  const H = f.length;
  const capOf = (k) => Math.max(0, k === 0 ? cap - capUsedToday : cap);
  const n = 3 * H, rows = [];
  const iI = k => k, iS = k => H + k, iD = k => 2 * H + k;
  const c = new Array(n).fill(0);
  for (let k = 0; k < H; k++) for (let j = 0; j <= k; j++) { c[iI(j)] += 1; c[iS(j)] += 1; c[iD(j)] -= 1; }
  let cumF = 0, cumC = 0, const0 = 0;
  for (let k = 0; k < H; k++) {
    cumF += f[k];
    const a = new Array(n).fill(0);           // midday k
    for (let j = 0; j <= k; j++) a[iI(j)] = 1;
    for (let j = 0; j < k; j++) { a[iS(j)] = 1; a[iD(j)] = -1; }
    rows.push({ a, op: '>=', b: floor - B0 - cumC + cumF });
    cumC += committed[k] || 0;
    const e = new Array(n).fill(0);           // end of day k + coverage of day k+1
    for (let j = 0; j <= k; j++) { e[iI(j)] = 1; e[iS(j)] = 1; e[iD(j)] = -1; }
    const reserve = k + 1 < H ? Math.max(0, U[k + 1] - capOf(k + 1)) : 0;
    rows.push({ a: e, op: '>=', b: floor + reserve - B0 - cumC + cumF });
    const ub = new Array(n).fill(0); ub[iI(k)] = 1;
    rows.push({ a: ub, op: '<=', b: capOf(k) });
    if (!settleable[k]) { const z = new Array(n).fill(0); z[iS(k)] = 1; rows.push({ a: z, op: '<=', b: 0 }); }
    const0 += B0 + cumC - cumF;
  }
  return { c, rows, n, H, const0, todayAtRisk: B0 + capOf(0) < U[0] + floor - 1e-6 };
}

// Turn a plan into dated orders.
export function ordersFromPlan(plan, days, settleMap, productKey) {
  const out = [];
  for (let k = 0; k < days.length; k++) {
    if (plan.instant[k] > 0.5) out.push({ type: 'instant', day: days[k], orderDay: days[k], amount: plan.instant[k], product: productKey });
    if (plan.standard[k] > 0.5) {
      const o = settleMap.get(days[k]);
      out.push({ type: 'standard', day: days[k], orderDay: o ? o.day : null, orderMinute: o ? o.minute : null, amount: plan.standard[k], product: productKey });
    }
    if (plan.deposit[k] > 0.5) out.push({ type: 'deposit', day: days[k], orderDay: days[k], amount: plan.deposit[k], product: productKey });
  }
  return out;
}

export { addDays };
