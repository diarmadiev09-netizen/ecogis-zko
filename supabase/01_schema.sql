-- ЭкоГИС ЗКО — схема базы данных (Supabase / PostgreSQL + PostGIS)
-- Запускать первым в Supabase → SQL Editor.

create extension if not exists postgis with schema extensions;

-- ---------------------------------------------------------------
-- Районы: административные границы (WGS 84, EPSG:4326)
-- ---------------------------------------------------------------
create table if not exists public.districts (
  id          text primary key,                 -- 'burlin', 'akzhaik', ...
  name_ru     text not null,
  short_ru    text not null,                    -- подпись на карте
  center      text,                             -- районный центр
  sources     text[] not null default '{}',     -- основные источники воздействия
  name_kk     text,                             -- то же на казахском
  short_kk    text,
  center_kk   text,
  sources_kk  text[] not null default '{}',
  is_city     boolean not null default false,   -- г. Уральск (контур условный)
  geom        extensions.geometry(MultiPolygon, 4326) not null
);
create index if not exists districts_geom_idx on public.districts using gist (geom);

-- ---------------------------------------------------------------
-- Станции мониторинга (точки)
-- district_id заполняется автоматически пространственным запросом
-- ---------------------------------------------------------------
create table if not exists public.stations (
  id           serial primary key,
  name         text not null,
  name_kk      text,
  kind        text not null default 'multi' check (kind in ('air','water','soil','multi')),
  district_id  text references public.districts(id),
  geom         extensions.geometry(Point, 4326) not null
);
create index if not exists stations_geom_idx on public.stations using gist (geom);

create or replace function public.stations_assign_district()
returns trigger language plpgsql
set search_path = public, extensions
as $$
begin
  -- самый маленький по площади содержащий полигон: точка в Уральске попадёт
  -- в город, а не в окружающий Байтерекский район
  select d.id into new.district_id
  from public.districts d
  where st_contains(d.geom, new.geom)
  order by st_area(d.geom) asc
  limit 1;
  if new.district_id is null then
    raise exception 'Станция "%" находится за пределами области', new.name;
  end if;
  return new;
end $$;

drop trigger if exists stations_assign_district on public.stations;
create trigger stations_assign_district
  before insert or update of geom on public.stations
  for each row execute function public.stations_assign_district();

-- ---------------------------------------------------------------
-- Предприятия-природопользователи (источники воздействия)
-- Начальный список — предприятия I категории ЗКО с ecokarta.kz (там указан только район)
-- ---------------------------------------------------------------
create table if not exists public.enterprises (
  id           serial primary key,
  name         text not null,
  oked         text,                              -- вид деятельности по ОКЭД
  category     smallint check (category in (1, 2, 3, 4)),  -- категория объекта по Экологическому кодексу РК
  district_id  text references public.districts(id),
  geom         extensions.geometry(Point, 4326),  -- точные координаты, когда будут известны
  source_url   text
);

-- ---------------------------------------------------------------
-- Измерения
-- aqi  — индекс качества воздуха
-- wpi  — индекс загрязнённости воды (ИЗВ)
-- soil — деградация почв, % площади
-- ndvi — вегетационный индекс
-- precip — осадки, мм за месяц
-- ---------------------------------------------------------------
create table if not exists public.measurements (
  id           bigserial primary key,
  station_id   int  not null references public.stations(id) on delete cascade,
  metric       text not null check (metric in ('aqi','wpi','soil','ndvi','precip')),
  value        numeric not null,
  measured_at  date not null,
  source       text not null default 'manual',   -- 'manual' | 'demo' | 'openaq' | ...
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  constraint measurements_value_range check (
    (metric = 'aqi'  and value between 0 and 500) or
    (metric = 'wpi'  and value between 0 and 20)  or
    (metric = 'soil' and value between 0 and 100) or
    (metric = 'ndvi' and value between -1 and 1)  or
    (metric = 'precip' and value between 0 and 500)
  )
);
create index if not exists measurements_metric_date_idx on public.measurements (metric, measured_at);
create index if not exists measurements_station_idx on public.measurements (station_id);

