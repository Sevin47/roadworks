import { GIS_BASE } from './config.js';
import { agsQuery } from './util.js';
import { loadCounties, lookupCounty } from './lrs.js';

const FACILITIES_LAYER = `${GIS_BASE}/Transportation/MapServer/4`;

/**
 * Classify a WVDOT facility by name rather than by its `Type` column.
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

/** Pull every WVDOT facility and shape it for the `facilities` table. */
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

    const name = String(a.Name || '').trim() || `Facility ${a.OBJECTID}`;
    const kind = classify(name, a.Type);
    const district = Number(a.District);
    const county = lookupCounty(a.County || '');

    out.push({
      id: String(a.OBJECTID),
      name,
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

  return out;
}

export function summarize(facilities) {
  const byKind = {};
  for (const f of facilities) byKind[f.kind] = (byKind[f.kind] || 0) + 1;
  const dispatchable = facilities.filter((f) => f.dispatchable).length;
  const districts = new Set(facilities.filter((f) => f.dispatchable).map((f) => f.district));
  return { total: facilities.length, dispatchable, byKind, districts: districts.size };
}
