// Seeded synthetic treasury ledger for a French B2B SaaS company (≈110 to 160 employees, Paris).
// Payment calendars follow published French rules:
//   - net salaries paid on the 28th (December on the 22nd), rolled to the preceding business day; 13th month in December
//   - DSN social charges (URSSAF + retirement) due on the 5th of M+1 for employers of 50+ paying in month M,
//     rolled to the next business day (urssaf.fr "Déclarer en DSN"; service-public.gouv.fr F34059)
//   - monthly VAT (CA3) due between the 15th and 24th of M+1 depending on the company; this one uses the 21st
//   - rent quarterly in advance; cloud provider direct debit early in the month; supplier invoices paid on Tue/Fri runs
// Amounts are synthetic (seeded), sized to a ~EUR 20M ARR company. Nothing here is real customer data.

import { addDays, diffDays, weekday, rollDate } from './calendar.js';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function makeRng(seed) {
  const u = mulberry32(seed);
  let spare = null;
  const normal = () => {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let x, y, r; do { x = 2 * u() - 1; y = 2 * u() - 1; r = x * x + y * y; } while (r === 0 || r >= 1);
    const m = Math.sqrt(-2 * Math.log(r) / r); spare = y * m; return x * m;
  };
  const poisson = (lam) => { let L = Math.exp(-lam), k = 0, p = 1; do { k++; p *= u(); } while (p > L); return k - 1; };
  return { u, normal, lognormal: (median, sigma) => median * Math.exp(sigma * normal()), poisson };
}

const ym = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
const clampDay = (y, m, d) => { const last = new Date(Date.UTC(y, m, 0)).getUTCDate(); return `${ym(y, m)}-${String(Math.min(d, last)).padStart(2, '0')}`; };
const r0 = (x) => Math.round(x * 100) / 100;

