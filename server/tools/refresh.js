/**
 * Offline check of the data pipeline: pull today's ten district PDFs, parse
 * them, and locate every row on the WVDOT county-milepoint route network.
 * Prints a coverage report without starting the game server.
 */
import { fetchAllReports } from '../wv511.js';
import { locateRows, loadCounties } from '../lrs.js';

await loadCounties();
const t0 = Date.now();
const bundle = await fetchAllReports({
  onProgress: (d, n) => console.log(`  district ${String(d).padStart(2)} -> ${n} rows`)
});
console.log(`\nreport date : ${bundle.reportDate}`);
console.log(`rows parsed : ${bundle.rows.length}`);
if (bundle.errors.length) console.log('errors      :', bundle.errors);

const geos = await locateRows(bundle.rows, {
  concurrency: 8,
  onProgress: (d, n) => process.stdout.write(`  locating ${d}/${n}\r`)
});

let exact = 0, approx = 0, miss = 0;
const missed = new Map();
const byCat = {};
bundle.rows.forEach((r, i) => {
  byCat[r.category] = (byCat[r.category] || 0) + 1;
  const g = geos[i];
  if (!g) { miss++; missed.set(`${r.county} ${r.routeType} ${r.routeNumber}`, true); }
  else if (g.exact) exact++;
  else approx++;
});

console.log(`\n\nlocated exact  : ${exact}`);
console.log(`located approx : ${approx}`);
console.log(`unlocated      : ${miss}`);
if (missed.size) console.log(`  ${[...missed.keys()].join(', ')}`);
console.log('\nby category    :', byCat);
console.log(`elapsed        : ${((Date.now() - t0) / 1000).toFixed(1)}s`);