-- ---------------------------------------------------------------
-- Представления и функции для карты
-- ---------------------------------------------------------------

-- Помесячные средние по районам — то, что раскрашивает карту
create or replace view public.district_monthly
with (security_invoker = on) as
select s.district_id,
       date_trunc('month', m.measured_at)::date as month,
       m.metric,
       round(avg(m.value), 3) as value,
       count(*)               as n
from public.measurements m
join public.stations s on s.id = m.station_id
group by 1, 2, 3;

-- Станции с координатами (lon/lat) для веб-клиента
create or replace view public.stations_xy
with (security_invoker = on) as
select id, name, name_kk, kind, district_id,
       extensions.st_x(geom) as lon,
       extensions.st_y(geom) as lat
from public.stations;

-- Границы районов одним GeoJSON (упрощённые для веба)
create or replace function public.districts_geojson(tolerance float default 0.003)
returns json language sql stable
set search_path = public, extensions
as $$
  select json_build_object(
    'type', 'FeatureCollection',
    'features', coalesce(json_agg(json_build_object(
      'type', 'Feature',
      'id', d.id,
      'properties', json_build_object(
        'name', d.name_ru, 'short', d.short_ru, 'center', d.center,
        'sources', d.sources, 'is_city', d.is_city,
        'name_kk', d.name_kk, 'short_kk', d.short_kk, 'center_kk', d.center_kk, 'sources_kk', d.sources_kk,
        'area_km2', round((st_area(d.geom::geography) / 1e6)::numeric)
      ),
      'geometry', st_asgeojson(st_simplifypreservetopology(d.geom, tolerance), 5)::json
    ) order by d.is_city, d.id), '[]'::json)
  )
  from public.districts d
$$;

-- Пространственный запрос: станции в радиусе R км от точки
create or replace function public.stations_within(lon float, lat float, radius_km float)
returns table (id int, name text, district_id text, distance_km numeric)
language sql stable
set search_path = public, extensions
as $$
  select s.id, s.name, s.district_id,
         round((st_distance(s.geom::geography, st_setsrid(st_makepoint(lon, lat), 4326)::geography) / 1000)::numeric, 1)
  from public.stations s
  where st_dwithin(s.geom::geography, st_setsrid(st_makepoint(lon, lat), 4326)::geography, radius_km * 1000)
  order by 4
$$;

-- ---------------------------------------------------------------
-- Доступ (Row Level Security)
-- Читать могут все; добавлять измерения — только вошедшие участники команды.
-- ---------------------------------------------------------------
alter table public.districts    enable row level security;
alter table public.stations     enable row level security;
alter table public.measurements enable row level security;
alter table public.enterprises  enable row level security;

drop policy if exists "read enterprises" on public.enterprises;
create policy "read enterprises" on public.enterprises for select to anon, authenticated using (true);

drop policy if exists "read districts" on public.districts;
create policy "read districts" on public.districts for select to anon, authenticated using (true);

drop policy if exists "read stations" on public.stations;
create policy "read stations" on public.stations for select to anon, authenticated using (true);

drop policy if exists "team adds stations" on public.stations;
create policy "team adds stations" on public.stations for insert to authenticated with check (true);

drop policy if exists "read measurements" on public.measurements;
create policy "read measurements" on public.measurements for select to anon, authenticated using (true);

drop policy if exists "team adds measurements" on public.measurements;
create policy "team adds measurements" on public.measurements for insert to authenticated
  with check (created_by = auth.uid() and source = 'manual');

drop policy if exists "authors delete own measurements" on public.measurements;
create policy "authors delete own measurements" on public.measurements for delete to authenticated
  using (created_by = auth.uid());

grant execute on function public.districts_geojson(float)            to anon, authenticated;
grant execute on function public.stations_within(float, float, float) to anon, authenticated;
