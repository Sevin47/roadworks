import { GIS_BASE } from './config.js';
import { agsQuery } from './util.js';
import { loadCounties, lookupCounty } from './lrs.js';

const FACILITIES_LAYER = `${GIS_BASE}/Transportation/MapServer/4`;

/**
 * Classify a highway facility by name rather than by its `Type` column.
 *
 * `Type` is misleading for our purposes: "Materials Division" covers the whole
 * maintenance organization (county headquarters, area headquarters, interstate
 * section garages), not laboratories, and "Equipment Division" covers both
 * substations and the salt stockpiles. The names are the reliable signal.
 */
function classify(name, type) {
  const n = String(name || '').toLowerCase();
  if (type === 'District Headquarters') return 'district_hq';
  if (n.includes('stockpile')) return 'stockpile';
  if (n === 'materials division') return 'lab';
  if (n.includes('substation') || n.includes('sub/')) return 'substation';
  if (/\bi-\d|corridor|section/.test(n)) return 'section';
  if (n.includes('headquarter')) return 'county_hq';
  return 'shop';
}

// Stockpiles hold salt and cinder, not crews; the lab does not dispatch either.
// Both are kept in the table (winter ops will want the stockpiles) but neither
// is a place a truck rolls out of.
const NOT_DISPATCHABLE = new Set(['stockpile', 'lab']);

/** Pull every highway facility and shape it for the `facilities` table. */
export async function fetchFacilities() {
  await loadCounties();
  const res = await agsQuery(FACILITIES_LAYER, {
    where: '1=1',
    outFields: 'OBJECTID,Name,Type,District,County,City,Lat,Long_',
    returnGeometry: 'false'
  });

  const out = [];
  for (const f of res.features || []) {
    const a = f.attributes;
    const lat = Number(a.Lat);
    const lng = Number(a.Long_);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (Math.abs(lat) < 1 || Math.abs(lng) < 1) continue;

    const sourceName = String(a.Name || '').trim() || `Facility ${a.OBJECTID}`;
    const kind = classify(sourceName, a.Type);
    const district = Number(a.District);
    const county = lookupCounty(a.County || '');

    out.push({
      id: String(a.OBJECTID),
      // Placed at the real location, but given a name of our own — see rename().
      name: sourceName,
      kind,
      district: Number.isFinite(district) && district >= 1 && district <= 10 ? district : null,
      county: county?.name || null,
      county_code: county?.code || null,
      lng: Math.round(lng * 1e5) / 1e5,
      lat: Math.round(lat * 1e5) / 1e5,
      dispatchable: !NOT_DISPATCHABLE.has(kind)
    });
  }

  // A facility with no district can't be a dispatch origin, since territory is
  // enforced by district. Infer it from the county where we can.
  for (const f of out) {
    if (!f.district && f.county_code) {
      const c = lookupCounty(f.county);
      if (c) f.district = c.district;
    }
    if (!f.district) f.dispatchable = false;
  }

  return rename(out);
}

/**
 * Replace every facility's published name with a generated one.
 *
 * The locations are public infrastructure data and worth keeping — a crew
 * rolling out of a garage that is really there is the point. The *names* are
 * somebody else's, so they are rebuilt from geography instead: county, district
 * and a sequence number. Numbering is by position so it stays stable between
 * runs rather than shuffling whenever the source ordering changes.
 */
function rename(facilities) {
  const counters = new Map();
  const next = (key) => {
    const n = (counters.get(key) || 0) + 1;
    counters.set(key, n);
    return n;
  };

  const ordered = [...facilities].sort((a, b) =>
    (a.district - b.district) || (a.lng - b.lng) || (a.lat - b.lat));

  for (const f of ordered) {
    const county = f.county || `District ${f.district}`;
    switch (f.kind) {
      case 'district_hq':
        f.name = `District ${f.district} Headquarters`;
        break;
      case 'county_hq': {
        const n = next(`hq:${county}`);
        f.name = n > 1 ? `${county} County Garage ${n}` : `${county} County Garage`;
        break;
      }
      case 'substation':
        f.name = `${county} Substation ${next(`sub:${county}`)}`;
        break;
      case 'section':
        f.name = `District ${f.district} Section Garage ${next(`sec:${f.district}`)}`;
        break;
      case 'stockpile':
        f.name = `${county} Material Stockpile ${next(`pile:${county}`)}`;
        break;
      case 'lab':
        f.name = `District ${f.district} Materials Lab`;
        break;
      default:
        f.name = `${county} Equipment Shop ${next(`shop:${county}`)}`;
    }
  }
  return facilities;
}

export function summarize(facilities) {
  const byKind = {};
  for (const f of facilities) byKind[f.kind] = (byKind[f.kind] || 0) + 1;
  const dispatchable = facilities.filter((f) => f.dispatchable).length;
  const districts = new Set(facilities.filter((f) => f.dispatchable).map((f) => f.district));
  return { total: facilities.length, dispatchable, byKind, districts: districts.size };
}
