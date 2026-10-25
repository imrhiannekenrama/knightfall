/* Knightfall Arena — Vercel serverless API (Supabase Postgres).
   Single catch-all function: every /api/* request routes through here.
   All DB access uses the service_role key server-side; the browser only
   ever talks to these endpoints, never to Supabase directly. */
'use strict';
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const C = require('../lib/chess-core');
const puzzlesPublic = require('../lib/puzzles');
const PUZZLES = require('../lib/puzzles').withSolutions;

/* ---------- config ---------- */
const required = () => {
  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'APP_SECRET'].filter(k => !process.env[k]);
  if (missing.length) throw new Error('Missing environment variables: ' + missing.join(', '));
};
let sb = null;
const db = () => sb || (sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }));

/* ---------- helpers ---------- */
const json = v => JSON.stringify(v);
const parse = (v, o = []) => { try { return JSON.parse(v) } catch { return o } };
const now = () => Date.now();
const uid = () => crypto.randomUUID();
const key = () => crypto.createHash('sha256').update(process.env.APP_SECRET).digest();
const hash = t => crypto.createHmac('sha256', key()).update(t).digest('hex');
const randomCode = p => p + '-' + crypto.randomBytes(6).toString('hex').toUpperCase();
function err(message, status = 400) { const e = new Error(message); e.status = status; throw e }
function response(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(json(data));
}
const validateString = (s, max = 500) => typeof s === 'string' && s.trim().length > 0 && s.trim().length <= max;
async function body(req) {
  const chunks = []; let len = 0;
  for await (const c of req) { len += c.length; if (len > 200000) err('Payload too large', 413); chunks.push(c) }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { err('Malformed JSON') }
}
function encrypt(v) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(v, 'utf8'), c.final()]).toString('hex');
  return [iv.toString('hex'), c.getAuthTag().toString('hex'), enc].join('.');
}
function decrypt(v) {
  const [a, b, c] = v.split('.'), d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(a, 'hex'));
  d.setAuthTag(Buffer.from(b, 'hex'));
  return Buffer.concat([d.update(Buffer.from(c, 'hex')), d.final()]).toString('utf8');
}
function passHash(pass) { const s = crypto.randomBytes(16).toString('hex'); return s + ':' + crypto.scryptSync(pass, s, 64).toString('hex') }
function passMatches(pass, stored) { try { const [s, h] = stored.split(':'); return crypto.timingSafeEqual(crypto.scryptSync(pass, s, 64), Buffer.from(h, 'hex')) } catch { return false } }
const secure = req => (req.headers['x-forwarded-proto'] === 'https' || process.env.NODE_ENV === 'production');
const authCookie = (req, token, maxAge) => 'kf_session=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge + (secure(req) ? '; Secure' : '');

/* in-memory throttle: effective within one warm serverless instance only */
const limits = new Map();
function throttle(ip, bucket, max = 12, period = 60000) {
  const k = ip + '|' + bucket, t = now(), l = (limits.get(k) || []).filter(x => t - x < period);
  if (l.length >= max) err('Too many requests. Try again shortly.', 429);
  l.push(t); limits.set(k, l);
}

/* supabase wrappers */
async function one(q) { const r = await q.maybeSingle(); if (r.error) throw err('Database error: ' + r.error.message, 500); return r.data }
async function many(q) { const r = await q; if (r.error) throw err('Database error: ' + r.error.message, 500); return r.data || [] }
async function rpc(name, args) {
  const r = await db().rpc(name, args);
  if (r.error) throw err('Database error: ' + r.error.message, 500);
  return r.data;
}
async function insert(table, row) { const r = await db().from(table).insert(row); if (r.error) throw err('Database error: ' + r.error.message, 500) }
async function updateWhere(table, data, match) {
  let q = db().from(table).update(data);
  for (const [k, v] of Object.entries(match)) q = v === null ? q.is(k, null) : q.eq(k, v);
  const r = await q.select();
  if (r.error) throw err('Database error: ' + r.error.message, 500);
  return r.data || [];
}

/* ---------- auth ---------- */
async function sessionUser(req) {
  const cookie = req.headers.cookie || '', token = (cookie.match(/(?:^|;\s*)kf_session=([^;]+)/) || [])[1];
  if (!token) return null;
  const s = await one(db().from('sessions').select('user_id,expires_at').eq('token_hash', hash(token)));
  if (!s || s.expires_at <= now()) return null;
  const u = await one(db().from('users').select('id,email,username,role,xp,created_at').eq('id', s.user_id));
  return u || null;
}
const requireUser = u => { if (!u) err('Please sign in first', 401); return u };
const adminOnly = u => { requireUser(u); if (u.role !== 'admin') err('Administrator access required', 403) };
async function createUser(email, username, password, role = 'player') {
  const id = uid();
  await insert('users', { id, email: email.toLowerCase(), username, password_hash: passHash(password), role, created_at: now() });
  return id;
}
async function newSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await insert('sessions', { token_hash: hash(token), user_id: userId, expires_at: now() + 30 * 86400000 });
  return token;
}
async function messengerLink() {
  const s = await one(db().from('settings').select('value').eq('key', 'messenger_url'));
  return s?.value || process.env.MESSENGER_URL || 'https://m.me/';
}
function validMessengerLink(input) { try { const u = new URL(input); return u.protocol === 'https:' && ['m.me', 'messenger.com', 'www.messenger.com', 'facebook.com', 'www.facebook.com'].includes(u.hostname) } catch { return false } }

