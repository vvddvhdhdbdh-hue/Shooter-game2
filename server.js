// Neon Arena - multiplayer server. Zero dependencies: `node server.js`
// Serves index.html and the /api/{join,sync,leave} endpoints the game polls.
const http = require('http'), fs = require('fs'), path = require('path');
const PORT = process.env.PORT || 3000;
const MAX_PER_ROOM = 12, RESPAWN_MS = 3000, IDLE_MS = 15000, A = 70;

// ---- arena layout (same seeded generator as the client) so spawns never land inside crates ----
const boxes = [];
(function () {
  const add = (x, z, w, d) => boxes.push({ x, z, hw: w / 2, hd: d / 2 });
  [[-8,-6,3,3],[9,-9,4,2],[0,-14,2.5,2.5],[-14,6,2,4],[12,5,3,3],[3,8,2,2],[-6,14,4,2],[18,-18,3,3],[-20,-15,3,3],[-18,20,3,3],[20,18,3,4]].forEach(a => add(...a));
  let sd = 12345; const rnd = () => (sd = (sd * 1664525 + 1013904223) >>> 0) / 4294967296;
  [[-42,-42],[42,-42],[-42,42],[42,42]].forEach(a => add(a[0], a[1], 3, 3));
  const ok = (x, z, r) => Math.hypot(x, z) > 12 && boxes.every(b => Math.hypot(b.x - x, b.z - z) > b.hw + b.hd + r + 2.5);
  for (let n = 0, tr = 0; n < 80 && tr < 1500; tr++) {
    const x = (rnd()*2-1)*(A-8), z = (rnd()*2-1)*(A-8), k = rnd(); let w, h, d;
    if (k < .55) { w = 2+rnd()*3; d = 2+rnd()*3; h = 2+rnd()*1.4; }
    else if (k < .8) { w = 1.4; d = 1.4; h = 5+rnd()*3; }
    else { w = 7+rnd()*5; d = 1.2; h = 2.4; if (rnd() < .5) { const q = w; w = d; d = q; } }
    if (!ok(x, z, Math.max(w, d) / 1.4)) continue;
    add(x, z, w, d); n++;
  }
})();
const clearSpot = (x, z) => boxes.every(b => Math.abs(x - b.x) > b.hw + 1.8 || Math.abs(z - b.z) > b.hd + 1.8);

