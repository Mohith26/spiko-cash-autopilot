// Split-conformal upper bounds with Mondrian buckets (day class x forecast horizon).
// Score: s = (actual outflow - f) / sigma, computed with the forecast made h days before the payment day.
// For a new day in the same bucket, P(actual <= f + q * sigma) >= 1 - alpha when scores are exchangeable,
// where q is the ceil((n+1)(1-alpha))-th smallest of the n calibration scores (finite-sample correction).

export function conformalQuantile(scores, alpha) {
  const n = scores.length;
  if (!n) return Infinity;
  const k = Math.ceil((n + 1) * (1 - alpha));
  if (k > n) return Infinity;
  const s = Float64Array.from(scores).sort();
  return s[k - 1];
}

export const horizonBucket = (h) => (h <= 0 ? 0 : Math.min(h, 4));
export const bucketKey = (cls, h) => `${cls}|${horizonBucket(h)}`;
export const MIN_N = (alpha) => Math.ceil(1 / alpha) - 1; // smallest n with a finite quantile

// Chebyshev fallback when a bucket has too few scores: P(|X - mu| >= k sigma) <= 1/k^2, so k = 1/sqrt(alpha).
export const chebyshevK = (alpha) => 1 / Math.sqrt(alpha);

// table: array of { d, h, cls, s } (one per realized day and horizon). Uses rows with d < asOf and d >= asOf - window.
export function calibrate(table, asOf, alpha, { windowDays = 730, minDay = null } = {}) {
  const lo = minDay;
  const groups = new Map();
  for (const r of table) {
    if (r.d >= asOf) continue;
    if (lo && r.d < lo) continue;
    const k = bucketKey(r.cls, r.h);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r.s);
  }
  const out = {};
  for (const cls of ['heavy', 'light']) for (const hb of [0, 1, 2, 3, 4]) {
    const k = `${cls}|${hb}`;
    const sc = groups.get(k) || [];
    const q = conformalQuantile(sc, alpha);
    out[k] = Number.isFinite(q) ? { q, n: sc.length, method: 'conformal' } : { q: chebyshevK(alpha), n: sc.length, method: 'chebyshev' };
  }
  return out;
}

export function upperBound(fc, h, cal) {
  const b = cal[bucketKey(fc.cls, h)];
  const margin = Math.max(0, b.q * fc.sigma);
  return { U: fc.f + margin, margin, q: b.q, n: b.n, method: b.method };
}
