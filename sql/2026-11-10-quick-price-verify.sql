-- 2026-11-10 Papa Duck: "before I do the nightly blast verify it is done, dont let the nightly blast go to the launch pad until
-- to verify that it is checked and then it turns to send to launch pad".
drop function if exists pipeline.quick_price_apply();
create or replace function pipeline.quick_price_apply(final boolean default false) returns int language plpgsql as $$
-- Drafts take the Quick check price (see 2026-11-10-quick-price.sql). final=true is the pre-blast verify: no 30-minute wait, no 2-day window.
declare d record; s record; n int := 0; sold int; listed int; dl numeric;
begin
  for d in select * from pipeline.drafts
           where source = 'station' and status in ('drafted','sent') and built_at is null and archived_at is null
             and price_override is null and coalesce(answers->>'qc_checked','') = ''
             and (final or created_at > now() - interval '2 days') and coalesce(ident->>'title','') <> '' loop
    select * into s from pipeline.scout_scans x
      where x.mode = 'cleanup' and x.created_at between d.created_at - interval '3 hours' and d.created_at
        and ((coalesce(x.isbn,'') <> '' and x.isbn = regexp_replace(upper(coalesce(d.ident->>'isbn','')),'[^0-9X]','','g'))
             or (length(coalesce(x.title,'')) >= 6 and
                 left(regexp_replace(regexp_replace(lower(x.title),'^(the|a|an) ',''),'[^a-z0-9]','','g'),16)
               = left(regexp_replace(regexp_replace(lower(d.ident->>'title'),'^(the|a|an) ',''),'[^a-z0-9]','','g'),16)))
      order by (x.verdict = 'LIST') desc, x.id desc limit 1;
    sold := coalesce((regexp_match(coalesce(s.summary,''), 'eBay (\d+) sold'))[1]::int, 0);
    listed := coalesce((regexp_match(coalesce(s.summary,''), '(\d+) listed'))[1]::int, 0);
    dl := nullif(d.pricing->>'list','')::numeric;
    if s.id is not null and s.verdict = 'LIST' and s.list is not null and not (sold = 0 and listed <= 2)
       and not (sold <= 1 and dl is not null and s.list > dl * 2) then
      update pipeline.drafts set price_override = s.list,
        answers = coalesce(answers,'{}'::jsonb) || jsonb_build_object('qc_checked','used','qc_price',s.list,'qc_scan',s.id,'qc_summary',left(s.summary,200)),
        updated_at = now() where id = d.id;
      n := n + 1;
    elsif final or d.created_at < now() - interval '30 minutes' then
      update pipeline.drafts set answers = coalesce(answers,'{}'::jsonb) || jsonb_build_object('qc_checked',
          case when s.id is null then 'no check found' when s.verdict <> 'LIST' then 'not used (check said '||s.verdict||')'
               when sold = 0 and listed <= 2 then 'not used (thin data)' else 'not used (one sale far above the rest)' end,
          'qc_scan', s.id, 'qc_summary', left(s.summary,200))
        where id = d.id;
    end if;
  end loop;
  return n;
end $$;

-- The pre-blast check. Runs the matcher one last time, then reports tonight's sent books: checked / still repricing.
create or replace function pipeline.quick_price_verify() returns jsonb language plpgsql as $$
declare used int; r jsonb;
begin
  used := pipeline.quick_price_apply(true);
  select jsonb_build_object('ok', count(*) filter (where pending) = 0, 'books', count(*),
           'used_now', used, 'qc_used', count(*) filter (where answers->>'qc_checked' = 'used'),
           'pending', count(*) filter (where pending),
           'pending_pd', coalesce(jsonb_agg(pd order by pd) filter (where pending), '[]'::jsonb),
           'checked_at', to_char(now() at time zone 'America/Los_Angeles', 'YYYY-MM-DD HH24:MI'))
    into r
    from (select pd, answers,
            (price_stale is true or (source = 'station' and price_override is null and coalesce(answers->>'qc_checked','') = '')) as pending
          from pipeline.drafts where status = 'sent' and built_at is null and archived_at is null) t;
  insert into pipeline.config(key, value) values ('quick_price_verified', r::text)
    on conflict (key) do update set value = excluded.value;
  return r;
end $$;

-- launch_create (not dry) now calls pipeline.quick_price_verify() first and refuses with
-- "Prices are still being checked for PD-…. Try again in a few minutes." until every sent book is checked.
