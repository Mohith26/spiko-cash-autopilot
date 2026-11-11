// Fetch Spiko public data (no auth): fund calendars, share classes, NAV history, current yields.
// https://docs.spiko.io/developers/public_api/getting_started
import { writeFileSync } from 'node:fs';
const B = 'https://public-api.spiko.io/v0';
const j = async (p) => { const r = await fetch(B + p); if (!r.ok) throw new Error(p + ' ' + r.status); return r.json(); };
const funds = await j('/funds/');
const shareClasses = await j('/share-classes/');
const pick = ['EUTBL', 'eurSAFO'];
const out = { fetchedAt: new Date().toISOString(), source: B, funds: {}, shareClasses: {} };
for (const f of funds) if (['EUTBL', 'SAFO'].includes(f.slug))
  out.funds[f.slug] = { id: f.id, timezone: f.timezone, launchDay: f.launchDay.slice(0, 10), nonOperatingDays: f.nonOperatingDays.map(d => d.slice(0, 10)).sort() };
for (const s of shareClasses) if (pick.includes(s.symbol)) {
  const navs = await j(`/net-asset-values/${s.symbol}?startDay=2024-04-30`);
  const y = await j(`/share-classes/${s.symbol}/yield`);
  out.shareClasses[s.symbol] = {
    id: s.id, fundId: s.fundId, isin: s.isin, currency: s.currency, name: s.data.en.name,
    managementFees: s.managementFees,
    yield: { daily: +y.dailyYield, weekly: +y.weeklyYield, monthly: +y.monthlyYield, updatedAt: y.updatedAt },
    nav: navs.map(n => [n.day.slice(0, 10), +n.amount.value]).sort((a, b) => a[0] < b[0] ? -1 : 1),
  };
}
writeFileSync(new URL('../data/spiko_public.json', import.meta.url), JSON.stringify(out));
for (const [k, v] of Object.entries(out.shareClasses)) console.log(k, v.name, v.nav.length, v.nav[0], v.nav.at(-1), v.yield);
for (const [k, v] of Object.entries(out.funds)) console.log(k, v.launchDay, v.nonOperatingDays.length);
