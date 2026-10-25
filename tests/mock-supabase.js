/* Minimal in-memory mock of the supabase-js query builder, faithful enough to
   exercise the router: filters, embedded joins, maybeSingle, upsert, rpc.
   TEST-ONLY. Never used in production. */
'use strict';

const SINGLE = Symbol('single');

function makeStore() {
  return {
    users: [], sessions: [], settings: [], tournaments: [], join_codes: [],
    entries: [], queue: [], games: [], signals: [], prize_codes: [], puzzle_solves: []
  };
}
/* column defaults mirroring supabase/schema.sql */
const DEFAULTS = {
  users: { role: 'player', xp: 0 },
  tournaments: { status: 'scheduled' },
  entries: { status: 'active' },
  games: { status: 'active', result: null, reason: null, draw_offer_by: null, ended_at: null },
  signals: { status: 'open', game_id: null, reviewer_id: null, reviewed_at: null, review_notes: null },
  prize_codes: { claimed_at: null }
};

const singular = t => t.replace(/s$/, '');

class Q {
  constructor(store, table) {
    this.store = store; this.table = table;
    this.ops = []; this.cols = '*'; this.limitN = Infinity;
    this.sort = null; this.mode = 'select'; this.data = null;
  }
  select(cols) { if (cols) this.cols = cols; return this }
  eq(k, v) { this.ops.push({ t: 'eq', k, v }); return this }
  neq(k, v) { this.ops.push({ t: 'neq', k, v }); return this }
  in(k, arr) { this.ops.push({ t: 'in', k, v: arr }); return this }
  is(k, v) { this.ops.push({ t: 'is', k, v }); return this }
  ilike(k, v) { this.ops.push({ t: 'ilike', k, v }); return this }
  or(str) { // PostgREST or() = OR semantics
    const conds = [];
    for (const part of str.split(',')) { const m = part.match(/^([a-zA-Z0-9_.]+)\.(eq|ilike|is)\.(.*)$/); if (m) conds.push({ t: m[2], k: m[1], v: m[3] }) }
    this.ops.push({ t: 'orGroup', conds });
    return this
  }
  order(k, o) { this.sort = { k, asc: !o || o.ascending !== false }; return this }
  limit(n) { this.limitN = n; return this }
  maybeSingle() { this[SINGLE] = true; return this }
  single() { this[SINGLE] = true; return this }
  insert(rows) { this.mode = 'insert'; this.data = Array.isArray(rows) ? rows : [rows]; return this }
  update(data) { this.mode = 'update'; this.data = data; return this }
  upsert(rows) { this.mode = 'upsert'; this.data = Array.isArray(rows) ? rows : [rows]; return this }
  delete() { this.mode = 'delete'; return this }

  /* ---- execution ---- */
  _embed(row, token) {
    // token like 'users(username)' | 'white:users!games_white_id_fkey(username)' | 'tournaments(name)'
    const m = token.match(/^(?:([a-zA-Z0-9_]+):)?([a-zA-Z0-9_]+)(?:!([a-zA-Z0-9_]+))?\(([^)]*)\)$/);
    if (!m) return null;
    const [, alias, table, fkRaw, cols] = m;
    const fkName = fkRaw === 'inner' ? null : fkRaw;
    let fkCol;
    if (fkName) { const s = fkName.replace(/_fkey$/, ''); fkCol = s.slice(s.indexOf('_') + 1); }
    if (!fkCol) fkCol = singular(table) + '_id';
    // normalize 'games_white_id_fkey' -> 'white_id'
    if (fkName) { const s = fkName.replace(/_fkey$/, ''); fkCol = s.slice(s.indexOf('_') + 1); }
    const id = row[fkCol];
    if (id === undefined || id === null) return null;
    const target = (this.store[table] || []).find(r => r.id === id);
    if (!target) return null;
    const proj = {};
    if (cols === '*') Object.assign(proj, target);
    else for (const c of cols.split(',')) proj[c.trim()] = target[c.trim()];
    return [alias || table, proj];
  }
  _project(row) {
    if (this.cols === '*') return { ...row };
    const out = {};
    for (const tokenRaw of this.cols.split(',')) {
      const token = tokenRaw.trim();
      if (!token) continue;
      if (token === '*') { Object.assign(out, row); continue }
      if (token.includes('(')) { const e = this._embed(row, token); if (e) out[e[0]] = e[1]; continue }
      const [k] = token.split(':');
      if (k in row) out[k] = row[k];
    }
    return out;
  }
  _match(row) {
    for (const op of this.ops) {
      if (op.t === 'orGroup') {
        const any = op.conds.some(c => {
          const v = row[c.k];
          if (c.t === 'eq') return v === c.v;
          if (c.t === 'ilike') return String(v ?? '').toLowerCase() === String(c.v).toLowerCase();
          if (c.t === 'is') return v === c.v;
          return false;
        });
        if (!any) return false;
        continue;
      }
      if (op.k.includes('.')) { // filter on embedded resource: path like users.username
        const [res, col] = op.k.split('.');
        const e = this._embed(row, res + '(' + col + ')');
        const target = e ? e[1][col] : undefined;
        if (op.t === 'eq' && target !== op.v) return false;
        if (op.t === 'ilike') { if (String(target ?? '').toLowerCase() !== String(op.v).toLowerCase()) return false }
        if (op.t === 'is' && target !== op.v) return false;
        continue;
      }
      const v = row[op.k];
      if (op.t === 'eq' && v !== op.v) return false;
      if (op.t === 'neq' && v === op.v) return false;
      if (op.t === 'in' && !op.v.includes(v)) return false;
      if (op.t === 'is' && ((op.v === null) ? v !== null && v !== undefined : v !== op.v)) return false;
      if (op.t === 'ilike' && String(v ?? '').toLowerCase() !== String(op.v).toLowerCase()) return false;
    }
    return true;
  }
  _applySort(rows) {
    if (!this.sort) return rows;
    const { k, asc } = this.sort;
    return [...rows].sort((a, b) => {
      const av = a[k], bv = b[k];
      const c = av === bv ? 0 : (av === null || av === undefined) ? -1 : (bv === null || bv === undefined) ? 1 : av < bv ? -1 : 1;
      return asc ? c : -c;
    });
  }
  _result() {
    const table = this.store[this.table];
    if (!table) return { data: null, error: { message: 'no table ' + this.table } };
    if (this.mode === 'select') {
      let rows = table.filter(r => this._match(r));
      rows = this._applySort(rows).slice(0, this.limitN);
      const projected = rows.map(r => this._project(r));
      return { data: this[SINGLE] ? (projected[0] ?? null) : projected, error: null };
    }
    if (this.mode === 'insert') {
      const defs = DEFAULTS[this.table] || {};
      for (const row of this.data) table.push({ ...defs, ...row });
      return { data: null, error: null };
    }
    if (this.mode === 'upsert') {
      for (const row of this.data) {
        const existing = table.find(r => r.id === row.id || (Object.keys(row).length && table.some(r => r.key === row.key && 'key' in row)));
        if (existing && 'key' in row) { Object.assign(existing, row) } else if (existing) Object.assign(existing, row);
        else table.push({ ...row });
      }
      return { data: null, error: null };
    }
    if (this.mode === 'update') {
      const rows = table.filter(r => this._match(r));
      for (const r of rows) Object.assign(r, { ...this.data });
      const projected = rows.map(r => this._project(r));
      return { data: this[SINGLE] ? (projected[0] ?? null) : projected, error: null };
    }
    if (this.mode === 'delete') {
      const rows = table.filter(r => this._match(r));
      this.store[this.table] = table.filter(r => !rows.includes(r));
      return { data: null, error: null };
    }
    return { data: null, error: { message: 'unsupported mode' } };
  }
  then(resolve, reject) {
    try { resolve(this._result()) } catch (e) { reject(e) }
  }
}

