import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const CACHE_DIR = path.join(DATA_DIR, 'cache');
// --- Upstream sources -------------------------------------------------------

export const GIS_BASE = 'https://gis.transportation.wv.gov/arcgis/rest/services';
// Public linear-referenced road centrelines, measured in county milepoints.
// The measures are what let a work zone be placed at a real BMP / EMP on a
// real road rather than at an arbitrary point in space.
export const LRS_COUNTY_MP =
  `${GIS_BASE}/Roads_And_Highways/Publication_LRS/MapServer/89`;
export const COUNTIES_LAYER = `${GIS_BASE}/Boundaries/MapServer/1`;
export const DISTRICTS_LAYER = `${GIS_BASE}/Boundaries/MapServer/3`;

// --- Game tuning ------------------------------------------------------------
// Gameplay numbers live in the database (see supabase/schema.sql); what stays
// here is only what the board generator needs.

// Effort (crew-seconds) per category before length scaling.
export const CATEGORY = {
  'Maintenance':          { base: 55,  perMile: 14, xp: 10, pay: 120, color: '#4cc9f0' },
  'Bridge':               { base: 130, perMile: 25, xp: 26, pay: 320, color: '#f7b32b' },
  'Heavy Maintenance':    { base: 110, perMile: 20, xp: 20, pay: 260, color: '#b892ff' },
  'Closures':             { base: 70,  perMile: 10, xp: 16, pay: 200, color: '#ff5d5d' },
  'Construction Projects':{ base: 190, perMile: 30, xp: 40, pay: 520, color: '#ff8a3d' },
  'Utilities/Oil & Gas':  { base: 80,  perMile: 14, xp: 14, pay: 170, color: '#7cf29b' },
  // Snow and ice control. Generated only in season, ramping through the cold
  // months; the category simply lights up when the weather turns. Plowing at
  // 5am pays better than mowing in July.
  'Winter Ops':           { base: 70,  perMile: 16, xp: 22, pay: 300, color: '#a8e6ff' },
  'Incident':             { base: 60,  perMile: 0,  xp: 34, pay: 430, color: '#ff2e63' }
};
export const DEFAULT_CATEGORY = 'Maintenance';
