// ЭкоГИС ЗКО — ИИ-помощник. Работает прямо в браузере, без сервера:
// посетитель выбирает сервис ИИ и вставляет свой ключ; ключ хранится только в его браузере
// и отправляется только выбранному сервису. Claude — через официальный SDK Anthropic,
// остальные сервисы — через OpenAI-совместимый API (chat/completions с вызовом функций).
// Данные берутся из уже загруженного data.json через инструменты ниже.
// Использует глобальные D, DATA, MONTHS, STATIONS, ENTERPRISES, S, render… из app.js.
import Anthropic from 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.0.0/+esm';
import { betaTool } from 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.0.0/helpers/beta/json-schema/+esm';

const CLAUDE_MODEL = 'claude-opus-5-5';
const STORE = 'ecogis-ai';
const METRIC_KEYS = ['aqi', 'wpi', 'soil', 'ndvi', 'precip'];
const MAX_STEPS = 8;

// Все проверены: разрешают запросы из браузера (CORS)
const PROVIDERS = {
  claude:     { label: 'Claude (Anthropic)', keysUrl: 'https://platform.claude.com/settings/keys', hint: 'sk-ant-…' },
  openai:     { label: 'OpenAI (ChatGPT)', base: 'https://api.openai.com/v1', keysUrl: 'https://platform.openai.com/api-keys', hint: 'sk-…' },
  gemini:     { label: 'Google Gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai', keysUrl: 'https://aistudio.google.com/apikey', hint: 'AIza…' },
  openrouter: { label: 'OpenRouter', base: 'https://openrouter.ai/api/v1', keysUrl: 'https://openrouter.ai/keys', hint: 'sk-or-…' },
  groq:       { label: 'Groq', base: 'https://api.groq.com/openai/v1', keysUrl: 'https://console.groq.com/keys', hint: 'gsk_…' },
  deepseek:   { label: 'DeepSeek', base: 'https://api.deepseek.com/v1', keysUrl: 'https://platform.deepseek.com/api_keys', hint: 'sk-…' },
  mistral:    { label: 'Mistral', base: 'https://api.mistral.ai/v1', keysUrl: 'https://console.mistral.ai/api-keys', hint: '…' },
  custom:     { label: null, base: '', keysUrl: null, hint: '…' }, // любой OpenAI-совместимый адрес
};
const provLabel = p => PROVIDERS[p].label || tr().customProvider;

// ---------------- settings (only in this browser) ----------------
let cfg = { provider: 'claude', keys: {}, models: {}, base: '' };
try {
  const saved = JSON.parse(localStorage.getItem(STORE) || 'null');
  if (saved && PROVIDERS[saved.provider]) cfg = { ...cfg, ...saved };
  const old = localStorage.getItem('ecogis-claude-key'); // ключ из прошлой версии сайта
  if (old && !cfg.keys.claude) { cfg.keys.claude = old; localStorage.removeItem('ecogis-claude-key'); saveCfg(); }
} catch (e) { /* storage unavailable: settings live for this visit only */ }
function saveCfg() { try { localStorage.setItem(STORE, JSON.stringify(cfg)); } catch (e) { /* storage unavailable */ } }
const keyOf = () => cfg.keys[cfg.provider] || '';
const baseOf = () => (cfg.provider === 'custom' ? cfg.base : PROVIDERS[cfg.provider].base).replace(/\/+$/, '');
const modelOf = () => cfg.provider === 'claude' ? CLAUDE_MODEL : (cfg.models[cfg.provider] || '');
const ready = () => !!keyOf() && !!modelOf() && (cfg.provider !== 'custom' || !!cfg.base);

const CHAT = [];              // {role: 'user'|'assistant', content}
let busy = false, chatError = null, editing = false;
const MODEL_LIST = {};        // provider → ['id', …] | 'loading' | 'failed'

// ---------------- prompt and tools (shared by every provider) ----------------
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

// Описание инструментов без привязки к сервису: {name, description, inputSchema, run}
function makeTools(actions) {
  return [
    {
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
    },
    {
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
    },
    {
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
    },
    {
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
    },
  ];
}

