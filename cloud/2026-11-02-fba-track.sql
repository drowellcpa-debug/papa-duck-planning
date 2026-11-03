-- Papa Duck 2026-11-02: FBA box tracker on the Launch Pad. fba-track edge function (cron pd-fba-track '17 */2 * * *') fills pipeline.fba_track;
-- pipeline.fba_track_board() feeds the "🚚 FBA boxes at Amazon" card (closed boxes stay 14 days).
create or replace function pipeline.fba_track_board() returns jsonb language sql stable security definer set search_path to 'pipeline','pg_catalog' as $$
  select coalesce(jsonb_agg(jsonb_build_object('box', t.box, 'shipment', t.shipment, 'status', t.status, 'stage', t.stage, 'books', t.books, 'shipped', t.shipped,
      'received', t.received, 'ready', t.ready, 'problem', t.problem, 'where', t.note, 'checked', t.checked_at, 'delivered', t.delivered_at, 'closed', t.closed_at,
      'sent', s.label_at, 'tracking', s.tracking) order by t.box desc), '[]'::jsonb)
  from pipeline.fba_track t join pipeline.fba_ship s on s.box = t.box
  where t.closed_at is null or t.closed_at > now() - interval '14 days' $$;
