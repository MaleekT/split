-- -- Split: opaque private pay-link token (Phase 5) -------------------------
-- The private pay link used to be /pay/{handle}/private, which told every payer
-- that the recipient uses private payments. The link now carries an opaque token
-- instead, so it is shaped exactly like a normal pay link: /pay/{token}.
-- Run once:  Dashboard -> SQL Editor -> paste and execute  (or `supabase db push`)

alter table stealth_meta
  add column if not exists link_token text;

-- Tokens are exactly 24 lowercase hex chars. HANDLE_RE caps handles at 20 chars
-- (/^[a-z0-9][a-z0-9_-]{1,18}[a-z0-9]$/), so a token can NEVER be registered as
-- a handle. That makes link-squatting structurally impossible rather than
-- something a runtime check has to remember to prevent.
alter table stealth_meta
  drop constraint if exists stealth_meta_link_token_shape;
alter table stealth_meta
  add constraint stealth_meta_link_token_shape
  check (link_token is null or link_token ~ '^[0-9a-f]{24}$');

create unique index if not exists stealth_meta_link_token_idx
  on stealth_meta (link_token) where link_token is not null;

-- Backfill anyone who already enabled private payments, so their link works
-- immediately without having to re-register.
--
-- gen_random_uuid() is used rather than pgcrypto's gen_random_bytes() because it
-- is built into PG13+ (no extension to enable, so this migration cannot fail on
-- a project without pgcrypto) and is backed by pg_strong_random(), a CSPRNG.
-- Fixed version/variant nibbles leave ~90 bits of entropy in these 24 chars,
-- far beyond what an unguessable URL needs. This is a one-time backfill only:
-- every token minted afterwards comes from crypto.randomBytes in lib/stealth-link.
update stealth_meta
set link_token = substr(replace(gen_random_uuid()::text, '-', ''), 1, 24)
where link_token is null;
