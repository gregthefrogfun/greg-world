-- Log of files Greg uploaded to GitHub through greg-github (daily cap is counted from here)
create table if not exists public.greg_uploads (id bigserial primary key, created_at timestamptz not null default now(), repo text not null, path text not null, bytes int, ok boolean not null default false, url text, error text);
alter table public.greg_uploads enable row level security;
drop policy if exists "public read ok uploads" on public.greg_uploads;
create policy "public read ok uploads" on public.greg_uploads for select using (ok);
