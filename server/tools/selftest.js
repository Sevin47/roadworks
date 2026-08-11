/**
 * End-to-end smoke test: connects three managers to a running server, piles
 * them onto one work order, and checks that the crowd actually closes it.
 *   node server/tools/selftest.js [http://host:port]
 */
import WebSocket from 'ws';

const base = process.argv[2] || 'http://localhost:8080';
const wsUrl = base.replace(/^http/, 'ws');

const log = (...a) => console.log(...a);
let fail = 0;
function check(name, cond, extra = '') {
  log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) fail++;
}

function manager(name, county) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    const m = { name, ws, self: null, state: null, events: [] };
    ws.on('message', (b) => {
      const msg = JSON.parse(b);
      if (msg.type === 'welcome') {
        m.state = msg.state;
        ws.send(JSON.stringify({ type: 'join', token: `test-${name}`, name, county }));
      } else if (msg.type === 'joined') {
        m.self = msg.you;
        resolve(m);
      } else if (msg.type === 'self') {
        m.self = msg.you;
      } else if (msg.type === 'delta') {
        m.delta = msg;
        for (const j of msg.jobs || []) m.lastJobs = (m.lastJobs || new Map()).set(j.id, j);
        m.events.push(...(msg.events || []));
      }
    });
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const a = await manager('TestAlpha', 'Kanawha');
const b = await manager('TestBravo', 'Kanawha');
const c = await manager('TestCharlie', 'Cabell');
check('three managers joined', !!(a.self && b.self && c.self));
check('manager seeded with crews', a.self.maxCrews >= 3, `maxCrews=${a.self.maxCrews}`);
check('board has work orders', a.state.jobs.length > 100, `${a.state.jobs.length} jobs`);
check('geometry present', a.state.jobs.every((j) => j.coords?.length >= 2));
check('milepoints preserved', a.state.jobs.some((j) => j.emp > j.bmp));
check('all ten districts represented',
  new Set(a.state.jobs.map((j) => j.district)).size === 10,
  [...new Set(a.state.jobs.map((j) => j.district))].sort((x, y) => x - y).join(','));

// Pick the cheapest open job so the test finishes quickly.
const target = a.state.jobs.filter((j) => !j.done).sort((x, y) => x.effort - y.effort)[0];
log(`\n  target: ${target.activity} on ${target.routeLabel} (${target.county} Co.) effort=${target.effort}\n`);

const xpBefore = a.self.xp;
for (const m of [a, b, c]) m.ws.send(JSON.stringify({ type: 'dispatch', jobId: target.id }));
await wait(4000);
const enRoute = a.delta.crews.filter((cr) => cr.jobId === target.id);
check('all three crews dispatched to the same job', enRoute.length === 3, `${enRoute.length} crews`);

const deadline = Date.now() + 120_000;
let closed = null;
while (Date.now() < deadline && !closed) {
  await wait(1500);
  const j = a.lastJobs?.get(target.id);
  if (j?.done) closed = j;
}
check('crowd closed the work order', !!closed);
await wait(1500);
check('XP awarded to contributor', a.self.xp > xpBefore, `${xpBefore} -> ${a.self.xp}`);
check('completion hit the ticker', a.events.some((e) => e.type === 'complete'));

const lb = a.delta.leaderboard || [];
check('leaderboard ranks the managers', lb.length >= 3, `${lb.length} entries`);

for (const m of [a, b, c]) m.ws.close();
log(`\n${fail ? `${fail} check(s) failed` : 'all checks passed'}`);
process.exit(fail ? 1 : 0);