export function generateLedger(cal, { seed = 20261111, start = '2023-11-01', end = '2027-02-28' } = {}) {
  const rng = makeRng(seed);
  const items = [];
  let id = 0;
  const push = (o) => { o.id = `p${++id}`; items.push(o); return o; };
  const months = [];
  for (let y = +start.slice(0, 4), m = +start.slice(5, 7); ym(y, m) <= end.slice(0, 7); m === 12 ? (y++, m = 1) : m++) months.push([y, m]);

  const revenue = {}; // invoiced revenue per month
  months.forEach(([y, m], i) => {
    const key = ym(y, m);
    // ---- payroll (net salaries) ----
    const base = 535000 * Math.pow(1.0095, i);
    const mult = m === 12 ? 1.82 : m === 2 ? 1.22 : 1; // 13th month in December, annual bonus in February
    const planned = base * mult;
    const actualPay = planned * (1 + 0.009 * rng.normal());
    const payDue = rollDate(cal, clampDay(y, m, m === 12 ? 22 : 28), 'preceding');
    push({ cat: 'payroll', label: `Net salaries ${monthName(m)}`, counterparty: 'Employees (payroll)', due: payDue, amount: r0(actualPay),
      est: [[addDays(payDue, -80), r0(planned), 0.04], [addDays(payDue, -25), r0(planned), 0.02], [addDays(payDue, -4), r0(actualPay), 0.002]] });
    // ---- DSN social charges, due 5th of M+1 ----
    const [ny, nm] = m === 12 ? [y + 1, 1] : [y, m + 1];
    const dsnDue = rollDate(cal, clampDay(ny, nm, 5), 'following');
    const dsnEst = 0.82 * actualPay;
    const dsnAct = dsnEst * (1 + 0.012 * rng.normal());
    push({ cat: 'social', label: `URSSAF and retirement (DSN ${monthName(m)})`, counterparty: 'URSSAF / AGIRC-ARRCO', due: dsnDue, amount: r0(dsnAct),
      est: [[addDays(dsnDue, -80), r0(0.82 * planned), 0.05], [payDue, r0(dsnEst), 0.025], [addDays(dsnDue, -3), r0(dsnAct), 0.002]] });
    // ---- VAT on month M revenue, due 21st of M+1 ----
    const rev = 1720000 * Math.pow(1.013, i) * (1 + 0.04 * rng.normal());
    revenue[key] = rev;
    const vatEst = 0.2 * rev * 0.6;
    const vatAct = vatEst * (1 + 0.07 * rng.normal());
    const vatDue = rollDate(cal, clampDay(ny, nm, 21), 'following');
    push({ cat: 'vat', label: `VAT return (CA3 ${monthName(m)})`, counterparty: 'DGFiP', due: vatDue, amount: r0(vatAct),
      est: [[addDays(vatDue, -80), r0(0.2 * 1720000 * Math.pow(1.013, i) * 0.6), 0.15], [clampDay(ny, nm, 1), r0(vatEst), 0.09], [addDays(vatDue, -6), r0(vatAct), 0]] });
    // ---- rent, quarterly in advance ----
    if ([1, 4, 7, 10].includes(m)) {
      const due = rollDate(cal, clampDay(y, m, 1), 'following');
      push({ cat: 'rent', label: `Office rent Q${(m + 2) / 3}`, counterparty: 'SCI Haussmann 112', due, amount: 268500, est: [[addDays(due, -60), 268500, 0]] });
    }
    // ---- cloud direct debit on the 3rd ----
    {
      const due = rollDate(cal, clampDay(y, m, 3), 'following');
      const trend = 64000 * Math.pow(1.011, i);
      const act = trend * (1 + 0.07 * rng.normal());
      push({ cat: 'cloud', label: `Cloud infrastructure (${monthName(m === 1 ? 12 : m - 1)} usage)`, counterparty: 'Nimbus Cloud EMEA', due, amount: r0(act),
        est: [[addDays(due, -80), r0(trend), 0.1], [addDays(due, -25), r0(trend), 0.08], [addDays(due, -2), r0(act), 0]] });
    }
    // ---- CFE (local business tax), 15 December ----
    if (m === 12) {
      const due = rollDate(cal, clampDay(y, 12, 15), 'following');
      push({ cat: 'tax', label: 'CFE (cotisation foncière des entreprises)', counterparty: 'DGFiP', due, amount: 28400, est: [[clampDay(y, 11, 1), 28400, 0]] });
    }
    // ---- supplier invoices, Net 30/45, paid on Tuesday/Friday payment runs ----
    const nInv = rng.poisson(31);
    for (let k = 0; k < nInv; k++) {
      const issue = clampDay(y, m, 1 + Math.floor(rng.u() * 28));
      const terms = rng.u() < 0.7 ? 30 : 45;
      let due = addDays(issue, terms);
      while (![2, 5].includes(weekday(due)) || !cal.isSepaDay(due)) due = addDays(due, 1);
      const amt = Math.min(240000, rng.lognormal(6800, 1.15));
      const known = addDays(issue, Math.floor(rng.u() * 6));
      push({ cat: 'supplier', label: supplierName(rng), counterparty: `Invoice ${issue.replace(/-/g, '').slice(2)}-${String(k + 1).padStart(2, '0')}, Net ${terms}`, due, amount: r0(amt), est: [[known, r0(amt), 0]] });
    }
  });
  for (const it of items) if (!it.counterparty) it.counterparty = it.label;

  // ---- unscheduled outflows (cards, direct debits, urgent transfers): never known in advance ----
  const unscheduled = {}, adhoc = [];
  const inflows = {};
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const biz = cal.isSepaDay(d);
    let x = biz ? rng.lognormal(7200, 0.55) : rng.lognormal(1300, 0.7);
    if (biz && rng.u() < 0.03) { const a = Math.min(420000, rng.lognormal(65000, 0.75)); x += a; adhoc.push([d, r0(a)]); }
    unscheduled[d] = r0(x);
    inflows[d] = biz ? r0(rng.lognormal(5200, 0.5)) : 0; // card-acquirer payouts
  }
  // customer receipts: invoices issued on the 1st, paid around Net 30 with lognormal delays
  months.forEach(([y, m]) => {
    const rev = revenue[ym(y, m)];
    const nCust = 64;
    for (let c = 0; c < nCust; c++) {
      const share = rev / nCust * (0.5 + rng.u());
      let pay = addDays(clampDay(y, m, 1), 30 + Math.round(rng.lognormal(4, 0.9)) - 2);
      while (!cal.isSepaDay(pay)) pay = addDays(pay, 1);
      if (pay <= end) inflows[pay] = r0((inflows[pay] || 0) + share);
    }
  });
  items.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));
  return { items, unscheduled, inflows, adhoc, start, end };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function monthName(m) { return MONTHS[m - 1]; }
const SUPPLIERS = ['Lumio Analytics', 'Collectif Freelance Nord', 'Brume Studio (design)', 'Cabinet Delorme (legal)', 'Audit & Associés',
  'Mutuelle Santé Plus', 'Titres-Repas Services', 'Comptacloud', 'Searchly', 'Heatmap Labs', 'Atelier Signal (brand)', 'Kerneo Security',
  'Pipeline CRM', 'Docspace', 'Vectoria Design Tools', 'Facility Services Paris', 'Transports Hiver', 'Campus Numérique', 'Nuage Hosting',
  'Mailtrain', 'SignFlow', 'PaieExpress', 'Dépense Cards', 'FormBox', 'École du Code (training)'];
function supplierName(rng) { return SUPPLIERS[Math.floor(rng.u() * SUPPLIERS.length)]; }

export { diffDays };
