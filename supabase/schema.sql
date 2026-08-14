-- ============================================================================
-- Roadworks — Supabase schema
--
-- The whole backend. There is no game server: the browser talks to Postgres,
-- every mutation goes through a security-definer RPC, and progress is derived
-- from timestamps rather than a tick loop.
--
-- Idempotent — paste the entire file into the SQL editor and run it. Safe to
-- re-run after edits.
-- ============================================================================

create extension if not exists pg_cron;

-- ----------------------------------------------------------------- the board

-- One row per daily road report that has been ingested.
create table if not exists game_day (
  report_date   date primary key,
  loaded_at     timestamptz not null default now(),
  rows_parsed   integer     not null default 0,
  rows_located  integer     not null default 0,
  sources       jsonb       not null default '[]'::jsonb
);

-- The immutable half of a work order. Written once a day by the ingest job and
-- never touched again, so clients can load it once and cache it.
create table if not exists jobs (
  id            text        primary key,
  report_date   date        not null references game_day(report_date) on delete cascade,
  district      integer     not null,
  county        text        not null,
  county_code   text,
  category      text        not null,
  activity      text        not null,
  route_type    text,
  route_label   text,
  route_name    text,
  bmp           numeric,
  emp           numeric,
  start_time    text,
  end_time      text,
  detail        text,
  miles         numeric     not null default 0,
  approx        boolean     not null default false,
  incident      boolean     not null default false,
  expires_at    timestamptz,
  coords        jsonb       not null,
  centroid      jsonb       not null,
  effort        numeric     not null,
  xp_award      integer     not null default 10,
  pay_award     integer     not null default 100,
  created_at    timestamptz not null default now()
);

alter table jobs add column if not exists min_crews integer not null default 1;
alter table jobs add column if not exists milestone boolean not null default false;
alter table jobs add column if not exists storm     boolean not null default false;
alter table jobs add column if not exists parent_id text;

create index if not exists jobs_report_date_idx on jobs (report_date);
create index if not exists jobs_incident_idx    on jobs (incident) where incident;
create index if not exists jobs_district_idx    on jobs (district);

-- The mutable half, split out so Realtime payloads stay small: a job's coords
-- array must not be re-broadcast every time a crew shows up.
create table if not exists job_state (
  job_id       text        primary key references jobs(id) on delete cascade,
  progress     numeric     not null default 0,   -- work units banked as of progress_at
  progress_at  timestamptz not null default now(),
  crew_count   integer     not null default 0,
  done         boolean     not null default false,
  done_at      timestamptz
);

create index if not exists job_state_active_idx on job_state (done, crew_count);

-- ------------------------------------------------------------------ players

-- County reference data, loaded by the ingest job from the state's own county
-- layer, so the county list a player picks from is the state's, not a hardcoded one.
create table if not exists wv_counties (
  code     text primary key,
  name     text not null unique,
  district integer not null,
  center   jsonb,
  fips     integer,
  geom     jsonb          -- simplified outline, used to tint counties under a storm
);
alter table wv_counties add column if not exists fips integer;
alter table wv_counties add column if not exists geom jsonb;

-- Real highway facilities (Transportation/MapServer/4). Crews roll from the
-- nearest dispatchable one in the player's district — a Boone job draws a crew
-- out of Seth Substation, an I-79 job out of the I-79 section garage.
-- Stockpiles are kept (winter ops will want them) but are not dispatch points.
create table if not exists facilities (
  id           text primary key,
  name         text not null,
  kind         text not null,          -- district_hq | county_hq | substation | section | shop | stockpile | lab
  district     integer,
  county       text,
  county_code  text,
  lng          numeric not null,
  lat          numeric not null,
  dispatchable boolean not null default true
);

create index if not exists facilities_district_idx on facilities (district) where dispatchable;

-- The career ladder. A table rather than a formula so the client can render
-- the whole ladder and gate its UI without duplicating the numbers.
create table if not exists ranks (
  idx          integer primary key,
  name         text    not null,
  xp_required  integer not null,
  crews        integer not null,
  unlock       text
);

insert into ranks (idx, name, xp_required, crews, unlock) values
  ( 1, 'Flagger',                       0, 3, null),
  ( 2, 'Crew Leader',                  40, 4, '4th crew'),
  ( 3, 'Foreman',                     160, 4, 'Overtime'),
  ( 4, 'County Supervisor',           400, 5, '5th crew, Equipment garage'),
  ( 5, 'Maintenance Superintendent',  800, 5, 'Certification slot'),
  ( 6, 'County Administrator',       1400, 6, '6th crew'),
  ( 7, 'District Engineer',          2200, 6, 'Second certification slot'),
  ( 8, 'Regional Engineer',          3200, 7, '7th crew'),
  ( 9, 'Deputy Director',            4400, 7, '+10% budget payouts'),
  (10, 'Highway Director',           5800, 8, '8th crew, prestige transfer')
on conflict (idx) do update
  set name = excluded.name, xp_required = excluded.xp_required,
      crews = excluded.crews, unlock = excluded.unlock;

create table if not exists players (
  id          uuid        primary key references auth.users(id) on delete cascade,
  name        text        not null,
  county      text        not null,
  county_code text,
  district    integer,
  home        jsonb,
  xp          integer     not null default 0,
  funds       integer     not null default 2500,
  jobs_done   integer     not null default 0,
  level       integer     not null default 1,   -- rank index
  day_xp      integer     not null default 0,
  day_date    date,
  prestige    integer     not null default 0,
  created_at  timestamptz not null default now(),
  last_seen   timestamptz not null default now()
);

alter table players add column if not exists prestige   integer not null default 0;
alter table players add column if not exists streak     integer not null default 0;
alter table players add column if not exists best_streak integer not null default 0;
alter table players add column if not exists stars      integer not null default 0;
alter table players add column if not exists last_login date;

create index if not exists players_day_idx on players (day_date, day_xp desc);

-- One row per crew currently assigned. `arrives_at` is when it stops driving
-- and starts producing work; `rate` is that crew's own units/sec with the
-- player's equipment already baked in at dispatch time.
create table if not exists crews (
  id               uuid        primary key default gen_random_uuid(),
  job_id           text        not null references jobs(id) on delete cascade,
  player_id        uuid        not null references players(id) on delete cascade,
  player_name      text        not null,
  dispatched_at    timestamptz not null default now(),
  arrives_at       timestamptz not null,
  rate             numeric     not null default 0.5,
  facility_id      text,
  route            jsonb,
  boost_until      timestamptz,
  contractor_until timestamptz
);

alter table crews add column if not exists rate             numeric not null default 0.5;
alter table crews add column if not exists facility_id      text;
alter table crews add column if not exists route            jsonb;
alter table crews add column if not exists boost_until      timestamptz;
alter table crews add column if not exists contractor_until timestamptz;
alter table crews add column if not exists convoy           boolean not null default false;
-- A crew that has finished is deadheading back to its garage: still yours,
-- still occupying a slot, but producing nothing until it gets home.
alter table crews add column if not exists return_from      timestamptz;
alter table crews add column if not exists return_at        timestamptz;

create index if not exists crews_returning_idx on crews (return_at) where return_at is not null;

-- A player may hold one real crew per job, plus any hired contractors, so the
-- old blanket unique constraint is replaced by a partial one.
alter table crews drop constraint if exists crews_job_id_player_id_key;
create unique index if not exists crews_one_per_job_idx
  on crews (job_id, player_id) where contractor_until is null;

create index if not exists crews_job_idx    on crews (job_id, arrives_at);
create index if not exists crews_player_idx on crews (player_id);

-- Work units each player has banked on each job, used to split the payout.
create table if not exists contributions (
  job_id     text    not null references jobs(id) on delete cascade,
  player_id  uuid    not null references players(id) on delete cascade,
  units      numeric not null default 0,
  primary key (job_id, player_id)
);

-- Driving routes, cached per facility/job pair. The first player to dispatch
-- pays the routing call; everyone after reuses it.
create table if not exists route_cache (
  facility_id text    not null,
  job_id      text    not null references jobs(id) on delete cascade,
  coords      jsonb   not null,
  drive_secs  numeric not null,
  created_at  timestamptz not null default now(),
  primary key (facility_id, job_id)
);

-- Ticker + chat.
create table if not exists feed (
  id          bigserial   primary key,
  report_date date,
  kind        text        not null,
  body        text        not null,
  created_at  timestamptz not null default now()
);

alter table feed add column if not exists job_id text;

create index if not exists feed_recent_idx on feed (created_at desc);

