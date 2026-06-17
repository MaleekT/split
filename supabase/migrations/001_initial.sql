-- ── Split: initial schema ──────────────────────────────────────────────────
-- Run this once in your Supabase project:
--   Dashboard → SQL Editor → paste and execute
-- or:
--   supabase db push

-- ── Profiles ──────────────────────────────────────────────────────────────

create table profiles (
  address    text        primary key,       -- checksummed EVM address
  handle     text        unique,
  avatar_url text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create unique index profiles_handle_lower_idx on profiles (lower(handle));

-- ── Activity feed ──────────────────────────────────────────────────────────
-- Off-chain index of on-chain events. Canonical state is always the contract.
--
-- No FK from user_address → profiles.address intentionally: activity rows
-- are created for any address that interacts with the contract, including
-- addresses that have never set up a profile. Enforcing the FK would require
-- inserting a profile row for every new user, coupling two unrelated concerns.

create table activity (
  id             uuid        default gen_random_uuid() primary key,
  user_address   text        not null,
  event_type     text        not null,
  tx_hash        text        not null,
  log_index      integer     not null,
  bucket_id      bigint,
  bucket_name    text,
  amount_raw     bigint      not null,   -- 6-decimal USDC units
  sender_address text,
  -- destination is nullable: 'deposit' events have none; 'split' events with
  -- a hold bucket (address(0)) store null here; all other types have a value.
  destination    text,
  block_number   bigint      not null,
  created_at     timestamptz default now(),
  constraint activity_tx_log_uniq  unique (tx_hash, log_index),
  constraint activity_event_type_check check (
    event_type in ('deposit', 'split', 'withdraw', 'scheduled_send')
  )
);
create index activity_user_idx        on activity (user_address, created_at desc);
create index activity_sender_idx      on activity (sender_address)
  where sender_address is not null;
create index activity_destination_idx on activity (destination)
  where destination is not null;

-- ── Scheduled send index ───────────────────────────────────────────────────
-- Same FK rationale as activity: user_address is any contract participant,
-- not limited to users with profiles.

create table scheduled_sends_index (
  user_address     text        not null,
  bucket_id        bigint      not null,
  amount_raw       bigint      not null,   -- 6-decimal USDC units
  interval_seconds bigint      not null,
  next_send_at     timestamptz not null,
  destination      text        not null,
  active           boolean     default true,
  primary key (user_address, bucket_id)
);
create index sched_due_idx on scheduled_sends_index (next_send_at)
  where active = true;

-- ── Indexer cursor ────────────────────────────────────────────────────────

create table indexer_state (
  key        text   primary key,
  last_block bigint not null default 0
);
insert into indexer_state (key, last_block) values ('split', 0);

-- ── Row Level Security ────────────────────────────────────────────────────
-- All writes go through server routes using SUPABASE_SERVICE_ROLE_KEY,
-- which bypasses RLS automatically.

alter table profiles              enable row level security;
alter table activity              enable row level security;
alter table scheduled_sends_index enable row level security;
alter table indexer_state         enable row level security;

-- Profiles and activity are public blockchain data — readable by anyone.
create policy "profiles_public_read" on profiles for select using (true);
create policy "activity_public_read" on activity  for select using (true);

-- Deny all non-service-role access to internal tables explicitly.
-- (RLS with no policies already denies by default, but explicit restrictive
-- policies make the intent unambiguous and survive Supabase policy UI edits.)
create policy "sched_deny_public"   on scheduled_sends_index as restrictive using (false);
create policy "indexer_deny_public" on indexer_state          as restrictive using (false);

-- ── RPC helpers ──────────────────────────────────────────────────────────
-- Called by the indexer cron to cancel multiple scheduled sends in one
-- round-trip without string-concatenated filter expressions.

create function bulk_cancel_scheduled_sends(p_pairs jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  update scheduled_sends_index
  set    active = false
  where  (user_address, bucket_id) in (
    select elem->>'user_address', (elem->>'bucket_id')::bigint
    from   jsonb_array_elements(p_pairs) as elem
  )
$$;

-- Restrict to service_role only (SECURITY DEFINER bypasses RLS; limit callers explicitly).
revoke execute on function bulk_cancel_scheduled_sends(jsonb) from public;
grant  execute on function bulk_cancel_scheduled_sends(jsonb) to   service_role;

-- ── Notes ─────────────────────────────────────────────────────────────────
-- Activity retention: Arc Testnet only; 500 MB free tier is ample for the
-- expected volume. Add a scheduled DELETE job for rows older than N days
-- before any mainnet deployment.
