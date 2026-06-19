-- Run this once in your AdBrain Supabase project SQL editor.
-- Matches columns POSTed by modules/discovery-export.js -> pushToAdBrain().
-- One row per KP keyword per product:
--   image_count = perceptual-hash match count of product image on Google SERP
--   matched_thumbnails = pipe-joined URLs of the matched SERP thumbnails
--   autosuggest_count = number of Google autocomplete suggestions returned
--   autosuggestions = pipe-joined suggestion strings

create table if not exists public.adbrain_discovered_keywords (
  id                    bigserial primary key,
  batch_id              text        not null,
  sku                   text,                       -- product SKU from input CSV
  keyword               text        not null,
  source                text        not null default 'kp_idea',
  parent_keyword        text,                       -- for autosuggest rows: the KP keyword that spawned them
  product_name          text,
  product_url           text,
  product_image         text,
  priority              int,
  image_count           int         default 0,     -- VERIFIED match count (URL/dHash hits + CLIP hits with brand context)
  image_count_unverified int        default 0,     -- CLIP hits without brand context (visually-similar competitor lookalikes)
  match_confidence_avg  int         default 0,     -- 0-100, avg across matched thumbs
  match_confidence_max  int         default 0,     -- 0-100, best single match
  match_confidence_min  int         default 0,     -- 0-100, worst kept match
  top_match_thumbnail   text,                       -- URL of highest-confidence thumbnail
  top_match_seller      text,                       -- merchant/domain of the top match (e.g. "amazon.com")
  top_match_price       text,                       -- price of the top match (e.g. "$24.99", "₹450")
  matched_thumbnails    text,                       -- "url [conf] | url [conf] | ..." sorted desc
  matched_sellers       text,                       -- pipe-joined merchants in same order as matched_thumbnails
  matched_prices        text,                       -- pipe-joined prices in same order as matched_thumbnails
  -- Categorisation / scoring (from modules/keyword-filter.js)
  ad_rating             int         default 0,     -- 0-100 composite "should I bid?" score
  frequency             int         default 1,     -- times the keyword surfaced across sources
  intent                text,                       -- transactional | navigational | commercial | informational
  topic                 text,                       -- price | review | comparison | how-to | ingredient | availability | concern | general
  funnel                text,                       -- bottom | mid | top
  -- Per-keyword SERP-wide signal (separate from matched_*; counts every shopping/organic seller, not just those on matched thumbnails)
  total_sellers         int         default 0,
  seller_type           text,                       -- 'product_sellers' (image_count>0) | 'competitor_sellers' (image_count=0)
  ads_on_serp           int         default 0,
  sellers_on_serp       text,                       -- "domain (price) | domain (price) | ..."
  -- KP-derived per-keyword metrics. Empty for autosuggest / PAA rows.
  kp_monthly_searches   text,                       -- e.g. "100 – 1K"
  kp_competition        text,                       -- "Low" | "Medium" | "High"
  kp_bid_low            text,                       -- "₹5.50"
  kp_bid_high           text,                       -- "₹50.00"
  autosuggest_count     int         default 0,
  autosuggestions       text,                       -- pipe-joined suggestions
  created_at            timestamptz default now(),
  unique (batch_id, keyword)
);

