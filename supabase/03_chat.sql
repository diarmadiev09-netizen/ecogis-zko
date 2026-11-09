-- ЭкоГИС ЗКО — журнал ИИ-помощника. Запускать после 01_schema.sql.
-- Пишет только Edge Function ask-ecogis (ключом service_role); с сайта таблица не видна.

create table if not exists public.chat_log (
  id             bigserial primary key,
  created_at     timestamptz not null default now(),
  ip_hash        text,                 -- SHA-256 от IP: для лимита, без хранения самого адреса
  lang           text,
  question       text not null,
  answer         text,
  input_tokens   int,
  output_tokens  int,
  error          text
);
create index if not exists chat_log_created_idx on public.chat_log (created_at);
create index if not exists chat_log_ip_idx on public.chat_log (ip_hash, created_at);

alter table public.chat_log enable row level security;
-- политик нет намеренно: anon и authenticated не читают и не пишут журнал
