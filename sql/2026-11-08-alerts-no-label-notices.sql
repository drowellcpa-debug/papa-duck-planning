-- 2026-11-08 Papa Duck: "when I mark them shipped it is also showing the labels have been printed, dont need that".
create or replace function pipeline.alerts_skip_labels_fn() returns trigger language plpgsql as $$
begin
  if new.done_at is null and new.kind in ('fyi','handled') and coalesce(new.title,'') ~* '\mlabel (ready|made|credit|printed|created)|\mlabels? (have been|has been|were) printed' then
    new.done_at := now();
  end if;
  return new;
end $$;
drop trigger if exists alerts_skip_labels on pipeline.alerts;
create trigger alerts_skip_labels before insert or update on pipeline.alerts for each row execute function pipeline.alerts_skip_labels_fn();
