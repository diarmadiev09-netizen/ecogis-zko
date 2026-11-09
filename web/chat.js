// ЭкоГИС ЗКО — ИИ-помощник. Работает прямо в браузере, без сервера:
// посетитель вставляет свой ключ Claude API, ключ хранится только в его браузере,
// запросы идут напрямую на api.anthropic.com. Данные Claude берёт из уже загруженного data.json
// через инструменты ниже. Использует глобальные D, DATA, MONTHS, STATIONS, ENTERPRISES, S, render… из app.js.
import Anthropic from 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.0.0/+esm';
import { betaTool } from 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.0.0/helpers/beta/json-schema/+esm';

const MODEL = 'claude-opus-5-5';
const KEY_STORE = 'ecogis-claude-key';
const METRIC_KEYS = ['aqi', 'wpi', 'soil', 'ndvi', 'precip'];

let apiKey = '';
try { apiKey = localStorage.getItem(KEY_STORE) || ''; } catch (e) { /* storage unavailable: key lives in memory only */ }
const CHAT = [];              // {role: 'user'|'assistant', content}
let busy = false, chatError = null;

// Неизменный системный промпт — кэшируется между запросами
const SYSTEM = `Ты — ИИ-помощник веб-ГИС «ЭкоГИС ЗКО»: мониторинг экологического состояния Западно-Казахстанской области (12 районов и г. Уральск). Проект студентов Қолқанат, Дияр и Аслан.

Отвечай на языке последнего вопроса пользователя: по-русски или по-казахски. Пиши коротко и по делу, без вступлений; списки — строками с «- ». Числа бери только из инструментов, не придумывай. Указывай месяц и единицы. Если данных нет — так и скажи.

Показатели (поле metric):
- aqi — индекс качества воздуха: ≤50 хороший, ≤100 умеренный, ≤150 вредный для чувствительных групп, >150 вредный (порог тревоги 150).
- wpi — индекс загрязнённости воды ИЗВ (по-казахски СЛИ): ≤0,3 очень чистая, ≤1 чистая, ≤2,5 умеренно загрязнённая, ≤4 загрязнённая, ≤6 грязная, >6 очень грязная (порог тревоги 3,5).
- soil — деградация почв, % площади: <15 слабая, <30 умеренная, <45 сильная, ≥45 очень сильная (порог тревоги 50).
- ndvi — вегетационный индекс: <0,15 скудная, <0,3 разреженная, <0,45 умеренная, иначе густая растительность. Зимой низкий — это нормально.
- precip — осадки за месяц, мм: <10 очень сухо, <20 сухо, <40 умеренно, иначе влажно. В эко-индекс не входят.
- score — эко-индекс района (0–100, выше — лучше), считается из AQI, ИЗВ, почв и пикового NDVI.

Если ответ касается конкретного района, показателя или месяца, вызови show_on_map, чтобы карта на сайте показала это пользователю.

Честность: все измерения на сайте сейчас демонстрационные — синтетические, сгенерированные скриптом с правдоподобными сезонными закономерностями. Когда приводишь цифры, обязательно скажи об этом одной фразой. Границы районов реальные (geoBoundaries), перечень предприятий I категории — с ecokarta.kz (у них известен только район). Не давай медицинских и юридических заключений; при опасных значениях советуй следить за официальными сообщениями Казгидромета и акимата.`;

