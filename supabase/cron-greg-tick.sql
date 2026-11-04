-- Greg's brain schedule. NOT applied yet. Run this in the Supabase SQL editor when you want Greg to live on his own.
-- It wakes greg-tick every 10 minutes (Greg skips a wake while he is still walking or when paused),
-- and tries to post one approved tweet every 2 hours (greg-x does nothing until X is connected and switched on).
-- The cron secret is read from greg_secrets so it never sits in this file.

select cron.schedule('greg-tick', '*/10 * * * *', $$
  select net.http_post(
    url := 'https://mdggkjocllyqxpthvtop.supabase.co/functions/v1/greg-tick',
    headers := jsonb_build_object('content-type', 'application/json', 'x-greg-cron', (select value from public.greg_secrets where name = 'cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000);
$$);

select cron.schedule('greg-x', '7 */2 * * *', $$
  select net.http_post(
    url := 'https://mdggkjocllyqxpthvtop.supabase.co/functions/v1/greg-x',
    headers := jsonb_build_object('content-type', 'application/json', 'x-greg-cron', (select value from public.greg_secrets where name = 'cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000);
$$);

-- To stop: select cron.unschedule('greg-tick'); select cron.unschedule('greg-x');
