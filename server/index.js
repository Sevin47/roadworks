import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WebSocketServer } from 'ws';
import { PORT, PUBLIC_DIR, REFRESH_MS, BROADCAST_MS, CATEGORY } from './config.js';
import { Game } from './game.js';
import { listDistrictReports } from './wv511.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const game = new Game();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/state') {
    return json(res, game.fullState());
  }
  if (url.pathname === '/api/stats') {
    return json(res, { day: game.day, stats: game.stats(), loading: game.loading });
  }
  if (url.pathname === '/api/sources') {
    try {
      return json(res, { reports: await listDistrictReports(), day: game.day });
    } catch (e) {
      return json(res, { error: String(e.message) }, 502);
    }
  }
  if (url.pathname === '/api/history') {
    return json(res, { history: game.history });
  }
  if (url.pathname === '/api/health') {
    return json(res, {
      ok: game.jobs.size > 0,
      loading: game.loading.active,
      storage: game.store?.kind || 'none',
      reportDate: game.day.reportDate,
      jobs: game.jobs.size,
      players: game.players.size
    });
  }
  if (url.pathname === '/api/refresh' && req.method === 'POST') {
    game.loadDay({ force: true }).catch(() => {});
    return json(res, { ok: true });
  }

  // Static files
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  p = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(PUBLIC_DIR, p);
  if (!file.startsWith(PUBLIC_DIR)) return notFound(res);
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    notFound(res);
  }
});

function json(res, obj, code = 200) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function notFound(res) {
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not found');
}

const wss = new WebSocketServer({ server, perMessageDeflate: true });

wss.on('connection', (ws) => {
  ws.playerId = null;
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });

  send(ws, { type: 'welcome', categories: CATEGORY, state: game.fullState() });

  ws.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    const p = ws.playerId ? game.players.get(ws.playerId) : null;
    if (p) p.lastSeen = Date.now();

    switch (msg.type) {
      case 'join': {
        const player = game.join(msg.token, msg.name, msg.county);
        ws.playerId = player.id;
        send(ws, { type: 'joined', you: publicSelf(player), token: player.token });
        game.log('join', `${player.name} took over as ${player.county} County manager.`);
        broadcast();
        break;
      }
      case 'dispatch': {
        if (!p) return;
        const r = game.dispatch(p.id, msg.jobId);
        if (r.error) send(ws, { type: 'toast', level: 'warn', text: r.error });
        else broadcast();
        break;
      }
      case 'recall': {
        if (!p) return;
        const r = game.recall(p.id, msg.crewId);
        if (r.error) send(ws, { type: 'toast', level: 'warn', text: r.error });
        else broadcast();
        break;
      }
      case 'chat':
        if (p) game.chat(p.id, msg.text);
        break;
      case 'ping':
        send(ws, { type: 'pong' });
        break;
    }
    if (ws.playerId) {
      const me = game.players.get(ws.playerId);
      if (me) send(ws, { type: 'self', you: publicSelf(me) });
    }
  });

  ws.on('close', () => {
    if (ws.playerId) {
      const p = game.players.get(ws.playerId);
      if (p) game.log('leave', `${p.name} signed off.`);
      game.leave(ws.playerId);
      broadcast();
    }
  });
});

function publicSelf(p) {
  return {
    id: p.id, name: p.name, county: p.county, countyCode: p.countyCode, district: p.district,
    home: p.home, level: p.level, xp: p.xp, dayXp: p.dayXp, funds: p.funds,
    jobsDone: p.jobsDone, maxCrews: p.maxCrews,
    crews: p.crews.map((c) => ({ id: c.id, jobId: c.jobId, phase: c.phase, travelLeft: Math.ceil(c.travelLeft) }))
  };
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

let pendingBroadcast = false;
function broadcast() { pendingBroadcast = true; }

setInterval(() => {
  if (!wss.clients.size) { pendingBroadcast = false; return; }
  const delta = game.deltaState();
  const payload = JSON.stringify({ type: 'delta', ...delta, loading: game.loading, day: game.day });
  for (const ws of wss.clients) {
    if (ws.readyState !== ws.OPEN) continue;
    ws.send(payload);
    if (ws.playerId) {
      const me = game.players.get(ws.playerId);
      if (me) send(ws, { type: 'self', you: publicSelf(me) });
    }
  }
  pendingBroadcast = false;
}, BROADCAST_MS);

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 30_000);

// Re-check WV511 periodically; a new reporting date starts a new game day.
setInterval(async () => {
  try {
    const before = game.day.reportDate;
    await game.loadDay({ force: true });
    if (game.day.reportDate !== before) {
      for (const ws of wss.clients) send(ws, { type: 'newday', state: game.fullState() });
    }
  } catch { /* keep playing on the cached day */ }
}, REFRESH_MS);

// Hosted platforms send SIGTERM on deploy and on idle spin-down; get the
// in-flight board and scores written before the process goes away.
let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n  ${sig} - saving state…`);
    await game.flush({ force: true }).catch(() => {});
    process.exit(0);
  });
}

await game.init();

server.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  const lan = Object.values(nets).flat().find((n) => n && n.family === 'IPv4' && !n.internal);
  console.log(`\n  WVDOT Roadworks running`);
  console.log(`    local:   http://localhost:${PORT}`);
  if (lan) console.log(`    network: http://${lan.address}:${PORT}   <- share this with coworkers`);
  console.log(`    report:  ${game.day.reportDate}  (${game.jobs.size} work orders)\n`);
});