/* ---------- chess / domain ---------- */
function currentClock(g) {
  const s = C.parseFen(g.fen), w = g.clock_w, b = g.clock_b;
  if (g.status !== 'active') return { w, b };
  const elapsed = Math.max(0, now() - g.turn_started);
  return s.turn === 'w' ? { w: w - elapsed, b } : { w, b: b - elapsed };
}
async function finishGame(g, result, reason) {
  if (g.status !== 'active') return;
  await updateWhere('games', { status: 'finished', result, reason, ended_at: now(), draw_offer_by: null }, { id: g.id, status: 'active' });
}
async function flagIfNeeded(g) {
  if (g.status !== 'active') return false;
  const c = currentClock(g), turn = C.parseFen(g.fen).turn;
  if ((turn === 'w' ? c.w : c.b) > 0) return false;
  const winner = turn === 'w' ? 'b' : 'w';
  const board = C.parseFen(g.fen).board;
  const available = board.filter(x => x && (winner === 'w' ? x === x.toUpperCase() : x === x.toLowerCase())).filter(x => x.toLowerCase() !== 'k');
  const result = available.length ? (winner === 'w' ? '1-0' : '0-1') : '1/2-1/2';
  await updateWhere('games', { clock_w: Math.max(0, c.w), clock_b: Math.max(0, c.b) }, { id: g.id });
  await finishGame(g, result, available.length ? 'Time forfeiture' : 'Time expired — opponent has only a king');
  return true;
}
function classifyOpening(moves) {
  const a = moves.map(m => m.san).slice(0, 8).join(' ');
  if (a.startsWith('e4 c5')) return 'Sicilian Defense';
  if (a.startsWith('e4 e6')) return 'French Defense';
  if (a.startsWith('e4 c6')) return 'Caro-Kann Defense';
  if (a.startsWith('e4 e5 Nf3 Nc6 Bc4')) return 'Italian Game';
  if (a.startsWith('e4 e5 Nf3 Nc6 Bb5')) return 'Ruy Lopez';
  if (a.startsWith('d4 d5 c4')) return 'Queen’s Gambit';
  if (a.startsWith('d4 Nf6 c4 g6')) return 'King’s Indian Defense';
  if (a.startsWith('d4') && a.includes('Bf4')) return 'London System';
  if (a.startsWith('e4 e5')) return 'Open Game';
  if (a.startsWith('d4')) return 'Queen’s Pawn Game';
  if (a.startsWith('e4')) return 'King’s Pawn Game';
  return 'Other opening';
}
async function userStats(id) {
  const games = await many(db().from('games').select('*,tournaments(name)').or(`white_id.eq.${id},black_id.eq.${id}`).eq('status', 'finished').order('ended_at', { ascending: false }));
  let wins = 0, losses = 0, draws = 0; const openings = {};
  for (const g of games) {
    const result = g.white_id === id ? g.result : (g.result === '1-0' ? '0-1' : g.result === '0-1' ? '1-0' : '1/2-1/2');
    if (result === '1-0') wins++; else if (result === '0-1') losses++; else draws++;
    const opening = classifyOpening(parse(g.moves));
    const obj = openings[opening] || { name: opening, games: 0, wins: 0 };
    obj.games++; if (result === '1-0') obj.wins++;
    openings[opening] = obj;
  }
  const wc = (await many(db().from('signals').select('id').eq('user_id', id).eq('status', 'confirmed'))).length;
  return { played: games.length, wins, losses, draws, winRate: games.length ? Math.round(wins / games.length * 100) : 0, warnings: wc, openings: Object.values(openings).sort((a, b) => b.games - a.games).slice(0, 6) };
}
async function entrants(id) {
  const rows = await many(db().from('entries').select('user_id,status,joined_at,users(username)').eq('tournament_id', id).order('joined_at'));
  const sigs = await many(db().from('signals').select('user_id').eq('tournament_id', id).eq('status', 'confirmed'));
  const wc = {}; for (const s of sigs) wc[s.user_id] = (wc[s.user_id] || 0) + 1;
  return rows.map(e => ({ id: e.user_id, username: e.users.username, status: e.status, joined_at: e.joined_at, warnings: wc[e.user_id] || 0 }));
}
async function standings(id) {
  const e = (await entrants(id)).filter(x => x.status === 'active');
  const games = await many(db().from('games').select('white_id,black_id,result').eq('tournament_id', id).eq('status', 'finished'));
  return e.map(p => {
    let won = 0, lost = 0, draw = 0, played = 0;
    for (const g of games) {
      if (g.white_id !== p.id && g.black_id !== p.id) continue;
      played++;
      if (g.result === '1/2-1/2') draw++;
      else if ((g.result === '1-0' && g.white_id === p.id) || (g.result === '0-1' && g.black_id === p.id)) won++;
      else lost++;
    }
    return { ...p, won, lost, draw, played, points: won + draw * .5 };
  }).sort((a, b) => b.points - a.points || b.won - a.won || a.lost - b.lost || a.username.localeCompare(b.username)).map((p, i) => ({ ...p, rank: i + 1 }));
}
async function awardPrizes(id) {
  const existing = await one(db().from('prize_codes').select('id').eq('tournament_id', id).limit(1));
  if (existing) return;
  const sorted = (await standings(id)).filter(x => x.played > 0).slice(0, 3);
  for (const p of sorted) {
    const code = randomCode('WIN');
    try { await insert('prize_codes', { id: uid(), tournament_id: id, user_id: p.id, rank: p.rank, code_hash: hash(code), code_encrypted: encrypt(code), created_at: now() })} catch { /* concurrent close already inserted this player's code */ }
  }
}
async function closeTournament(id) {
  const t = await one(db().from('tournaments').select('*').eq('id', id));
  if (!t || t.status === 'finished') return;
  const active = await many(db().from('games').select('*').eq('tournament_id', id).eq('status', 'active'));
  for (const g of active) { const c = currentClock(g); await updateWhere('games', { clock_w: Math.max(c.w, 0), clock_b: Math.max(c.b, 0) }, { id: g.id }); await finishGame(g, '1/2-1/2', 'Tournament finished by director') }
  await updateWhere('tournaments', { status: 'finished' }, { id, status: 'live' });
  await db().from('queue').delete().eq('tournament_id', id);
  await awardPrizes(id);
}
async function maybeAutoTournaments() {
  const t = now();
  const ts = await many(db().from('tournaments').select('*').in('status', ['scheduled', 'live']));
  for (const x of ts) {
    if (x.status === 'scheduled' && x.starts_at <= t && x.ends_at > t) await updateWhere('tournaments', { status: 'live' }, { id: x.id, status: 'scheduled' });
    if (x.status === 'live' && x.ends_at <= t) await closeTournament(x.id);
  }
}
const GAMES_SELECT = 'id,tournament_id,white_id,black_id,fen,moves,status,result,reason,clock_w,clock_b,turn_started,draw_offer_by,started_at,ended_at';
async function gameView(g, u) {
  const [white, black] = await Promise.all([
    one(db().from('users').select('id,username').eq('id', g.white_id)),
    one(db().from('users').select('id,username').eq('id', g.black_id))
  ]);
  const sigs = u && u.role === 'admin' ? await many(db().from('signals').select('*').eq('game_id', g.id)) : undefined;
  return { ...g, moves: parse(g.moves), white, black, myColor: u?.id === g.white_id ? 'w' : u?.id === g.black_id ? 'b' : null, serverNow: now(), fairPlaySignals: sigs };
}
async function tourneyView(t, u, detail = false) {
  const [entryRows, queueRows, activeGames] = await Promise.all([
    many(db().from('entries').select('tournament_id,user_id,status').eq('tournament_id', t.id)),
    u ? many(db().from('queue').select('tournament_id,user_id').eq('tournament_id', t.id)) : Promise.resolve([]),
    u ? many(db().from('games').select('id,white_id,black_id').eq('tournament_id', t.id).eq('status', 'active')) : Promise.resolve([])
  ]);
  const n = entryRows.filter(x => x.status === 'active').length;
  const joined = u ? entryRows.find(x => x.user_id === u.id) : null;
  const active = u ? activeGames.find(g => g.white_id === u.id || g.black_id === u.id) : null;
  const queued = u ? queueRows.some(x => x.user_id === u.id) : false;
  const base = { ...t, playerCount: n, joined: joined?.status === 'active', entryStatus: joined?.status || null, activeGameId: active?.id || null, queued };
  if (detail) {
    base.standings = await standings(t.id);
    base.games = await many(db().from('games').select('id,result,status,started_at,ended_at,white:users!games_white_id_fkey(username),black:users!games_black_id_fkey(username)').eq('tournament_id', t.id).order('started_at', { ascending: false }).limit(20));
  }
  return base;
}
const moveRejections = new Map();
async function recordRejectedMove(g, userId, from, to) {
  const k = g.id + ':' + userId, attempts = (moveRejections.get(k) || []).filter(x => now() - x.at < 90000);
  attempts.push({ at: now(), from: String(from).slice(0, 5), to: String(to).slice(0, 5) });
  moveRejections.set(k, attempts);
  if (attempts.length === 5) await makeSignal({ tournament_id: g.tournament_id, game_id: g.id, user_id: userId, kind: 'rejected_move_burst', evidence: { message: 'Five rejected move requests from the client in 90 seconds. Can be bugs or misclicks; not standalone evidence of cheating.', attempts, reviewRequired: true } });
}
async function makeSignal(data) {
  if (data.kind === 'rapid_moves') {
    const dup = await one(db().from('signals').select('id').eq('game_id', data.game_id).eq('user_id', data.user_id).eq('kind', data.kind).eq('status', 'open').limit(1));
    if (dup) return;
  }
  const id = uid();
  await insert('signals', { id, tournament_id: data.tournament_id, game_id: data.game_id || null, user_id: data.user_id, kind: data.kind, evidence: json(data.evidence), created_at: now() });
  return id;
}
async function checkMoveSignals(game, moves, userId) {
  const own = moves.filter(x => x.by === userId).slice(-7);
  if (own.length < 6) return;
  const fast = own.filter(x => x.thinkMs >= 0 && x.thinkMs < 220);
  if (fast.length >= 5) await makeSignal({ tournament_id: game.tournament_id, game_id: game.id, user_id: userId, kind: 'rapid_moves', evidence: { message: 'Five or more very fast moves; may simply be preparation or pre-moves. Not proof of cheating.', moveNumbers: fast.map(x => x.ply), thinkTimesMs: fast.map(x => x.thinkMs), reviewRequired: true } });
}