const rooms = {};
let nextId = 1;
const num = (v, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function getRoom(code) {
  return rooms[code] || (rooms[code] = { code, players: {}, ev: [], seq: 0 });
}
function pushEv(room, e) {
  e.n = ++room.seq; room.ev.push(e);
  if (room.ev.length > 200) room.ev.shift();
}
function spawnPoint(room) {
  let best = null, bestD = -1;
  for (let i = 0; i < 40; i++) {
    const a = Math.random() * Math.PI * 2, r = 15 + Math.random() * 48;
    const x = Math.sin(a) * r, z = Math.cos(a) * r;
    if (!clearSpot(x, z)) continue;
    let d = 1e9;
    for (const p of Object.values(room.players)) if (p.hp > 0) d = Math.min(d, Math.hypot(p.x - x, p.z - z));
    if (d > bestD) { bestD = d; best = { x, z }; }
  }
  return best || { x: 0, z: 30 };
}
function cleanName(s) { return String(s || '').replace(/[^\w \-.]/g, '').trim().slice(0, 12) || 'Player'; }
function cleanModel(m) {
  if (!m || typeof m !== 'object') return {};
  const o = {}; let n = 0;
  for (const k of Object.keys(m)) { if (n++ > 80) break; if (/^\w{1,16}$/.test(k) && typeof m[k] === 'number' && isFinite(m[k])) o[k] = m[k]; }
  return o;
}
function meView(p) { return { rs: p.rs, x: p.sx, z: p.sz, hp: p.hp, k: p.k, d: p.d }; }

function join(b) {
  const code = String(b.room || 'LOBBY').toUpperCase().replace(/[^A-Z0-9_\-]/g, '').slice(0, 12) || 'LOBBY';
  const room = getRoom(code);
  if (Object.keys(room.players).length >= MAX_PER_ROOM) return { error: 'Room is full' };
  const sp = spawnPoint(room), id = nextId++;
  const p = { id, name: cleanName(b.name), model: cleanModel(b.model), x: sp.x, y: 0, z: sp.z, yaw: 0, pitch: 0,
    hp: 100, k: 0, d: 0, rs: 1, sx: sp.x, sz: sp.z, last: Date.now(), dieAt: 0, budget: 300, bt: Date.now() };
  room.players[id] = p;
  return { id, room: code, seq: room.seq, me: meView(p) };
}
function leave(b) {
  const room = rooms[b.room]; if (!room) return;
  delete room.players[b.id];
  if (!Object.keys(room.players).length) delete rooms[b.room];
}
function sync(b) {
  const room = rooms[b.room], p = room && room.players[b.id];
  if (!p) return { error: 'Session expired' };
  const now = Date.now(); p.last = now;
  // respawn
  if (p.hp <= 0 && now - p.dieAt >= RESPAWN_MS) {
    const sp = spawnPoint(room);
    p.hp = 100; p.rs++; p.sx = sp.x; p.sz = sp.z; p.x = sp.x; p.z = sp.z; p.y = 0;
  }
  // position (trusted, clamped to arena; dead players are frozen)
  if (p.hp > 0 && b.s) {
    p.x = clamp(num(b.s.x, p.x), -A, A); p.z = clamp(num(b.s.z, p.z), -A, A);
    p.y = clamp(num(b.s.y, 0), 0, 30); p.yaw = num(b.s.yaw, 0); p.pitch = clamp(num(b.s.pitch, 0), -1.6, 1.6);
  }
  // damage budget refills over time to blunt spoofed hits
  p.budget = Math.min(600, p.budget + (now - p.bt) * 0.5); p.bt = now;
  if (p.hp > 0) {
    for (const s of (Array.isArray(b.shots) ? b.shots : []).slice(0, 12)) {
      if (!Array.isArray(s.o) || !Array.isArray(s.e) || s.o.length < 3 || s.e.length < 3) continue;
      pushEv(room, { t: 'shot', id: p.id, o: s.o.slice(0, 3).map(v => num(v)), e: s.e.slice(0, 3).map(v => num(v)), w: clamp(num(s.w) | 0, 0, 5), f: s.f ? 1 : 0 });
    }
    for (const h of (Array.isArray(b.hits) ? b.hits : []).slice(0, 16)) {
      const v = room.players[h && h.t];
      if (!v || v.id === p.id || v.hp <= 0) continue;
      const dmg = clamp(Math.round(num(h.dmg)), 0, 120);
      if (dmg <= 0 || p.budget < dmg) continue;
      p.budget -= dmg; v.hp = Math.max(0, v.hp - dmg);
      if (v.hp <= 0) {
        v.d++; p.k++; v.dieAt = now;
        pushEv(room, { t: 'kill', k: p.id, v: v.id, kn: p.name, vn: v.name });
      }
    }
  }
  // drop idle players
  for (const q of Object.values(room.players)) if (now - q.last > IDLE_MS) delete room.players[q.id];
  const known = new Set(Array.isArray(b.known) ? b.known : []);
  const players = Object.values(room.players).map(q => {
    const o = { id: q.id, name: q.name, x: q.x, y: q.y, z: q.z, yaw: q.yaw, pitch: q.pitch, hp: q.hp, k: q.k, d: q.d };
    if (!known.has(q.id)) o.model = q.model;
    return o;
  });
  const since = num(b.since, 0);
  return { seq: room.seq, me: meView(p), players, ev: room.ev.filter(e => e.n > since) };
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon' };
const INDEX = path.join(__dirname, 'index.html');
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };

http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (req.method === 'POST' && url.startsWith('/api/')) {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 200000) req.destroy(); });
    req.on('end', () => {
      let b; try { b = JSON.parse(body || '{}'); } catch (e) { res.writeHead(400, CORS); return res.end('{}'); }
      let out;
      try {
        const ep = url.slice(5);
        out = ep === 'join' ? join(b) : ep === 'sync' ? sync(b) : ep === 'leave' ? (leave(b), {}) : { error: 'Not found' };
      } catch (e) { console.error(e); out = { error: 'Server error' }; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS });
      res.end(JSON.stringify(out));
    });
    return;
  }
  if (url === '/healthz') { res.writeHead(200, CORS); return res.end('ok'); }
  if (url === '/' || url === '/index.html') {
    return fs.readFile(INDEX, (err, data) => {
      if (err) { res.writeHead(500); return res.end('index.html missing'); }
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' }); res.end(data);
    });
  }
  res.writeHead(404); res.end('Not found');
}).listen(PORT, () => console.log('Neon Arena online on http://localhost:' + PORT));
