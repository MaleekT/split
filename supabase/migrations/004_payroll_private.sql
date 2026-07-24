-- ── Split: private-payroll opt-in (Phase 4) ─────────────────────────────────
-- Adds a per-payee "pay privately" flag. When true AND the payee has a published
-- stealth meta-address, a payroll run pays them via a one-time stealth address
-- (SplitPayrollV2 mode 2) instead of a normal transfer, inside the same batch.
-- Run once:  Dashboard → SQL Editor → paste and execute  (or `supabase db push`)

alter table payees
  add column if not exists pay_private boolean not null default false;

-- Records the on-chain routing mode used for each run item (0 split, 1 plain,
-- 2 private), for the employer's own records and CSV export. For private items,
-- payee_dest stays the real contractor address (the employer's private record);
-- the on-chain event logs only the one-time stealth address.
alter table payroll_run_items
  add column if not exists mode smallint not null default 0;