/* rpc mocks mirroring supabase/schema.sql */
function rpc(store, name, args) {
  const now = () => (Date.now());
  if (name === 'kf_redeem') {
    const { p_tournament, p_code_hash, p_user } = args;
    const code = store.join_codes.find(c => c.tournament_id === p_tournament && c.code_hash === p_code_hash && c.used_by == null);
    if (!code) return { data: false, error: null };
    code.used_by = p_user; code.used_at = now();
    store.entries.push({ status: 'active', tournament_id: p_tournament, user_id: p_user, joined_at: now() });
    return { data: true, error: null };
  }
  if (name === 'kf_try_pair') {
    const { p_tournament, p_user } = args;
    if (!store.entries.some(e => e.tournament_id === p_tournament && e.user_id === p_user && e.status === 'active')) return { data: null, error: { message: 'not_registered' } };
    if (store.games.some(g => g.tournament_id === p_tournament && g.status === 'active' && (g.white_id === p_user || g.black_id === p_user))) return { data: null, error: { message: 'already_playing' } };
    if (!store.queue.some(q => q.tournament_id === p_tournament && q.user_id === p_user)) store.queue.push({ tournament_id: p_tournament, user_id: p_user, queued_at: now() });
    const t = store.tournaments.find(x => x.id === p_tournament);
    if (!t) return { data: null, error: { message: 'no_tournament' } };
    const busy = id => store.games.some(g => g.tournament_id === p_tournament && g.status === 'active' && (g.white_id === id || g.black_id === id));
    const waiting = store.queue.filter(q => q.tournament_id === p_tournament && q.user_id !== p_user && !busy(q.user_id)).sort((a, b) => a.queued_at - b.queued_at);
    if (!waiting.length) return { data: null, error: null };
    const other = waiting[0].user_id;
    const recent = store.games.filter(g => g.tournament_id === p_tournament && ((g.white_id === other && g.black_id === p_user) || (g.white_id === p_user && g.black_id === other))).sort((a, b) => a.started_at - b.started_at).pop();
    let white = recent && recent.white_id === other ? p_user : other;
    const black = white === p_user ? other : p_user;
    const id = 'g' + Math.random().toString(36).slice(2, 10);
    store.games.push({ id, tournament_id: p_tournament, white_id: white, black_id: black, fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', moves: '[]', status: 'active', result: null, reason: null, clock_w: t.base_minutes * 60000, clock_b: t.base_minutes * 60000, turn_started: now(), draw_offer_by: null, started_at: now(), ended_at: null });
    store.queue = store.queue.filter(q => !(q.tournament_id === p_tournament && (q.user_id === other || q.user_id === p_user)));
    return { data: id, error: null };
  }
  return { data: null, error: { message: 'unknown rpc ' + name } };
}

module.exports = function createMockClient(store) {
  return {
    from(table) { return new Q(store, table) },
    rpc(name, args) { return rpc(store, name, args) }
  };
};
module.exports.makeStore = makeStore;