-- Idempotent column adds for existing installations.
alter table public.adbrain_discovered_keywords add column if not exists ad_rating       int  default 0;
alter table public.adbrain_discovered_keywords add column if not exists frequency       int  default 1;
alter table public.adbrain_discovered_keywords add column if not exists intent          text;
alter table public.adbrain_discovered_keywords add column if not exists topic           text;
alter table public.adbrain_discovered_keywords add column if not exists funnel          text;
alter table public.adbrain_discovered_keywords add column if not exists total_sellers   int  default 0;
alter table public.adbrain_discovered_keywords add column if not exists ads_on_serp     int  default 0;
alter table public.adbrain_discovered_keywords add column if not exists sellers_on_serp text;
-- seller_titles: per-seller product-card title, pipe-joined.
-- Example: "amazon.in: Now Foods Alfalfa 10 Grain, 650 mg | iherb.com: Alfalfa, 650 mg, 250 Tablets"
-- Useful for ad-copy research — see how each merchant names our product.
alter table public.adbrain_discovered_keywords add column if not exists seller_titles  text;
-- seller_type: 'product_sellers' when image_count>0 on this keyword's SERP
-- (these sellers carry our product) vs 'competitor_sellers' (sellers carry
-- something else for this query).
alter table public.adbrain_discovered_keywords add column if not exists seller_type     text;
-- image_count_unverified: CLIP thumbnails that scored above the threshold
-- but had no brand mention in surrounding SERP text (visually-similar
-- competitor product). Diagnostic / audit only — NOT counted as a real match.
alter table public.adbrain_discovered_keywords add column if not exists image_count_unverified int default 0;
-- amazon_suggest_count: number of Amazon.in autosuggestions surfaced for
-- this keyword during the Amazon Round (R3). Only set on parent keywords
-- (the top-N by adRating that were expanded); leaves from those parents
-- have source='amazon_suggest' and parent_keyword pointing back.
alter table public.adbrain_discovered_keywords add column if not exists amazon_suggest_count int default 0;
-- Per-parent Amazon marketplace data (from scraping amazon.in/s?k=...):
--   amazon_rank: 1-N position our product appears at (0 = not in top 20)
--   amazon_price: price Amazon shows for our product
--   amazon_rating: star rating (e.g. "4.6")
--   amazon_reviews: review count
--   amazon_title: how Amazon names our product (often differs from our title)
--   amazon_competitors: top 5 other products on the same SERP
--   amazon_total_results: total listings on the Amazon SERP
alter table public.adbrain_discovered_keywords add column if not exists amazon_rank          int  default 0;
alter table public.adbrain_discovered_keywords add column if not exists amazon_price         text;
alter table public.adbrain_discovered_keywords add column if not exists amazon_rating        text;
alter table public.adbrain_discovered_keywords add column if not exists amazon_reviews       text;
alter table public.adbrain_discovered_keywords add column if not exists amazon_title         text;
alter table public.adbrain_discovered_keywords add column if not exists amazon_competitors   text;
alter table public.adbrain_discovered_keywords add column if not exists amazon_total_results int  default 0;
-- Per-keyword audit aids:
--   serp_url        clickable Google search URL we used (with &gl=in&hl=en&pws=0)
--   match_sources   per-zone breakdown of matched thumbnails
--                   ("knowledge_panel:5 | organic:3 | shopping_carousel:2")
--   thumbs_captured "12 found, 8 matched, 2 unverified" — what the scraper saw
alter table public.adbrain_discovered_keywords add column if not exists serp_url        text;
alter table public.adbrain_discovered_keywords add column if not exists match_sources   text;
alter table public.adbrain_discovered_keywords add column if not exists thumbs_captured text;
-- Visibility scoring (new ad_rating formula):
--   total_thumbs   total product images captured on the keyword's SERP
--                  (denominator for visibility_pct)
--   visibility_pct image_count / total_thumbs × 100 (0-100)
alter table public.adbrain_discovered_keywords add column if not exists total_thumbs   int default 0;
alter table public.adbrain_discovered_keywords add column if not exists visibility_pct int default 0;

create index if not exists adbrain_discovered_keywords_sku_idx
  on public.adbrain_discovered_keywords (sku);

create index if not exists adbrain_discovered_keywords_batch_idx
  on public.adbrain_discovered_keywords (batch_id);
create index if not exists adbrain_discovered_keywords_keyword_idx
  on public.adbrain_discovered_keywords (keyword);

-- Sorting / filtering helpers for the UI ("show me top-rated bottom-funnel keywords").
create index if not exists adbrain_discovered_keywords_ad_rating_idx
  on public.adbrain_discovered_keywords (ad_rating desc);
create index if not exists adbrain_discovered_keywords_funnel_idx
  on public.adbrain_discovered_keywords (funnel);

-- ============================================================================
-- DISTRIBUTED WORK QUEUE (multi-PC mode)
-- ============================================================================
-- Workflow:
--   1. ONE PC (the "manager") uploads sample-products.xlsx via the Manager
--      tab in the popup → bulk-insert into adbrain_discovery_jobs (status='pending').
--   2. Each worker PC sets a Worker ID in Settings (e.g. "PC-A") and clicks
--      "Claim from queue" on the Run tab. The extension calls the
--      adbrain_claim_jobs RPC which atomically locks N pending rows for
--      this worker (status='claimed') and returns them as products to the
--      engine.
--   3. The engine runs as normal; when each product completes, the extension
--      PATCHes the matching adbrain_discovery_jobs row to status='done'.
--   4. Every 60s while running, each worker PATCHes heartbeat_at=now() on
--      its claimed rows. If a PC crashes, no heartbeat for >10min →
--      adbrain_release_stale_jobs() releases the claim so another PC picks
--      it up.
-- The keyword results land in adbrain_discovered_keywords (existing table) —
-- this jobs table only coordinates work distribution.

