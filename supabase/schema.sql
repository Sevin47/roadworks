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
  level       integer     not null default 1,
  day_xp      integer     not null default 0,
  day_date    date,
  created_at  timestamptz not null default now(),
  last_seen   timestamptz not null default now()
);

create index if not exists players_day_idx on players (day_date, day_xp desc);

-- One row per crew currently assigned. `arrives_at` is when it stops driving
-- and starts producing work.
create table if not exists crews (
  id             uuid        primary key default gen_random_uuid(),
  job_id         text        not null references jobs(id) on delete cascade,
  player_id      uuid        not null references players(id) on delete cascade,
  player_name    text        not null,
  dispatched_at  timestamptz not null default now(),
  arrives_at     timestamptz not null,
  unique (job_id, player_id)
);

create index if not exists crews_job_idx    on crews (job_id, arrives_at);
create index if not exists crews_player_idx on crews (player_id);

-- Work units each player has banked on each job, used to split the payout.
create table if not exists contributions (
  job_id     text    not null references jobs(id) on delete cascade,
  player_id  uuid    not null references players(id) on delete cascade,
  units      numeric not null default 0,
  primary key (job_id, player_id)
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

-- ============================================================================
-- Row level security
--
-- Everything is readable by a signed-in player (anonymous sign-in counts).
-- Nothing is directly writable: every mutation below is a security-definer
-- function that recomputes the outcome from server state, so a patched client
-- can lie to its own screen and nothing else.
-- ============================================================================

alter table game_day      enable row level security;
alter table wv_counties   enable row level security;
alter table jobs          enable row level security;
alter table job_state     enable row level security;
alter table players       enable row level security;
alter table crews         enable row level security;
alter table contributions enable row level security;
alter table feed          enable row level security;
alter table day_scores    enable row level security;

do $$
declare t text;
begin
  foreach t in array array['game_day','wv_counties','jobs','job_state','players','crews','contributions','feed','day_scores']
  loop
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format('create policy %I on %I for select to authenticated using (true)', t || '_read', t);
  end loop;
end $$;

-- ============================================================================
-- Game math
-- ============================================================================

-- Crowd bonus: one crew does 1 unit/sec, and each extra crew on the same job
-- makes *every* crew there faster, up to 3x. This is the whole point of the
-- game — piling on is strictly better than spreading out.
create or replace function crew_multiplier(n integer)
returns numeric language sql immutable as $$
  select case when n <= 0 then 0 else least(3.0, 1 + 0.12 * (n - 1)) end;
$$;

-- Clients animate progress locally between Realtime events, so they need to
-- know how far their own clock is from Postgres's.
create or replace function server_now()
returns timestamptz language sql stable as $$ select now(); $$;

create or replace function level_for(p_xp integer)
returns integer language sql immutable as $$
  select greatest(1, floor(sqrt(greatest(p_xp, 0) / 40.0))::int + 1);
$$;

create or replace function max_crews_for(p_level integer)
returns integer language sql immutable as $$
  select least(12, 3 + (p_level / 2));
$$;

-- ----------------------------------------------------------------------------
-- settle_job: the replacement for the old server tick.
--
-- Between crew arrivals the crowd rate is constant, so progress over any such
-- span is exactly rate * elapsed. This walks the arrival events since the last
-- checkpoint, banks the work for each constant-rate span, and stops early at
-- the precise instant the job hits its effort target. Idempotent and safe for
-- anyone to call — it reads clocks and rows, never client input.
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
  v_mult    numeric;
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
      union all
      select v_now
    ) e
    order by t
  loop
    -- Crews already on site at the start of this span set its rate.
    select count(*) into v_n from crews where job_id = p_job and arrives_at <= v_cursor;
    v_dt := extract(epoch from (v_ev.t - v_cursor));

    if v_n > 0 and v_dt > 0 then
      v_mult := crew_multiplier(v_n);
      v_gain := v_n * v_mult * v_dt;
      v_need := v_job.effort - v_st.progress;

      if v_gain >= v_need then          -- finishes partway through this span
        v_dt   := v_need / (v_n * v_mult);
        v_gain := v_need;
      end if;

      insert into contributions (job_id, player_id, units)
        select p_job, c.player_id, v_mult * v_dt
          from crews c
         where c.job_id = p_job and c.arrives_at <= v_cursor
      on conflict (job_id, player_id)
        do update set units = contributions.units + excluded.units;

      v_st.progress := v_st.progress + v_gain;
      v_cursor := v_cursor + make_interval(secs => v_dt);

      exit when v_st.progress >= v_job.effort;
    else
      v_cursor := v_ev.t;
    end if;
  end loop;

  select count(*) into v_n from crews where job_id = p_job and arrives_at <= v_now;

  if v_st.progress >= v_job.effort then
    -- ------------------------------------------------------------- payout
    select coalesce(sum(units), 0) into v_total from contributions where job_id = p_job;
    if v_total <= 0 then v_total := 1; end if;

    for v_c in select * from contributions where job_id = p_job loop
      v_frac := v_c.units / v_total;
      v_xp := greatest(1, round(v_job.xp_award * (0.6 + 0.4 * v_frac)
                                * (case when v_job.incident then 1.4 else 1 end))::int);
      v_pay := round(v_job.pay_award * v_frac)::int;
      update players
         set xp        = xp + v_xp,
             day_xp    = case when day_date = v_job.report_date then day_xp + v_xp else v_xp end,
             day_date  = v_job.report_date,
             funds     = funds + v_pay,
             jobs_done = jobs_done + 1,
             level     = level_for(xp + v_xp)
       where id = v_c.player_id;
    end loop;

    select string_agg(distinct player_name, ', ') into v_names from crews where job_id = p_job;

    delete from crews where job_id = p_job;

    update job_state
       set progress = v_job.effort, progress_at = v_cursor,
           crew_count = 0, done = true, done_at = v_cursor
     where job_id = p_job
     returning * into v_st;

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
        county = excluded.county,
        county_code = excluded.county_code,
        district = excluded.district,
        home = excluded.home,
        last_seen = now()
  returning * into v_row;

  return v_row;