-- Frozen standings for each finished day.
create table if not exists day_scores (
  report_date date    not null,
  player_id   uuid    not null,
  name        text    not null,
  county      text,
  day_xp      integer not null default 0,
  jobs_done   integer not null default 0,
  primary key (report_date, player_id)
);

create index if not exists day_scores_board_idx on day_scores (report_date desc, day_xp desc);

-- Running per-district incident tallies, kept as counters because expired
-- incidents are deleted and can't be counted after the fact.
create table if not exists district_day_stats (
  report_date       date    not null,
  district          integer not null,
  incidents_cleared integer not null default 0,
  incidents_expired integer not null default 0,
  primary key (report_date, district)
);

create table if not exists day_report_cards (
  report_date       date    not null,
  district          integer not null,
  grade             text    not null,
  pct_closed        numeric not null,
  jobs_total        integer not null,
  jobs_done         integer not null,
  incidents_cleared integer not null default 0,
  incidents_expired integer not null default 0,
  top_player        text,
  primary key (report_date, district)
);

-- ----------------------------------------------------------------- weather

-- Live National Weather Service warnings, refreshed by a scheduled job.
-- `intensity` is what the game reads: a Warning is a real event, a Watch is a
-- nudge, an Advisory is only a tint. Without the tiering a single 34-county
-- Flood Watch would put most of the state into full storm mode at once.
create table if not exists alerts (
  id         text primary key,
  event      text    not null,
  kind       text    not null,          -- winter | flood | wind | storm | other
  intensity  integer not null default 0,-- 2 warning, 1 watch, 0 advisory
  severity   text,
  headline   text,
  onset      timestamptz,
  expires    timestamptz not null,
  counties   text[]  not null default '{}',
  updated_at timestamptz not null default now()
);

create index if not exists alerts_live_idx on alerts (expires) where intensity > 0;

-- Finishing some work uncovers more of it.
create table if not exists job_chains (
  id             bigserial primary key,
  match_pattern  text    not null,      -- ILIKE pattern against the parent activity
  child_activity text    not null,
  child_category text    not null,
  child_detail   text,
  chance         numeric not null default 0.15,
  effort_factor  numeric not null default 0.6
);

insert into job_chains (match_pattern, child_activity, child_category, child_detail, chance, effort_factor)
select * from (values
  ('%bridge inspection%',  'Bridge Deck Repair',     'Bridge',            'Inspection found spalling on the deck.',        0.35, 0.8),
  ('%debris removal%',     'Guardrail Repair',       'Heavy Maintenance', 'Guardrail damaged behind the debris.',          0.18, 0.6),
  ('%dead deer%',          'Litter Pickup and Disposal','Maintenance',    'Cleanup left behind after the pickup.',         0.12, 0.4),
  ('%patching%',           'Pavement Marking',       'Maintenance',       'Fresh patch needs its markings restored.',      0.22, 0.5),
  ('%ditch%',              'Minor Drainage Structures','Maintenance',     'Ditch work exposed a failing culvert.',         0.20, 0.7),
  ('%mowing%',             'Removing Brush',         'Maintenance',       'Mowing crew flagged heavy brush on the shoulder.',0.15, 0.5),
  ('%slide%',              'Slope Stabilization',    'Heavy Maintenance', 'Slip is still moving; stabilization required.',  0.30, 1.0),
  ('%high water%',         'Debris Removal',         'Maintenance',       'Water receded and left debris across the lane.', 0.40, 0.5),
  ('%snow%',               'Pothole Patching',       'Maintenance',       'Freeze-thaw opened potholes on the plow route.', 0.25, 0.5)
) v(a,b,c,d,e,f)
where not exists (select 1 from job_chains);

-- Segment bonuses on the day's biggest jobs.
create table if not exists job_milestones (
  job_id  text    not null references jobs(id) on delete cascade,
  pct     integer not null,
  paid_at timestamptz not null default now(),
  primary key (job_id, pct)
);

-- ------------------------------------------------------- dailies + awards

-- Per-manager tally for the current report day. Everything the daily
-- commendations key off lives here, so awarding them is a cheap lookup rather
-- than a scan over the day's completions.
create table if not exists player_day (
  player_id         uuid not null references players(id) on delete cascade,
  report_date       date not null,
  jobs_closed       integer not null default 0,
  jobs_home         integer not null default 0,
  incidents_cleared integer not null default 0,
  winter_closes     integer not null default 0,
  convoys           integer not null default 0,
  checked_in        boolean not null default false,
  primary key (player_id, report_date)
);

-- Commendations are the trophy currency: earned, never spent.
create table if not exists commendations (
  id          bigserial primary key,
  player_id   uuid not null references players(id) on delete cascade,
  code        text not null,
  title       text not null,
  detail      text,
  report_date date not null,
  earned_at   timestamptz not null default now(),
  unique (player_id, code, report_date)
);

create index if not exists commendations_player_idx on commendations (player_id, earned_at desc);

-- --------------------------------------------------------------- equipment

create table if not exists equipment_catalog (
  key       text primary key,
  name      text    not null,
  blurb     text,
  cost      integer not null,
  min_rank  integer not null default 4,
  effect    text    not null,   -- rate_all | rate_cat | travel | xp_cat | crew_slot
  category  text,               -- for rate_cat / xp_cat
  amount    numeric not null,   -- fractional bonus, or 1 for crew_slot
  sort      integer not null default 0
);

insert into equipment_catalog (key, name, blurb, cost, min_rank, effect, category, amount, sort) values
  ('pickup',    'Crew-cab pickup',    'Crews get where they are going 25% faster.',            2000,  4, 'travel',    null,                    0.25, 10),
  ('trailer',   'Equipment trailer',  '+10% work rate on every category.',                     3500,  4, 'rate_all',  null,                    0.10, 20),
  ('msgboard',  'Mobile message board','+20% XP from Closures.',                               3000,  4, 'xp_cat',    'Closures',              0.20, 30),
  ('patcher',   'Thermal patcher',    '+30% work rate on Maintenance.',                        5000,  4, 'rate_cat',  'Maintenance',           0.30, 40),
  ('snowplow',  'Snow plow rig',      '+30% work rate on Winter Ops.',                         8000,  4, 'rate_cat',  'Winter Ops',            0.30, 50),
  ('bridgerig', 'Under-bridge rig',   '+30% work rate on Bridge work.',                        8000,  5, 'rate_cat',  'Bridge',                0.30, 60),
  ('mill',      'Milling machine',    '+30% work rate on Construction Projects.',             12000,  6, 'rate_cat',  'Construction Projects', 0.30, 70),
  ('garage',    'County garage upgrade','A ninth crew. The only crew money can buy.',         25000,  8, 'crew_slot', null,                    1,    80)
on conflict (key) do update
  set name = excluded.name, blurb = excluded.blurb, cost = excluded.cost,
      min_rank = excluded.min_rank, effect = excluded.effect,
      category = excluded.category, amount = excluded.amount, sort = excluded.sort;

create table if not exists player_equipment (
  player_id uuid        not null references players(id) on delete cascade,
  item_key  text        not null references equipment_catalog(key) on delete cascade,
  bought_at timestamptz not null default now(),
  primary key (player_id, item_key)
);

-- ============================================================================
-- Row level security
--
-- Everything is readable by a signed-in player (anonymous sign-in counts).
-- Nothing is directly writable: every mutation below is a security-definer
-- function that recomputes the outcome from server state, so a patched client
-- can lie to its own screen and nothing else.
-- ============================================================================

do $$
declare t text;
begin
  foreach t in array array[
    'game_day','wv_counties','facilities','ranks','jobs','job_state','players',
    'crews','contributions','route_cache','feed','day_scores',
    'district_day_stats','day_report_cards','equipment_catalog','player_equipment',
    'alerts','job_chains','job_milestones','player_day','commendations']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format('create policy %I on %I for select to authenticated using (true)', t || '_read', t);
  end loop;
end $$;

-- ============================================================================
-- Game math
-- ============================================================================

-- Base output of a single crew, in work units per second. Halved from launch:
-- closes should feel earned and the crowd bonus should read clearly against it.
create or replace function base_crew_rate()
returns numeric language sql immutable as $$ select 0.5::numeric; $$;

-- Crowd bonus: each extra crew on the same job makes *every* crew there faster,
-- up to 3x. This is the whole point of the game — piling on beats spreading out.
create or replace function crew_multiplier(n integer)
returns numeric language sql immutable as $$
  select case when n <= 0 then 0 else least(3.0, 1 + 0.12 * (n - 1)) end;
