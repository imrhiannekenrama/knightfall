-- Knightfall Arena — Supabase schema
-- Run this ONCE in the Supabase Dashboard → SQL Editor on a fresh project.
-- All timestamps are JS epoch milliseconds (bigint).

create extension if not exists "pgcrypto";

-- ============ tables ============

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  username text unique not null,
  password_hash text not null,
  role text not null default 'player',
  xp bigint not null default 0,
  created_at bigint not null
);

create table if not exists settings (
  key text primary key,
  value text not null
);

create table if not exists sessions (
  token_hash text primary key,
  user_id uuid not null references users(id) on delete cascade,
  expires_at bigint not null
);

create table if not exists tournaments (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null,
  starts_at bigint not null,
  ends_at bigint not null,
  base_minutes integer not null,
  increment_seconds integer not null,
  max_players integer not null,
  rounds integer not null default 7,
  system text not null default 'SWISS',
  entry_fee text not null,
  prize_text text not null,
  status text not null default 'scheduled',
  created_at bigint not null
);

create table if not exists join_codes (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references tournaments(id) on delete cascade,
  code_hash text unique not null,
  issued_at bigint not null,
  used_by uuid references users(id),
  used_at bigint
);

create table if not exists entries (
  tournament_id uuid not null references tournaments(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  joined_at bigint not null,
  status text not null default 'active',
  primary key (tournament_id, user_id)
);

create table if not exists queue (
  tournament_id uuid not null references tournaments(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  queued_at bigint not null,
  primary key (tournament_id, user_id)
);

create table if not exists games (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references tournaments(id),
  white_id uuid not null references users(id),
  black_id uuid not null references users(id),
  fen text not null,
  moves text not null,
  status text not null default 'active',
  result text,
  reason text,
  clock_w bigint not null,
  clock_b bigint not null,
  turn_started bigint not null,
  draw_offer_by uuid,
  started_at bigint not null,
  ended_at bigint
);

create table if not exists signals (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references tournaments(id),
  game_id uuid references games(id),
  user_id uuid not null references users(id),
  kind text not null,
  evidence text not null,
  status text not null default 'open',
  created_at bigint not null,
  reviewer_id uuid references users(id),
  reviewed_at bigint,
  review_notes text
);

create table if not exists prize_codes (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references tournaments(id),
  user_id uuid not null references users(id),
  rank integer not null,
  code_hash text not null,
  code_encrypted text not null,
  claimed_at bigint,
  created_at bigint not null,
  unique (tournament_id, user_id)
);

create table if not exists puzzle_solves (
  user_id uuid not null references users(id),
  puzzle_id text not null,
  solved_at bigint not null,
  primary key (user_id, puzzle_id)
);

create index if not exists games_participants on games(tournament_id, white_id, black_id);
create index if not exists games_status on games(status);
create index if not exists signals_subject on signals(tournament_id, user_id, status);
create index if not exists sessions_expiry on sessions(expires_at);

-- ============ atomic server functions ============

-- Redeem a one-use JOIN code. Returns true exactly once per code.
create or replace function kf_redeem(p_tournament uuid, p_code_hash text, p_user uuid)
returns boolean
language plpgsql security definer as $$
begin
  update join_codes
     set used_by = p_user, used_at = (extract(epoch from now()) * 1000)::bigint
   where tournament_id = p_tournament and code_hash = p_code_hash and used_by is null;
  if not found then return false; end if;
  insert into entries (tournament_id, user_id, joined_at, status)
  values (p_tournament, p_user, (extract(epoch from now()) * 1000)::bigint, 'active');
  return true;
end $$;

-- Queue a player and, when an opponent is waiting, create the game atomically.
-- Returns the new game id, or null while still waiting.
create or replace function kf_try_pair(p_tournament uuid, p_user uuid)
returns uuid
language plpgsql security definer as $$
declare
  v_other uuid;
  v_game uuid;
  v_white uuid;
  v_black uuid;
  v_recent_white uuid;
  v_base int;
begin
  if not exists (select 1 from entries where tournament_id = p_tournament and user_id = p_user and status = 'active') then
    raise exception 'not_registered';
  end if;
  if exists (select 1 from games where tournament_id = p_tournament and status = 'active' and (white_id = p_user or black_id = p_user)) then
    raise exception 'already_playing';
  end if;

  insert into queue (tournament_id, user_id, queued_at)
  values (p_tournament, p_user, (extract(epoch from now()) * 1000)::bigint)
  on conflict do nothing;

  select base_minutes into v_base from tournaments where id = p_tournament;
  if v_base is null then raise exception 'no_tournament'; end if;

  select user_id into v_other from queue
   where tournament_id = p_tournament and user_id <> p_user
     and not exists (select 1 from games
                     where tournament_id = p_tournament and status = 'active'
                       and (white_id = queue.user_id or black_id = queue.user_id))
   order by queued_at
   limit 1 for update skip locked;

  if v_other is null then return null; end if;

  select white_id into v_recent_white from games
   where tournament_id = p_tournament
     and ((white_id = v_other and black_id = p_user) or (white_id = p_user and black_id = v_other))
   order by started_at desc limit 1;

  if v_recent_white = v_other then v_white := p_user; else v_white := v_other; end if;
  v_black := case when v_white = p_user then v_other else p_user end;

  v_game := gen_random_uuid();
  insert into games (id, tournament_id, white_id, black_id, fen, moves, status, clock_w, clock_b, turn_started, started_at)
  values (v_game, p_tournament, v_white, v_black,
          'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', '[]', 'active',
          v_base * 60000, v_base * 60000,
          (extract(epoch from now()) * 1000)::bigint, (extract(epoch from now()) * 1000)::bigint);

  delete from queue where tournament_id = p_tournament and user_id in (v_other, p_user);
  return v_game;
end $$;

-- ============ security ============

-- Every table is locked down: the anon/public key can read NOTHING.
-- All access happens through the Vercel API functions which use the
-- service_role key (bypasses RLS) and enforce permissions in code.
alter table users         enable row level security;
alter table settings      enable row level security;
alter table sessions      enable row level security;
alter table tournaments   enable row level security;
alter table join_codes    enable row level security;
alter table entries       enable row level security;
alter table queue         enable row level security;
alter table games         enable row level security;
alter table signals       enable row level security;
alter table prize_codes   enable row level security;
alter table puzzle_solves enable row level security;

-- Done. Now deploy the Vercel side and visit /api/setup to create the
-- first administrator account (see README section 4).

-- Upgrade for existing installs (safe to re-run):
alter table tournaments add column if not exists rounds integer not null default 7;
alter table tournaments add column if not exists system text not null default 'SWISS';