/* ---------- router ---------- */
module.exports = async (req, res) => {
  try {
    required();
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    const parts = url.pathname.split('/').filter(Boolean);
    const method = req.method;
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    if (method === 'POST' && req.headers.origin) {
      const host = req.headers.host || '';
      try { if (new URL(req.headers.origin).host !== host) err('Cross-origin requests are not allowed', 403) } catch { err('Cross-origin requests are not allowed', 403) }
    }
    if (!['GET', 'POST'].includes(method)) return response(res, 405, { error: 'Method not allowed' });
    if (parts[0] !== 'api' || parts.length < 2) return response(res, 404, { error: 'Endpoint not found' });
    const u = await sessionUser(req);
    const sub = parts[1];

    if (sub === 'health' && method === 'GET') return response(res, 200, { ok: true, version: '2.0.0', time: now() });
    if (sub === 'setup' && method === 'POST') {
      throttle(ip, 'setup', 10);
      const b = await body(req);
      if (!process.env.SETUP_TOKEN || String(b.setupToken || '') !== process.env.SETUP_TOKEN) err('Invalid setup token', 403);
      if (!validateString(b.adminEmail, 150) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.adminEmail.trim())) err('Enter a valid admin email');
      if (typeof b.adminPassword !== 'string' || b.adminPassword.length < 12) err('Admin password must be at least 12 characters');
      const adminExists = await one(db().from('users').select('id').eq('role', 'admin').limit(1));
      let adminEmail = null;
      if (!adminExists) { await createUser(b.adminEmail.trim(), 'TournamentDirector', b.adminPassword, 'admin'); adminEmail = b.adminEmail.trim(); }
      if (b.seedDemo) {
        const t = now(), day = 86400000;
        const existing = await one(db().from('tournaments').select('id').limit(1));
        if (!existing) {
          const demos = [
            ['The Autumn Crown', 'Our featured rapid arena. Beautiful chess, thoughtful competition, and a champion’s finish.', t + 2 * day, t + 2 * day + 2 * 3600000, 10, 5, 64, '₱150', 'Champion ₱3,000 · Runner-up ₱1,500', 'scheduled'],
            ['Sunday Rapid Open', 'An open arena for sharp minds and quicker clocks. Enter with a one-time access code.', t - 3600000, t + 3 * 3600000, 5, 3, 48, '₱75', 'Top 3 cash awards', 'live'],
            ['Midnight Blitz Series', 'Fast pieces, fearless decisions. An evening of three-minute blitz.', t + 6 * day, t + 6 * day + 90 * 60000, 3, 2, 32, '₱100', 'Champion ₱1,500', 'scheduled']
          ];
          for (const [name, description, starts_at, ends_at, base_minutes, increment_seconds, max_players, entry_fee, prize_text, status] of demos)
            await insert('tournaments', { id: uid(), name, description, starts_at, ends_at, base_minutes, increment_seconds, max_players, entry_fee, prize_text, status, created_at: t });
        }
      }
      return response(res, 200, { ok: true, adminCreated: !!adminEmail, adminEmail, message: adminEmail ? 'Administrator created. Sign in from the website login.' : 'An administrator already existed; none created.' });
    }

    if (sub === 'bootstrap' && method === 'GET') {
      await maybeAutoTournaments();
      const ts = await many(db().from('tournaments').select('*').order('starts_at'));
      return response(res, 200, {
        user: u ? { ...u, stats: await userStats(u.id) } : null,
        tournaments: await Promise.all(ts.map(t => tourneyView(t, u))),
        messengerUrl: await messengerLink(),
        puzzles: puzzlesPublic, serverNow: now()
      });
    }
    if (sub === 'notifications' && method === 'GET') {
      if (!u) return response(res, 200, { warnings: 0, prizes: 0, serverNow: now() });
      const wc = (await many(db().from('signals').select('id').eq('user_id', u.id).eq('status', 'confirmed'))).length;
      const pc = (await many(db().from('prize_codes').select('id').eq('user_id', u.id))).length;
      return response(res, 200, { warnings: wc, prizes: pc, serverNow: now() });
    }

    if (sub === 'auth' && method === 'POST') {
      throttle(ip, 'auth', 12, 60000); const b = await body(req);
      if (parts[2] === 'register') {
        const email = String(b.email || '').trim().toLowerCase(), username = String(b.username || '').trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 150) err('Enter a valid email');
        if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) err('Username must be 3–20 letters, numbers or underscores');
        if (typeof b.password !== 'string' || b.password.length < 10 || b.password.length > 128) err('Password must be 10–128 characters');
        const dup = await one(db().from('users').select('id').or(`email.eq.${email},username.eq.${username}`).limit(1));
        if (dup) err('Email or username already exists', 409);
        const id = await createUser(email, username, b.password);
        const token = await newSession(id);
        return response(res, 201, { ok: true }, { 'Set-Cookie': authCookie(req, token, 30 * 86400) });
      }
      if (parts[2] === 'login') {
        const identity = String(b.identity || '').trim();
        const account = await one(db().from('users').select('*').or(`email.eq.${identity.toLowerCase()},username.eq.${identity}`).limit(1));
        if (!account || !passMatches(String(b.password || ''), account.password_hash)) err('Invalid credentials', 401);
        const token = await newSession(account.id);
        return response(res, 200, { ok: true }, { 'Set-Cookie': authCookie(req, token, 30 * 86400) });
      }
      if (parts[2] === 'logout') {
        const cookie = req.headers.cookie || '', token = (cookie.match(/(?:^|;\s*)kf_session=([^;]+)/) || [])[1];
        if (token) await db().from('sessions').delete().eq('token_hash', hash(token));
        return response(res, 200, { ok: true }, { 'Set-Cookie': authCookie(req, '', 0) });
      }
    }

    if (sub === 'me' && method === 'GET') {
      requireUser(u);
      const games = await many(db().from('games').select('*,white:users!games_white_id_fkey(username),black:users!games_black_id_fkey(username),tournaments(name)').or(`white_id.eq.${u.id},black_id.eq.${u.id}`).order('started_at', { ascending: false }).limit(80));
      const prizes = await many(db().from('prize_codes').select('*,tournaments(name)').eq('user_id', u.id));
      const solved = await many(db().from('puzzle_solves').select('puzzle_id').eq('user_id', u.id));
      const warnings = await many(db().from('signals').select('kind,evidence,created_at,review_notes,tournaments(name)').eq('user_id', u.id).eq('status', 'confirmed').order('created_at', { ascending: false }));
      return response(res, 200, {
        user: { ...u, stats: await userStats(u.id) },
        games: games.map(g => ({ ...g, moves: parse(g.moves), tournamentName: g.tournaments?.name })),
        prizes: prizes.map(p => ({ id: p.id, rank: p.rank, tournamentName: p.tournaments?.name, code: decrypt(p.code_encrypted), claimedAt: p.claimed_at })),
        solved: solved.map(x => x.puzzle_id),
        warnings: warnings.map(w => ({ kind: w.kind, evidence: parse(w.evidence, {}), created_at: w.created_at, review_notes: w.review_notes, tournamentName: w.tournaments?.name }))
      });
    }

    if (sub === 'tournaments') {
      if (parts.length === 2 && method === 'GET') {
        const ts = await many(db().from('tournaments').select('*').order('starts_at'));
        return response(res, 200, { tournaments: await Promise.all(ts.map(t => tourneyView(t, u))) });
      }
      const t = await one(db().from('tournaments').select('*').eq('id', parts[2] || ''));
      if (!t) err('Tournament not found', 404);
      if (parts.length === 3 && method === 'GET') { await maybeAutoTournaments(); const fresh = await one(db().from('tournaments').select('*').eq('id', t.id)); return response(res, 200, { tournament: await tourneyView(fresh, u, true) }); }
      if (parts[3] === 'join' && method === 'POST') {
        requireUser(u); throttle(ip, 'join', 15); const b = await body(req);
        if (t.status === 'finished') err('Tournament has ended');
        if (t.status === 'live' && now() > t.ends_at) err('Entry is closed');
        if (await one(db().from('entries').select('user_id').eq('tournament_id', t.id).eq('user_id', u.id).limit(1))) err('Already registered for this tournament');
        const n = (await many(db().from('entries').select('user_id,status').eq('tournament_id', t.id))).filter(x => x.status === 'active').length;
        if (n >= t.max_players) err('Tournament is full');
        const code = String(b.code || '').trim().toUpperCase();
        const ok = await rpc('kf_redeem', { p_tournament: t.id, p_code_hash: hash(code), p_user: u.id });
        if (!ok) err('Code is invalid or already redeemed');
        return response(res, 200, { ok: true });
      }
      if (parts[3] === 'queue' && method === 'POST') {
        requireUser(u);
        if (t.status !== 'live') err('Tournament is not live');
        if (await one(db().from('games').select('id').eq('tournament_id', t.id).eq('status', 'active').or(`white_id.eq.${u.id},black_id.eq.${u.id}`).limit(1))) err('You already have an active game');
        let gameId;
        try { gameId = await rpc('kf_try_pair', { p_tournament: t.id, p_user: u.id }) } catch (e) { if (String(e.message).includes('not_registered')) err('Join the tournament first', 403); else if (String(e.message).includes('already_playing')) err('You already have an active game'); else throw e }
        return response(res, 200, { queued: !gameId, gameId });
      }
      if (parts[3] === 'leave-queue' && method === 'POST') {
        requireUser(u);
        await db().from('queue').delete().eq('tournament_id', t.id).eq('user_id', u.id);
        return response(res, 200, { ok: true });
      }
    }

    if (sub === 'games') {
      requireUser(u);
      const g = await one(db().from('games').select(GAMES_SELECT).eq('id', parts[2] || ''));
      if (!g) err('Game not found', 404);
      if (parts.length === 3 && method === 'GET') {
        const flagged = await flagIfNeeded(g);
        const fresh = flagged ? await one(db().from('games').select(GAMES_SELECT).eq('id', g.id)) : g;
        return response(res, 200, { game: await gameView(fresh, u) });
      }
      if (method === 'POST') {
        if (u.id !== g.white_id && u.id !== g.black_id) err('Only participants can control this game', 403);
        const flagged = await flagIfNeeded(g);
        if (g.status !== 'active' || flagged) err('This game is complete');
        const s = C.parseFen(g.fen), myColor = u.id === g.white_id ? 'w' : 'b', clock = currentClock(g);
        const b = await body(req);
        if (parts[3] === 'move') {
          throttle(u.id, 'move', 80, 10000);
          if (s.turn !== myColor) err('Wait for your turn');
          const m = C.moveFromInput(s, String(b.from || ''), String(b.to || ''), String(b.promotion || 'q'));
          if (!m) { await recordRejectedMove(g, u.id, b.from, b.to); throttle(u.id, 'invalid-move', 8, 60000); err('Illegal move') }
          const newState = C.apply(s, m), moves = parse(g.moves), thinkMs = now() - g.turn_started, after = C.fenOf(newState);
          const times = { w: Math.max(clock.w, 0), b: Math.max(clock.b, 0) };
          times[myColor] += (await one(db().from('tournaments').select('increment_seconds').eq('id', g.tournament_id))).increment_seconds * 1000;
          moves.push({ ply: moves.length + 1, from: m.fromSquare, to: m.toSquare, promotion: m.promotion || null, uci: m.uci, san: m.san, fen: after, at: now(), by: u.id, thinkMs, clockWhiteMs: times.w, clockBlackMs: times.b });
          const updated = await updateWhere('games', { fen: after, moves: json(moves), clock_w: times.w, clock_b: times.b, turn_started: now(), draw_offer_by: null }, { id: g.id, status: 'active', turn_started: g.turn_started, moves: g.moves });
          if (!updated.length) err('The game changed while you moved. Refresh and try again.', 409);
          let ss = C.parseFen(C.START), counts = { [C.positionKey(ss)]: 1 };
          for (const row of moves) { ss = C.apply(ss, C.moveFromInput(ss, row.from, row.to, row.promotion)); counts[C.positionKey(ss)] = (counts[C.positionKey(ss)] || 0) + 1 }
          const end = C.gameState(newState, counts);
          if (end.over) { await finishGame(g, end.result, end.reason); return response(res, 200, { ok: true, move: m.san, gameOver: true }) }
          await checkMoveSignals(g, moves, u.id);
          return response(res, 200, { ok: true, move: m.san, gameOver: false });
        }
        if (parts[3] === 'resign') { await finishGame(g, myColor === 'w' ? '0-1' : '1-0', 'Resignation'); return response(res, 200, { ok: true }) }
        if (parts[3] === 'draw-offer') { await updateWhere('games', { draw_offer_by: u.id }, { id: g.id, status: 'active' }); return response(res, 200, { ok: true }) }
        if (parts[3] === 'draw-accept') { if (!g.draw_offer_by || g.draw_offer_by === u.id) err('No opponent draw offer'); await finishGame(g, '1/2-1/2', 'Draw by agreement'); return response(res, 200, { ok: true }) }
        if (parts[3] === 'draw-claim') {
          if (s.turn !== myColor) err('You must have the move to claim');
          let ss = C.parseFen(C.START), cnt = { [C.positionKey(ss)]: 1 };
          for (const row of parse(g.moves)) { ss = C.apply(ss, C.moveFromInput(ss, row.from, row.to, row.promotion)); cnt[C.positionKey(ss)] = (cnt[C.positionKey(ss)] || 0) + 1 }
          const st = C.gameState(s, cnt);
          if (!st.canClaimThreefold && !st.canClaimFifty) err('A threefold repetition or 50-move draw is not available');
          await finishGame(g, '1/2-1/2', st.canClaimThreefold ? 'Threefold repetition claimed' : '50-move rule claimed');
          return response(res, 200, { ok: true });
        }
      }
    }

    if (sub === 'puzzles' && parts[3] === 'solve' && method === 'POST') {
      const p = PUZZLES.find(x => x.id === parts[2]);
      if (!p) err('Puzzle not found', 404);
      const b = await body(req), answer = String(b.move || '').toLowerCase();
      if (answer !== p.solution) return response(res, 200, { correct: false, message: 'Not quite. Revisit the king’s escape squares.' });
      if (!u) return response(res, 200, { correct: true, newSolve: false, xp: 0, guest: true });
      const existed = await one(db().from('puzzle_solves').select('user_id').eq('user_id', u.id).eq('puzzle_id', p.id).limit(1));
      if (!existed) {
        await insert('puzzle_solves', { user_id: u.id, puzzle_id: p.id, solved_at: now() });
        await updateWhere('users', { xp: (u.xp || 0) + (p.difficulty === 'Beginner' ? 40 : 75) }, { id: u.id });
      }
      return response(res, 200, { correct: true, newSolve: !existed, xp: !existed ? (p.difficulty === 'Beginner' ? 40 : 75) : 0 });
    }

    if (sub === 'admin') {
      adminOnly(u);
      if (parts[2] === 'games' && parts[4] === 'evidence' && method === 'GET') {
        const g = await one(db().from('games').select('*').eq('id', parts[3] || ''));
        if (!g) err('Game not found', 404);
        const [event, white, black, cases] = await Promise.all([
          one(db().from('tournaments').select('id,name,starts_at,ends_at,base_minutes,increment_seconds').eq('id', g.tournament_id)),
          one(db().from('users').select('id,username').eq('id', g.white_id)),
          one(db().from('users').select('id,username').eq('id', g.black_id)),
          many(db().from('signals').select('*,users!signals_user_id_fkey(username)').eq('game_id', g.id).order('created_at'))
        ]);
        const evidence = { generatedAt: new Date().toISOString(), gameId: g.id, event, white, black, startingFen: C.START, currentFen: g.fen, status: g.status, result: g.result, reason: g.reason, startedAt: g.started_at, endedAt: g.ended_at, moveHistory: parse(g.moves), fairPlayCases: cases.map(c => ({ id: c.id, user_id: c.user_id, kind: c.kind, evidence: parse(c.evidence, {}), status: c.status, created_at: c.created_at, reviewed_at: c.reviewed_at, review_notes: c.review_notes, player: c.users?.username })) };
        return response(res, 200, { record: evidence, serverIntegrityHmac: hash(json(evidence)), notice: 'This record documents logged events and decisions. It does not independently prove engine assistance.' });
      }
      if (parts[2] === 'settings' && parts.length === 3 && method === 'POST') {
        const b = await body(req), link = String(b.messengerUrl || '').trim();
        if (!validMessengerLink(link)) err('Provide a valid https:// m.me or messenger.com link');
        const r = await db().from('settings').upsert({ key: 'messenger_url', value: link });
        if (r.error) throw err('Database error: ' + r.error.message, 500);
        return response(res, 200, { ok: true });
      }
      if (parts[2] === 'tournaments' && parts.length === 3 && method === 'POST') {
        const b = await body(req);
        if (!validateString(b.name, 90) || !validateString(b.description, 500)) err('Tournament name and description required');
        const start = Date.parse(b.startsAt), end = Date.parse(b.endsAt);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end <= now()) err('Set a valid upcoming tournament window');
        const base = Number(b.baseMinutes), inc = Number(b.incrementSeconds), max = Number(b.maxPlayers);
        if (!Number.isInteger(base) || base < 1 || base > 180 || !Number.isInteger(inc) || inc < 0 || inc > 60 || !Number.isInteger(max) || max < 2 || max > 2048) err('Invalid clock or player limit');
        const id = uid();
        await insert('tournaments', { id, name: b.name.trim(), description: b.description.trim(), starts_at: start, ends_at: end, base_minutes: base, increment_seconds: inc, max_players: max, entry_fee: String(b.entryFee || 'Free').slice(0, 60), prize_text: String(b.prizeText || 'To be announced').slice(0, 180), status: 'scheduled', created_at: now() });
        return response(res, 201, { ok: true, id });
      }
      if (parts[2] === 'tournaments' && parts.length === 5 && method === 'POST') {
        const t = await one(db().from('tournaments').select('*').eq('id', parts[3] || ''));
        if (!t) err('Tournament not found', 404);
        const b = await body(req);
        if (parts[4] === 'codes') {
          const n = Number(b.count || 1);
          if (!Number.isInteger(n) || n < 1 || n > 40) err('Generate 1 to 40 codes at a time');
          if (t.status === 'finished') err('Tournament is finished');
          const codes = [];
          for (let i = 0; i < n; i++) { const code = randomCode('JOIN'); await insert('join_codes', { id: uid(), tournament_id: t.id, code_hash: hash(code), issued_at: now() }); codes.push(code) }
          return response(res, 200, { codes, message: 'Codes are shown only now. Share one per verified payment in Messenger.' });
        }
        if (parts[4] === 'status') {
          if (!['live', 'finished'].includes(b.status)) err('Invalid tournament status');
          if (t.status === 'finished') err('Cannot reopen a finished tournament');
          if (b.status === 'finished') await closeTournament(t.id);
          else await updateWhere('tournaments', { status: 'live' }, { id: t.id, status: 'scheduled' });
          return response(res, 200, { ok: true });
        }
      }
      if (parts[2] === 'cases' && parts.length === 3 && method === 'POST') {
        const b = await body(req);
        const t = await one(db().from('tournaments').select('id').eq('id', b.tournamentId || ''));
        const p = await one(db().from('users').select('id').eq('id', b.userId || ''));
        if (!t || !p) err('Select a valid registered player');
        if (!await one(db().from('entries').select('user_id').eq('tournament_id', t.id).eq('user_id', p.id).limit(1))) err('Select a valid registered player');
        if (!validateString(b.evidence, 1500)) err('Provide specific evidence, not just a suspicion');
        const id = await makeSignal({ tournament_id: t.id, user_id: p.id, game_id: null, kind: 'director_report', evidence: { description: b.evidence, source: 'Director-submitted incident', reviewRequired: true } });
        return response(res, 201, { ok: true, id });
      }
      if (parts[2] === 'cases' && parts.length === 5 && parts[4] === 'revoke' && method === 'POST') {
        const c = await one(db().from('signals').select('*').eq('id', parts[3] || ''));
        if (!c || c.status !== 'confirmed') err('No confirmed case to revoke', 404);
        const b = await body(req);
        if (!validateString(b.notes, 1000)) err('Document the appeal decision');
        await updateWhere('signals', { status: 'dismissed', reviewer_id: u.id, reviewed_at: now(), review_notes: 'REVOKED ON APPEAL: ' + b.notes }, { id: c.id, status: 'confirmed' });
        const cnt = (await many(db().from('signals').select('id').eq('user_id', c.user_id).eq('tournament_id', c.tournament_id).eq('status', 'confirmed'))).length;
        if (cnt < 3) await updateWhere('entries', { status: 'active' }, { tournament_id: c.tournament_id, user_id: c.user_id, status: 'defaulted' });
        return response(res, 200, { ok: true, remainingWarnings: cnt, note: 'Any concluded game forfeiture requires separate director resolution.' });
      }
      if (parts[2] === 'cases' && parts.length === 5 && parts[4] === 'review' && method === 'POST') {
        const c = await one(db().from('signals').select('*').eq('id', parts[3] || ''));
        if (!c) err('Case not found', 404);
        if (c.status !== 'open') err('This case was already reviewed');
        const b = await body(req);
        if (!['confirmed', 'dismissed'].includes(b.decision)) err('Invalid decision');
        if (!validateString(b.notes, 1000)) err('Record the evidence and decision rationale');
        await updateWhere('signals', { status: b.decision, reviewer_id: u.id, reviewed_at: now(), review_notes: b.notes.trim() }, { id: c.id, status: 'open' });
        if (b.decision === 'confirmed') {
          const cnt = (await many(db().from('signals').select('id').eq('user_id', c.user_id).eq('tournament_id', c.tournament_id).eq('status', 'confirmed'))).length;
          if (cnt >= 3) {
            await updateWhere('entries', { status: 'defaulted' }, { tournament_id: c.tournament_id, user_id: c.user_id });
            await db().from('queue').delete().eq('tournament_id', c.tournament_id).eq('user_id', c.user_id);
            const active = await many(db().from('games').select('*').eq('tournament_id', c.tournament_id).eq('status', 'active').or(`white_id.eq.${c.user_id},black_id.eq.${c.user_id}`));
            for (const g of active) await finishGame(g, g.white_id === c.user_id ? '0-1' : '1-0', 'Default: third confirmed fair-play violation');
          }
        }
        return response(res, 200, { ok: true });
      }
      if (parts[2] === 'prizes' && parts[3] === 'claim' && method === 'POST') {
        throttle(ip, 'prize-verify', 15, 60000);
        const b = await body(req);
        const p = await one(db().from('prize_codes').select('*,users!inner(username)').eq('tournament_id', b.tournamentId || '').eq('users.username', String(b.username || '')));
        if (!p || String(p.users?.username ?? '').toLowerCase() !== String(b.username || '').toLowerCase() || p.code_hash !== hash(String(b.code || '').trim().toUpperCase())) err('Invalid prize claim details', 400);
        if (p.claimed_at) err('Prize has already been claimed');
        const upd = await updateWhere('prize_codes', { claimed_at: now() }, { id: p.id, claimed_at: null });
        if (!upd.length) err('Prize has already been claimed');
        return response(res, 200, { ok: true, username: p.users.username, rank: p.rank });
      }
      if (!parts[2] && method === 'GET') {
        const [mset, ts, users, cases, prizes, codes] = await Promise.all([
          one(db().from('settings').select('value').eq('key', 'messenger_url')),
          many(db().from('tournaments').select('*').order('starts_at')),
          many(db().from('users').select('id,username,email,role,xp,created_at').order('created_at', { ascending: false }).limit(150)),
          many(db().from('signals').select('*,users!signals_user_id_fkey(username),tournaments(name)').order('created_at', { ascending: false }).limit(150)),
          many(db().from('prize_codes').select('id,rank,claimed_at,created_at,tournaments(name),users(username)').order('created_at', { ascending: false }).limit(100)),
          many(db().from('join_codes').select('tournament_id,used_by'))
        ]);
        const isOpen = x => x.status === 'open';
        cases.sort((a, b) => (isOpen(b) ? 1 : 0) - (isOpen(a) ? 1 : 0) || b.created_at - a.created_at);
        const withCounts = [];
        for (const t of ts) {
          const eRows = await many(db().from('entries').select('user_id,status').eq('tournament_id', t.id));
          withCounts.push({ ...t, codesRemaining: codes.filter(c => c.tournament_id === t.id && !c.used_by).length, playerCount: eRows.filter(x => x.status === 'active').length });
        }
        return response(res, 200, {
          settings: { messengerUrl: mset?.value || process.env.MESSENGER_URL || 'https://m.me/' },
          tournaments: withCounts,
          users,
          cases: cases.map(s => ({ ...s, evidence: parse(s.evidence, {}) })),
          prizes: prizes.map(p => ({ id: p.id, rank: p.rank, claimed_at: p.claimed_at, tournamentName: p.tournaments?.name, username: p.users?.username }))
        });
      }
    }

    err('Endpoint not found', 404);
  } catch (e) {
    if (!e.status) console.error('API error:', e);
    if (!res.headersSent) response(res, e.status || 500, { error: e.status ? e.message : 'Internal server error' });
    else res.end();
  }
};