$$;

-- Clients animate progress locally between Realtime events, so they need to
-- know how far their own clock is from Postgres's.
create or replace function server_now()
returns timestamptz language sql stable as $$ select now(); $$;

create or replace function rank_for(p_xp integer)
returns integer language sql stable as $$
  select coalesce(max(idx), 1) from ranks where xp_required <= greatest(p_xp, 0);
$$;

create or replace function player_equip_bonus(p_player uuid, p_effect text, p_category text)
returns numeric language sql stable as $$
  select coalesce(sum(e.amount), 0)
    from player_equipment pe
    join equipment_catalog e on e.key = pe.item_key
   where pe.player_id = p_player
     and e.effect = p_effect
     and (e.category is null or e.category = p_category);
$$;

create or replace function max_crews_for(p_player uuid)
returns integer language sql stable as $$
  select least(12,
    (select r.crews from ranks r where r.idx = rank_for(p.xp))
    + (select count(*)::int from player_equipment pe
        join equipment_catalog e on e.key = pe.item_key
       where pe.player_id = p.id and e.effect = 'crew_slot'))
  from players p where p.id = p_player;
$$;

-- A crew's own output, with the dispatching player's equipment and prestige
-- baked in. Stored on the crew row so settle_job() never has to re-derive it.
create or replace function player_crew_rate(p_player uuid, p_category text)
returns numeric language sql stable as $$
  select base_crew_rate()
       * (1 + player_equip_bonus(p_player, 'rate_all', p_category))
       * (1 + player_equip_bonus(p_player, 'rate_cat', p_category))
       * (1 + 0.02 * coalesce((select prestige from players where id = p_player), 0));
$$;

-- ------------------------------------------------------- weekly focus

-- The rotating focus category, derived from the ISO week rather than stored,
-- so there is no scheduler to drift and no config row to go stale.
create or replace function current_focus()
returns text language sql stable as $$
  select (array['Bridge','Closures','Construction Projects','Utilities/Oil & Gas',
                'Heavy Maintenance','Winter Ops','Maintenance'])
         [1 + (extract(week from now())::int % 7)];
$$;

-- ------------------------------------------------------------ commendations

create or replace function award(
  p_player uuid, p_code text, p_title text, p_detail text,
  p_date date, p_once boolean default false)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare v_new boolean := false; v_name text;
begin
  if p_once and exists (select 1 from commendations where player_id = p_player and code = p_code) then
    return false;
  end if;

  insert into commendations (player_id, code, title, detail, report_date)
  values (p_player, p_code, p_title, p_detail, p_date)
  on conflict (player_id, code, report_date) do nothing;
  get diagnostics v_new = row_count;

  if v_new then
    update players set stars = stars + 1 where id = p_player returning name into v_name;
    insert into feed (report_date, kind, body)
    values (p_date, 'commendation', v_name || ' earned a commendation: ' || p_title || ' *');
  end if;
  return v_new;
end $$;

/*
 * Re-check the daily commendations for one manager. Called after every close,
 * and cheap enough to be: all of it reads a single player_day row.
 */
create or replace function check_commendations(p_player uuid, p_date date)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_d player_day%rowtype; v_p players%rowtype;
begin
  select * into v_d from player_day where player_id = p_player and report_date = p_date;
  if not found then return; end if;
  select * into v_p from players where id = p_player;

  if v_d.jobs_home >= 5 then
    perform award(p_player, 'county-quota', 'County Quota',
                  'Five work orders closed in your home county.', p_date);
  end if;

  if v_d.incidents_cleared >= 3 then
    perform award(p_player, 'incident-sla', 'Rapid Response',
                  'Three incidents cleared before they timed out.', p_date);
  end if;

  if v_d.winter_closes >= 10 then
    perform award(p_player, 'snowbird', 'Snowbird',
                  'Ten winter jobs cleared while the state was under a winter warning.',
                  p_date, true);
  end if;

  if v_d.convoys >= 3 then
    perform award(p_player, 'convoy', 'Rolling Convoy',
                  'Three convoy dispatches in one day.', p_date);
  end if;

  -- First close on the board today, whoever gets there.
  if v_d.jobs_closed >= 1
     and not exists (select 1 from commendations where code = 'first-light' and report_date = p_date) then
    perform award(p_player, 'first-light', 'First Light',
                  'First work order closed on the board today.', p_date);
  end if;

  if v_p.streak >= 5 then
    perform award(p_player, 'streak-5', 'Week of Service',
                  'Reported for duty five report days running.', p_date, true);
  end if;
  if v_p.streak >= 10 then
    perform award(p_player, 'streak-10', 'Two Weeks Running',
                  'Ten consecutive report days on shift.', p_date, true);
  end if;
  if v_p.streak >= 20 then
    perform award(p_player, 'streak-20', 'Twenty and Counting',
                  'Twenty consecutive report days on shift.', p_date, true);
  end if;
end $$;

/*
 * Morning standup. Idempotent per report day: the first call books the streak
 * and the stipend, later calls just report what today already looks like.
 *
 * The streak counts report days rather than calendar days, and tolerates a gap
 * of up to three, so a long weekend away does not wipe out a run.
 */
create or replace function daily_checkin()
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_p    players%rowtype;
  v_day  date;
  v_gap  integer;
  v_pay  integer := 0;
  v_new  boolean := false;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select max(report_date) into v_day from game_day;
  if v_day is null then raise exception 'no report loaded yet'; end if;

  select * into v_p from players where id = v_uid for update;
  if not found then raise exception 'no manager profile yet'; end if;

  if v_p.last_login is distinct from v_day then
    v_gap := case when v_p.last_login is null then 999 else v_day - v_p.last_login end;
    -- Up to three calendar days of gap still counts as consecutive: that covers
    -- a normal weekend plus a holiday with no report filed.
    if v_gap between 1 and 3 then
      v_p.streak := v_p.streak + 1;
    else
      v_p.streak := 1;
    end if;
    v_pay := 100 + 25 * least(v_p.streak - 1, 8);
    v_new := true;

    update players
       set streak = v_p.streak,
           best_streak = greatest(best_streak, v_p.streak),
           last_login = v_day,
           funds = funds + v_pay,
           last_seen = now()
     where id = v_uid;

    insert into player_day (player_id, report_date, checked_in)
    values (v_uid, v_day, true)
    on conflict (player_id, report_date) do update set checked_in = true;

    perform check_commendations(v_uid, v_day);
  end if;

  return jsonb_build_object(
    'new', v_new,
    'report_date', v_day,
    'streak', (select streak from players where id = v_uid),
    'stipend', v_pay,
    'focus', current_focus(),
    'stars', (select stars from players where id = v_uid),
    'quota', coalesce((select jobs_home from player_day
                        where player_id = v_uid and report_date = v_day), 0));
end $$;

/*
 * Radio ping: one tap turns "somebody help me on Corridor G" from a chat
 * message into a link everyone can dispatch from.
 */
