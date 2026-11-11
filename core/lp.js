// Small dense two-phase simplex (Bland's rule). minimize c.x  s.t. rows {a, op: '<='|'>='|'=', b}, x >= 0.
// Only used as an independent oracle in tests; the product path uses the O(H) planner in plan.js.
export function solveLP(c, rows, { eps = 1e-9, maxIter = 20000 } = {}) {
  const n = c.length, m = rows.length;
  const norm = rows.map(r => (r.b < 0 ? { a: r.a.map(v => -v), op: r.op === '<=' ? '>=' : r.op === '>=' ? '<=' : '=', b: -r.b } : r));
  let nSlack = 0, nArt = 0;
  for (const r of norm) { if (r.op !== '=') nSlack++; if (r.op !== '<=') nArt++; }
  const N = n + nSlack + nArt;
  const T = Array.from({ length: m + 1 }, () => new Float64Array(N + 1));
  const basis = new Int32Array(m);
  let si = n, ai = n + nSlack;
  const artCols = [];
  norm.forEach((r, i) => {
    for (let j = 0; j < n; j++) T[i][j] = r.a[j];
    T[i][N] = r.b;
    if (r.op === '<=') { T[i][si] = 1; basis[i] = si++; }
    else if (r.op === '>=') { T[i][si++] = -1; T[i][ai] = 1; artCols.push(ai); basis[i] = ai++; }
    else { T[i][ai] = 1; artCols.push(ai); basis[i] = ai++; }
  });
  const pivot = (r, col) => {
    const row = T[r], pv = row[col];
    for (let j = 0; j <= N; j++) row[j] /= pv;
    for (let i = 0; i <= m; i++) if (i !== r) {
      const f = T[i][col];
      if (Math.abs(f) > 0) { const ti = T[i]; for (let j = 0; j <= N; j++) ti[j] -= f * row[j]; }
    }
    basis[r] = col;
  };
  const run = (allowed) => {
    for (let it = 0; it < maxIter; it++) {
      let col = -1;
      for (let j = 0; j < N; j++) if (allowed(j) && T[m][j] < -eps) { col = j; break; } // Bland: lowest index
      if (col < 0) return 'optimal';
      let r = -1, best = Infinity;
      for (let i = 0; i < m; i++) if (T[i][col] > eps) {
        const ratio = T[i][N] / T[i][col];
        if (ratio < best - eps || (Math.abs(ratio - best) <= eps && basis[i] < basis[r])) { best = ratio; r = i; }
      }
      if (r < 0) return 'unbounded';
      pivot(r, col);
    }
    return 'iteration_limit';
  };
  const isArt = new Uint8Array(N); for (const a of artCols) isArt[a] = 1;
  // Phase 1: minimize sum of artificials.
  T[m].fill(0);
  for (const a of artCols) T[m][a] = 1;
  for (let i = 0; i < m; i++) if (isArt[basis[i]]) for (let j = 0; j <= N; j++) T[m][j] -= T[i][j];
  run(() => true);
  if (-T[m][N] > 1e-6 * Math.max(1, ...norm.map(r => Math.abs(r.b)))) return { status: 'infeasible' };
  // Drive artificials out of the basis where possible.
  for (let i = 0; i < m; i++) if (isArt[basis[i]]) {
    for (let j = 0; j < N; j++) if (!isArt[j] && Math.abs(T[i][j]) > eps) { pivot(i, j); break; }
  }
  // Phase 2.
  T[m].fill(0);
  for (let j = 0; j < n; j++) T[m][j] = c[j];
  for (let i = 0; i < m; i++) { const cb = basis[i] < n ? c[basis[i]] : 0; if (cb) for (let j = 0; j <= N; j++) T[m][j] -= cb * T[i][j]; }
  const st = run(j => !isArt[j]);
  if (st !== 'optimal') return { status: st };
  const x = new Float64Array(n);
  for (let i = 0; i < m; i++) if (basis[i] < n) x[basis[i]] = T[i][N];
  let obj = 0; for (let j = 0; j < n; j++) obj += c[j] * x[j];
  return { status: 'optimal', x, obj };
}
