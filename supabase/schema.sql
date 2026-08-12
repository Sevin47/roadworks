-- ============================================================================
-- WVDOT Roadworks — Supabase schema
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

-- One row per WV511 daily road report that has been ingested.
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

-- County reference data, loaded by the ingest job from WVDOT's own county
-- layer, so the county list a player picks from is WVDOT's, not a hardcoded one.
create table if not exists wv_counties (
  code     text primary key,
  name     text not null unique,
  district integer not null,
  center   jsonb
);

-- Real WVDOT facilities (Transportation/MapServer/4). Crews roll from the
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
  ( 8, 'State Highway Engineer',     3200, 7, '7th crew'),
  ( 9, 'Deputy Commissioner',        4400, 7, '+10% budget payouts'),
  (10, 'Commissioner of Highways',   5800, 8, '8th crew, prestige transfer')
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

alter table players add column if not exists prestige integer not null default 0;

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
    'district_day_stats','day_report_cards','equipment_catalog','player_equipment']
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
as $$
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
begin
  select * into v_job from jobs where id = p_job;
  if not found then return null; end if;

  select * into v_st from job_state where job_id = p_job for update;
  if not found then return null; end if;
  if v_st.done then return v_st; end if;

  v_cursor := v_st.progress_at;

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
       and (c.contractor_until is null or c.contractor_until > v_cursor);

    v_dt := extract(epoch from (v_ev.t - v_cursor));

    if v_n > 0 and v_dt > 0 then
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

  select count(*) into v_n from crews where job_id = p_job and arrives_at <= v_now;

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
                -- Patrol your own turf: home county work pays better.
                * (case when v_c.county_code is not null
                          and v_c.county_code = v_job.county_code then 1.25 else 1 end)
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
    end loop;

    select string_agg(distinct player_name, ', ') into v_names from crews where job_id = p_job;

    delete from crews where job_id = p_job;

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
  else
    update job_state
       set progress = v_st.progress, progress_at = v_now, crew_count = v_n
     where job_id = p_job
     returning * into v_st;
  end if;

  return v_st;
end $$;

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

  select count(*) into v_out from crews where player_id = v_uid and contractor_until is null;
  if v_out >= max_crews_for(v_uid) then raise exception 'all of your crews are already out'; end if;

  if exists (select 1 from crews
              where job_id = p_job and player_id = v_uid and contractor_until is null) then
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
  v_travel := least(75, greatest(8, v_travel));

  insert into crews (job_id, player_id, player_name, arrives_at, rate, facility_id, route)
  values (p_job, v_uid, v_p.name, now() + make_interval(secs => v_travel),
          player_crew_rate(v_uid, v_job.category), v_fac.id, v_route);

  update job_state set crew_count = crew_count + 1 where job_id = p_job returning * into v_st;
  update players set last_seen = now() where id = v_uid;
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
  delete from crews where job_id = p_job and player_id = v_uid and contractor_until is null;
  select count(*) into v_n from crews where job_id = p_job;
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
   where job_id = p_job and player_id = v_uid and contractor_until is null and arrives_at > now();
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
     and (boost_until is null or boost_until <= now());
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

create or replace function heartbeat()
returns void language sql security definer set search_path = public as $$
  update players set last_seen = now() where id = auth.uid();
$$;

-- ============================================================================
-- Scheduled work (pg_cron) — the replacement for the old setInterval timers
-- ============================================================================

create or replace function sweep_jobs()
returns integer
language plpgsql security definer set search_path = public
as $$
declare v_id text; v_n integer := 0;
begin
  for v_id in
    select s.job_id from job_state s where not s.done and s.crew_count > 0 limit 500
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
-- exists at a milepoint WVDOT actually reports.
create or replace function spawn_incident()
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_src   jobs%rowtype;
  v_day   date;
  v_live  integer;
  v_kind  text;
  v_note  text;
  v_i     integer;
  v_k     integer;
  v_seg   jsonb;
  v_id    text;
  v_kinds text[] := array[
    'Rock Slide','Downed Tree','High Water','Crash Debris',
    'Signal Outage','Guardrail Strike','Sinkhole','Slip / Slide'];
  v_notes text[] := array[
    'Rock and debris in the roadway - dispatch to clear.',
    'Tree across both lanes after storm activity.',
    'Water over the roadway; signs and barricades needed.',
    'Secondary cleanup requested by responders.',
    'Dark signal - temporary stop control required.',
    'Damaged guardrail needs emergency repair.',
    'Pavement failure reported; lane closure in place.',
    'Embankment slip encroaching on the travel lane.'];
begin
  select max(report_date) into v_day from game_day;
  if v_day is null then return null; end if;

  select count(*) into v_live
    from jobs j join job_state s on s.job_id = j.id
   where j.incident and not s.done;
  if v_live >= 14 then return null; end if;

  select * into v_src from jobs
   where report_date = v_day and not incident and jsonb_array_length(coords) > 1
   order by random() limit 1;
  if not found then return null; end if;

  v_i := 1 + floor(random() * (jsonb_array_length(v_src.coords) - 1))::int;
  v_seg := jsonb_build_array(v_src.coords->(v_i - 1), v_src.coords->v_i);

  v_k    := 1 + floor(random() * array_length(v_kinds, 1))::int;
  v_kind := v_kinds[v_k];
  v_note := v_notes[v_k];
  v_id   := 'inc-' || replace(gen_random_uuid()::text, '-', '');

  insert into jobs (
    id, report_date, district, county, county_code, category, activity,
    route_type, route_label, route_name, bmp, emp, start_time, end_time, detail,
    miles, approx, incident, expires_at, coords, centroid, effort, xp_award, pay_award)
  values (
    v_id, v_day, v_src.district, v_src.county, v_src.county_code, 'Incident', v_kind,
    v_src.route_type, v_src.route_label, v_src.route_name, v_src.bmp, v_src.emp,
    to_char(now(), 'FMHH12:MI AM'), to_char(now() + interval '10 minutes', 'FMHH12:MI AM'),
    v_note, 0, false, true, now() + interval '10 minutes',
    v_seg, v_src.coords->(v_i - 1), 30, 34, 430);

  insert into job_state (job_id) values (v_id);

  insert into feed (report_date, kind, body)
  values (v_day, 'incident',
          v_kind || ' reported on ' || coalesce(v_src.route_label, '?') ||
          ' in ' || v_src.county || ' County - District ' || v_src.district || '.');

  return v_id;
end $$;

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
-- ingest job when WV511 posts a new reporting date.
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
end $$;

do $$
begin
  perform cron.unschedule(jobname)
    from cron.job
   where jobname in ('roadworks-sweep', 'roadworks-incidents', 'roadworks-prune');
exception when others then null;
end $$;

select cron.schedule('roadworks-sweep',     '* * * * *',   $$select sweep_jobs(); select expire_incidents();$$);
select cron.schedule('roadworks-incidents', '*/2 * * * *', $$select spawn_incident();$$);
select cron.schedule('roadworks-prune',     '17 4 * * *',  $$select prune_history();$$);

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

alter table job_state replica identity full;
alter table crews     replica identity full;

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