create or replace function radio_ping(p_job text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_p   players%rowtype;
  v_job jobs%rowtype;
  v_st  job_state%rowtype;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select * into v_p from players where id = v_uid;
  select * into v_job from jobs where id = p_job;
  if not found then raise exception 'that work order is gone'; end if;
  select * into v_st from job_state where job_id = p_job;
  if v_st.done then raise exception 'that work order is already closed'; end if;

  -- One ping per job per minute, so the ticker stays readable.
  if exists (select 1 from feed
              where kind = 'radio' and job_id = p_job
                and created_at > now() - interval '60 seconds') then
    raise exception 'that job was just called out on the radio';
  end if;

  insert into feed (report_date, kind, body, job_id)
  values (v_job.report_date, 'radio',
          v_p.name || ' is requesting backup on ' || v_job.activity || ' - ' ||
          coalesce(v_job.route_label, '?') || ' (' || v_job.county || ' Co., D' ||
          v_job.district || ')', p_job);
end $$;

-- ------------------------------------------------------------------ weather

-- Strongest live alert intensity for a county: 2 warning, 1 watch, 0 none.
create or replace function county_storm_level(p_county_code text)
returns integer language sql stable as $$
  select coalesce(max(a.intensity), 0)
    from alerts a
   where a.expires > now()
     and a.intensity > 0
     and p_county_code = any(a.counties);
$$;

create or replace function county_storm_kind(p_county_code text)
returns text language sql stable as $$
  select a.kind from alerts a
   where a.expires > now() and a.intensity > 0 and p_county_code = any(a.counties)
   order by a.intensity desc, a.expires desc limit 1;
$$;

-- Counties currently in play for storm effects, strongest first.
create or replace view storm_counties as
  select c.code, c.name, c.district,
         county_storm_level(c.code) as level,
         county_storm_kind(c.code)  as kind
    from wv_counties c
   where county_storm_level(c.code) > 0;

grant select on storm_counties to authenticated;

-- ----------------------------------------------------------------------------
-- settle_job: the replacement for the old server tick.
--
-- The crowd rate only changes at discrete instants — a crew arrives, a paid
-- boost expires, a hired contractor goes home — so progress between any two of
-- those is exactly rate * elapsed. This walks those events since the last
-- checkpoint, banks each constant-rate span, and stops at the precise moment
-- the job hits its effort target. Idempotent and safe for anyone to call: it
-- reads clocks and rows, never client input.
-- ----------------------------------------------------------------------------
create or replace function settle_job(p_job text)
returns job_state
language plpgsql security definer set search_path = public
as $BODY$
declare
  v_job     jobs%rowtype;
  v_st      job_state%rowtype;
  v_now     timestamptz := now();
  v_cursor  timestamptz;
  v_ev      record;
  v_n       integer;
  v_sum     numeric;
  v_mult    numeric;
  v_rate    numeric;
  v_dt      numeric;
  v_gain    numeric;
  v_need    numeric;
  v_total   numeric;
  v_c       record;
  v_frac    numeric;
  v_xp      integer;
  v_pay     integer;
  v_names   text;
  v_before  numeric;
  v_ms      integer;
  v_bxp     integer;
  v_chain   record;
  v_child   text;
begin
  select * into v_job from jobs where id = p_job;
  if not found then return null; end if;

  select * into v_st from job_state where job_id = p_job for update;
  if not found then return null; end if;
  if v_st.done then return v_st; end if;

  v_cursor := v_st.progress_at;
  v_before := v_st.progress;

  for v_ev in
    select t from (
      select arrives_at as t from crews
        where job_id = p_job and arrives_at > v_cursor and arrives_at <= v_now
      union
      select boost_until from crews
        where job_id = p_job and boost_until > v_cursor and boost_until <= v_now
      union
      select contractor_until from crews
        where job_id = p_job and contractor_until > v_cursor and contractor_until <= v_now
      union all
      select v_now
    ) e
    order by t
  loop
    -- Whoever is on site at the start of this span sets its rate.
    select count(*),
           coalesce(sum(c.rate * (case when c.boost_until > v_cursor then 2 else 1 end)), 0)
      into v_n, v_sum
      from crews c
     where c.job_id = p_job
       and c.arrives_at <= v_cursor
       and c.return_at is null
       and (c.contractor_until is null or c.contractor_until > v_cursor);

    v_dt := extract(epoch from (v_ev.t - v_cursor));

    -- An emergency callout produces nothing until enough crews are on site.
    if v_n >= v_job.min_crews and v_n > 0 and v_dt > 0 then
      v_mult := crew_multiplier(v_n);
      v_rate := v_sum * v_mult;
      v_gain := v_rate * v_dt;
      v_need := v_job.effort - v_st.progress;

      if v_gain >= v_need then          -- finishes partway through this span
        v_dt   := v_need / v_rate;
        v_gain := v_need;
      end if;

      insert into contributions (job_id, player_id, units)
        select p_job, c.player_id,
               sum(c.rate * (case when c.boost_until > v_cursor then 2 else 1 end) * v_mult * v_dt)
          from crews c
         where c.job_id = p_job
           and c.arrives_at <= v_cursor
           and c.return_at is null
           and (c.contractor_until is null or c.contractor_until > v_cursor)
         group by c.player_id
      on conflict (job_id, player_id)
        do update set units = contributions.units + excluded.units;

      v_st.progress := v_st.progress + v_gain;
      v_cursor := v_cursor + make_interval(secs => v_dt);

      exit when v_st.progress >= v_job.effort;
    else
      v_cursor := v_ev.t;
    end if;
  end loop;

  -- Hired contractors go home once their shift is up.
  delete from crews where job_id = p_job and contractor_until <= v_now;

  -- Segment bonuses on the day's biggest jobs: everyone on site is paid as the
  -- work marches past each quarter of the real route.
  if v_job.milestone and v_st.progress > v_before then
    v_bxp := greatest(1, round(v_job.xp_award * 0.25)::int);
    foreach v_ms in array array[25, 50, 75] loop
      if v_before < v_job.effort * v_ms / 100.0
         and v_st.progress >= v_job.effort * v_ms / 100.0
         and not exists (select 1 from job_milestones where job_id = p_job and pct = v_ms) then
        insert into job_milestones (job_id, pct) values (p_job, v_ms) on conflict do nothing;
        update players p
           set xp       = p.xp + v_bxp,
               day_xp   = case when p.day_date = v_job.report_date then p.day_xp + v_bxp else v_bxp end,
               day_date = v_job.report_date,
               funds    = p.funds + round(v_job.pay_award * 0.15)::int,
               level    = rank_for(p.xp + v_bxp)
         where p.id in (select distinct c.player_id from crews c
                         where c.job_id = p_job and c.arrives_at <= v_now
                           and c.return_at is null);
        insert into feed (report_date, kind, body)
        values (v_job.report_date, 'milestone',
                v_ms || '% marker reached on ' || v_job.activity || ' (' ||
                coalesce(v_job.route_label, '?') || ') - bonus paid to every crew on site.');
      end if;
    end loop;
  end if;

  -- Assigned crews, not crews already on site.
  --
  -- dispatch_crew increments this the moment a crew rolls, while it is still
  -- driving. Counting only arrivals here meant that settling a job during any
  -- crew's drive wrote crew_count = 0 - and the minute sweep, which only looks
  -- at jobs with crew_count > 0, then skipped that job forever. The crew worked
  -- at 100% and nothing ever closed it.
  select count(*) into v_n from crews
   where job_id = p_job and return_at is null;

  if v_st.progress >= v_job.effort then
    -- ------------------------------------------------------------- payout
    select coalesce(sum(units), 0) into v_total from contributions where job_id = p_job;
    if v_total <= 0 then v_total := 1; end if;

    for v_c in
      select ct.player_id, ct.units, p.county_code, p.xp as cur_xp
        from contributions ct join players p on p.id = ct.player_id
       where ct.job_id = p_job
    loop
      v_frac := v_c.units / v_total;
      v_xp := greatest(1, round(
                v_job.xp_award
                * (0.6 + 0.4 * v_frac)
                * (case when v_job.incident then 1.4 else 1 end)
                -- Storm work pays double: this is when the state actually needs it.
                * (case when v_job.storm then 2.0 else 1 end)
                -- Patrol your own turf: home county work pays better.
                * (case when v_c.county_code is not null
                          and v_c.county_code = v_job.county_code then 1.25 else 1 end)
                -- This week's focus category.
                * (case when v_job.category = current_focus() then 1.5 else 1 end)
                * (1 + player_equip_bonus(v_c.player_id, 'xp_cat', v_job.category))
              )::int);
      v_pay := round(v_job.pay_award * v_frac
                     * (case when rank_for(v_c.cur_xp) >= 9 then 1.1 else 1 end))::int;

      update players
         set xp        = xp + v_xp,
             day_xp    = case when day_date = v_job.report_date then day_xp + v_xp else v_xp end,
             day_date  = v_job.report_date,
             funds     = funds + v_pay,
             jobs_done = jobs_done + 1,
             level     = rank_for(xp + v_xp)
       where id = v_c.player_id;

      insert into player_day (player_id, report_date, jobs_closed, jobs_home,
                              incidents_cleared, winter_closes)
      values (v_c.player_id, v_job.report_date, 1,
              case when v_c.county_code = v_job.county_code then 1 else 0 end,
              case when v_job.incident then 1 else 0 end,
              case when v_job.category = 'Winter Ops' and v_job.storm then 1 else 0 end)
      on conflict (player_id, report_date) do update set
        jobs_closed       = player_day.jobs_closed + 1,
        jobs_home         = player_day.jobs_home + excluded.jobs_home,
        incidents_cleared = player_day.incidents_cleared + excluded.incidents_cleared,
        winter_closes     = player_day.winter_closes + excluded.winter_closes;

      perform check_commendations(v_c.player_id, v_job.report_date);
    end loop;

    select string_agg(distinct player_name, ', ') into v_names
      from crews where job_id = p_job and return_at is null;

    -- Job done: the crews load up and drive back to the garage they came from.
    -- The return leg runs at 60% of the outbound trip - an empty truck with
    -- nothing to set up - and the crew is unavailable until it arrives.
    -- The drive home takes about as long as the drive out; it is the same road.
    -- Only the loading and setup are saved, so 90% rather than the 60% this
    -- used to be, and it honours the same bounds as an outbound trip.
    update crews
       set return_from = v_now,
           return_at = v_now + make_interval(secs => greatest(8, least(75,
             extract(epoch from (arrives_at - dispatched_at)) * 0.9))),
           boost_until = null,
           convoy = false
     where job_id = p_job and contractor_until is null and return_at is null;

    -- Hired contractors are not yours to bring home.
    delete from crews where job_id = p_job and contractor_until is not null;

    update job_state
       set progress = v_job.effort, progress_at = v_cursor,
           crew_count = 0, done = true, done_at = v_cursor
     where job_id = p_job
     returning * into v_st;

    if v_job.incident then
      insert into district_day_stats (report_date, district, incidents_cleared)
      values (v_job.report_date, v_job.district, 1)
      on conflict (report_date, district)
        do update set incidents_cleared = district_day_stats.incidents_cleared + 1;
    end if;

    insert into feed (report_date, kind, body)
    values (v_job.report_date,
            case when v_job.incident then 'incident-cleared' else 'complete' end,
            coalesce(v_names, 'A crew') || ' completed ' || v_job.activity ||
            ' on ' || coalesce(v_job.route_label, '?') || ' (' || v_job.county || ' Co.)');

    -- Finishing some work uncovers more of it.
    if not v_job.incident and v_job.parent_id is null then
      select * into v_chain from job_chains
       where v_job.activity ilike match_pattern
       order by random() limit 1;
      if found and random() < v_chain.chance then
        v_child := 'chain-' || replace(gen_random_uuid()::text, '-', '');
        insert into jobs (
          id, report_date, district, county, county_code, category, activity,
          route_type, route_label, route_name, bmp, emp, start_time, end_time, detail,
          miles, approx, incident, coords, centroid, effort, xp_award, pay_award, parent_id)
        select v_child, v_job.report_date, v_job.district, v_job.county, v_job.county_code,
               v_chain.child_category, v_chain.child_activity,
               v_job.route_type, v_job.route_label, v_job.route_name, v_job.bmp, v_job.emp,
               to_char(now(), 'FMHH12:MI AM'), v_job.end_time, v_chain.child_detail,
               v_job.miles, v_job.approx, false, v_job.coords, v_job.centroid,
               greatest(30, round(v_job.effort * v_chain.effort_factor)),
               v_job.xp_award, v_job.pay_award, p_job;
        insert into job_state (job_id) values (v_child);
        insert into feed (report_date, kind, body)
        values (v_job.report_date, 'chain',
                'Follow-up opened: ' || v_chain.child_activity || ' on ' ||
                coalesce(v_job.route_label, '?') || ' (' || v_job.county || ' Co.) - ' ||
                coalesce(v_chain.child_detail, ''));
      end if;
    end if;
  else
    update job_state
       set progress = v_st.progress, progress_at = v_now, crew_count = v_n
     where job_id = p_job
     returning * into v_st;
  end if;

  return v_st;
end $BODY$;

-- ============================================================================
-- Player actions
-- ============================================================================

create or replace function ensure_player(p_name text, p_county text)
returns players
language plpgsql security definer set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_row    players%rowtype;
  v_county record;
  v_name   text := nullif(btrim(coalesce(p_name, '')), '');
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  v_name := left(coalesce(v_name, 'Manager'), 22);

  select * into v_county from wv_counties where lower(name) = lower(btrim(p_county));
  if not found then
    select * into v_county from wv_counties order by name limit 1;
  end if;

  insert into players (id, name, county, county_code, district, home)
  values (v_uid, v_name, v_county.name, v_county.code, v_county.district, v_county.center)
  on conflict (id) do update
    set name = excluded.name,
        -- County is identity: it can be set at signup but not swapped later to
        -- chase whichever district has the fattest board today.
        last_seen = now()
  returning * into v_row;

  return v_row;
end $$;

-- Nearest dispatchable facility in a district to a point. Degrees are scaled
-- so a degree of longitude counts for less than a degree of latitude at WV's
-- latitude; exact distance doesn't matter, ordering does.
create or replace function nearest_facility(p_district integer, p_lng numeric, p_lat numeric)
returns facilities
language sql stable as $$
  select f.* from facilities f
   where f.dispatchable and f.district = p_district
   order by (f.lat - p_lat) ^ 2 + ((f.lng - p_lng) * 0.78) ^ 2
   limit 1;
$$;

-- Straight-line miles, good enough for travel estimates and route sanity.
create or replace function rough_miles(p_lng1 numeric, p_lat1 numeric, p_lng2 numeric, p_lat2 numeric)
returns numeric language sql immutable as $$
  select 69.0 * sqrt((p_lat2 - p_lat1) ^ 2 + ((p_lng2 - p_lng1) * 0.78) ^ 2);
$$;

-- `create or replace function` overloads rather than replaces when the argument
-- list changes, and PostgREST then refuses to choose between the two. Retire
-- the signatures these replaced.
drop function if exists dispatch_crew(text);
drop function if exists max_crews_for(integer);
drop function if exists level_for(integer);

/*
 * dispatch_crew
 *
 * The client picks the same facility the server would, fetches a real driving
 * route, and hands up the route geometry and the *real* driving seconds. The
 * server re-derives the facility itself, converts real time to game time, and
 * clamps it — so the polyline is cosmetic and the clock stays authoritative.
 */
create or replace function dispatch_crew(
  p_job      text,
  p_facility text    default null,
  p_route    jsonb   default null,
  p_secs     numeric default null)
returns job_state
language plpgsql security definer set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_p      players%rowtype;
  v_job    jobs%rowtype;
  v_st     job_state%rowtype;
  v_fac    facilities%rowtype;
  v_out    integer;
  v_miles  numeric;
  v_travel numeric;
  v_route  jsonb := null;
  v_ok     boolean := false;
  v_convoy integer := 0;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select * into v_p from players where id = v_uid;
  if not found then raise exception 'no manager profile yet'; end if;

  select * into v_job from jobs where id = p_job;
  if not found then raise exception 'that work order is gone'; end if;

  -- Territory: your district is your turf. Emergencies are everyone's.
  if not v_job.incident and v_job.district is distinct from v_p.district then
    raise exception 'that work order is in District %, outside your district', v_job.district;
  end if;

  -- Bank work done under the old crew count before the rate changes.
  v_st := settle_job(p_job);
  if v_st.done then raise exception 'that work order is already closed'; end if;

  -- Crews that have made it back to the garage are free again. Reap them here
  -- as well as on the cron sweep so a manager is never held up waiting for it.
  delete from crews where player_id = v_uid and return_at <= now();

  select count(*) into v_out from crews where player_id = v_uid and contractor_until is null;
  if v_out >= max_crews_for(v_uid) then
    if exists (select 1 from crews where player_id = v_uid and return_at is not null) then
      raise exception 'all of your crews are out - one is still returning to the garage';
    end if;
    raise exception 'all of your crews are already out';
  end if;

  if exists (select 1 from crews
              where job_id = p_job and player_id = v_uid
                and contractor_until is null and return_at is null) then
    raise exception 'you already have a crew on that one';
  end if;

  v_fac := nearest_facility(coalesce(v_job.district, v_p.district),
                            (v_job.centroid->>0)::numeric, (v_job.centroid->>1)::numeric);
  if v_fac.id is null then
    v_fac := nearest_facility(v_p.district,
                              (v_job.centroid->>0)::numeric, (v_job.centroid->>1)::numeric);
  end if;

  v_miles := case when v_fac.id is null then 20
             else rough_miles(v_fac.lng, v_fac.lat,
                              (v_job.centroid->>0)::numeric, (v_job.centroid->>1)::numeric) end;

  -- Accept the client's route only if it is for the facility the server chose
  -- and its driving time is physically plausible for that distance.
  if p_route is not null and p_secs is not null and v_fac.id is not null
     and p_facility = v_fac.id
     and jsonb_typeof(p_route) = 'array' and jsonb_array_length(p_route) between 2 and 400
     and p_secs >= v_miles * 30 and p_secs <= v_miles * 400 + 600 then
    v_ok := true;
  end if;

  if v_ok then
    -- Game time runs ~2 seconds per real driving minute.
    v_travel := p_secs / 30.0;
    v_route  := p_route;
    insert into route_cache (facility_id, job_id, coords, drive_secs)
    values (v_fac.id, p_job, p_route, p_secs)
    on conflict (facility_id, job_id) do nothing;
  else
    v_travel := 6 + v_miles * 0.28;
    select rc.coords into v_route from route_cache rc
     where rc.facility_id = v_fac.id and rc.job_id = p_job;
  end if;

  v_travel := v_travel * (1 - player_equip_bonus(v_uid, 'travel', v_job.category));

  -- Rolling convoy: if anyone else set out for this job in the last minute,
  -- everyone still on the road runs 40% of their remaining trip faster. This is
  -- what makes "everyone hit Corridor G" in chat worth saying out loud.
  select count(*) into v_convoy from crews
   where job_id = p_job and dispatched_at > now() - interval '60 seconds'
     and arrives_at > now() and return_at is null and player_id <> v_uid;

  if v_convoy > 0 then
    v_travel := v_travel * 0.6;
    -- `and not convoy` matters: without it every later dispatch re-applied the
    -- 0.6 to crews that had already been sped up, so four crews rolling
    -- together cut the first one's trip to 0.6^3 of its length and a big pile-on
    -- arrived almost instantly. The discount is once per crew, and the floor is
    -- reapplied here because this update sidesteps the clamp below.
    update crews
       set arrives_at = greatest(
             now() + interval '4 seconds',
             now() + make_interval(secs => extract(epoch from (arrives_at - now())) * 0.6)),
           convoy = true
     where job_id = p_job and arrives_at > now() and return_at is null
       and not convoy
       and dispatched_at > now() - interval '60 seconds';
    insert into player_day (player_id, report_date, convoys)
    select c.player_id, v_job.report_date, 1 from crews c
     where c.job_id = p_job and c.convoy and c.arrives_at > now()
    on conflict (player_id, report_date)
      do update set convoys = player_day.convoys + 1;
  end if;

  v_travel := least(75, greatest(6, v_travel));

  insert into crews (job_id, player_id, player_name, arrives_at, rate, facility_id, route, convoy)
  values (p_job, v_uid, v_p.name, now() + make_interval(secs => v_travel),
          player_crew_rate(v_uid, v_job.category), v_fac.id, v_route, v_convoy > 0);

  update job_state set crew_count = crew_count + 1 where job_id = p_job returning * into v_st;
  update players set last_seen = now() where id = v_uid;

  if v_convoy > 0 then
    perform check_commendations(v_uid, v_job.report_date);
  end if;
  return v_st;
end $$;

create or replace function recall_crew(p_job text)
returns job_state
language plpgsql security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_st  job_state%rowtype;
  v_n   integer;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  v_st := settle_job(p_job);
  delete from crews
   where job_id = p_job and player_id = v_uid
     and contractor_until is null and return_at is null;
  select count(*) into v_n from crews where job_id = p_job and return_at is null;
  update job_state set crew_count = v_n where job_id = p_job returning * into v_st;
  return v_st;
end $$;

-- --------------------------------------------------------------- overtime

create or replace function spend(p_player uuid, p_amount integer, p_what text)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_funds integer;
begin
  -- A negative amount would *credit* the account. This is an internal helper
  -- and EXECUTE is revoked from players below, but the guard stays: the cost of
  -- being wrong about that once is every budget in the game.
  if p_amount is null or p_amount <= 0 then
    raise exception 'invalid amount';
  end if;
  select funds into v_funds from players where id = p_player for update;
  if v_funds is null then raise exception 'no manager profile yet'; end if;
  if v_funds < p_amount then
    raise exception 'not enough budget for % ($% short)', p_what, p_amount - v_funds;
  end if;
  update players set funds = funds - p_amount where id = p_player;
end $$;

create or replace function buy_hot_shot(p_job text)
returns job_state
language plpgsql security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_st  job_state%rowtype;
  v_n   integer;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  if rank_for((select xp from players where id = v_uid)) < 3 then
    raise exception 'overtime unlocks at Foreman';
  end if;
  v_st := settle_job(p_job);

  select count(*) into v_n from crews
   where job_id = p_job and player_id = v_uid and contractor_until is null
     and return_at is null and arrives_at > now();
  if v_n = 0 then raise exception 'no crew of yours is still on the road to that job'; end if;

  perform spend(v_uid, 75, 'a hot-shot dispatch');
  update crews set arrives_at = now()
   where job_id = p_job and player_id = v_uid and contractor_until is null;

  v_st := settle_job(p_job);
  return v_st;
end $$;

create or replace function buy_double_shift(p_job text)
returns job_state
language plpgsql security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_st  job_state%rowtype;
  v_n   integer;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  if rank_for((select xp from players where id = v_uid)) < 3 then
    raise exception 'overtime unlocks at Foreman';
  end if;
  v_st := settle_job(p_job);
  if v_st.done then raise exception 'that work order is already closed'; end if;

  select count(*) into v_n from crews
   where job_id = p_job and player_id = v_uid and contractor_until is null
     and return_at is null and (boost_until is null or boost_until <= now());
  if v_n = 0 then raise exception 'no un-boosted crew of yours on that job'; end if;

  perform spend(v_uid, 150, 'a double shift');
  update crews set boost_until = now() + interval '10 minutes'
   where job_id = p_job and player_id = v_uid and contractor_until is null;

  insert into feed (report_date, kind, body)
  select (select max(report_date) from game_day), 'overtime',
         p.name || ' put a crew on a double shift.'
    from players p where p.id = v_uid;

  return settle_job(p_job);
end $$;

create or replace function buy_contractor(p_job text)
returns job_state
language plpgsql security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_p   players%rowtype;
  v_job jobs%rowtype;
  v_st  job_state%rowtype;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select * into v_p from players where id = v_uid;
  if rank_for(v_p.xp) < 3 then raise exception 'overtime unlocks at Foreman'; end if;

  select * into v_job from jobs where id = p_job;
  if not found then raise exception 'that work order is gone'; end if;
  if not v_job.incident and v_job.district is distinct from v_p.district then
    raise exception 'that work order is outside your district';
  end if;

  v_st := settle_job(p_job);
  if v_st.done then raise exception 'that work order is already closed'; end if;

  if exists (select 1 from crews
              where job_id = p_job and player_id = v_uid and contractor_until is not null) then
    raise exception 'you already have a contractor on that job';
  end if;

  perform spend(v_uid, 400, 'an emergency contractor');

  insert into crews (job_id, player_id, player_name, arrives_at, rate, contractor_until)
  values (p_job, v_uid, v_p.name || ' (contractor)', now() + interval '8 seconds',
          player_crew_rate(v_uid, v_job.category), now() + interval '15 minutes');

  update job_state set crew_count = crew_count + 1 where job_id = p_job returning * into v_st;
  return v_st;
end $$;

create or replace function buy_equipment(p_key text)
returns players
language plpgsql security definer set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_p    players%rowtype;
  v_item equipment_catalog%rowtype;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select * into v_p from players where id = v_uid;
  if not found then raise exception 'no manager profile yet'; end if;

  select * into v_item from equipment_catalog where key = p_key;
  if not found then raise exception 'no such equipment'; end if;

  if rank_for(v_p.xp) < 4 then raise exception 'the equipment garage unlocks at County Supervisor'; end if;
  if rank_for(v_p.xp) < v_item.min_rank then
    raise exception '% requires %', v_item.name,
      (select name from ranks where idx = v_item.min_rank);
  end if;
  if exists (select 1 from player_equipment where player_id = v_uid and item_key = p_key) then
    raise exception 'you already own the %', v_item.name;
  end if;

  perform spend(v_uid, v_item.cost, v_item.name);
  insert into player_equipment (player_id, item_key) values (v_uid, p_key);

  insert into feed (report_date, kind, body)
  values ((select max(report_date) from game_day), 'equipment',
          v_p.name || ' put a ' || v_item.name || ' into service.');

  select * into v_p from players where id = v_uid;
  return v_p;
end $$;

create or replace function post_chat(p_text text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_p    players%rowtype;
  v_body text := left(btrim(coalesce(p_text, '')), 200);
begin
  if v_uid is null or v_body = '' then return; end if;
  select * into v_p from players where id = v_uid;
  if not found then return; end if;
  insert into feed (report_date, kind, body)
  values ((select max(report_date) from game_day), 'chat', v_p.name || ': ' || v_body);
  update players set last_seen = now() where id = v_uid;
end $$;

/*
 * Delete your own account and everything attached to it.
 *
 * Player-facing (a manager can retire), and it is also how automated checks
 * clean up after themselves. Test accounts used to be removed by hand-written
 * DELETEs against auth.users, and one of those - `where p.id = u.id and name
 * like 'X%' or name in (...)` - lost its join to operator precedence and wiped
 * every account on the board. A function that can only ever touch auth.uid()
 * cannot make that mistake.
 */
create or replace function delete_my_account()
returns void
language plpgsql security definer set search_path = public
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then return; end if;
  delete from crews where player_id = v_uid;
  -- players, contributions, player_day and commendations all cascade from here.
  delete from auth.users where id = v_uid;
end $$;

create or replace function heartbeat()
returns void language sql security definer set search_path = public as $$
  update players set last_seen = now() where id = auth.uid();
$$;

-- ============================================================================
-- Scheduled work (pg_cron) — the replacement for the old setInterval timers
-- ============================================================================

/** Crews that have reached their garage are available again. */
create or replace function retire_returned_crews()
returns integer
language plpgsql security definer set search_path = public
as $$
declare v_n integer;
begin
  delete from crews where return_at is not null and return_at <= now();
  get diagnostics v_n = row_count;
  return v_n;
end $$;

create or replace function sweep_jobs()
returns integer
language plpgsql security definer set search_path = public
as $$
declare v_id text; v_n integer := 0;
begin
  -- Driven from the crews table rather than job_state.crew_count: a counter
  -- that drifts out of step must not be able to strand a job.
  for v_id in
    select distinct c.job_id
      from crews c
      join job_state s on s.job_id = c.job_id
     where not s.done and c.return_at is null
     limit 500
  loop
    perform settle_job(v_id);
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

create or replace function expire_incidents()
returns integer
language plpgsql security definer set search_path = public
as $$
declare v_j record; v_n integer := 0;
begin
  for v_j in
    select j.* from jobs j
      join job_state s on s.job_id = j.id
     where j.incident and not s.done and j.expires_at < now()
  loop
    insert into district_day_stats (report_date, district, incidents_expired)
    values (v_j.report_date, v_j.district, 1)
    on conflict (report_date, district)
      do update set incidents_expired = district_day_stats.incidents_expired + 1;

    insert into feed (report_date, kind, body)
    values (v_j.report_date, 'incident-expired',
            v_j.activity || ' on ' || coalesce(v_j.route_label, '?') ||
            ' (' || v_j.county || ' Co.) went unattended.');
    delete from jobs where id = v_j.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- Live incidents ride on real route geometry: a random scheduled work order
-- donates one of its segments, so a rock slide lands on a road that actually
-- exists, at a milepoint on that road.
--
-- When the National Weather Service has counties under a warning,
-- incidents concentrate there, take their character from the weather, and pay
-- double. Winter warnings put them on plow priority: interstates first, then US
-- routes, then state routes -- normal plow priority.
create or replace function spawn_incident()
returns text
language plpgsql security definer set search_path = public
as $BODY$
declare
  v_src     jobs%rowtype;
  v_day     date;
  v_live    integer;
  v_kind    text;
  v_note    text;
  v_i       integer;
  v_k       integer;
  v_seg     jsonb;
  v_id      text;
  v_storm   record;
  v_online  integer;
  v_callout boolean := false;
  v_minc    integer := 1;
  v_effort  numeric := 30;
  v_xp      integer := 34;
  v_pay     integer := 430;
  v_kinds   text[];
  v_notes   text[];
begin
  select max(report_date) into v_day from game_day;
  if v_day is null then return null; end if;

  select count(*) into v_live
    from jobs j join job_state s on s.job_id = j.id
   where j.incident and not s.done;
  if v_live >= 14 then return null; end if;

  -- Is anywhere in the state under active weather right now?
  --
  -- Weighted rather than ranked: `order by level desc` meant that whenever a
  -- single county held the only Warning, every storm incident in the state
  -- landed there and the board turned into one county's bad day. Dividing a
  -- random draw by the level gives a Warning county roughly twice the pull of a
  -- Watch county while still spreading across all of them. Counties already
  -- holding three live incidents are skipped outright.
  select * into v_storm from storm_counties sc
   where (select count(*) from jobs j
            join job_state s on s.job_id = j.id
           where j.incident and not s.done and j.county_code = sc.code) < 3
   order by random() / greatest(sc.level, 1)
   limit 1;

  if v_storm.code is not null and random() < (case when v_storm.level >= 2 then 0.8 else 0.45 end) then
    -- Storm-driven: pull a donor segment from the affected county, favouring
    -- the routes that actually get cleared first.
    select * into v_src from jobs
     where report_date = v_day and not incident
       and county_code = v_storm.code
       and jsonb_array_length(coords) > 1
     order by case when v_storm.kind = 'winter' then
                case route_type when 'I' then 0 when 'US' then 1 when 'WV' then 2 else 3 end
              else 0 end,
              random()
     limit 1;
  end if;

  if v_src.id is null then
    v_storm := null;
    select * into v_src from jobs
     where report_date = v_day and not incident and jsonb_array_length(coords) > 1
     order by random() limit 1;
  end if;
  if v_src.id is null then return null; end if;

  case coalesce(v_storm.kind, 'none')
    when 'winter' then
      v_kinds := array['Snow & Ice Control','Drifting Snow','Black Ice','Plow Route Callout','Stranded Vehicle'];
      v_notes := array[
        'Plow and spreader needed - accumulation on the travel lanes.',
        'Blowing and drifting snow closing the lane.',
        'Black ice reported; brine and cinders requested.',
        'Priority plow route has not been cleared this cycle.',
        'Vehicle stuck in the roadway blocking the plow lane.'];
    when 'flood' then
      v_kinds := array['High Water','Slip / Slide','Debris Flow','Washout'];
      v_notes := array[
        'Water over the roadway; signs and barricades needed.',
        'Saturated bank is moving into the travel lane.',
        'Mud and debris pushed across both lanes.',
        'Shoulder washed out - lane closure required.'];
    when 'wind' then
      v_kinds := array['Downed Tree','Sign Down','Guardrail Strike','Debris in Roadway'];
      v_notes := array[
        'Tree across both lanes after storm activity.',
        'Regulatory sign blown down; replacement needed.',
        'Damaged guardrail needs emergency repair.',
        'Wind-blown debris scattered across the lanes.'];
    when 'storm' then
      v_kinds := array['Signal Outage','Crash Debris','Downed Tree','Flash Flooding'];
      v_notes := array[
        'Dark signal - temporary stop control required.',
        'Secondary cleanup requested by responders.',
        'Tree across both lanes after storm activity.',
        'Fast-rising water across the roadway.'];
    else
      v_kinds := array['Rock Slide','Downed Tree','High Water','Crash Debris',
                       'Signal Outage','Guardrail Strike','Sinkhole','Slip / Slide'];
      v_notes := array[
        'Rock and debris in the roadway - dispatch to clear.',
        'Tree across both lanes after storm activity.',
        'Water over the roadway; signs and barricades needed.',
        'Secondary cleanup requested by responders.',
        'Dark signal - temporary stop control required.',
        'Damaged guardrail needs emergency repair.',
        'Pavement failure reported; lane closure in place.',
        'Embankment slip encroaching on the travel lane.'];
  end case;

  v_k    := 1 + floor(random() * array_length(v_kinds, 1))::int;
  v_kind := v_kinds[v_k];
  v_note := v_notes[v_k];

  -- Emergency callouts need a real crowd before work can start, so they only
  -- appear when there are enough managers on shift to actually answer one.
  select count(*) into v_online from players where last_seen > now() - interval '6 minutes';
  if v_online >= 3 and random() < 0.12 then
    v_callout := true;
    v_minc    := 3;
    v_effort  := 180;
    v_xp      := 90;
    v_pay     := 1200;
    v_kind    := 'CALLOUT: ' || v_kind;
    v_note    := v_note || ' MAJOR EVENT - three crews must be on site before work can begin.';
  end if;

  if coalesce(v_storm.level, 0) >= 2 then
    v_effort := v_effort * 1.3;
  end if;

  v_i   := 1 + floor(random() * (jsonb_array_length(v_src.coords) - 1))::int;
  v_seg := jsonb_build_array(v_src.coords->(v_i - 1), v_src.coords->v_i);
  v_id  := 'inc-' || replace(gen_random_uuid()::text, '-', '');

  insert into jobs (
    id, report_date, district, county, county_code, category, activity,
    route_type, route_label, route_name, bmp, emp, start_time, end_time, detail,
    miles, approx, incident, expires_at, coords, centroid, effort, xp_award, pay_award,
    min_crews, storm)
  values (
    v_id, v_day, v_src.district, v_src.county, v_src.county_code,
    case when v_storm.kind = 'winter' then 'Winter Ops' else 'Incident' end, v_kind,
    v_src.route_type, v_src.route_label, v_src.route_name, v_src.bmp, v_src.emp,
    to_char(now(), 'FMHH12:MI AM'),
    to_char(now() + interval '12 minutes', 'FMHH12:MI AM'),
    v_note, 0, false, true, now() + interval '12 minutes',
    v_seg, v_src.coords->(v_i - 1), round(v_effort), v_xp, v_pay,
    v_minc, v_storm.code is not null);

  insert into job_state (job_id) values (v_id);

  insert into feed (report_date, kind, body)
  values (v_day,
          case when v_callout then 'callout' else 'incident' end,
          case when v_callout then '*** EMERGENCY CALLOUT *** ' else '' end ||
          v_kind || ' reported on ' || coalesce(v_src.route_label, '?') ||
          ' in ' || v_src.county || ' County - District ' || v_src.district ||
          case when v_storm.code is not null
               then ' (' || upper(v_storm.kind) || ' conditions - double XP)' else '' end ||
          case when v_callout then ' - 3 CREWS REQUIRED' else '' end);

  return v_id;
end $BODY$;

-- End-of-day district report card: the trash-talk engine.
create or replace function build_report_cards(p_date date)
returns integer
language plpgsql security definer set search_path = public
as $$
declare v_d record; v_n integer := 0; v_pct numeric; v_grade text; v_top text;
begin
  for v_d in
    select j.district,
           count(*)::int                                as total,
           count(*) filter (where s.done)::int          as done
      from jobs j join job_state s on s.job_id = j.id
     where j.report_date = p_date and not j.incident
     group by j.district
  loop
    v_pct := case when v_d.total = 0 then 0 else 100.0 * v_d.done / v_d.total end;
    v_grade := case
      when v_pct >= 90 then 'A+' when v_pct >= 80 then 'A'
      when v_pct >= 65 then 'B'  when v_pct >= 50 then 'C'
      when v_pct >= 35 then 'D'  else 'F' end;

    select p.name into v_top
      from players p
     where p.day_date = p_date and p.district = v_d.district
     order by p.day_xp desc limit 1;

    insert into day_report_cards (
      report_date, district, grade, pct_closed, jobs_total, jobs_done,
      incidents_cleared, incidents_expired, top_player)
    select p_date, v_d.district, v_grade, round(v_pct, 1), v_d.total, v_d.done,
           coalesce(ds.incidents_cleared, 0), coalesce(ds.incidents_expired, 0), v_top
      from (select 1) x
      left join district_day_stats ds
        on ds.report_date = p_date and ds.district = v_d.district
    on conflict (report_date, district) do update
      set grade = excluded.grade, pct_closed = excluded.pct_closed,
          jobs_total = excluded.jobs_total, jobs_done = excluded.jobs_done,
          incidents_cleared = excluded.incidents_cleared,
          incidents_expired = excluded.incidents_expired,
          top_player = excluded.top_player;
    v_n := v_n + 1;
  end loop;

  insert into feed (report_date, kind, body)
  select p_date, 'report-card',
         'Report card for ' || p_date || ' — ' ||
         string_agg('D' || district || ' ' || grade, '  ' order by district)
    from day_report_cards where report_date = p_date;

  return v_n;
end $$;

-- Freeze yesterday's standings and zero everyone's daily score. Called by the
-- generator when a new day's board is published.
create or replace function roll_day(p_new_date date)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_old date;
begin
  select max(report_date) into v_old from game_day where report_date < p_new_date;
  if v_old is not null then
    perform build_report_cards(v_old);
    insert into day_scores (report_date, player_id, name, county, day_xp, jobs_done)
    select v_old, id, name, county, day_xp, jobs_done
      from players where day_date = v_old and day_xp > 0
    on conflict (report_date, player_id) do update
      set day_xp = excluded.day_xp, jobs_done = excluded.jobs_done;
  end if;

  update players set day_xp = 0, day_date = p_new_date;
  -- A manager who skipped more than three calendar days has broken their run.
  update players set streak = 0
   where last_login is null or p_new_date - last_login > 3;
  delete from crews;
  insert into feed (report_date, kind, body)
  values (p_new_date, 'system', 'A new daily road report posted - the board has reset.');
end $$;

create or replace function prune_history()
returns void
language plpgsql security definer set search_path = public
as $$
begin
  delete from feed where created_at < now() - interval '2 days';
  delete from game_day where report_date < (select max(report_date) - 1 from game_day);
  delete from route_cache where created_at < now() - interval '3 days';
  delete from alerts where expires < now() - interval '6 hours';
end $$;

/*
 * Mark the day's biggest jobs as milestone routes. Called by the ingest job
 * after it loads a report: the three longest jobs in each district get 25/50/75%
 * segment bonuses, so a five-mile paving run on Corridor G reads as a march down
 * the route rather than one long wall.
 */
create or replace function mark_milestone_jobs(p_date date)
returns integer
language plpgsql security definer set search_path = public
as $$
declare v_n integer;
begin
  update jobs set milestone = false where report_date = p_date;
  with ranked as (
    select id, row_number() over (partition by district order by effort desc) as rn
      from jobs where report_date = p_date and not incident
  )
  update jobs j set milestone = true
    from ranked r where r.id = j.id and r.rn <= 3;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

do $$
begin
  perform cron.unschedule(jobname)
    from cron.job
   where jobname in ('roadworks-sweep', 'roadworks-incidents', 'roadworks-prune');
exception when others then null;
end $$;

select cron.schedule('roadworks-sweep',     '* * * * *',   $$select sweep_jobs(); select expire_incidents(); select retire_returned_crews();$$);
select cron.schedule('roadworks-incidents', '*/2 * * * *', $$select spawn_incident();$$);
select cron.schedule('roadworks-prune',     '17 4 * * *',  $$select prune_history();$$);

-- ============================================================================
-- Function privileges
--
-- Postgres grants EXECUTE on new functions to PUBLIC, and PostgREST exposes
-- every one of them as an RPC. Row level security does nothing here: these are
-- security-definer functions, so anyone who can call them runs them as the
-- owner. Everything that is not a deliberate player action is locked down.
--
-- (Left callable on purpose: settle_job is idempotent and recomputes from
-- server state, and nearest_facility is a read-only helper the client already
-- mirrors.)
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'spend(uuid,integer,text)',
    'spawn_incident()',
    'sweep_jobs()',
    'expire_incidents()',
    'roll_day(date)',
    'build_report_cards(date)',
    'mark_milestone_jobs(date)',
    'prune_history()',
    'award(uuid,text,text,text,date,boolean)',
    'check_commendations(uuid,date)',
    'retire_returned_crews()']
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;

-- ============================================================================
-- Realtime — only the small, frequently-changing tables are published.
-- ============================================================================
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['job_state','feed','crews','jobs','players']
    loop
      if not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime'
                        and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table %I', t);
      end if;
    end loop;
  end if;
exception when others then
  raise notice 'could not configure realtime (%) - the client falls back to polling', sqlerrm;
end $$;

-- Deliberately NOT `replica identity full`.
--
-- Full identity makes every UPDATE carry a complete copy of the old row as
-- well as the new one, and nothing here reads `old` beyond the primary key
-- the delete handler needs. Crew rows carry their driving route, so the saving
-- scales with trip length: measured at 1.3-2.2KB per update on short hops,
-- and a cross-district route of 400 points would be roughly ten times that.
--
-- This is a reduction in realtime traffic, not a proven fix for the dropped
-- updates that stranded crews client-side; the periodic resync is what
-- actually guarantees those heal.
alter table job_state replica identity default;
alter table crews     replica identity default;

-- ============================================================================
-- Convenience views
-- ============================================================================

create or replace view leaderboard_today as
  select p.id, p.name, p.county, p.day_xp, p.xp, p.level, p.jobs_done
    from players p
   where p.day_date = (select max(report_date) from game_day)
   order by p.day_xp desc, p.xp desc;

create or replace view all_time_standings as
  select name, county, xp, level, jobs_done from players order by xp desc;

grant select on leaderboard_today, all_time_standings to authenticated;