create table if not exists public.adbrain_discovery_jobs (
  id              bigserial primary key,
  batch_id        text        not null,   -- groups a single upload session
  sku             text,
  product_url     text        not null,   -- canonical Shopify product URL
  product_name    text,
  priority        int         default 100,
  handles         text,                    -- pipe-joined extra KP seeds
  brands          text,                    -- pipe-joined brand aliases
  status          text        not null default 'pending',
                                          -- 'pending' | 'claimed' | 'done' | 'failed'
  claimed_by      text,                    -- worker_id of the claiming PC
  claimed_at      timestamptz,
  heartbeat_at    timestamptz,             -- updated every 60s by the worker
  done_at         timestamptz,
  failed_reason   text,
  attempts        int         default 0,
  created_at      timestamptz default now(),
  unique (batch_id, product_url)
);

create index if not exists adbrain_discovery_jobs_status_idx
  on public.adbrain_discovery_jobs (status, priority desc, id asc);
create index if not exists adbrain_discovery_jobs_batch_idx
  on public.adbrain_discovery_jobs (batch_id);
create index if not exists adbrain_discovery_jobs_claimed_idx
  on public.adbrain_discovery_jobs (claimed_by, heartbeat_at);

-- Atomic claim: locks up to p_limit pending rows for p_worker_id within a
-- batch. FOR UPDATE SKIP LOCKED is the Postgres feature that makes
-- concurrent claims from different PCs race-safe — each PC gets a
-- different set of rows, no double-processing possible.
create or replace function public.adbrain_claim_jobs(
  p_worker_id text,
  p_batch_id  text,
  p_limit     int  default 5
) returns setof public.adbrain_discovery_jobs
language sql as $$
  update public.adbrain_discovery_jobs
     set status      = 'claimed',
         claimed_by  = p_worker_id,
         claimed_at  = now(),
         heartbeat_at= now(),
         attempts    = attempts + 1
   where id in (
     select id from public.adbrain_discovery_jobs
      where status   = 'pending'
        and batch_id = p_batch_id
      order by priority desc, id asc
      limit p_limit
      for update skip locked
   )
  returning *;
$$;

-- Auto-release: any claim with heartbeat_at older than p_stale_minutes
-- (default 10) goes back to pending so another PC can pick it up. Called
-- by every worker on each claim cycle — distributed cleanup without a
-- central scheduler.
create or replace function public.adbrain_release_stale_jobs(
  p_stale_minutes int default 10
) returns int
language sql as $$
  with released as (
    update public.adbrain_discovery_jobs
       set status='pending', claimed_by=null,
           claimed_at=null, heartbeat_at=null
     where status='claimed'
       and (heartbeat_at is null or heartbeat_at < now() - (p_stale_minutes || ' minutes')::interval)
    returning id
  )
  select count(*)::int from released;
$$;

-- View for the Manager tab's live status — one row per batch with counts.
create or replace view public.adbrain_discovery_job_summary as
select
  batch_id,
  count(*)                                                     as total,
  count(*) filter (where status='pending')                     as pending,
  count(*) filter (where status='claimed')                     as claimed,
  count(*) filter (where status='done')                        as done,
  count(*) filter (where status='failed')                      as failed,
  count(distinct claimed_by) filter (where status='claimed')   as active_workers,
  max(done_at)                                                  as last_done_at
from public.adbrain_discovery_jobs
group by batch_id
order by batch_id desc;

-- ============================================================================
-- OPERATIONS DASHBOARD (Option C) — activity log + command bus + stats
-- ============================================================================
-- Activity log: each worker pushes recent engine events (per-product progress,
-- KP failures, CAPTCHA hits, match counts, etc.) to this table. The manager
-- dashboard polls it every 5s to render a unified live activity feed across
-- every worker PC, with filters by worker/level/source.
create table if not exists public.adbrain_activity_log (
  id            bigserial primary key,
  batch_id      text,                       -- which batch this event belongs to
  worker_id     text,                       -- which PC emitted it
  level         text default 'info',        -- 'info' | 'ok' | 'warn' | 'err'
  source        text,                       -- 'engine' | 'kp' | 'r1' | 'r2' | 'rs' | 'serp' | 'amazon' | ...
  message       text not null,              -- human-readable line
  product_url   text,                       -- optional: which product the event is about
  sku           text,                       -- optional: SKU for fast filtering
  ts            timestamptz default now()
);
create index if not exists adbrain_activity_log_batch_ts_idx
  on public.adbrain_activity_log (batch_id, ts desc);