// ---------------- Claude: Anthropic SDK + tool runner ----------------
async function askClaude(history, tools) {
  const client = new Anthropic({ apiKey: keyOf(), dangerouslyAllowBrowser: true });
  const final = await client.beta.messages.toolRunner({
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    max_iterations: MAX_STEPS,
    output_config: { effort: 'low' },              // чат: короткие ответы, мало размышлений
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',                         // если запрос отклонят фильтры безопасности, ответит запасная модель
    cache_control: { type: 'ephemeral' },
    system: SYSTEM,
    tools: tools.map(t => betaTool(t)),
    messages: history,
  }).runUntilDone();
  if (final.stop_reason === 'refusal') throw Object.assign(new Error('refusal'), { refusal: true });
  return final.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

// ---------------- other providers: OpenAI-compatible chat/completions ----------------
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
async function api(path, init = {}) {
  const res = await fetch(baseOf() + path, {
    ...init,
    headers: { Authorization: `Bearer ${keyOf()}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  const text = await res.text();
  let body = null; try { body = JSON.parse(text); } catch (e) { /* not JSON */ }
  if (!res.ok) {
    const err = Array.isArray(body) ? body[0]?.error : body?.error;
    throw new HttpError(res.status, (typeof err === 'string' ? err : err?.message) || text.slice(0, 200) || res.statusText);
  }
  return body;
}
async function askCompatible(history, tools) {
  const messages = [{ role: 'system', content: SYSTEM }, ...history];
  const fnTools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
  for (let step = 0; step < MAX_STEPS; step++) {
    const data = await api('/chat/completions', { method: 'POST', body: JSON.stringify({ model: modelOf(), messages, tools: fnTools }) });
    const msg = data?.choices?.[0]?.message;
    if (!msg) throw new HttpError(0, 'empty response');
    const calls = msg.tool_calls || [];
    if (!calls.length) return (msg.content || '').trim();
    messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: calls });
    for (const call of calls) {
      const tool = tools.find(t => t.name === call.function?.name);
      let out;
      try {
        const args = JSON.parse(call.function?.arguments || '{}');
        out = tool ? await tool.run(args) : `Unknown tool: ${call.function?.name}`;
      } catch (e) { out = `Error: ${e.message}`; }
      messages.push({ role: 'tool', tool_call_id: call.id, content: out });
    }
  }
  return tr().tooManySteps;
}
async function loadModels(p) {
  if (MODEL_LIST[p] === 'loading') return;
  MODEL_LIST[p] = 'loading'; renderChat();
  try {
    const data = await api('/models');
    const skip = /(embed|whisper|tts|audio|image|imagen|dall|moderation|transcri|realtime|rerank|guard|vision-preview|aqa|veo|search)/i;
    let rows = data?.data || data?.models || [];
    if (rows.some(r => Array.isArray(r.supported_parameters))) rows = rows.filter(r => !r.supported_parameters || r.supported_parameters.includes('tools'));
    const ids = rows.map(r => String(r.id || r.name || '').replace(/^models\//, '')).filter(id => id && !skip.test(id));
    MODEL_LIST[p] = ids.length ? [...new Set(ids)].sort() : 'failed';
    if (Array.isArray(MODEL_LIST[p]) && !MODEL_LIST[p].includes(cfg.models[p])) { cfg.models[p] = MODEL_LIST[p][0]; saveCfg(); }
  } catch (e) {
    console.error(e);
    MODEL_LIST[p] = 'failed';
    if (isAuthError(e) || e.status === 403) chatError = tr().chatErrors.auth;
  }
  renderChat();
}

// ---------------- conversation ----------------
function applyMapActions(actions) {
  const a = actions.at(-1);
  if (!a || !T) return;
  if (a.district_id && byId[a.district_id]) S.sel = a.district_id;
  if (a.metric && MODES[a.metric]) S.mode = a.metric;
  if (a.month && MONTHS.includes(a.month)) S.t = MONTHS.indexOf(a.month);
  render();
}
// Gemini отвечает на неверный ключ кодом 400, а не 401
const isAuthError = e => e instanceof Anthropic.AuthenticationError || e.status === 401 || (e.status === 400 && /api.?key/i.test(e.message || ''));
function errorText(e) {
  const E = tr().chatErrors;
  if (e.refusal) return E.refusal;
  if (isAuthError(e)) return E.auth;
  if (e instanceof Anthropic.PermissionDeniedError || e.status === 403) return E.permission;
  if (e instanceof Anthropic.RateLimitError || e.status === 429) return E.rate;
  if (e instanceof Anthropic.APIConnectionError || e instanceof TypeError) return E.network;
  return `${E.api} ${e.status || ''} ${e.message || e}`.replace(/\s+/g, ' ').trim();
}
async function ask(q) {
  q = q.trim();
  if (!ready() || busy || !q || !T) return;
  CHAT.push({ role: 'user', content: q.slice(0, 1000) });
  busy = true; chatError = null; renderChat();
  const actions = [], tools = makeTools(actions);
  const history = CHAT.slice(-12).map(m => ({ role: m.role, content: m.content }));
  try {
    const answer = cfg.provider === 'claude' ? await askClaude(history, tools) : await askCompatible(history, tools);
    CHAT.push({ role: 'assistant', content: answer || '—' });
    applyMapActions(actions);
  } catch (e) {
    console.error(e);
    chatError = errorText(e);
    CHAT.pop();
  }
  busy = false; renderChat();
  if (!chatError) $('chatInput').focus();
}

// ---------------- UI ----------------
// безопасная мини-разметка: экранирование, **жирный**, списки «- »
function md(s) {
  const lines = esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').split('\n');
  let html = '', inList = false;
  for (const l of lines) {
    const m = l.match(/^\s*[-•*]\s+(.*)/);
    if (m) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${m[1]}</li>`; continue; }
    if (inList) { html += '</ul>'; inList = false; }
    if (l.trim()) html += `<p>${l.replace(/^#+\s*/, '')}</p>`;
  }
  return html + (inList ? '</ul>' : '');
}

function renderSettings() {
  const L = tr(), p = cfg.provider, P = PROVIDERS[p];
  if (keyOf() && !editing) {
    let model;
    if (p === 'claude') model = `<code>${CLAUDE_MODEL}</code>`;
    else if (Array.isArray(MODEL_LIST[p])) model = `<select id="modelSel" aria-label="${L.model}">${MODEL_LIST[p].map(id => `<option${id === cfg.models[p] ? ' selected' : ''}>${esc(id)}</option>`).join('')}</select>`;
    else if (MODEL_LIST[p] === 'failed') model = `<input id="modelInput" aria-label="${L.model}" value="${esc(cfg.models[p] || '')}" placeholder="${L.modelPlaceholder}">`;
    else model = `<span>${L.loadingModels}</span>`;
    $('chatKey').innerHTML = `<div class="ai-now"><b>${esc(provLabel(p))}</b> · ${L.model}: ${model}</div>
      ${MODEL_LIST[p] === 'failed' && p !== 'claude' ? `<p class="warn">${L.modelsFail}</p>` : ''}
      <div class="ai-actions"><button type="button" class="linkish" id="aiChange">${L.changeProvider}</button> · <button type="button" class="linkish" id="keyForget">${L.keyForget}</button> <span>· ${L.keySaved}</span></div>`;
    $('aiChange').addEventListener('click', () => { editing = true; renderChat(); });
    $('keyForget').addEventListener('click', () => { delete cfg.keys[p]; saveCfg(); renderChat(); });
    $('modelSel')?.addEventListener('change', e => { cfg.models[p] = e.target.value; saveCfg(); renderChat(); });
    $('modelInput')?.addEventListener('change', e => { cfg.models[p] = e.target.value.trim(); saveCfg(); renderChat(); });
    if (p !== 'claude' && MODEL_LIST[p] === undefined) loadModels(p);
    return;
  }
  $('chatKey').innerHTML = `<form id="keyForm" class="key-form">
      <p>${L.keyIntro}</p>
      <label for="provSel">${L.providerLabel}</label>
      <select id="provSel">${Object.keys(PROVIDERS).map(k => `<option value="${k}"${k === p ? ' selected' : ''}>${esc(provLabel(k))}</option>`).join('')}</select>
      ${p === 'custom' ? `<label for="baseInput">${L.baseUrl}</label><input id="baseInput" type="url" required placeholder="https://…/v1" value="${esc(cfg.base)}">` : ''}
      <label for="keyInput">${L.keyLabel}</label>
      <div class="key-row"><input id="keyInput" type="password" autocomplete="off" spellcheck="false" placeholder="${P.hint}" value="${esc(cfg.keys[p] || '')}" required>
      <button class="btn" type="submit">${L.keySave}</button></div>
      ${P.keysUrl ? `<p>${L.whereKey} <a href="${P.keysUrl}">${esc(new URL(P.keysUrl).host)}</a></p>` : ''}
      <p class="warn">${L.keyShared}</p>
    </form>`;
  $('provSel').addEventListener('change', e => { cfg.provider = e.target.value; saveCfg(); chatError = null; renderChat(); });
  $('keyForm').addEventListener('submit', e => {
    e.preventDefault();
    cfg.keys[p] = $('keyInput').value.trim();
    if (p === 'custom') { cfg.base = $('baseInput').value.trim(); delete MODEL_LIST.custom; }
    delete MODEL_LIST[p];
    editing = false; chatError = null; saveCfg(); renderChat();
    $('chatInput').focus();
  });
}

function renderChat() {
  const L = tr();
  renderSettings();
  const bubbles = [`<div class="msg bot">${md(L.chatHello)}</div>`, ...CHAT.map(m => `<div class="msg ${m.role === 'user' ? 'me' : 'bot'}">${md(m.content)}</div>`)];
  if (busy) bubbles.push(`<div class="msg bot typing">${L.thinking}</div>`);
  if (chatError) bubbles.push(`<div class="msg sys err">${esc(chatError)}</div>`);
  $('chatLog').innerHTML = bubbles.join('');
  $('chatLog').scrollTop = $('chatLog').scrollHeight;
  $('chatExamples').innerHTML = CHAT.length ? '' : L.chatExamples.map(q => `<button type="button" class="ex"${ready() ? '' : ' disabled'}>${esc(q)}</button>`).join('');
  $('chatExamples').querySelectorAll('button').forEach(b => b.addEventListener('click', () => ask(b.textContent)));
  $('chatInput').placeholder = L.chatPlaceholder;
  $('chatInput').disabled = $('chatSend').disabled = !ready() || busy;
}

$('chatBtn').addEventListener('click', () => {
  const d = $('chatDrawer'); d.hidden = !d.hidden;
  if (!d.hidden) { renderChat(); (ready() ? $('chatInput') : $('keyInput'))?.focus(); }
});
$('chatClose').addEventListener('click', () => { $('chatDrawer').hidden = true; });
$('chatForm').addEventListener('submit', e => { e.preventDefault(); const v = $('chatInput').value; $('chatInput').value = ''; ask(v); });
$('chatInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('chatForm').requestSubmit(); } });
document.addEventListener('ecogis:lang', () => { if (!$('chatDrawer').hidden) renderChat(); });
