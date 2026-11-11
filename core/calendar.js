// Calendar and lead-time engine.
// Dates are ISO day strings ("2026-11-27") interpreted in Europe/Paris; times are minutes after midnight Paris time.
// Rules come from Spiko's public sources:
//   - fund non-operating days: public-api.spiko.io/v0/funds/ (committed snapshot in data/spiko_public.json)
//   - cut-offs: support.spiko.io "Make a standard withdrawal" (T-Bills 11:30 same day; Smart Cash 15:00, next business day)
//   - instant withdrawals: EUR share classes, 24/7, up to EUR 500,000 per day ("Make an instant withdrawal")
//   - SEPA credit: same day on TARGET2 business days.

const DAY_MS = 86400000;

export function parse(iso) { return Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)); }
export function fmt(ms) { return new Date(ms).toISOString().slice(0, 10); }
export function addDays(iso, n) { return fmt(parse(iso) + n * DAY_MS); }
export function diffDays(a, b) { return Math.round((parse(b) - parse(a)) / DAY_MS); } // b - a
export function weekday(iso) { return new Date(parse(iso)).getUTCDay(); } // 0 Sun .. 6 Sat
export function isWeekend(iso) { const w = weekday(iso); return w === 0 || w === 6; }
export function range(from, n) { const out = []; for (let i = 0; i < n; i++) out.push(addDays(from, i)); return out; }

// Anonymous Gregorian algorithm (Meeus/Jones/Butcher).
export function easterSunday(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// TARGET2 closing days (SEPA does not settle): New Year, Good Friday, Easter Monday, 1 May, 25 and 26 December.
export function targetHolidays(year) {
  const e = easterSunday(year);
  return [`${year}-01-01`, addDays(e, -2), addDays(e, 1), `${year}-05-01`, `${year}-12-25`, `${year}-12-26`];
}

// French public holidays (used when a fund calendar does not cover a date, and for payment-date rolling).
export function frenchHolidays(year) {
  const e = easterSunday(year);
  return [`${year}-01-01`, addDays(e, 1), `${year}-05-01`, `${year}-05-08`, addDays(e, 39), addDays(e, 50),
    `${year}-07-14`, `${year}-08-15`, `${year}-11-01`, `${year}-11-11`, `${year}-12-25`];
}

export const PRODUCTS = {
  EUTBL: { key: 'EUTBL', fund: 'EUTBL', name: 'Spiko T-Bills Euro', short: 'T-Bills Euro', cutoffMin: 11 * 60 + 30, lagBusinessDays: 0, instant: true },
  eurSAFO: { key: 'eurSAFO', fund: 'SAFO', name: 'Spiko Euro', short: 'Spiko Euro', cutoffMin: 15 * 60, lagBusinessDays: 1, instant: true },
};
export const INSTANT_CAP = 500000;

export class Calendar {
  // fundCalendars: { EUTBL: {launchDay, nonOperatingDays[]}, SAFO: {...} }
  constructor(fundCalendars = {}) {
    this.fund = {};
    for (const [k, v] of Object.entries(fundCalendars)) {
      const days = new Set(v.nonOperatingDays);
      const years = new Set(v.nonOperatingDays.map(d => +d.slice(0, 4)));
      this.fund[k] = { days, years };
    }
    this.cache = new Map();
  }
  _yearSet(kind, year) {
    const key = kind + year;
    if (!this.cache.has(key)) this.cache.set(key, new Set(kind === 'T' ? targetHolidays(year) : frenchHolidays(year)));
    return this.cache.get(key);
  }
  isSepaDay(iso) { return !isWeekend(iso) && !this._yearSet('T', +iso.slice(0, 4)).has(iso); }
  isFrenchBusinessDay(iso) { return !isWeekend(iso) && !this._yearSet('F', +iso.slice(0, 4)).has(iso); }
  // A fund operating day: weekday and not in the fund's published non-operating list. For years the API does not
  // list (before launch / far future), fall back to French public holidays.
  isFundDay(fund, iso) {
    if (isWeekend(iso)) return false;
    const f = this.fund[fund];
    const y = +iso.slice(0, 4);
    if (f && f.years.has(y)) return !f.days.has(iso);
    return this.isFrenchBusinessDay(iso);
  }
  nextFundDay(fund, iso) { let d = addDays(iso, 1); while (!this.isFundDay(fund, d)) d = addDays(d, 1); return d; }
  nextSepaDayOnOrAfter(iso) { let d = iso; while (!this.isSepaDay(d)) d = addDays(d, 1); return d; }

  // Day the cash of a standard withdrawal lands in the bank (afternoon) when ordered on `day` at `minute`.
  settleDay(productKey, day, minute) {
    const p = PRODUCTS[productKey];
    let processed;
    const beforeCutoff = this.isFundDay(p.fund, day) && minute < p.cutoffMin;
    if (p.lagBusinessDays === 0) processed = beforeCutoff ? day : this.nextFundDay(p.fund, day);
    else {
      const base = beforeCutoff ? day : this.nextFundDay(p.fund, day);
      processed = base;
      for (let i = 0; i < p.lagBusinessDays; i++) processed = this.nextFundDay(p.fund, processed);
    }
    return this.nextSepaDayOnOrAfter(processed);
  }

  // Latest order moment (day, cutoff minute) whose cash lands on or before `arriveBy`, not earlier than (nowDay, nowMin).
  // Returns null if no such moment exists.
  latestOrderFor(productKey, arriveBy, nowDay, nowMin) {
    const p = PRODUCTS[productKey];
    for (let d = arriveBy; diffDays(nowDay, d) >= 0; d = addDays(d, -1)) {
      if (!this.isFundDay(p.fund, d)) continue;
      if (d === nowDay && nowMin >= p.cutoffMin) continue;
      const s = this.settleDay(productKey, d, p.cutoffMin - 1);
      if (diffDays(s, arriveBy) >= 0) return { day: d, minute: p.cutoffMin - 1, settles: s };
    }
    return null;
  }

  // For a planning moment, the set of days on which a standard withdrawal ordered from now on can land,
  // with the latest order moment for each.
  settleOptions(productKey, nowDay, nowMin, horizonDays) {
    const out = new Map();
    for (let i = 0; i < horizonDays; i++) {
      const e = addDays(nowDay, i);
      if (!this.isSepaDay(e)) continue;
      const o = this.latestOrderFor(productKey, e, nowDay, nowMin);
      if (o && o.settles === e) out.set(e, o);
    }
    return out;
  }
}

// Roll a nominal due date to a business day: 'following' (social charges, taxes) or 'preceding' (payroll).
export function rollDate(cal, iso, convention) {
  let d = iso;
  const step = convention === 'preceding' ? -1 : 1;
  while (!cal.isSepaDay(d) || !cal.isFrenchBusinessDay(d)) d = addDays(d, step);
  return d;
}
