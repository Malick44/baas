-- Limits that hold across every baas process exactly, not per node: a token bucket per project, and a daily request counter
-- handed out in blocks. Both run in the database, on its clock, in one statement per call.
CREATE UNLOGGED TABLE shared_buckets (
  key    text PRIMARY KEY,
  tokens double precision NOT NULL,
  at     timestamptz NOT NULL
);

-- Take up to `want` tokens from a bucket that holds at most `burst` and refills `rps` per second. Returns how many were granted (possibly 0).
CREATE FUNCTION baas_take_tokens(k text, burst double precision, rps double precision, want int) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  cur double precision;
  granted int;
BEGIN
  INSERT INTO shared_buckets (key, tokens, at) VALUES (k, burst, now()) ON CONFLICT (key) DO NOTHING;
  SELECT LEAST(burst, tokens + GREATEST(0, extract(epoch FROM (now() - at))) * rps) INTO cur FROM shared_buckets WHERE key = k FOR UPDATE;
  granted := LEAST(want, floor(cur))::int;
  UPDATE shared_buckets SET tokens = cur - granted, at = now() WHERE key = k;
  RETURN granted;
END $$;

-- Claim up to `want` requests of today's quota for a project (cap = the plan's daily limit). The counter starts from what the
-- metering already recorded today, and the claim shrinks as the cap nears (to one request at a time at the end), so the total never goes over it.
CREATE FUNCTION baas_claim_day(p text, want int, cap bigint, nodes int) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  k text := 'day:' || p;
  ends timestamptz := (date_trunc('day', now() AT TIME ZONE 'utc') + interval '1 day') AT TIME ZONE 'utc';
  used bigint;
  granted int;
BEGIN
  INSERT INTO rate_limits (key, count, window_end)
    VALUES (k, LEAST(2000000000, COALESCE((SELECT requests FROM usage_daily WHERE ref = p AND day = (now() AT TIME ZONE 'utc')::date), 0)), ends)
    ON CONFLICT (key) DO UPDATE SET count = CASE WHEN rate_limits.window_end <= now() THEN 0 ELSE rate_limits.count END,
                                    window_end = CASE WHEN rate_limits.window_end <= now() THEN ends ELSE rate_limits.window_end END;
  SELECT count INTO used FROM rate_limits WHERE key = k FOR UPDATE;
  IF cap - used <= 0 THEN RETURN 0; END IF;
  granted := GREATEST(1, LEAST(want::bigint, (cap - used) / (2 * GREATEST(nodes, 1))))::int;
  UPDATE rate_limits SET count = count + granted WHERE key = k;
  RETURN granted;
END $$;
