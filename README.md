# ЭкоГИС ЗКО

Веб-ГИС мониторинга экологического состояния Западно-Казахстанской области.
Авторы: Қолқанат, Дияр, Аслан.

**Сайт:** https://diarmadiev09-netizen.github.io/ecogis-zko/ · **Код:** https://github.com/diarmadiev09-netizen/ecogis-zko

Карта в стиле Europa Universalis IV: районы раскрашиваются по выбранному показателю (воздух, вода, почва, растительность, интегральный эко-индекс), есть хронология по месяцам, тревоги при превышении порогов и рейтинг районов. Данные хранятся в PostgreSQL + PostGIS (Supabase).

## Структура

```
supabase/01_schema.sql   таблицы, пространственные функции, политики доступа (RLS)
supabase/02_seed.sql     границы 12 районов + г. Уральск, 17 станций, предприятия, демо-измерения
supabase/03_chat.sql     журнал ИИ-помощника (для лимитов)
supabase/functions/ask-ecogis/index.ts   ИИ-помощник: Edge Function, Claude + инструменты к базе
web/                     сайт: index.html, app.js, i18n.js, style.css, config.js, demo-data.json
tools/generate_seed.py   пересобирает 02_seed.sql и demo-data.json из GeoJSON
```

## Как это устроено

| Слой | Что делает |
|---|---|
| `districts` | полигоны районов (MultiPolygon, EPSG:4326), источники воздействия |
| `stations` | точки станций; триггер сам определяет район через `ST_Contains` |
| `measurements` | измерения: `aqi`, `wpi` (ИЗВ), `soil` (% деградации), `ndvi`, `precip` (осадки, мм/мес.) |
| `district_monthly` | представление: средние по району за месяц, им раскрашивается карта |
| `districts_geojson()` | отдаёт границы одним GeoJSON (упрощение `ST_SimplifyPreserveTopology`) |
| `stations_within(lon, lat, km)` | станции в радиусе (`ST_DWithin` по geography) |

Интерфейс двуязычный (русский / қазақша, кнопка в шапке, выбор запоминается). Тексты — в `web/i18n.js`, казахские названия районов и станций — в колонках `*_kk` базы.

Осадки показываются на карте и в рейтинге, но в эко-индекс не входят: это климатический фон, а не загрязнение.

Читать данные может любой посетитель сайта. Добавлять измерения могут только вошедшие участники команды (политики RLS в `01_schema.sql`).

## Запуск

