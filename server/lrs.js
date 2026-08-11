import path from 'node:path';
import { LRS_COUNTY_MP, COUNTIES_LAYER, CACHE_DIR } from './config.js';
import { agsQuery, readJson, writeJson, pool, simplify, round5, pathLengthMi } from './util.js';

const COUNTY_FILE = path.join(CACHE_DIR, 'counties.json');

/** WV511 route-type token -> WVDOT LRS CO_SignSystem code. */
const SIGN_SYSTEM = { I: '1', US: '2', WV: '3', CO: '4', HA: '5', PK: '3', OT: '5' };
const SIGN_FALLBACK = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

let counties = null;   // name(lower) -> {name, code, district, fips}
let routeCache = null; // "cc|s|nnnn|ss" -> {paths:[[ [x,y,m], ... ]]} | null

export async function loadCounties() {
  if (counties) return counties;
  const cached = await readJson(COUNTY_FILE, null);
  let rows = cached?.rows;
  if (!rows) {
    const res = await agsQuery(COUNTIES_LAYER, {
      where: '1=1',
      outFields: 'NAME,CO_CODE,Districts,FIPS',
      returnGeometry: 'true',
      outSR: '4326',
      maxAllowableOffset: '0.02',
      geometryPrecision: '4'
    });
    rows = res.features.map((f) => ({
      name: f.attributes.NAME,
      code: String(f.attributes.CO_CODE).padStart(2, '0'),
      district: Number(f.attributes.Districts),
      fips: f.attributes.FIPS,
      center: ringCentroid(f.geometry)
    }));
    await writeJson(COUNTY_FILE, { fetchedAt: new Date().toISOString(), rows });
  }
  counties = new Map();
  for (const r of rows) counties.set(normCounty(r.name), r);
  return counties;
}

export function countyList() {
  return counties ? [...counties.values()].sort((a, b) => a.name.localeCompare(b.name)) : [];
}

export function lookupCounty(name) {
  return counties?.get(normCounty(name)) || null;
}

/** Area-weighted centroid of a polygon's outer rings - used as the county HQ. */
function ringCentroid(geom) {
  let ax = 0, ay = 0, aa = 0;
  for (const ring of geom?.rings || []) {
    for (let i = 0; i < ring.length - 1; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[i + 1];
      const cross = x1 * y2 - x2 * y1;
      aa += cross;
      ax += (x1 + x2) * cross;
      ay += (y1 + y2) * cross;
    }
  }
  if (!aa) return null;
  return [round5(ax / (3 * aa)), round5(ay / (3 * aa))];
}

function normCounty(n) {
  return String(n).toLowerCase().replace(/\s*county\s*$/, '').replace(/[^a-z]/g, '');
}

/**
 * Raw LRS geometry is huge (statewide interstates run to tens of MB), so it is
 * only ever held in memory for the duration of a geocoding pass. The clipped,
 * simplified result is what gets persisted, as part of the day's job bundle.
 */
async function loadRouteCache() {
  if (!routeCache) routeCache = new Map();
  return routeCache;
}

export function releaseRouteCache() {
  routeCache = null;
}

/** "119/32" -> { num: "0119", sub: "32" } */
function splitRoute(routeNumber) {
  const [a, b] = String(routeNumber).split('/');
  const num = String(a).replace(/\D/g, '').padStart(4, '0').slice(-4);
  const sub = b ? String(b).replace(/\D/g, '').padStart(2, '0').slice(-2) : '00';
  return { num, sub };
}

async function queryRoute(countyCode, sign, num, sub) {
  const where =
    (countyCode ? `CO_CountyID='${countyCode}' AND ` : '') +
    `CO_SignSystem='${sign}' AND CO_RouteNumber='${num}' AND CO_SubRoute='${sub}'`;
  const res = await agsQuery(LRS_COUNTY_MP, {
    where,
    outFields: 'CO_ROUTEID,CO_RouteLabel,CO_CountyID',
    returnGeometry: 'true',
    returnM: 'true',
    outSR: '4326',
    resultRecordCount: countyCode ? '20' : '80'
  });
  const paths = [];
  for (const f of res.features || []) {
    const cc = f.attributes?.CO_CountyID || null;
    for (const p of f.geometry?.paths || []) {
      const fixed = fillMeasures(p);
      if (fixed && fixed.length > 1) paths.push({ cc, pts: fixed });
    }
  }
  return paths;
}

/**
 * Fetch (and cache) the county-milepoint geometry for one route. Falls back
 * across sign systems because a handful of report rows use a route-type token
 * that does not match the LRS sign system for that road.
 */
export async function getRouteGeometry(countyName, routeType, routeNumber) {
  await loadCounties();
  await loadRouteCache();
  const county = countyName ? lookupCounty(countyName) : null;
  if (countyName && !county) return null;

  const { num, sub } = splitRoute(routeNumber);
  const primary = SIGN_SYSTEM[routeType] || '4';
  const cc = county ? county.code : '';
  const key = `${cc || '*'}|${primary}|${num}|${sub}`;
  if (routeCache.has(key)) return routeCache.get(key);

  let paths = await queryRoute(cc, primary, num, sub);
  if (!paths.length) {
    for (const s of SIGN_FALLBACK) {
      if (s === primary) continue;
      paths = await queryRoute(cc, s, num, sub);
      if (paths.length) break;
    }
  }
  const value = paths.length ? { paths } : null;
  routeCache.set(key, value);
  return value;
}

