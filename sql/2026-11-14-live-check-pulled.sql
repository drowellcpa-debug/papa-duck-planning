-- 2026-11-14 Papa Duck: "When we pull a book down, it needs to show on my confirmation table so it can put away"
-- An Amazon live-check row for a book we took off Amazon (draft amazon_on = false) is 'pulled' - done, not waiting.
create or replace function pipeline.live_check_pulled() returns trigger language plpgsql as $$
begin
  if new.channel = 'amazon' and exists (select 1 from pipeline.drafts d where upper(d.pd) = upper(new.pd) and d.amazon_on is false) then
    new.state := 'pulled'; new.detail := 'pulled from Amazon';
  end if;
  return new;
end $$;
drop trigger if exists live_check_pulled on pipeline.launch_live_check;
create trigger live_check_pulled before insert or update on pipeline.launch_live_check
  for each row execute function pipeline.live_check_pulled();
