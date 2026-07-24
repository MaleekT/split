-- ── Split: stealth-address privacy schema (Phase 3) ────────────────────────
-- New tables only. Inserts one indexer cursor row; alters nothing existing.
-- Run once:  Dashboard → SQL Editor → paste and execute  (or `supabase db push`)

-- ── Stealth meta-addresses ──────────────────────────────────────────────────
-- Maps a user's main address to their published ERC-5564 stealth meta-address,
-- for fast pay-page lookup. The same value is also published on-chain in the
-- ERC-6538 Registry; this table is the off-chain read path (like profiles).
-- Meta-addresses are public by design (payers must read them to pay privately).

create table stealth_meta (
  address       text        primary key,          -- checksummed main address
  meta_address  text        not null,             -- 0x-hex ERC-5564 meta-address
  scheme_id     integer     not null default 1,
  registered_at timestamptz default now(),
  updated_at    timestamptz default now()
);

-- ── Announcements ────────────────────────────────────────────────────────────
-- Off-chain index of ERC-5564 Announcement events, fed by the stealth-index
-- cron. Public chain data; the recipient's client downloads these and filters
-- LOCALLY with their viewing key + the view tag — the server never learns which
-- announcements belong to whom (Bottleneck 6, Solution A).

create table announcements (
  id               uuid        default gen_random_uuid() primary key,
  scheme_id        bigint      not null,
  stealth_address  text        not null,
  caller           text        not null,          -- the gateway/announcer caller
  ephemeral_pub_key text       not null,          -- hex
  metadata         text        not null,          -- hex; byte 0 is the view tag
  block_number     bigint      not null,
  tx_hash          text        not null,
  log_index        integer     not null,
  created_at       timestamptz default now(),
  constraint announcements_tx_log_uniq unique (tx_hash, log_index)
);
-- Ordered scan/pagination for the client, newest first.
create index announcements_block_idx on announcements (block_number desc, log_index desc);
create index announcements_created_idx on announcements (created_at desc);

-- ── Indexer cursor ──────────────────────────────────────────────────────────
insert into indexer_state (key, last_block) values ('stealth', 0)
  on conflict (key) do nothing;

-- ── Row Level Security ──────────────────────────────────────────────────────
-- Both tables are public chain data (readable by anyone). Writes go through
-- server routes using SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS: meta-address
-- registration is signature-authed, announcements are written only by the cron.

alter table stealth_meta   enable row level security;
alter table announcements  enable row level security;

create policy "stealth_meta_public_read"  on stealth_meta  for select using (true);
create policy "announcements_public_read"  on announcements for select using (true);
