-- Real trade log (signatures from the trade executor). Empty until trading is switched on by the owner.
create table if not exists public.greg_trades (id bigserial primary key, created_at timestamptz not null default now(), side text not null check (side in ('buy','sell')), venue text, mint text, symbol text, amount_usd numeric, amount_sol numeric, price_usd numeric, pnl_usd numeric, signature text unique, reason text, paper boolean not null default false);
alter table public.greg_trades enable row level security;
drop policy if exists "public read trades" on public.greg_trades;
create policy "public read trades" on public.greg_trades for select using (true);