function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371, rad = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * rad / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin((lon2 - lon1) * rad / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function makeTools(actions) {
  return [
    betaTool({
      name: 'list_districts',
      description: 'Районы ЗКО: id, названия (рус./каз.), районный центр, станции мониторинга, предприятия I категории, основные источники воздействия; и за какие месяцы есть данные.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => JSON.stringify({
        months_available: { from: MONTHS[0], to: MONTHS[MONTHS.length - 1] },
        districts: D.map(d => ({
          id: d.id, name_ru: d.name, name_kk: d.name_kk, center: d.center, is_city: d.is_city, sources: d.sources,
          stations: STATIONS.filter(s => s.district_id === d.id).map(s => s.name),
          enterprises: ENTERPRISES.filter(e => e.district_id === d.id).map(e => `${e.name} (${e.oked})`),
        })),
      }),
    }),
    betaTool({
      name: 'get_monthly_data',
      description: 'Помесячные средние значения показателей по районам, включая эко-индекс score. Фильтры необязательны; без фильтров вернёт всё. Месяцы в формате YYYY-MM.',
      inputSchema: {
        type: 'object',
        properties: {
          district_ids: { type: 'array', items: { type: 'string' }, description: 'id районов; пусто — все' },
          metrics: { type: 'array', items: { type: 'string', enum: [...METRIC_KEYS, 'score'] }, description: 'показатели; пусто — все' },
          from_month: { type: 'string', description: 'начало периода, YYYY-MM' },
          to_month: { type: 'string', description: 'конец периода, YYYY-MM' },
        },
        additionalProperties: false,
      },
      run: async (input) => {
        const ids = input.district_ids?.length ? input.district_ids : D.map(d => d.id);
        const ks = input.metrics?.length ? input.metrics : [...METRIC_KEYS, 'score'];
        const out = {};
        for (const id of ids) {
          if (!DATA[id]) continue;
          out[id] = {};
          for (const k of ks) {
            out[id][k] = {};
            MONTHS.forEach((m, t) => {
              if ((input.from_month && m < input.from_month) || (input.to_month && m > input.to_month)) return;
              const v = DATA[id][t][k];
              if (v != null) out[id][k][m] = v;
            });
          }
        }
        return JSON.stringify(out);
      },
    }),
    betaTool({
      name: 'find_stations_near',
      description: 'Станции мониторинга в радиусе от точки (долгота/широта WGS 84), с расстоянием по большому кругу. Уральск ≈ 51.37, 51.23; Аксай ≈ 53.03, 51.17.',
      inputSchema: {
        type: 'object',
        properties: { lon: { type: 'number' }, lat: { type: 'number' }, radius_km: { type: 'number', description: 'радиус, км' } },
        required: ['lon', 'lat', 'radius_km'],
        additionalProperties: false,
      },
      run: async ({ lon, lat, radius_km }) => JSON.stringify(STATIONS
        .map(s => ({ name: s.name, district_id: s.district_id, distance_km: Math.round(distanceKm(lat, lon, s.lat, s.lon) * 10) / 10 }))
        .filter(s => s.distance_km <= radius_km)
        .sort((a, b) => a.distance_km - b.distance_km)),
    }),
    betaTool({
      name: 'show_on_map',
      description: 'Показать на карте сайта район, режим карты (показатель или score — эко-индекс) и месяц. Вызывай, когда ответ касается конкретного района, показателя или месяца.',
      inputSchema: {
        type: 'object',
        properties: {
          district_id: { type: 'string' },
          metric: { type: 'string', enum: [...METRIC_KEYS, 'score'] },
          month: { type: 'string', description: 'YYYY-MM' },
        },
        additionalProperties: false,
      },
      run: async (input) => { actions.push(input); return 'Карта на сайте обновится после ответа.'; },
    }),
  ];
}

function applyMapActions(actions) {
  const a = actions.at(-1);
  if (!a || !T) return;
  if (a.district_id && byId[a.district_id]) S.sel = a.district_id;
  if (a.metric && MODES[a.metric]) S.mode = a.metric;
  if (a.month && MONTHS.includes(a.month)) S.t = MONTHS.indexOf(a.month);
  render();
}

function errorText(e) {
  const E = tr().chatErrors;
  if (e instanceof Anthropic.AuthenticationError) return E.auth;
  if (e instanceof Anthropic.PermissionDeniedError) return E.permission;
  if (e instanceof Anthropic.RateLimitError) return E.rate;
  if (e instanceof Anthropic.APIConnectionError) return E.network;
  if (e instanceof Anthropic.APIError) return `${E.api} ${e.status ?? ''} ${e.message}`.trim();
  return `${E.api} ${e?.message || e}`;
}

