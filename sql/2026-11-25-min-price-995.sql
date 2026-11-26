-- 2026-11-25 Papa Duck: "make my minimum 9.95 dont have it ask me just set t there"
-- Books under $9.95 are set to $9.95 at blast off - no Launch Pad question. (Old rule: $9.99 with a question.)
insert into pipeline.config(key, value) values ('min_price', '9.95')
  on conflict (key) do update set value = excluded.value;

do $do$
declare d text := pg_get_functiondef('pipeline.launch_create'::regproc); n text;
begin
  n := replace(d, 'sug := greatest(9.99, floor(r.lst * 0.75) - 0.01);', 'sug := greatest(9.95, floor(r.lst * 0.75) - 0.01);');
  n := replace(n,
$o$    -- 1b) under his $9.99 minimum (2026-10-17 rule; PD-3538 slipped through at $5.99 on 10/25)
    if r.lst < 9.99 then
      k := k + 1;
      insert into pipeline.launch_questions(night_id, ord, kind, pd, prompt, detail, options) values (nid, k, 'price', r.pd,
        r.pd || ' ' || coalesce(r.ident->>'title','') || ' is priced at $' || to_char(r.lst,'FM999990.00'),
        'That is under your $9.99 minimum. Use $9.99, or keep it if you really want it lower.',
        jsonb_build_object('current', r.lst, 'suggest', 9.99));
    end if;$o$,
$n$    -- 1b) under his minimum: 2026-11-25 "make my minimum 9.95 dont have it ask me just set it there"
    if r.lst < 9.95 and coalesce(r.answers->>'price_ok','') <> 'launch: kept' and not p_dry then
      perform pipeline.launch_set_draft_price(r.pd, 9.95);
    end if;$n$);
  if n = d or position('launch_set_draft_price(r.pd, 9.95)' in n) = 0 then raise exception 'patch did not apply'; end if;
  execute n;
end $do$;

-- Papa Duck: "we will start with my next blast off tomorrow" - tonight's night 11252026-L54 (id 55) left as is ($9.99 questions)
