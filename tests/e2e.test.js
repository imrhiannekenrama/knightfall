/* End-to-end test of the Vercel API router against the in-memory Supabase mock.
   Runs the full director + player lifecycle: setup, auth, tournaments, join
   codes, matchmaking, moves, fair-play review, prizes. TEST-ONLY. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const mock = require('./mock-supabase');
const { Readable } = require('stream');

const ENV = {
  SUPABASE_URL: 'https://mock.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key',
  APP_SECRET: 'test-secret-32-characters-abcdefghij',
  SETUP_TOKEN: 'setup-token-1',
  MESSENGER_URL: 'https://m.me/TestPage'
};
const store = mock.makeStore();
for (const [k, v] of Object.entries(ENV)) process.env[k] = v;
const realCreate = require('@supabase/supabase-js').createClient;
require('@supabase/supabase-js').createClient = () => mock(store);
const api = require('../api/[[...path]].js');

function makeReq(method, path, bodyData, cookies) {
  const req = new Readable({ read() { this.push(null) } });
  req.method = method; req.url = path; req.headers = { host: 'test.local' };
  if (Object.keys(cookies).length) req.headers.cookie = Object.entries(cookies).map(([k, v]) => k + '=' + v).join('; ');
  req.bodyData = bodyData ? JSON.stringify(bodyData) : '';
  const origForAwait = req[Symbol.asyncIterator];
  return new Proxy(req, {
    get(target, prop) {
      if (prop === Symbol.asyncIterator) {
        return async function* () { if (target.bodyData) yield Buffer.from(target.bodyData); };
      }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    }
  });
}
async function call(method, path, data, cookies = {}) {
  const captured = {};
  const res = {
    headersSent: false,
    writeHead(status, headers) { captured.status = status; captured.headers = headers || {}; this.headersSent = true },
    end(chunk) { captured.body = chunk ? String(chunk) : '' },
    setHeader() {}
  };
  await api(makeReq(method, path, data, cookies), res);
  let json = null;
  try { json = JSON.parse(captured.body) } catch { }
  const setCookie = captured.headers?.['Set-Cookie'];
  if (setCookie) {
    const m = setCookie.match(/kf_session=([^;]+)/);
    if (m && m[1]) cookies.kf_session = m[1];
    if (setCookie.includes('kf_session=;')) delete cookies.kf_session;
  }
  return { status: captured.status, body: json, cookies };
}

test('setup, auth and admin flows', async () => {
  process.env.APP_SECRET = ENV.APP_SECRET; process.env.SETUP_TOKEN = ENV.SETUP_TOKEN; process.env.MESSENGER_URL = ENV.MESSENGER_URL;

  // setup rejects a bad token
  let r = await call('POST', '/api/setup', { setupToken: 'wrong', adminEmail: 'a@b.co', adminPassword: 'longpassword1' });
  assert.equal(r.status, 403);

  r = await call('POST', '/api/setup', { setupToken: 'setup-token-1', adminEmail: 'director@test.co', adminPassword: 'longpassword1', seedDemo: true });
  assert.equal(r.status, 200);
  assert.ok(r.body.adminCreated);
  assert.equal(store.users.filter(u => u.role === 'admin').length, 1);
  assert.equal(store.tournaments.length, 3);

  // admin login
  const adm = {};
  r = await call('POST', '/api/auth/login', { identity: 'director@test.co', password: 'longpassword1' }, adm);
  assert.equal(r.status, 200);
  r = await call('GET', '/api/bootstrap', null, {});
  assert.equal(r.status, 200);
  assert.equal(r.body.tournaments.length, 3);
  assert.equal(r.body.messengerUrl, 'https://m.me/TestPage');
  assert.ok(Array.isArray(r.body.puzzles) && r.body.puzzles.length >= 45);
  assert.ok(!('solution' in r.body.puzzles[0]));

  // duplicate admin setup does not create another
  r = await call('POST', '/api/setup', { setupToken: 'setup-token-1', adminEmail: 'x@y.co', adminPassword: 'longpassword2' });
  assert.ok(!r.body.adminCreated);

  // create a tournament
  const start = new Date(Date.now() + 3600e3).toISOString(), end = new Date(Date.now() + 7200e3).toISOString();
  r = await call('POST', '/api/admin/tournaments', { name: 'Test Cup', description: 'A test event', startsAt: start, endsAt: end, baseMinutes: 5, incrementSeconds: 3, maxPlayers: 16, entryFee: '₱100', prizeText: '₱500' }, adm);
  assert.equal(r.status, 201);
  const tid = r.body.id;

  // generate 2 codes
  r = await call('POST', `/api/admin/tournaments/${tid}/codes`, { count: 2 }, adm);
  assert.equal(r.status, 200);
  assert.equal(r.body.codes.length, 2);
  const [code1, code2] = r.body.codes;
  assert.match(code1, /^JOIN-/);

  // set live
  r = await call('POST', `/api/admin/tournaments/${tid}/status`, { status: 'live' }, adm);
  assert.equal(r.status, 200);

  // admin overview
  r = await call('GET', '/api/admin', null, adm);
  assert.equal(r.status, 200);
  const tc = r.body.tournaments.find(t => t.id === tid);
  assert.ok(tc); assert.equal(tc.codesRemaining, 2);

  // register two players
  const a = {}, b = {};
  r = await call('POST', '/api/auth/register', { email: 'p1@test.co', username: 'playerone', password: 'Password123!' }, a);
  assert.equal(r.status, 201);
  r = await call('POST', '/api/auth/register', { email: 'p2@test.co', username: 'playertwo', password: 'Password123!' }, b);
  assert.equal(r.status, 201);
  r = await call('POST', '/api/auth/register', { email: 'p1@test.co', username: 'another', password: 'Password123!' });
  assert.equal(r.status, 409);

  // join with codes; reuse blocked
  r = await call('POST', `/api/tournaments/${tid}/join`, { code: code1 }, a);
  assert.equal(r.status, 200);
  r = await call('POST', `/api/tournaments/${tid}/join`, { code: code1 }, b);
  assert.ok(r.status >= 400);
  r = await call('POST', `/api/tournaments/${tid}/join`, { code: code2 }, b);
  assert.equal(r.status, 200);

  // matchmaking
  r = await call('POST', `/api/tournaments/${tid}/queue`, {}, a);
  assert.equal(r.status, 200); assert.equal(r.body.queued, true);
  r = await call('POST', `/api/tournaments/${tid}/queue`, {}, b);
  assert.equal(r.status, 200);
  const gid = r.body.gameId;
  assert.ok(gid);

  // play a game
  r = await call('GET', `/api/games/${gid}`, null, a);
  assert.equal(r.status, 200);
  const g0 = r.body.game;
  const whiteIsA = g0.white.id === (await call('GET', '/api/me', null, a)).body.user.id;
  const white = whiteIsA ? a : b, black = whiteIsA ? b : a;

  r = await call('POST', `/api/games/${gid}/move`, { from: 'e2', to: 'e4' }, white);
  assert.equal(r.status, 200); assert.equal(r.body.move, 'e4');
  r = await call('POST', `/api/games/${gid}/move`, { from: 'e2', to: 'e4' }, white);
  assert.equal(r.status, 400); // wait for your turn
  r = await call('POST', `/api/games/${gid}/move`, { from: 'e7', to: 'e4' }, black);
  assert.equal(r.status, 400); // illegal
  r = await call('POST', `/api/games/${gid}/move`, { from: 'e7', to: 'e5' }, black);
  assert.equal(r.status, 200);
  r = await call('POST', `/api/games/${gid}/resign`, {}, black);
  assert.equal(r.status, 200);

  // stats
  r = await call('GET', '/api/me', null, white);
  assert.equal(r.body.user.stats.wins, 1);
  assert.equal(r.body.user.stats.played, 1);
  assert.ok(r.body.games[0].moves.length >= 2);

  // notifications
  r = await call('GET', '/api/notifications', null, white);
  assert.equal(r.status, 200);

  // draw flow on a second game
  r = await call('POST', `/api/tournaments/${tid}/queue`, {}, white);
  r = await call('POST', `/api/tournaments/${tid}/queue`, {}, black);
  const gid2 = r.body.gameId;
  r = await call('POST', `/api/games/${gid2}/draw-offer`, {}, white);
  assert.equal(r.status, 200);
  r = await call('POST', `/api/games/${gid2}/draw-accept`, {}, black);
  assert.equal(r.status, 200);

  // standings + detail view
  r = await call('GET', `/api/tournaments/${tid}`, null, white);
  assert.equal(r.status, 200);
  assert.equal(r.body.tournament.standings.length, 2);
  assert.equal(r.body.tournament.standings.find(p => p.username === 'playerone').points, 1.5);

  // fair-play: director case, confirm x3 -> default
  const victim = white;
  r = await call('GET', '/api/admin', null, adm);
  const victimUsername = (await call('GET', '/api/me', null, victim)).body.user.username;
  const victimId = r.body.users.find(u => u.username === victimUsername).id;
  for (let i = 0; i < 3; i++) {
    r = await call('POST', '/api/admin/cases', { tournamentId: tid, userId: victimId, evidence: 'Incident ' + i + ' documented by director.' }, adm);
    assert.equal(r.status, 201);
    const caseId = r.body.id;
    r = await call('POST', `/api/admin/cases/${caseId}/review`, { decision: 'confirmed', notes: 'Confirmed with evidence ' + i + '.' }, adm);
    assert.equal(r.status, 200);
  }
  r = await call('GET', `/api/tournaments/${tid}`, null, victim);
  assert.equal(r.body.tournament.entryStatus, 'defaulted');
  r = await call('GET', '/api/notifications', null, victim);
  assert.equal(r.body.warnings, 3);

  // revoke one warning -> entry active again
  const confirmed = store.signals.filter(s => s.user_id === victimId && s.status === 'confirmed');
  r = await call('POST', `/api/admin/cases/${confirmed[0].id}/revoke`, { notes: 'Appeal accepted; evidence was insufficient.' }, adm);
  require('fs').writeFileSync('/tmp/revoke.json',JSON.stringify({status:r.status,body:r.body,id:confirmed[0]&&confirmed[0].id}));
  assert.equal(r.status, 200);
  r = await call('GET', `/api/tournaments/${tid}`, null, victim);
  assert.equal(r.body.tournament.entryStatus, 'active');

  // finish -> prize codes -> claim once
  r = await call('POST', `/api/admin/tournaments/${tid}/status`, { status: 'finished' }, adm);
  assert.equal(r.status, 200);
  r = await call('GET', '/api/me', null, victim);
  assert.ok(r.body.prizes.length >= 1);
  const prize = r.body.prizes[0];
  assert.match(prize.code, /^WIN-/);
  const winnerUsername = victimUsername;
  r = await call('POST', '/api/admin/prizes/claim', { username: winnerUsername, tournamentId: tid, code: prize.code }, adm);
  assert.equal(r.status, 200);
  r = await call('POST', '/api/admin/prizes/claim', { username: winnerUsername, tournamentId: tid, code: prize.code }, adm);
  assert.equal(r.status, 400); // already claimed

  // puzzle solve + xp
  r = await call('POST', '/api/puzzles/mate1/solve', { move: 'e1e8' }, {});
  assert.equal(r.status, 200); assert.ok(r.body.guest);
  r = await call('POST', '/api/puzzles/mate1/solve', { move: 'e1e8' }, black);
  assert.equal(r.body.correct, true); assert.ok(r.body.xp > 0);
  r = await call('POST', '/api/puzzles/mate1/solve', { move: 'e1e7' }, black);
  assert.equal(r.body.correct, false);

  // settings: valid messenger link only
  r = await call('POST', '/api/admin/settings', { messengerUrl: 'https://m.me/RealPage' }, adm);
  assert.equal(r.status, 200);
  r = await call('POST', '/api/admin/settings', { messengerUrl: 'https://evil.example.com' }, adm);
  assert.equal(r.status, 400);

  // logout kills session
  r = await call('POST', '/api/auth/logout', {}, black);
  assert.equal(r.status, 200);
  r = await call('GET', '/api/me', null, black);
  assert.equal(r.status, 401);

  // non-admin blocked from admin
  r = await call('GET', '/api/admin', null, a);
  assert.equal(r.status, 403);
});
