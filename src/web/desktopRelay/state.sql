-- Private desktop transport only. Codex credentials and workspace files stay on
-- the owner's computer; this queue stores owner-authorized UI RPCs and updates.
BEGIN;
CREATE TABLE IF NOT EXISTS public.ludoready_desktop_worker (
  slot integer PRIMARY KEY CHECK (slot = 1), worker_id text NOT NULL, seen_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS public.ludoready_desktop_requests (
  id text PRIMARY KEY, kind text NOT NULL CHECK (kind IN ('rpc', 'preview', 'upload', 'download')),
  channel text NOT NULL, args jsonb NOT NULL CHECK (jsonb_typeof(args) = 'array'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'done')),
  worker_id text, result jsonb, error text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), claimed_at timestamptz
);
CREATE INDEX IF NOT EXISTS ludoready_desktop_pending ON public.ludoready_desktop_requests(created_at) WHERE status = 'pending';
CREATE TABLE IF NOT EXISTS public.ludoready_desktop_events (
  id bigserial PRIMARY KEY, channel text NOT NULL, payload jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.ludoready_desktop_worker ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ludoready_desktop_worker FORCE ROW LEVEL SECURITY;
ALTER TABLE public.ludoready_desktop_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ludoready_desktop_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE public.ludoready_desktop_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ludoready_desktop_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.ludoready_desktop_worker, public.ludoready_desktop_requests, public.ludoready_desktop_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ludoready_desktop_worker, public.ludoready_desktop_requests, public.ludoready_desktop_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.ludoready_desktop_events_id_seq TO service_role;

CREATE OR REPLACE FUNCTION public.ludoready_desktop_state(op text, input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $desktop$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_worker text;
  v_seen timestamptz;
  v_connected boolean;
  v_requests jsonb;
  v_row public.ludoready_desktop_requests%ROWTYPE;
  v_event jsonb;
  v_events jsonb;
  v_cursor bigint;
BEGIN
  IF (COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'role') IS DISTINCT FROM 'service_role' THEN
    RETURN jsonb_build_object('status', 403, 'body', jsonb_build_object('error', '状态服务请求未获授权。'));
  END IF;
  IF op IS NULL OR op NOT IN ('desktop-submit', 'desktop-result', 'desktop-poll', 'desktop-heartbeat', 'desktop-complete', 'desktop-events', 'desktop-read-events')
      OR jsonb_typeof(input) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('status', 400, 'body', jsonb_build_object('error', '工作台请求格式无效。'));
  END IF;
  -- One transaction serializes the connection lease and command claims. A
  -- claimed mutating RPC is never automatically retried on another computer.
  PERFORM pg_advisory_xact_lock(774162184);
  SELECT worker_id, seen_at INTO v_worker, v_seen FROM public.ludoready_desktop_worker WHERE slot = 1;
  v_connected := v_seen IS NOT NULL AND v_now - v_seen < interval '45 seconds';
  IF op IN ('desktop-poll', 'desktop-heartbeat', 'desktop-complete', 'desktop-events') THEN
    IF jsonb_typeof(input -> 'workerId') IS DISTINCT FROM 'string' OR (input ->> 'workerId') !~ '^[a-f0-9-]{36}$' THEN
      RETURN jsonb_build_object('status', 400, 'body', jsonb_build_object('error', '工作台标识无效。'));
    END IF;
    IF v_connected AND v_worker <> input ->> 'workerId' THEN
      RETURN jsonb_build_object('status', 409, 'body', jsonb_build_object('error', '已有另一台电脑连接工作台。'));
    END IF;
    IF v_worker IS DISTINCT FROM input ->> 'workerId' THEN
      UPDATE public.ludoready_desktop_requests SET status = 'done', error = '原本机连接已断开，操作未自动重试。' WHERE status = 'claimed';
    END IF;
    INSERT INTO public.ludoready_desktop_worker(slot, worker_id, seen_at) VALUES(1, input ->> 'workerId', v_now)
      ON CONFLICT(slot) DO UPDATE SET worker_id = EXCLUDED.worker_id, seen_at = EXCLUDED.seen_at;
    v_connected := true;
  END IF;
  IF op = 'desktop-submit' THEN
    IF NOT v_connected THEN RETURN jsonb_build_object('status', 409, 'body', jsonb_build_object('error', '本机工作台离线，请打开电脑上的 LudoReady。')); END IF;
    IF jsonb_typeof(input -> 'id') IS DISTINCT FROM 'string' OR (input ->> 'id') !~ '^[a-f0-9-]{36}$'
        OR input ->> 'kind' NOT IN ('rpc', 'preview', 'upload', 'download') OR jsonb_typeof(input -> 'args') IS DISTINCT FROM 'array'
        OR jsonb_typeof(input -> 'channel') IS DISTINCT FROM 'string' OR pg_column_size(input) > 4194304 THEN
      RETURN jsonb_build_object('status', 400, 'body', jsonb_build_object('error', '工作台操作格式无效。'));
    END IF;
    IF (SELECT count(*) FROM public.ludoready_desktop_requests WHERE status = 'pending') >= 100 THEN
      RETURN jsonb_build_object('status', 429, 'body', jsonb_build_object('error', '本机正在处理较多操作，请稍后再试。'));
    END IF;
    INSERT INTO public.ludoready_desktop_requests(id, kind, channel, args) VALUES(input ->> 'id', input ->> 'kind', input ->> 'channel', input -> 'args');
    RETURN jsonb_build_object('status', 200, 'body', jsonb_build_object('requestId', input ->> 'id'));
  ELSIF op = 'desktop-result' THEN
    SELECT * INTO v_row FROM public.ludoready_desktop_requests WHERE id = input ->> 'id';
    IF NOT FOUND THEN RETURN jsonb_build_object('status', 404, 'body', jsonb_build_object('error', '工作台操作记录不存在。')); END IF;
    IF v_row.status <> 'done' THEN
      RETURN jsonb_build_object('status', 200, 'body', jsonb_build_object('pending', true, 'connected', v_connected));
    END IF;
    RETURN jsonb_build_object('status', 200, 'body', jsonb_build_object('pending', false, 'result', v_row.result, 'error', v_row.error));
  ELSIF op = 'desktop-poll' THEN
    -- Expire queued UI work rather than replaying old destructive clicks when
    -- the computer comes back online much later.
    UPDATE public.ludoready_desktop_requests SET status = 'done', error = '操作等待时间过长，请重新操作。'
      WHERE status = 'pending' AND v_now - created_at > interval '2 minutes';
    DELETE FROM public.ludoready_desktop_requests WHERE status = 'done' AND v_now - created_at > interval '1 hour';
    WITH claimed AS (
      UPDATE public.ludoready_desktop_requests SET status = 'claimed', worker_id = input ->> 'workerId', claimed_at = v_now
      WHERE id IN (SELECT id FROM public.ludoready_desktop_requests WHERE status = 'pending' ORDER BY created_at LIMIT 20 FOR UPDATE SKIP LOCKED)
      RETURNING id, kind, channel, args, created_at
    ) SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'channel', channel, 'args', args) ORDER BY created_at), '[]'::jsonb) INTO v_requests FROM claimed;
    RETURN jsonb_build_object('status', 200, 'body', jsonb_build_object('requests', v_requests, 'connected', true));
  ELSIF op = 'desktop-complete' THEN
    -- A successful result can lose its HTTP acknowledgement. Re-delivering the
    -- same worker/request completion must acknowledge the saved result without
    -- changing it or asking the desktop to execute the command again.
    IF EXISTS (SELECT 1 FROM public.ludoready_desktop_requests WHERE id = input ->> 'id'
        AND status = 'done' AND worker_id = input ->> 'workerId') THEN
      RETURN jsonb_build_object('status', 200, 'body', jsonb_build_object('ok', true));
    END IF;
    UPDATE public.ludoready_desktop_requests SET status = 'done', result = input -> 'result', error = input ->> 'error'
      WHERE id = input ->> 'id' AND status = 'claimed' AND worker_id = input ->> 'workerId';
    IF NOT FOUND THEN RETURN jsonb_build_object('status', 409, 'body', jsonb_build_object('error', '工作台操作已经结束或连接已更换。')); END IF;
    RETURN jsonb_build_object('status', 200, 'body', jsonb_build_object('ok', true));
  ELSIF op = 'desktop-events' THEN
    IF jsonb_typeof(input -> 'events') IS DISTINCT FROM 'array' OR jsonb_array_length(input -> 'events') > 100 THEN
      RETURN jsonb_build_object('status', 400, 'body', jsonb_build_object('error', '工作台更新格式无效。'));
    END IF;
    FOR v_event IN SELECT value FROM jsonb_array_elements(input -> 'events') LOOP
      INSERT INTO public.ludoready_desktop_events(channel, payload) VALUES(v_event ->> 'channel', v_event -> 'payload');
    END LOOP;
    DELETE FROM public.ludoready_desktop_events WHERE id < (SELECT COALESCE(max(id), 0) - 2000 FROM public.ludoready_desktop_events);
    RETURN jsonb_build_object('status', 200, 'body', jsonb_build_object('ok', true));
  ELSIF op = 'desktop-read-events' THEN
    IF input -> 'latest' = 'true'::jsonb THEN
      SELECT COALESCE(max(id), 0) INTO v_cursor FROM public.ludoready_desktop_events;
      RETURN jsonb_build_object('status', 200, 'body', jsonb_build_object('events', '[]'::jsonb, 'cursor', v_cursor, 'connected', v_connected));
    END IF;
    v_cursor := COALESCE((input ->> 'cursor')::bigint, 0);
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'channel', channel, 'payload', payload) ORDER BY id), '[]'::jsonb), COALESCE(max(id), v_cursor)
      INTO v_events, v_cursor FROM (SELECT id, channel, payload FROM public.ludoready_desktop_events WHERE id > v_cursor ORDER BY id LIMIT 100) AS batch;
    RETURN jsonb_build_object('status', 200, 'body', jsonb_build_object('events', v_events, 'cursor', v_cursor, 'connected', v_connected));
  END IF;
  RETURN jsonb_build_object('status', 200, 'body', jsonb_build_object('connected', true));
END;
$desktop$;
REVOKE ALL ON FUNCTION public.ludoready_desktop_state(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ludoready_desktop_state(text, jsonb) TO service_role;
COMMIT;
