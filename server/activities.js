/**
 * The work the game invents.
 *
 * Every activity here is generic highway-maintenance vocabulary, not a copy of
 * any agency's task list. Weights control how often each shows up on a board;
 * `routes` restricts an activity to the road classes it makes sense on, so a
 * plow route never lands on a gravel county road and a lane closure never lands
 * on a driveway.
 */

export const CATALOG = [
  // ---------------------------------------------------------- Maintenance
  { name: 'Pothole Patching',            cat: 'Maintenance', w: 10, len: [0.4, 4] },
  { name: 'Shoulder Repair',             cat: 'Maintenance', w: 8,  len: [0.5, 5] },
  { name: 'Ditch Cleaning',              cat: 'Maintenance', w: 9,  len: [0.3, 3] },
  { name: 'Culvert Cleaning',            cat: 'Maintenance', w: 7,  len: [0.2, 1.5] },
  { name: 'Mowing',                      cat: 'Maintenance', w: 10, len: [1, 8] },
  { name: 'Brush Cutting',               cat: 'Maintenance', w: 8,  len: [0.5, 5] },
  { name: 'Litter Collection',           cat: 'Maintenance', w: 9,  len: [1, 10] },
  { name: 'Street Sweeping',             cat: 'Maintenance', w: 7,  len: [1, 8],  routes: ['I', 'US', 'WV'] },
  { name: 'Sign Replacement',            cat: 'Maintenance', w: 6,  len: [0.1, 1] },
  { name: 'Pavement Marking',            cat: 'Maintenance', w: 6,  len: [1, 9],  routes: ['I', 'US', 'WV'] },
  { name: 'Crack Sealing',               cat: 'Maintenance', w: 7,  len: [0.5, 5] },
  { name: 'Grading - Unpaved Roadway',   cat: 'Maintenance', w: 8,  len: [0.5, 6], routes: ['CO', 'HA'] },
  { name: 'Dust Control',                cat: 'Maintenance', w: 4,  len: [0.5, 4], routes: ['CO', 'HA'] },
  { name: 'Animal Carcass Removal',      cat: 'Maintenance', w: 6,  len: [0.1, 0.4] },
  { name: 'Drainage Repair',             cat: 'Maintenance', w: 6,  len: [0.2, 2] },

  // --------------------------------------------------------------- Bridge
  { name: 'Bridge Inspection',           cat: 'Bridge', w: 4, len: [0.05, 0.3] },
  { name: 'Bridge Deck Repair',          cat: 'Bridge', w: 3, len: [0.05, 0.4] },
  { name: 'Bridge Joint Replacement',    cat: 'Bridge', w: 2, len: [0.05, 0.3] },
  { name: 'Bridge Washing',              cat: 'Bridge', w: 3, len: [0.05, 0.3] },
  { name: 'Bridge Railing Repair',       cat: 'Bridge', w: 2, len: [0.05, 0.3] },

  // ---------------------------------------------------- Heavy Maintenance
  { name: 'Slope Stabilization',         cat: 'Heavy Maintenance', w: 4, len: [0.2, 2] },
  { name: 'Guardrail Replacement',       cat: 'Heavy Maintenance', w: 5, len: [0.2, 2] },
  { name: 'Base Repair',                 cat: 'Heavy Maintenance', w: 4, len: [0.3, 3] },
  { name: 'Retaining Wall Repair',       cat: 'Heavy Maintenance', w: 2, len: [0.1, 1] },
  { name: 'Rock Scaling',                cat: 'Heavy Maintenance', w: 3, len: [0.2, 2] },

  // ------------------------------------------------------------- Closures
  { name: 'Lane Closure',                cat: 'Closures', w: 8, len: [0.5, 6],  routes: ['I', 'US', 'WV'] },
  { name: 'Shoulder Closure',            cat: 'Closures', w: 6, len: [0.5, 5],  routes: ['I', 'US', 'WV'] },
  { name: 'Flagging Operation',          cat: 'Closures', w: 7, len: [0.2, 3] },
  { name: 'Road Closed - Detour',        cat: 'Closures', w: 4, len: [0.5, 6] },
  { name: 'Night Work - Lane Shift',     cat: 'Closures', w: 3, len: [1, 6],    routes: ['I', 'US'] },

  // -------------------------------------------------- Construction Projects
  { name: 'Resurfacing Project',         cat: 'Construction Projects', w: 6, len: [2, 12] },
  { name: 'Widening Project',            cat: 'Construction Projects', w: 3, len: [1, 8] },
  { name: 'Intersection Improvement',    cat: 'Construction Projects', w: 4, len: [0.2, 1.5] },
  { name: 'Culvert Replacement',         cat: 'Construction Projects', w: 4, len: [0.1, 1] },
  { name: 'Paving Operation',            cat: 'Construction Projects', w: 6, len: [1, 10] },
  { name: 'Bridge Replacement',          cat: 'Construction Projects', w: 2, len: [0.1, 0.6] },

  // ----------------------------------------------------- Utilities/Oil & Gas
  { name: 'Utility Permit Work',         cat: 'Utilities/Oil & Gas', w: 6, len: [0.2, 3] },
  { name: 'Pipeline Crossing',           cat: 'Utilities/Oil & Gas', w: 4, len: [0.1, 1] },
  { name: 'Pole Replacement',            cat: 'Utilities/Oil & Gas', w: 4, len: [0.1, 0.8] },
  { name: 'Water Line Repair',           cat: 'Utilities/Oil & Gas', w: 4, len: [0.1, 1.5] },

  // ----------------------------------------------------------- Winter Ops
  // Only generated in season; see winterWeight().
  { name: 'Snow Removal',                cat: 'Winter Ops', w: 12, len: [2, 15] },
  { name: 'Ice Control - Salting',       cat: 'Winter Ops', w: 10, len: [2, 15] },
  { name: 'Brine Application',           cat: 'Winter Ops', w: 8,  len: [2, 12], routes: ['I', 'US', 'WV'] },
  { name: 'Cinder Application',          cat: 'Winter Ops', w: 7,  len: [1, 8] },
  { name: 'Snow Fence Maintenance',      cat: 'Winter Ops', w: 3,  len: [0.2, 2] },
  { name: 'Drift Removal',               cat: 'Winter Ops', w: 5,  len: [0.5, 6] }
];

