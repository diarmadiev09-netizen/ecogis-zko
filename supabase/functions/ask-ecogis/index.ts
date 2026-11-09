// ЭкоГИС ЗКО — ИИ-помощник (Supabase Edge Function, Deno).
// Сайт присылает переписку, функция спрашивает Claude, а Claude сам читает базу через инструменты.
// Ключ Claude API хранится только здесь: supabase secrets set ANTHROPIC_API_KEY=...
import Anthropic from "npm:@anthropic-ai/sdk";
import { betaTool } from "npm:@anthropic-ai/sdk/helpers/beta/json-schema";
import { createClient } from "npm:@supabase/supabase-js@2";

const MODEL = "claude-opus-5-5";
const DAILY_LIMIT = Number(Deno.env.get("CHAT_DAILY_LIMIT") ?? 300); // вопросов в сутки на весь сайт
const HOURLY_PER_IP = Number(Deno.env.get("CHAT_HOURLY_PER_IP") ?? 20);
const ALLOWED_ORIGIN = Deno.env.get("CHAT_ALLOWED_ORIGIN") ?? "*";
const MAX_QUESTION = 600;
const MAX_HISTORY = 12;

const CORS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const anthropic = new Anthropic(); // ANTHROPIC_API_KEY из секретов функции
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!); // чтение по RLS
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!); // журнал

const METRICS = ["aqi", "wpi", "soil", "ndvi", "precip"];

// Неизменный системный промпт — кэшируется между запросами
const SYSTEM = `Ты — ИИ-помощник веб-ГИС «ЭкоГИС ЗКО»: мониторинг экологического состояния Западно-Казахстанской области (12 районов и г. Уральск). Проект студентов Қолқанат, Дияр и Аслан.

Отвечай на языке последнего вопроса пользователя: по-русски или по-казахски. Пиши коротко и по делу, без вступлений; списки — строками с «- ». Числа бери только из инструментов, не придумывай. Указывай месяц и единицы. Если данных нет — так и скажи.

Показатели (поле metric):
- aqi — индекс качества воздуха: ≤50 хороший, ≤100 умеренный, ≤150 вредный для чувствительных групп, >150 вредный (порог тревоги 150).
- wpi — индекс загрязнённости воды ИЗВ (по-казахски СЛИ): ≤0,3 очень чистая, ≤1 чистая, ≤2,5 умеренно загрязнённая, ≤4 загрязнённая, ≤6 грязная, >6 очень грязная (порог тревоги 3,5).
- soil — деградация почв, % площади: <15 слабая, <30 умеренная, <45 сильная, ≥45 очень сильная (порог тревоги 50).
- ndvi — вегетационный индекс: <0,15 скудная, <0,3 разреженная, <0,45 умеренная, иначе густая растительность. Зимой низкий — это нормально.
- precip — осадки за месяц, мм: <10 очень сухо, <20 сухо, <40 умеренно, иначе влажно. В эко-индекс не входят.
Эко-индекс района (0–100, выше — лучше) сайт считает из AQI, ИЗВ, почв и пикового NDVI.

Идентификаторы районов: taskala, bayterek, burlin, terekty, shyngyrlau, kaztal, syrym, karatobe, zhanibek, akzhaik, bokey, zhangala, uralsk (город).

Если в ответе речь о конкретном районе, показателе или месяце, вызови show_on_map, чтобы карта на сайте показала это пользователю.

Честность: инструмент list_districts сообщает, сколько в базе реальных и демонстрационных измерений. Пока измерения демонстрационные (синтетические), обязательно скажи об этом одной фразой, когда приводишь цифры. Не давай медицинских и юридических заключений; при опасных значениях советуй следить за официальными сообщениями Казгидромета и акимата.`;

type MapAction = { district_id?: string; metric?: string; month?: string };

