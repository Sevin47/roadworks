import { LRS_COUNTY_MP } from './config.js';
import { agsQuery, pool, round5 } from './util.js';
import { loadCounties, countyList } from './lrs.js';

/**
 * A sampled catalogue of real, measured road centrelines to place work on.
 *
 * The roads are genuine public GIS geometry — that is what makes the map worth
 * looking at — but nothing about the *work* comes from anyone's published
 * schedule. This library is the world; the day generator invents what happens
 * on it.
 *
 * Sign systems are queried separately so a county ends up with a spread of road
 * classes rather than forty segments of whichever one happens to sort first.
 */
const SIGN_TO_TYPE = { 1: 'I', 2: 'US', 3: 'WV', 4: 'CO', 5: 'HA' };

// How many routes to sample per county, per class.
const QUOTA = [
  { sign: '1', take: 4 },
  { sign: '2', take: 6 },
  { sign: '3', take: 10 },
  { sign: '4', take: 22 }
];

function usable(feature) {
  const path = feature.geometry?.paths?.[0];
  if (!path || path.length < 2) return null;

  // Fill gaps in the measure values, then require a real, increasing range —
  // a route with no length in milepoints cannot host a work zone.
  const idx = [];
  for (let i = 0; i < path.length; i++) if (Number.isFinite(path[i][2])) idx.push(i);
  if (idx.length < 2) return null;

  const pts = path.map((p) => [p[0], p[1], p[2]]);
  for (let k = 0; k < idx.length - 1; k++) {
    const a = idx[k];
    const b = idx[k + 1];
    for (let i = a + 1; i < b; i++) {
      const t = (i - a) / (b - a);
      pts[i][2] = pts[a][2] + t * (pts[b][2] - pts[a][2]);
    }
  }
  for (let i = 0; i < idx[0]; i++) pts[i][2] = pts[idx[0]][2];
  for (let i = idx[idx.length - 1] + 1; i < pts.length; i++) pts[i][2] = pts[idx[idx.length - 1]][2];

  const m0 = pts[0][2];
  const m1 = pts[pts.length - 1][2];
  if (!(Math.abs(m1 - m0) > 0.4)) return null;

  return {
    pts: pts.map((p) => [round5(p[0]), round5(p[1]), Math.round(p[2] * 1000) / 1000]),
    m0: Math.min(m0, m1),
    m1: Math.max(m0, m1)
  };
}

/** Sample road centrelines across every county, grouped by road class. */
export async function buildRouteLibrary({ onProgress } = {}) {
  await loadCounties();
  const counties = countyList();
  const tasks = [];
  for (const c of counties) for (const q of QUOTA) tasks.push({ county: c, ...q });

  let done = 0;
  const results = await pool(tasks, 8, async (t) => {
    const res = await agsQuery(LRS_COUNTY_MP, {
      where: `CO_CountyID='${t.county.code}' AND CO_SignSystem='${t.sign}'`,
      outFields: 'CO_ROUTEID,CO_SignSystem,CO_RouteNumber,CO_SubRoute',
      returnGeometry: 'true',
      returnM: 'true',
      outSR: '4326',
      // ~3m. At the previous 45m a work zone visibly cut the corners off any
      // winding road, which is most of them here.
      maxAllowableOffset: '0.00003',
      geometryPrecision: '5',
      resultRecordCount: String(t.take * 3)
    });

    // A route number can come back as several segments, and the first is often
    // a stub a few hundred feet long — useless to place a work zone on. Keep
    // the longest segment for each number, then take the longest overall.
    const best = new Map();
    for (const f of res.features || []) {
      const a = f.attributes;
      const g = usable(f);
      if (!g) continue;
      const key = `${a.CO_RouteNumber}/${a.CO_SubRoute}`;
      const span = g.m1 - g.m0;
      const prev = best.get(key);
      if (prev && prev.span >= span) continue;

      const num = String(a.CO_RouteNumber || '').replace(/^0+/, '') || '0';
      const sub = String(a.CO_SubRoute || '').replace(/^0+/, '');
      best.set(key, {
        span,
        countyCode: t.county.code,
        county: t.county.name,
        district: t.county.district,
        routeType: SIGN_TO_TYPE[t.sign] || 'CO',
        routeNumber: sub ? `${num}/${sub}` : num,
        m0: g.m0,
        m1: g.m1,
        pts: g.pts
      });
    }
    const out = [...best.values()]
      .sort((x, y) => y.span - x.span)
      .slice(0, t.take);

    onProgress?.(++done, tasks.length);
    return out;
  });

  const routes = results.filter((r) => Array.isArray(r)).flat();

  // A county with nothing usable would silently drop out of the game.
  const byCounty = new Map();
  for (const r of routes) {
    if (!byCounty.has(r.countyCode)) byCounty.set(r.countyCode, []);
    byCounty.get(r.countyCode).push(r);
  }
  return { routes, byCounty, counties };
}

/** Clip a measured centreline to a milepoint window. */
export function clipMeasured(pts, lo, hi) {
  const asc = pts[pts.length - 1][2] >= pts[0][2];
  const p = asc ? pts : [...pts].reverse();
  const out = [];
  for (let i = 0; i < p.length - 1; i++) {
    const [x1, y1, m1] = p[i];
    const [x2, y2, m2] = p[i + 1];
    if (Math.max(m1, m2) < lo || Math.min(m1, m2) > hi) continue;
    const at = (m) => {
      if (m2 === m1) return [x1, y1];
      const t = Math.max(0, Math.min(1, (m - m1) / (m2 - m1)));
      return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
    };
    const a = m1 < lo ? at(lo) : m1 > hi ? at(hi) : [x1, y1];
    const b = m2 > hi ? at(hi) : m2 < lo ? at(lo) : [x2, y2];
    if (!out.length) out.push(a);
    out.push(b);
  }
  return out
    .map((c) => [round5(c[0]), round5(c[1])])
    .filter((c, i, arr) => i === 0 || c[0] !== arr[i - 1][0] || c[1] !== arr[i - 1][1]);
}

export function summarize(lib) {
  const byType = {};
  for (const r of lib.routes) byType[r.routeType] = (byType[r.routeType] || 0) + 1;
  const empty = lib.counties.filter((c) => !(lib.byCounty.get(c.code) || []).length);
  return {
    routes: lib.routes.length,
    counties: lib.byCounty.size,
    byType,
    countiesWithNoRoutes: empty.map((c) => c.name)
  };
}
