-- 2026-11-14 Papa Duck: "on the app that can't decide on price it should be listed, flag it, and have it show flagged on drafts when I scan it"
-- station-api v7r: a Quick check with no price proof is LIST + cleanup_piles.price_flag. The flag follows the sticker PD or the
-- Book Station draft (draft_id) into drafts.answers.price_flag; Drafts shows a 🚩 Price check chip until he sets a price.
alter table pipeline.cleanup_piles add column if not exists price_flag text;
alter table pipeline.draft_presets add column if not exists price_flag text;
create or replace function pipeline.piles_flag_push() returns trigger language plpgsql as $$
begin
  if coalesce(new.price_flag,'') = '' then return new; end if;
  if new.draft_id is not null then
    update pipeline.drafts set answers = coalesce(answers,'{}'::jsonb) || jsonb_build_object('price_flag', new.price_flag) where id = new.draft_id;
  end if;
  if new.pd is not null then
    if exists (select 1 from pipeline.drafts where upper(pd) = upper(new.pd)) then
      update pipeline.drafts set answers = coalesce(answers,'{}'::jsonb) || jsonb_build_object('price_flag', new.price_flag) where upper(pd) = upper(new.pd);
    else
      insert into pipeline.draft_presets(pd, price_flag) values (upper(new.pd), new.price_flag)
        on conflict (pd) do update set price_flag = excluded.price_flag, used_at = null;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists piles_flag_push on pipeline.cleanup_piles;
create trigger piles_flag_push after insert or update of pd, draft_id, price_flag on pipeline.cleanup_piles for each row execute function pipeline.piles_flag_push();
-- drafts_preset_apply(): also copies draft_presets.price_flag into answers.price_flag (see migration price_flag_to_drafts).
