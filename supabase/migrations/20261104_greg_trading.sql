-- Greg's pump.fun trading: owner-editable caps (enforced server side in greg-trade), positions, a public trade state.
-- Safe defaults: dry run ON. enabled and kill_switch are NOT touched here (owner only).
alter table public.greg_wallet
  add column if not exists trade_usd numeric not null default 5,
  add column if not exists trade_daily_usd numeric not null default 25,
  add column if not exists trade_max_open int not null default 3,
  add column if not exists trade_slippage_bps int not null default 1500,
  add column if not exists trade_reserve_sol numeric not null default 0.02,
  add column if not exists trade_min_curve_pct numeric not null default 20,
  add column if not exists trade_min_holders int not null default 50,
  add column if not exists trade_max_dev_pct numeric not null default 10,
  add column if not exists trade_max_top10_pct numeric not null default 40,
  add column if not exists trade_tp_pct numeric not null default 100,
  add column if not exists trade_sl_pct numeric not null default 40,
  add column if not exists trade_time_stop_h numeric not null default 24,
  add column if not exists trade_scan_every_min int not null default 60,
  add column if not exists trade_dry_run boolean not null default true;

-- Greg's existing wallet (public address only). Prevents a new wallet from ever being generated.
update public.greg_wallet set address = 'CNAg1pWXsyakdDr2XfVQqDWkdzY9mQpbYBTBxgc1oppf' where id = 1 and address is null;

-- (greg_positions already exists for the paper portfolio, so live/paper trade positions get their own table)
create table if not exists public.greg_trade_positions (
  id bigserial primary key, opened_at timestamptz not null default now(), mint text not null, symbol text, name text, icon text,
  paper boolean not null default false, status text not null default 'open' check (status in ('open','closed')),
  tokens_raw numeric not null, decimals int, cost_usd numeric, cost_sol numeric, entry_price_usd numeric,
  took_profit boolean not null default false, realized_usd numeric not null default 0,
  last_price_usd numeric, last_value_usd numeric, last_checked_at timestamptz, curve_pct numeric, opened_on_curve boolean,
  closed_at timestamptz, close_reason text, reason text);
alter table public.greg_trade_positions enable row level security;
drop policy if exists "public read trade positions" on public.greg_trade_positions;
create policy "public read trade positions" on public.greg_trade_positions for select using (true);

alter table public.greg_trades
  add column if not exists position_id bigint, add column if not exists tokens_raw numeric, add column if not exists mcap_usd numeric,
  add column if not exists curve_pct numeric, add column if not exists sim_ok boolean, add column if not exists note text,
  add column if not exists name text, add column if not exists icon text;

-- What Greg is looking at right now (for the monitors), and when he last scanned.
create table if not exists public.greg_trade_state (id int primary key default 1, watching jsonb, candidates jsonb, last_scan_at timestamptz, last_tick_at timestamptz, last_result jsonb, updated_at timestamptz default now());
insert into public.greg_trade_state (id) values (1) on conflict do nothing;
alter table public.greg_trade_state enable row level security;
drop policy if exists "public read trade state" on public.greg_trade_state;
create policy "public read trade state" on public.greg_trade_state for select using (true);