async function ask(q) {
  q = q.trim();
  if (!apiKey || busy || !q || !T) return;
  CHAT.push({ role: 'user', content: q.slice(0, 1000) });
  busy = true; chatError = null; renderChat();
  const actions = [];
  try {
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    const final = await client.beta.messages.toolRunner({
      model: MODEL,
      max_tokens: 16000,
      max_iterations: 8,
      output_config: { effort: 'low' },              // чат: короткие ответы, мало размышлений
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',                         // если запрос отклонят фильтры безопасности, ответит запасная модель
      cache_control: { type: 'ephemeral' },
      system: SYSTEM,
      tools: makeTools(actions),
      messages: CHAT.slice(-12).map(m => ({ role: m.role, content: m.content })),
    }).runUntilDone();
    if (final.stop_reason === 'refusal') throw Object.assign(new Error('refusal'), { refusal: true });
    const answer = final.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    CHAT.push({ role: 'assistant', content: answer || '—' });
    applyMapActions(actions);
  } catch (e) {
    console.error(e);
    chatError = e.refusal ? tr().chatErrors.refusal : errorText(e);
    CHAT.pop();
  }
  busy = false; renderChat();
  if (!chatError) $('chatInput').focus();
}

// безопасная мини-разметка: экранирование, **жирный**, списки «- »
function md(s) {
  const lines = esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').split('\n');
  let html = '', inList = false;
  for (const l of lines) {
    const m = l.match(/^\s*[-•]\s+(.*)/);
    if (m) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${m[1]}</li>`; continue; }
    if (inList) { html += '</ul>'; inList = false; }
    if (l.trim()) html += `<p>${l}</p>`;
  }
  return html + (inList ? '</ul>' : '');
}

function renderKey() {
  const L = tr();
  if (apiKey) {
    $('chatKey').innerHTML = `<span>${L.keySaved}</span> <button type="button" class="linkish" id="keyForget">${L.keyForget}</button>`;
    $('keyForget').addEventListener('click', () => {
      apiKey = '';
      try { localStorage.removeItem(KEY_STORE); } catch (e) { /* storage unavailable */ }
      renderChat();
    });
    return;
  }
  $('chatKey').innerHTML = `<form id="keyForm" class="key-form">
      <p>${L.keyIntro} <a href="https://platform.claude.com/settings/keys">platform.claude.com</a></p>
      <label for="keyInput">${L.keyLabel}</label>
      <div class="key-row"><input id="keyInput" type="password" autocomplete="off" spellcheck="false" placeholder="sk-ant-…" required>
      <button class="btn" type="submit">${L.keySave}</button></div>
      <p class="warn">${L.keyShared}</p>
    </form>`;
  $('keyForm').addEventListener('submit', e => {
    e.preventDefault();
    apiKey = $('keyInput').value.trim();
    try { localStorage.setItem(KEY_STORE, apiKey); } catch (err) { /* storage unavailable: keep for this visit */ }
    renderChat(); $('chatInput').focus();
  });
}

function renderChat() {
  const L = tr();
  renderKey();
  const bubbles = [`<div class="msg bot">${md(L.chatHello)}</div>`, ...CHAT.map(m => `<div class="msg ${m.role === 'user' ? 'me' : 'bot'}">${md(m.content)}</div>`)];
  if (busy) bubbles.push(`<div class="msg bot typing">${L.thinking}</div>`);
  if (chatError) bubbles.push(`<div class="msg sys err">${esc(chatError)}</div>`);
  $('chatLog').innerHTML = bubbles.join('');
  $('chatLog').scrollTop = $('chatLog').scrollHeight;
  $('chatExamples').innerHTML = CHAT.length ? '' : L.chatExamples.map(q => `<button type="button" class="ex"${apiKey ? '' : ' disabled'}>${esc(q)}</button>`).join('');
  $('chatExamples').querySelectorAll('button').forEach(b => b.addEventListener('click', () => ask(b.textContent)));
  $('chatInput').placeholder = L.chatPlaceholder;
  $('chatInput').disabled = $('chatSend').disabled = !apiKey || busy;
}

$('chatBtn').addEventListener('click', () => {
  const d = $('chatDrawer'); d.hidden = !d.hidden;
  if (!d.hidden) { renderChat(); (apiKey ? $('chatInput') : $('keyInput'))?.focus(); }
});
$('chatClose').addEventListener('click', () => { $('chatDrawer').hidden = true; });
$('chatForm').addEventListener('submit', e => { e.preventDefault(); const v = $('chatInput').value; $('chatInput').value = ''; ask(v); });
$('chatInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('chatForm').requestSubmit(); } });
document.addEventListener('ecogis:lang', () => { if (!$('chatDrawer').hidden) renderChat(); });
