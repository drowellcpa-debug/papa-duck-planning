-- 2026-11-12 Papa Duck: "can you go ahead and add that for me ... pd 3675" - a note / price Claude sets BEFORE a book is sent;
-- applied when the draft with that PD arrives (trigger drafts_preset_apply). Migration: draft_presets.
create table if not exists pipeline.draft_presets (pd text primary key, tell_add text, price numeric, made_at timestamptz not null default now(), used_at timestamptz);
alter table pipeline.draft_presets enable row level security;
create or replace function pipeline.drafts_preset_apply() returns trigger language plpgsql as $$
declare p record;
begin
  if new.pd is null then return new; end if;
  select * into p from pipeline.draft_presets where upper(pd) = upper(new.pd) and used_at is null;
  if p.pd is null then return new; end if;
  if coalesce(p.tell_add,'') <> '' then
    new.answers := coalesce(new.answers,'{}'::jsonb) || jsonb_build_object('tell', trim(coalesce(new.answers->>'tell','') || E'\n' || p.tell_add));
  end if;
  if p.price is not null then new.price_override := p.price; end if;
  update pipeline.draft_presets set used_at = now() where pd = p.pd;
  return new;
end $$;
drop trigger if exists drafts_preset_apply on pipeline.drafts;
create trigger drafts_preset_apply before insert or update of pd on pipeline.drafts for each row execute function pipeline.drafts_preset_apply();
-- PD-3675 (draft 999, Landmarks of Te Arawa Vol 2) had already arrived: note appended to answers.tell and price_override 74.99 set directly.