create index if not exists adbrain_activity_log_worker_ts_idx
  on public.adbrain_activity_log (worker_id, ts desc);
-- Retention: keep last 7 days. The manager dashboard never asks for older.
-- Run this periodically (Supabase cron) or manually:
--   delete from public.adbrain_activity_log where ts < now() - interval '7 days';

-- Worker commands: manager pushes "stop", "pause", "set_pacing" etc. here.
-- Each worker polls every 30s for unacknowledged commands matching its
-- worker_id (or worker_id=null for broadcast). The worker honors the command,
-- then marks it acknowledged so it doesn't fire again.
create table if not exists public.adbrain_worker_commands (
  id              bigserial primary key,
  worker_id       text,                     -- null = broadcast to all workers
  command         text not null,            -- 'stop' | 'pause' | 'resume' | 'set_pacing' | 'set_continuous' | 'release_claims'
  payload         jsonb,                    -- command-specific args
  created_at      timestamptz default now(),
  created_by      text,                     -- manager PC id (optional)
  acknowledged_at timestamptz,
  acknowledged_by text                      -- which worker_id acknowledged
);
create index if not exists adbrain_worker_commands_pending_idx
  on public.adbrain_worker_commands (worker_id, acknowledged_at)
  where acknowledged_at is null;

-- Per-worker stats view — aggregates throughput, success/fail counts, and
-- the worker's last heartbeat. Powers the per-worker grid on the dashboard.
create or replace view public.adbrain_worker_stats as
select
  claimed_by                                                     as worker_id,
  batch_id,
  count(*)                                                       as total_touched,
  count(*) filter (where status='done')                          as done_count,
  count(*) filter (where status='failed')                        as failed_count,
  count(*) filter (where status='claimed')                       as in_flight,
  max(heartbeat_at)                                              as last_heartbeat,
  -- Average seconds per completed product (claimed_at → done_at).
  avg(extract(epoch from (done_at - claimed_at)))
    filter (where status='done' and claimed_at is not null and done_at is not null)
                                                                 as avg_secs_per_product
from public.adbrain_discovery_jobs
where claimed_by is not null
group by claimed_by, batch_id;

-- Per-product status view — flat lookup the dashboard uses for the
-- "which worker is on which SKU right now" grid.
create or replace view public.adbrain_per_product_status as
select
  id, batch_id, sku, product_url, product_name,
  status, claimed_by, claimed_at, heartbeat_at, done_at,
  failed_reason, attempts
from public.adbrain_discovery_jobs;

-- ============================================================================
-- MANAGER-CONTROLLED WORKER CONFIG (single global row)
-- ============================================================================
-- The manager pushes run options (KP URL, pacing, match profile, caps, etc.)
-- to this table; every worker fetches it before each claim and merges into
-- its local runOpts. Result: workers don't have to be reconfigured manually
-- when the manager changes settings — change once at the manager, every PC
-- picks it up on its next chunk claim.
--
-- Single-row table by design (id=1 always). UPSERT semantics: managers can
-- write partial updates; null columns mean "use the worker's local default."
create table if not exists public.adbrain_worker_config (
  id                          int  primary key default 1,
  kp_url                      text,
  kp_max_per_product          int,
  match_profile               text,          -- 'loose' | 'normal' | 'strict' | 'custom'
  clip_threshold_override     numeric,       -- only used when match_profile='custom'
  max_image_match_rows        int,           -- 0 = unbounded
  search_delay_min_ms         int,
  search_delay_max_ms         int,
  product_delay_min_ms        int,
  product_delay_max_ms        int,
  chunk_size                  int,
  chunk_rest_min_ms           int,
  chunk_rest_max_ms           int,
  cap                         int,           -- global keyword cap
  auto_export                 boolean,
  updated_at                  timestamptz default now(),
  updated_by                  text,
  constraint adbrain_worker_config_single check (id = 1)
);

-- Seed the single row if it doesn't exist so PATCH calls don't fail.
insert into public.adbrain_worker_config (id) values (1)
  on conflict (id) do nothing;

-- Manager-pinned batch override. When set, every armed worker pulls
-- ONLY from this batch instead of "newest pending". Lets the manager
-- redirect the whole fleet from batch X to batch Y without re-uploading
-- or touching each worker. Null = auto-pick newest (default behaviour).
alter table public.adbrain_worker_config add column if not exists active_batch_id text;

-- Refresh the schema cache so all the new endpoints (dashboard tables +
-- worker config) work IMMEDIATELY.
NOTIFY pgrst, 'reload schema';