### 1. Проект Supabase
1. Зарегистрируйтесь на [supabase.com](https://supabase.com) и создайте проект (бесплатный план подходит). Регион — Frankfurt (ближе всего).
2. Откройте **SQL Editor**, вставьте содержимое `supabase/01_schema.sql`, нажмите **Run**.
3. Затем так же выполните `supabase/02_seed.sql`.
4. Проверка — в SQL Editor:
   ```sql
   select id, name_ru, round((st_area(geom::geography)/1e6)::numeric) as km2 from districts order by km2 desc;
   select * from stations_within(51.37, 51.23, 50);   -- станции в 50 км от Уральска
   ```

### 2. Вход для команды
1. **Authentication → Sign In / Providers**: включён Email; отключите **Allow new users to sign up**, чтобы посторонние не могли зарегистрироваться.
2. **Authentication → Users → Invite user**: пригласите почты трёх участников.
3. **Authentication → URL Configuration**: в **Site URL** и **Redirect URLs** укажите адрес сайта (после шага 4), а для локальной проверки добавьте `http://localhost:8000`.

### 3. Подключение сайта
**Project Settings → API**: скопируйте **Project URL** и ключ **anon public** в `web/config.js`:
```js
window.ECO_CONFIG = {
  supabaseUrl: 'https://xxxx.supabase.co',
  supabaseAnonKey: 'eyJ...',
};
```
anon-ключ можно публиковать: без входа он даёт только чтение. Ключ **service_role** никогда не вставляйте в сайт.

Проверка на своём компьютере:
```
cd web
python -m http.server 8000
```
и откройте http://localhost:8000. В шапке должно быть «источник: Supabase».

### 4. Публикация в интернете
Сайт публикуется на GitHub Pages автоматически: при каждом изменении папки `web` в ветке `main` срабатывает `.github/workflows/pages.yml`. Адрес: https://diarmadiev09-netizen.github.io/ecogis-zko/ — его же впишите в Supabase (шаг 2.3).

Другой способ — **Netlify Drop**: зайдите на [app.netlify.com/drop](https://app.netlify.com/drop) и перетащите папку `web`. Получите адрес вида `https://ecogis-zko.netlify.app`. Затем впишите его в Supabase (шаг 2.3).


## ИИ-помощник

Кнопка «ИИ-помощник» на сайте открывает чат. Вопрос уходит в Supabase Edge Function `ask-ecogis`, она спрашивает Claude (модель `claude-opus-5-5`), а Claude сам читает базу через инструменты:

| Инструмент | Что делает |
|---|---|
| `list_districts` | районы, станции, предприятия, сколько в базе реальных и демо-измерений |
| `get_monthly_data` | помесячные значения из `district_monthly` с фильтрами по району, показателю и периоду |
| `find_stations_near` | пространственный запрос PostGIS `stations_within` |
| `show_on_map` | переключает на сайте район, режим карты и месяц — карта показывает то, о чём ответ |

Отвечает на языке вопроса (русский / қазақша). Ключ Claude API хранится только в секретах функции, на сайт он не попадает.

**Защита от лишних расходов:** вопрос до 600 символов, не больше `CHAT_HOURLY_PER_IP` (20) вопросов в час с одного адреса и `CHAT_DAILY_LIMIT` (300) в сутки на весь сайт. Журнал — в таблице `chat_log` (IP хранится только как хеш); с сайта она не читается.

### Как включить
1. Получите ключ на [platform.claude.com](https://platform.claude.com) (раздел API keys). Запросы платные; Claude Opus 5.5 стоит $4 / $20 за миллион входных / выходных токенов, короткий вопрос обычно обходится в доли цента.
2. В SQL Editor выполните `supabase/03_chat.sql`.
3. Разверните функцию — через Supabase CLI:
   ```
   npx supabase login
   npx supabase link --project-ref <id проекта>
   npx supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
   npx supabase functions deploy ask-ecogis
   ```
   или в панели: **Edge Functions → Deploy a new function → Via Editor**, имя `ask-ecogis`, вставьте код `supabase/functions/ask-ecogis/index.ts`; ключ — в **Edge Functions → Secrets** как `ANTHROPIC_API_KEY`.
4. Необязательно: `CHAT_ALLOWED_ORIGIN=https://diarmadiev09-netizen.github.io` в секретах — тогда функцию сможет вызывать только ваш сайт; `CHAT_DAILY_LIMIT`, `CHAT_HOURLY_PER_IP` — свои лимиты.

В демо-режиме (без `config.js`) чат открывается, но вопросы отправить нельзя — он объясняет, что нужно подключить.

## Данные

Сейчас в базе **синтетические** измерения (`source = 'demo'`) за январь 2025 – октябрь 2026, чтобы карта была заполнена. Когда появятся реальные данные:
```sql
delete from measurements where source = 'demo';
```
Реальные значения добавляются кнопкой «Добавить измерение» на сайте или SQL-запросом. Возможные источники: бюллетени РГП «Казгидромет», OpenAQ (воздух), Sentinel-2 (NDVI), Sentinel-5P (NO₂).

Без `config.js` сайт работает в демо-режиме на `web/demo-data.json`.

### Пересборка начальных данных
```
python tools/generate_seed.py geoBoundaries-KAZ-ADM2_simplified.geojson
```
Исходник границ: [geoBoundaries KAZ ADM2](https://github.com/wmgeolab/geoBoundaries/raw/main/releaseData/gbOpen/KAZ/ADM2/geoBoundaries-KAZ-ADM2_simplified.geojson) (CC BY 4.0). В нём старые названия: Зеленовский = Байтерекский, Урдинский = Бокейординский. У г. Уральска отдельной границы нет, поэтому город задан кругом радиусом 9 км.