/** Some vertices come back with null M; interpolate them from their neighbours. */
function fillMeasures(pts) {
  const idx = [];
  for (let i = 0; i < pts.length; i++) if (Number.isFinite(pts[i][2])) idx.push(i);
  if (idx.length < 2) return null;
  const out = pts.map((p) => [p[0], p[1], p[2]]);
  for (let k = 0; k < idx.length - 1; k++) {
    const a = idx[k];
    const b = idx[k + 1];
    for (let i = a + 1; i < b; i++) {
      const t = (i - a) / (b - a);
      out[i][2] = out[a][2] + t * (out[b][2] - out[a][2]);
    }
  }
  for (let i = 0; i < idx[0]; i++) out[i][2] = out[idx[0]][2];
  for (let i = idx[idx.length - 1] + 1; i < out.length; i++) out[i][2] = out[idx[idx.length - 1]][2];
  return out;
}

/** Clip one measured path to [lo, hi] county milepoints. */
function clipPath(pts, lo, hi) {
  const asc = pts[pts.length - 1][2] >= pts[0][2];
  const p = asc ? pts : [...pts].reverse();
  const out = [];
  for (let i = 0; i < p.length - 1; i++) {
    const [x1, y1, m1] = p[i];
    const [x2, y2, m2] = p[i + 1];
    const segLo = Math.min(m1, m2);
    const segHi = Math.max(m1, m2);
    if (segHi < lo || segLo > hi) continue;
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
  // Drop duplicate consecutive vertices.
  return out.filter((c, i) => i === 0 || Math.abs(c[0] - out[i - 1][0]) > 1e-9 || Math.abs(c[1] - out[i - 1][1]) > 1e-9);
}

/**
 * Turn one parsed report row into map geometry.
 * Returns { coords, centroid, miles, exact } or null when the route can't be found.
 */
function bestClip(paths, lo, hi, preferCodes) {
  let best = null;
  for (const p of paths) {
    const c = clipPath(p.pts, lo, hi);
    if (c.length < 2) continue;
    const mi = pathLengthMi(c);
    const rank = preferCodes ? preferCodes.indexOf(p.cc) : 0;
    const score = (rank === -1 ? 99 : rank) * 1000 - mi;
    if (!best || score < best.score) best = { coords: c, mi, score, cc: p.cc };
  }
  return best;
}

export async function locateRow(row) {
  let lo = Math.min(row.bmp, row.emp);
  let hi = Math.max(row.bmp, row.emp);
  if (hi - lo < 0.01) hi = lo + 0.01; // point jobs get a nub so they're clickable

  const home = lookupCounty(row.county);
  const geo = await getRouteGeometry(row.county, row.routeType, row.routeNumber);

  let best = geo ? bestClip(geo.paths, lo, hi) : null;
  let exact = !!best;
  let placedIn = home?.code || null;

  if (!best) {
    // The county heading on the report is the maintenance HQ, and crews
    // routinely work just over the county line. Widen to a statewide search on
    // the same route number, preferring counties in the reporting district.
    const wide = await getRouteGeometry(null, row.routeType, row.routeNumber);
    if (wide) {
      const prefer = countyList()
        .filter((c) => c.district === row.district)
        .map((c) => c.code);
      const w = bestClip(wide.paths, lo, hi, prefer);
      if (w) {
        best = w;
        exact = true;
        placedIn = w.cc;
      }
    }
  }

  if (!best && geo) {
    // Milepoints fall outside the mapped extent of this route (happens on
    // recently re-measured county routes). Show the whole route instead so the
    // job still lands in roughly the right place.
    exact = false;
    for (const p of geo.paths) {
      const c = p.pts.map((v) => [v[0], v[1]]);
      const mi = pathLengthMi(c);
      if (!best || mi > best.mi) best = { coords: c, mi };
    }
  }
  if (!best) return null;

  const coords = simplify(best.coords).map((c) => [round5(c[0]), round5(c[1])]);
  const mid = coords[Math.floor(coords.length / 2)];
  return {
    coords,
    centroid: [round5(mid[0]), round5(mid[1])],
    miles: Math.round(best.mi * 100) / 100,
    exact,
    countyCode: placedIn
  };
}

/** Geolocate a whole batch of rows with bounded concurrency. */
export async function locateRows(rows, { concurrency = 6, onProgress } = {}) {
  await loadCounties();
  await loadRouteCache();
  let done = 0;
  const located = await pool(rows, concurrency, async (row) => {
    const g = await locateRow(row).catch(() => null);
    if (++done % 50 === 0) onProgress?.(done, rows.length);
    return g;
  });
  return located;
}
