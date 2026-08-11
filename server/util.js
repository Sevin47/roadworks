import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, CACHE_DIR } from './config.js';

for (const d of [DATA_DIR, CACHE_DIR]) fs.mkdirSync(d, { recursive: true });

const UA = 'WVDOT-Roadworks-Game/1.0 (internal fun project; contact your local county manager)';

export async function httpGet(url, { as = 'text', tries = 3, timeoutMs = 45000, body = null } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ac.signal,
        method: body ? 'POST' : 'GET',
        headers: body
          ? { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded' }
          : { 'user-agent': UA },
        body: body || undefined
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      if (as === 'buffer') return Buffer.from(await res.arrayBuffer());
      if (as === 'json') return await res.json();
      return await res.text();
    } catch (e) {
      lastErr = e;
      await sleep(600 * (i + 1));
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

/** ArcGIS REST query helper. Always POSTs so long WHERE clauses are safe. */
export async function agsQuery(layerUrl, params) {
  const form = new URLSearchParams({ f: 'json', ...params });
  const json = await httpGet(`${layerUrl}/query`, { as: 'json', body: form.toString() });
  if (json.error) throw new Error(`ArcGIS: ${json.error.message} ${JSON.stringify(json.error.details || [])}`);
  return json;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function writeJson(file, obj) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${(writeJson.n = (writeJson.n || 0) + 1)}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(obj));
  await fsp.rename(tmp, file);
}

/** Run `worker` over `items` with bounded concurrency, preserving order. */
export async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let idx = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      try {
        out[i] = await worker(items[i], i);
      } catch (e) {
        out[i] = { __error: String(e && e.message || e) };
      }
    }
  });
  await Promise.all(runners);
  return out;
}

export function haversineMi(a, b) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const la1 = toRad(a[1]);
  const la2 = toRad(b[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function pathLengthMi(coords) {
  let m = 0;
  for (let i = 1; i < coords.length; i++) m += haversineMi(coords[i - 1], coords[i]);
  return m;
}

/** Ramer-Douglas-Peucker in degree space; good enough for display simplification. */
export function simplify(points, tol = 0.00015, maxPts = 40) {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = perpDist(points[i], points[s], points[e]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  let out = points.filter((_, i) => keep[i]);
  if (out.length > maxPts) {
    const step = (out.length - 1) / (maxPts - 1);
    const thinned = [];
    for (let i = 0; i < maxPts; i++) thinned.push(out[Math.round(i * step)]);
    out = thinned;
  }
  return out;
}

function perpDist(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const den = dx * dx + dy * dy;
  if (den === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / den;
  const tc = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + tc * dx), p[1] - (a[1] + tc * dy));
}

export const round5 = (n) => Math.round(n * 1e5) / 1e5;

export function hashId(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