end $$;

create or replace function dispatch_crew(p_job text)
returns job_state
language plpgsql security definer set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_p      players%rowtype;
  v_job    jobs%rowtype;
  v_st     job_state%rowtype;
  v_out    integer;
  v_miles  numeric;
  v_travel numeric;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select * into v_p from players where id = v_uid;
  if not found then raise exception 'no manager profile yet'; end if;

  select * into v_job from jobs where id = p_job;
  if not found then raise exception 'that work order is gone'; end if;

  -- Bank work done under the old crew count before the rate changes.
  v_st := settle_job(p_job);
  if v_st.done then raise exception 'that work order is already closed'; end if;

  select count(*) into v_out from crews where player_id = v_uid;
  if v_out >= max_crews_for(v_p.level) then raise exception 'all of your crews are already out'; end if;

  if exists (select 1 from crews where job_id = p_job and player_id = v_uid) then
    raise exception 'you already have a crew on that one';
  end if;

  -- Rough great-circle miles from the manager's county seat, in degrees.
  v_miles := 0;
  if v_p.home is not null and v_job.centroid is not null then
    v_miles := 69.0 * sqrt(
      power((v_job.centroid->>1)::numeric - (v_p.home->>1)::numeric, 2) +
      power(((v_job.centroid->>0)::numeric - (v_p.home->>0)::numeric) * 0.78, 2));
  end if;
  v_travel := least(30, greatest(6, 6 + v_miles * 0.28));

  insert into crews (job_id, player_id, player_name, arrives_at)
  values (p_job, v_uid, v_p.name, now() + make_interval(secs => v_travel));

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
  delete from crews where job_id = p_job and player_id = v_uid;
  select count(*) into v_n from crews where job_id = p_job;
  update job_state set crew_count = v_n where job_id = p_job returning * into v_st;
  return v_st;
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

-- Backstop for completion: clients settle a job the moment their own clock says
-- it is due, so this only matters when nobody is watching.
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
    to_char(now(), 'FMHH12:MI AM'), to_char(now() + interval '8 minutes', 'FMHH12:MI AM'),
    v_note, 0, false, true, now() + interval '8 minutes',
    v_seg, v_src.coords->(v_i - 1), 60, 34, 430);

  insert into job_state (job_id) values (v_id);

  insert into feed (report_date, kind, body)
  values (v_day, 'incident',
          v_kind || ' reported on ' || coalesce(v_src.route_label, '?') ||
          ' in ' || v_src.county || ' County - District ' || v_src.district || '.');

  return v_id;
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

-- Keep the feed and old boards from growing without bound.
create or replace function prune_history()
returns void
language plpgsql security definer set search_path = public
as $$
begin
  delete from feed where created_at < now() - interval '2 days';
  delete from game_day where report_date < (select max(report_date) - 1 from game_day);
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
-- RLS already governs what postgres_changes will deliver.
-- ============================================================================
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'job_state') then
      alter publication supabase_realtime add table job_state;
    end if;
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'feed') then
      alter publication supabase_realtime add table feed;
    end if;
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'crews') then
      alter publication supabase_realtime add table crews;
    end if;
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'jobs') then
      alter publication supabase_realtime add table jobs;
    end if;
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
