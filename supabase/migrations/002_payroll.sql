-- ── Split: payroll schema (Phase 2) ────────────────────────────────────────
-- New tables only. Does NOT alter any existing table (profiles, activity,
-- scheduled_sends_index, indexer_state) beyond inserting one cursor row.
-- Run once:
--   Dashboard → SQL Editor → paste and execute   (or `supabase db push`)

-- ── Payrolls: an employer's named roster container ──────────────────────────

create table payrolls (
  id               uuid        default gen_random_uuid() primary key,
  employer_address text        not null,             -- checksummed EVM address
  name             text        not null,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);
create index payrolls_employer_idx on payrolls (employer_address, created_at desc);

-- ── Payees: roster entries with PINNED addresses ────────────────────────────
-- pinned_address is the destination resolved at the moment the payee was added
-- or last re-confirmed. Every run re-resolves the handle and hard-blocks on a
-- mismatch (Bottleneck 8) — the roster never trusts a live handle lookup blindly.

create table payees (
  id            uuid        default gen_random_uuid() primary key,
  payroll_id    uuid        not null references payrolls (id) on delete cascade,
  label         text        not null,
  handle        text,                               -- null when added by raw address
  pinned_address text       not null,               -- checksummed; the trusted destination
  amount_raw    bigint      not null check (amount_raw > 0),  -- 6-decimal USDC units
  is_split_user boolean     not null default false, -- cached pre-validation result
  active        boolean     not null default true,  -- paused/disabled payees are skipped in runs
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);
create index payees_payroll_idx on payees (payroll_id);

-- ── Payroll runs: the run-record / resume model ─────────────────────────────
-- A logical run (one "pay everyone" action) that may execute as several chunked
-- on-chain transactions. base_run_id is a per-run numeric base; each chunk's
-- on-chain runId (echoed in the PayrollRun event) is derived from it. Rows are
-- written BEFORE execution so a mid-run crash is recoverable, never a double-pay.

create table payroll_runs (
  id               uuid        default gen_random_uuid() primary key,
  payroll_id       uuid        references payrolls (id) on delete set null,
  employer_address text        not null,
  base_run_id      text        not null,            -- numeric string; base for chunk runIds
  status           text        not null default 'draft',
  total_raw        bigint      not null,            -- 6-decimal USDC units
  payee_count      integer     not null,
  chunk_count      integer     not null,
  chunks_confirmed integer     not null default 0,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now(),
  constraint payroll_runs_base_uniq unique (employer_address, base_run_id),
  constraint payroll_runs_status_check check (
    status in ('draft', 'executing', 'completed', 'partial', 'failed')
  )
);
create index payroll_runs_employer_idx on payroll_runs (employer_address, created_at desc);

-- At most one in-flight run per payroll, enforced atomically at the DB level so a
-- concurrent double-submission cannot create two executing runs (the app also
-- guards this, but the index is the race-proof backstop).
create unique index payroll_runs_one_active_idx on payroll_runs (payroll_id)
  where status = 'executing';

-- ── Payroll run items: per-payee snapshot + reconciled outcome ──────────────
-- item_index is the payee's position within its chunk. The payroll-index cron
-- matches on-chain PayrollPayment events to items by (chunk_run_id, item_index)
-- because events are emitted in payee-array order, so the k-th PayrollPayment in
-- a chunk tx is item_index = k. outcome: 0 split / 1 fallback / 2 plain, null
-- until the indexer reconciles it from chain.

create table payroll_run_items (
  id            uuid        default gen_random_uuid() primary key,
  run_ref       uuid        not null references payroll_runs (id) on delete cascade,
  chunk_index   integer     not null,
  item_index    integer     not null,
  chunk_run_id  text        not null,               -- on-chain runId for this chunk
  payee_dest    text        not null,               -- resolved destination at execution time
  label         text,
  amount_raw    bigint      not null,               -- 6-decimal USDC units
  is_split_user boolean     not null,
  memo_hash     text        not null,               -- bytes32 hex, echoed in the event
  outcome       smallint,                           -- 0 split / 1 fallback / 2 plain; null = pending
  tx_hash       text,                               -- chunk tx, set on send and confirmed by indexer
  created_at    timestamptz default now(),
  constraint payroll_run_items_uniq unique (run_ref, chunk_index, item_index)
);
create index payroll_run_items_run_idx   on payroll_run_items (run_ref);
create index payroll_run_items_chunk_idx on payroll_run_items (chunk_run_id);

-- ── Indexer cursor for the payroll-index cron ───────────────────────────────
-- Additive: a second cursor row in the existing indexer_state table (never
-- alters its shape). The cron advances it from the SplitPayroll deploy block.

insert into indexer_state (key, last_block) values ('payroll', 0)
  on conflict (key) do nothing;

-- ── Row Level Security ──────────────────────────────────────────────────────
-- Payroll data is private employer data (not public chain state like profiles).
-- Deny all public access; every read and write goes through signature-authed
-- server routes using SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS.

alter table payrolls          enable row level security;
alter table payees            enable row level security;
alter table payroll_runs      enable row level security;
alter table payroll_run_items enable row level security;

create policy "payrolls_deny_public"      on payrolls          as restrictive using (false);
create policy "payees_deny_public"        on payees            as restrictive using (false);
create policy "payroll_runs_deny_public"  on payroll_runs      as restrictive using (false);
create policy "payroll_items_deny_public" on payroll_run_items as restrictive using (false);

-- ── Post-deploy seed (run manually AFTER SplitPayroll is deployed) ──────────
-- Registers the payroll contract address under the reserved handle "payroll" so a
-- recipient's existing on-chain activity feed shows the sender as "@payroll"
-- instead of a raw contract address (the feed resolves sender handles from the
-- profiles table). Pure data; touches no code and no existing route.
-- NOTE: use the SplitPayrollV2 address (the contract that actually sends payroll
-- payments after Phase 4), not the V1 SplitPayroll. Replace the placeholder with
-- the checksummed deployed V2 address:
--
--   insert into profiles (address, handle)
--   values ('0xYOUR_SPLITPAYROLLV2_ADDRESS', 'payroll')
--   on conflict (address) do update set handle = excluded.handle;