function makeTools(actions: MapAction[]) {
  return [
    betaTool({
      name: "list_districts",
      description: "Список районов ЗКО: id, названия (рус./каз.), районный центр, площадь, станции мониторинга, предприятия I категории, основные источники воздействия. Плюс сколько в базе реальных и демо-измерений и за какие месяцы есть данные.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: async () => {
        const [geo, st, ent, months, real, demo] = await Promise.all([
          db.rpc("districts_geojson", { tolerance: 1 }),
          db.from("stations").select("name,district_id"),
          db.from("enterprises").select("name,oked,district_id"),
          db.from("district_monthly").select("month").order("month"),
          db.from("measurements").select("id", { count: "exact", head: true }).neq("source", "demo"),
          db.from("measurements").select("id", { count: "exact", head: true }).eq("source", "demo"),
        ]);
        const err = [geo, st, ent, months, real, demo].find((r) => r.error)?.error;
        if (err) throw new Error(err.message);
        const ms = (months.data ?? []).map((r) => String(r.month).slice(0, 7));
        return JSON.stringify({
          measurements: { real: real.count, demo: demo.count },
          months_available: ms.length ? { from: ms[0], to: ms[ms.length - 1] } : null,
          districts: (geo.data?.features ?? []).map((f: { id: string; properties: Record<string, unknown> }) => ({
            id: f.id,
            name_ru: f.properties.name, name_kk: f.properties.name_kk,
            center: f.properties.center, area_km2: f.properties.area_km2, is_city: f.properties.is_city,
            sources: f.properties.sources,
            stations: (st.data ?? []).filter((s) => s.district_id === f.id).map((s) => s.name),
            enterprises: (ent.data ?? []).filter((e) => e.district_id === f.id).map((e) => `${e.name} (${e.oked})`),
          })),
          enterprises_source: "ecokarta.kz (перечень предприятий I категории; точных координат нет)",
        });
      },
    }),
    betaTool({
      name: "get_monthly_data",
      description: "Помесячные средние значения показателей по районам (представление district_monthly). Фильтры необязательны; без фильтров вернёт всё. Месяцы в формате YYYY-MM.",
      inputSchema: {
        type: "object",
        properties: {
          district_ids: { type: "array", items: { type: "string" }, description: "id районов; пусто — все" },
          metrics: { type: "array", items: { type: "string", enum: METRICS }, description: "показатели; пусто — все" },
          from_month: { type: "string", description: "начало периода, YYYY-MM" },
          to_month: { type: "string", description: "конец периода, YYYY-MM" },
        },
        additionalProperties: false,
      },
      run: async (input: { district_ids?: string[]; metrics?: string[]; from_month?: string; to_month?: string }) => {
        let q = db.from("district_monthly").select("district_id,month,metric,value,n").order("month").limit(2000);
        if (input.district_ids?.length) q = q.in("district_id", input.district_ids);
        if (input.metrics?.length) q = q.in("metric", input.metrics);
        if (input.from_month) q = q.gte("month", `${input.from_month}-01`);
        if (input.to_month) q = q.lte("month", `${input.to_month}-01`);
        const { data, error } = await q;
        if (error) throw new Error(error.message);
        // компактно: район → показатель → {месяц: значение}
        const out: Record<string, Record<string, Record<string, number>>> = {};
        for (const r of data ?? []) {
          ((out[r.district_id] ??= {})[r.metric] ??= {})[String(r.month).slice(0, 7)] = Number(r.value);
        }
        return JSON.stringify(out);
      },
    }),
    betaTool({
      name: "find_stations_near",
      description: "Пространственный запрос PostGIS: станции мониторинга в радиусе от точки (долгота/широта WGS 84). Уральск ≈ 51.37, 51.23; Аксай ≈ 53.03, 51.17.",
      inputSchema: {
        type: "object",
        properties: {
          lon: { type: "number" }, lat: { type: "number" },
          radius_km: { type: "number", description: "радиус, км (1–500)" },
        },
        required: ["lon", "lat", "radius_km"],
        additionalProperties: false,
      },
      run: async (input: { lon: number; lat: number; radius_km: number }) => {
        const { data, error } = await db.rpc("stations_within", {
          lon: input.lon, lat: input.lat, radius_km: Math.min(500, Math.max(1, input.radius_km)),
        });
        if (error) throw new Error(error.message);
        return JSON.stringify(data);
      },
    }),
    betaTool({
      name: "show_on_map",
      description: "Показать на карте сайта район, режим карты (показатель или score — эко-индекс) и месяц. Вызывай, когда ответ касается конкретного района, показателя или месяца.",
      inputSchema: {
        type: "object",
        properties: {
          district_id: { type: "string" },
          metric: { type: "string", enum: [...METRICS, "score"] },
          month: { type: "string", description: "YYYY-MM" },
        },
        additionalProperties: false,
      },
      run: async (input: MapAction) => {
        actions.push(input);
        return "Карта на сайте обновится после ответа.";
      },
    }),
  ];
}

async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: { messages?: { role: string; content: string }[]; lang?: string };
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

  // только текстовые реплики user/assistant, последние MAX_HISTORY, первая — от пользователя
  const history = (body.messages ?? [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content.slice(0, m.role === "user" ? MAX_QUESTION : 4000) }));
  while (history.length && history[0].role !== "user") history.shift();
  const question = history.at(-1);
  if (!question || question.role !== "user") return json({ error: "no_question" }, 400);
  const lang = body.lang === "kk" ? "kk" : "ru";

  // лимиты: сутки на весь сайт и час на один IP
  const ipHash = await sha256((req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() + "ecogis");
  const dayAgo = new Date(Date.now() - 864e5).toISOString(), hourAgo = new Date(Date.now() - 36e5).toISOString();
  const [day, hour] = await Promise.all([
    admin.from("chat_log").select("id", { count: "exact", head: true }).gte("created_at", dayAgo),
    admin.from("chat_log").select("id", { count: "exact", head: true }).eq("ip_hash", ipHash).gte("created_at", hourAgo),
  ]);
  if ((day.count ?? 0) >= DAILY_LIMIT || (hour.count ?? 0) >= HOURLY_PER_IP) return json({ error: "rate_limited" }, 429);

  const actions: MapAction[] = [];
  const log = { ip_hash: ipHash, lang, question: question.content } as Record<string, unknown>;
  try {
    const final = await anthropic.beta.messages.toolRunner({
      model: MODEL,
      max_tokens: 16000,
      max_iterations: 8,
      output_config: { effort: "low" }, // чат: короткие ответы, мало размышлений
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default", // если запрос отклонят фильтры безопасности, его выполнит запасная модель
      cache_control: { type: "ephemeral" },
      system: SYSTEM,
      tools: makeTools(actions),
      messages: history,
    }).runUntilDone();

    log.input_tokens = final.usage.input_tokens;
    log.output_tokens = final.usage.output_tokens;
    if (final.stop_reason === "refusal") {
      log.error = "refusal";
      await admin.from("chat_log").insert(log);
      return json({ error: "refusal" }, 200);
    }
    const answer = final.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n").trim();
    log.answer = answer;
    await admin.from("chat_log").insert(log);
    return json({ answer, actions });
  } catch (e) {
    log.error = e instanceof Anthropic.APIError ? `${e.status} ${e.message}` : String(e);
    await admin.from("chat_log").insert(log);
    if (e instanceof Anthropic.RateLimitError) return json({ error: "busy" }, 503);
    if (e instanceof Anthropic.APIError) return json({ error: "ai_unavailable" }, 502);
    return json({ error: "server_error" }, 500);
  }
});