/** Flavour text, picked to match the activity's category. */
const DETAILS = {
  'Maintenance': [
    'Routine cycle work; expect brief delays.',
    'Crew working from the shoulder.',
    'Single lane affected during working hours.',
    ''
  ],
  'Bridge': [
    'Structure work; height and width restrictions in place.',
    'Alternating traffic across the span.',
    'Inspection access from beneath the deck.',
    ''
  ],
  'Heavy Maintenance': [
    'Heavy equipment on site.',
    'Excavation adjacent to the travel lane.',
    'Expect reduced width through the work zone.',
    ''
  ],
  'Closures': [
    'Follow posted signage and flagger direction.',
    'Detour posted for through traffic.',
    'Closure in effect during posted hours only.',
    ''
  ],
  'Construction Projects': [
    'Long-term project; phased lane restrictions.',
    'Contractor operation with daytime closures.',
    'Reduced speed limit through the project limits.',
    ''
  ],
  'Utilities/Oil & Gas': [
    'Permitted utility work within the right of way.',
    'Bore crossing beneath the roadway.',
    'Temporary shoulder occupancy.',
    ''
  ],
  'Winter Ops': [
    'Treating priority routes first.',
    'Continuous operation until conditions improve.',
    'Plows working; give equipment room.',
    ''
  ]
};

const SHIFTS = [
  ['6:00 AM', '2:30 PM'],
  ['7:00 AM', '3:30 PM'],
  ['7:30 AM', '4:00 PM'],
  ['8:00 AM', '4:30 PM'],
  ['9:00 AM', '5:00 PM'],
  ['6:00 PM', '6:00 AM'],
  ['12:00 AM', '11:59 PM']
];

/**
 * Winter work only appears in season, ramping up through the cold months so the
 * board changes character with the calendar rather than flipping overnight.
 */
export function winterWeight(date) {
  const m = date.getMonth() + 1;           // 1-12
  if (m === 12 || m === 1 || m === 2) return 1;
  if (m === 11 || m === 3) return 0.55;
  if (m === 10 || m === 4) return 0.15;
  return 0;
}

/** Deterministic pseudo-random so a given date always produces the same board. */
export function makeRng(seed) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return function rng() {
    h ^= h << 13; h >>>= 0;
    h ^= h >> 17;
    h ^= h << 5;  h >>>= 0;
    return h / 4294967296;
  };
}

export function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/** Weighted choice over the catalogue, filtered to what suits this road. */
export function pickActivity(rng, routeType, winter) {
  const usable = CATALOG.filter((a) => {
    if (a.cat === 'Winter Ops' && winter <= 0) return false;
    if (a.routes && !a.routes.includes(routeType)) return false;
    return true;
  });
  const weights = usable.map((a) => (a.cat === 'Winter Ops' ? a.w * winter : a.w));
  const total = weights.reduce((x, y) => x + y, 0);
  let r = rng() * total;
  for (let i = 0; i < usable.length; i++) {
    r -= weights[i];
    if (r <= 0) return usable[i];
  }
  return usable[usable.length - 1];
}

export function pickDetail(rng, cat) {
  return pick(rng, DETAILS[cat] || ['']);
}

export function pickShift(rng, cat) {
  if (cat === 'Winter Ops') return pick(rng, [SHIFTS[0], SHIFTS[5], SHIFTS[6]]);
  if (cat === 'Closures') return pick(rng, SHIFTS);
  return pick(rng, SHIFTS.slice(0, 5));
}
