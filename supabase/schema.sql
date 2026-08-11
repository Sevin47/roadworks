-- WVDOT Roadworks — Supabase schema
-- Paste this whole file into your project's SQL editor and run it once.
--
-- The game server talks to these tables with the SERVICE ROLE key, which
-- bypasses row level security. RLS is enabled with no public policies on
-- purpose: nothing here should be reachable from a browser with the anon key.

create table if not exists players (
  token       text primary key,
  name        text        not null,
  county      text,
  xp          integer     not null default 0,
  funds       integer     not null default 2500,
  jobs_done   integer     not null default 0,
  day_xp      integer     not null default 0,
  day_date    date,
  joined_at   timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- The in-progress board, so a restart or a free-tier cold start doesn't wipe
-- everyone's day. One row per reporting date; `jobs` is the located work orders
-- with their current progress and per-player contributions.
create table if not exists day_state (
  report_date date        primary key,
  day         jsonb       not null,
  events      jsonb       not null default '[]'::jsonb,
  jobs        jsonb       not null default '[]'::jsonb,
  updated_at  timestamptz not null default now()
);

-- Frozen standings for each finished day.
create table if not exists day_scores (
  report_date date    not null,
  token       text    not null,
  name        text    not null,
  county      text,
  day_xp      integer not null default 0,
  jobs_done   integer not null default 0,
  primary key (report_date, token)
);

create index if not exists day_scores_leaderboard_idx
  on day_scores (report_date desc, day_xp desc);

alter table players    enable row level security;
alter table day_state  enable row level security;
alter table day_scores enable row level security;

-- Convenience view: all-time standings.
create or replace view all_time_standings as
  select name, county, xp, jobs_done, updated_at
  from players
  order by xp desc;
