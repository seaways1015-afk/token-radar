// AI 深度分析：把近 30 天的用量统计（匿名化后）交给用户自己配置的大模型，生成更具体的发现和建议。
// 只在用户点击时调用；API Key 只存本机（桌面版用系统加密），不会返回给页面。
const fs = require('fs');
const { dataFile } = require('./paths');
const { costOf } = require('./pricing');
const { SOURCES } = require('./collector');
const { projectKey } = require('./stats');

const CONFIG_FILE = dataFile('ai.json');
const LAST_FILE = dataFile('ai.last.json');
const DEBUG_FILE = dataFile('ai.debug.txt'); // 最近一次解析失败时模型的原始回复

// 两种协议覆盖绝大多数服务：Anthropic 原生，或 OpenAI 兼容（DeepSeek / Kimi / 通义 / OpenRouter / 中转站……）
const PRESETS = {
  anthropic: { label: 'Anthropic Claude', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5' },
  deepseek: { label: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash' },
  openai: { label: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', model: '' },
  moonshot: { label: 'Kimi（Moonshot）', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1', model: '' },
  dashscope: { label: '通义千问（阿里云百炼）', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: '' },
  openrouter: { label: 'OpenRouter', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: '' },
  'custom-openai': { label: '自定义（OpenAI 兼容）', protocol: 'openai', baseUrl: '', model: '' },
  'custom-anthropic': { label: '自定义（Anthropic 兼容）', protocol: 'anthropic', baseUrl: '', model: '' },
};

// Claude API 上支持 fallbacks: "default" 的模型：遇到安全分类器误拒时由服务端自动换模型重试
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
const EFFORT_MODELS = /^claude-(fable-5|mythos-5|opus-5|sonnet-5|opus-4-[5-8])/;

const DAY = 86400e3;

// ---------- 配置与密钥 ----------
function safeStorage() {
  if (!process.versions.electron) return null;
  try {
    const { safeStorage: s } = require('electron');
    return s && s.isEncryptionAvailable() ? s : null;
  } catch { return null; }
}
function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } }
function writeJson(p, v) {
  fs.mkdirSync(require('path').dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2), { mode: 0o600 });
}

function loadConfig() { return readJson(CONFIG_FILE, { preset: 'deepseek', ...PRESETS.deepseek, key: null }); }

function getKey(cfg) {
  if (!cfg.key) return null;
  if (cfg.key.enc) {
    const s = safeStorage();
    if (!s) return null;
    try { return s.decryptString(Buffer.from(cfg.key.data, 'base64')); } catch { return null; }
  }
  return cfg.key.data || null;
}
function packKey(k) {
  const s = safeStorage();
  return s ? { enc: true, data: s.encryptString(k).toString('base64') } : { enc: false, data: k };
}
const host = (u) => { try { return new URL(u).host; } catch { return ''; } };

function publicConfig() {
  const cfg = loadConfig();
  const k = getKey(cfg);
  const preset = PRESETS[cfg.preset] || PRESETS['custom-openai'];
  return {
    preset: cfg.preset, label: preset.label, protocol: cfg.protocol || preset.protocol,
    baseUrl: cfg.baseUrl || '', model: cfg.model || '',
    hasKey: !!k, keyHint: k ? k.slice(0, 3) + '…' + k.slice(-4) : '', encrypted: !!(cfg.key && cfg.key.enc),
    ready: !!(k && cfg.model && (cfg.baseUrl || preset.baseUrl)),
  };
}

function setConfig(body) {
  const cur = loadConfig();
  const preset = PRESETS[body.preset] ? body.preset : cur.preset;
  const def = PRESETS[preset];
  const baseUrl = String(body.baseUrl ?? cur.baseUrl ?? def.baseUrl).trim().replace(/\/+$/, '');
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) throw new Error('接口地址需要以 http:// 或 https:// 开头');
  const next = { preset, protocol: def.protocol, baseUrl, model: String(body.model ?? cur.model ?? '').trim(), key: cur.key };
  // 换了服务地址又没提供新 Key：清掉旧 Key，避免把它发到新的地址
  if (host(baseUrl) !== host(cur.baseUrl || '') && !body.apiKey) next.key = null;
  if (typeof body.apiKey === 'string' && body.apiKey.trim()) next.key = packKey(body.apiKey.trim());
  if (body.apiKey === null) next.key = null;
  writeJson(CONFIG_FILE, next);
  return publicConfig();
}

// ---------- 匿名化的统计数据 ----------
function buildPayload({ records, plans, limitHist, limits, ruleFindings = [], now = Date.now() }) {
  const since = now - 30 * DAY;
  const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
  const tok = (r) => r.in + r.out + r.cr + r.cw5 + r.cw1h;
  const tools = {}, projects = {}, daily = {}, hours = new Array(24).fill(0), weekdays = new Array(7).fill(0), providers = {};
  for (let i = records.length - 1; i >= 0 && records[i].t >= since; i--) {
    const r = records[i];
    const c = costOf(r);
    const sub = !!(plans[r.src] && plans[r.src].subscription);
    const t = tools[r.src] || (tools[r.src] = { requests: 0, sessions: new Set(), new_input: 0, output: 0, cache_read: 0, cache_write: 0, api_equivalent_usd: 0, paid_usd: 0, unpriced_tokens: 0, background_tokens: 0, models: {} });
    t.requests++; t.sessions.add(r.session);
    t.new_input += r.in; t.output += r.out; t.cache_read += r.cr; t.cache_write += r.cw5 + r.cw1h;
    if (c) { t.api_equivalent_usd += c.cost; if (!sub) t.paid_usd += c.cost; } else t.unpriced_tokens += tok(r);
    if (r.side) t.background_tokens += tok(r);
    const mk = (r.provider ? r.provider + '/' : '') + r.model;
    const m = t.models[mk] || (t.models[mk] = { tokens: 0, usd: 0 });
    m.tokens += tok(r); if (c) m.usd += c.cost;

    const d = new Date(r.t);
    const day = `${d.getMonth() + 1}/${d.getDate()}`;
    const dd = daily[day] || (daily[day] = { tokens: 0, usd: 0 });
    dd.tokens += tok(r); if (c) dd.usd += c.cost;
    hours[d.getHours()] += tok(r);
    weekdays[d.getDay()] += tok(r);

    const pk = projectKey(r.project);
    const p = projects[pk] || (projects[pk] = { name: r.project, tokens: 0, api_equivalent_usd: 0, paid_usd: 0, requests: 0, sessions: new Set(), days: new Set(), in: 0, cr: 0, cw: 0, tools: {} });
    p.tokens += tok(r); p.requests++; p.sessions.add(r.src + r.session); p.days.add(day);
    p.in += r.in; p.cr += r.cr; p.cw += r.cw5 + r.cw1h;
    p.tools[r.src] = (p.tools[r.src] || 0) + tok(r);
    if (c) { p.api_equivalent_usd += c.cost; if (!sub) p.paid_usd += c.cost; }

    const pv = (r.provider || { claude: 'anthropic', codex: 'openai' }[r.src] || 'unknown');
    const pp = providers[pv] || (providers[pv] = { billing: new Set(), tokens: 0, usd: 0 });
    pp.billing.add(sub ? 'subscription' : 'pay_as_you_go'); pp.tokens += tok(r); if (c) pp.usd += c.cost;
  }

  // 项目匿名化：按用量排序后依次命名为 项目A、项目B…
  const mapping = {};
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const projList = Object.values(projects).sort((a, b) => b.tokens - a.tokens).slice(0, 12).map((p, i) => {
    const alias = '项目' + (letters[i] || String(i + 1));
    mapping[alias] = (p.name || '').split(/[\\/]/).filter(Boolean).pop() || p.name || '未知项目';
    const total = p.tokens || 1;
    return {
      project: alias, requests: p.requests, sessions: p.sessions.size, active_days: p.days.size,
      tokens: p.tokens, api_equivalent_usd: round(p.api_equivalent_usd), paid_usd: round(p.paid_usd),
      cache_hit_rate: round(p.cr / Math.max(1, p.in + p.cr + p.cw)),
      tool_share: Object.fromEntries(Object.entries(p.tools).map(([k, v]) => [SOURCES[k] ? SOURCES[k].label : k, round(v / total)])),
    };
  });

  const toolList = Object.entries(tools).map(([src, t]) => {
    const plan = plans[src];
    const total = t.new_input + t.output + t.cache_read + t.cache_write || 1;
    return {
      tool: SOURCES[src] ? SOURCES[src].label : src,
      billing: plan && plan.subscription ? `订阅 ${plan.label}${plan.monthly ? `（$${plan.monthly}/月）` : ''}` : '按量计费',
      requests: t.requests, sessions: t.sessions.size,
      tokens: { new_input: t.new_input, output: t.output, cache_read: t.cache_read, cache_write: t.cache_write },
      cache_hit_rate: round(t.cache_read / Math.max(1, t.new_input + t.cache_read + t.cache_write)),
      api_equivalent_usd: round(t.api_equivalent_usd), paid_usd: round(t.paid_usd), unpriced_tokens: t.unpriced_tokens,
      background_share: round(t.background_tokens / total),
      top_models: Object.entries(t.models).sort((a, b) => b[1].tokens - a[1].tokens).slice(0, 5).map(([model, m]) => ({ model, tokens: m.tokens, usd: round(m.usd) })),
    };
  });

  // Codex 额度：当前状态 + 近 30 天每个 5 小时窗口的峰值，以及触顶发生在一天中的哪个小时
  let quota = null;
  const lim = limits.codex;
  if (lim) {
    const wins = new Map();
    for (const x of limitHist) {
      if (x.t < since || x.pr == null || x.p == null) continue;
      const k = Math.round(x.pr / 1800);
      const w = wins.get(k) || { max: 0, hitAt: null };
      if (x.p >= 95 && w.hitAt == null) w.hitAt = x.t;
      w.max = Math.max(w.max, x.p);
      wins.set(k, w);
    }
    const hitHours = new Array(24).fill(0);
    for (const w of wins.values()) if (w.hitAt) hitHours[new Date(w.hitAt).getHours()]++;
    const hrs = (s) => (s ? round((s * 1000 - now) / 3600e3, 1) : null);
    quota = {
      note: 'Codex 订阅额度，used_pct 为已用百分比',
      five_hour: lim.primary ? { used_pct: lim.primary.used_percent, resets_in_hours: hrs(lim.primary.resets_at) } : null,
      weekly: lim.secondary ? { used_pct: lim.secondary.used_percent, resets_in_hours: hrs(lim.secondary.resets_at) } : null,
      five_hour_windows_30d: { total: wins.size, reached_95pct: [...wins.values()].filter((w) => w.max >= 95).length, reached_80pct: [...wins.values()].filter((w) => w.max >= 80).length },
      hour_of_day_when_reached_95pct: hitHours,
    };
  }

  const sumH = hours.reduce((a, b) => a + b, 0) || 1;
  const sumW = weekdays.reduce((a, b) => a + b, 0) || 1;
  const data = {
    period: '近 30 天', generated_at: new Date(now).toLocaleString('zh-CN', { hour12: false }),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    notes: [
      'api_equivalent_usd 是按 API 公开价折算的等价费用；订阅工具不会真的按这个扣费。paid_usd 才是按量计费的真实花费。',
      'cache_hit_rate = cache_read / (new_input + cache_read + cache_write)。',
      'background_share 是子代理、自动审查、上下文压缩等不在对话里显示的请求所占比例。',
      '项目名已匿名化为“项目A”等代号。',
    ],
    tools: toolList,
    providers: Object.entries(providers).map(([name, p]) => ({ provider: name, billing: [...p.billing], tokens: p.tokens, api_equivalent_usd: round(p.usd) })),
    codex_quota: quota,
    usage_by_hour_of_day_pct: hours.map((v) => round(v / sumH * 100, 1)),
    usage_by_weekday_pct: Object.fromEntries(['周日', '周一', '周二', '周三', '周四', '周五', '周六'].map((k, i) => [k, round(weekdays[i] / sumW * 100, 1)])),
    daily: Object.entries(daily).reverse().map(([date, v]) => ({ date, tokens: v.tokens, usd: round(v.usd) })),
    projects: projList,
    rule_findings: ruleFindings.map((x) => x.title),
  };
  return { data, mapping };
}

// ---------- 调用模型 ----------
const SYSTEM = `你是一名 AI 编程工具的用量与成本分析师。用户会给你一份本机近 30 天的用量统计（JSON，已匿名化，项目用“项目A”这类代号）。
请找出最值得用户知道、并且能据此采取行动的发现，输出 3 到 6 条。要求：
- 只依据给出的数据，不要编造数据里没有的数字；引用的数字必须能在数据里找到或直接算出。
- 优先关注：浪费或风险（额度触顶、花费异常、缓存效率低、后台消耗），使用模式（时段、星期、项目、工具分工），以及能省钱或提高效率的具体做法。
- 建议要具体到做法和时间点，避免空泛的套话。
- rule_findings 是规则体检已经给出的结论，不要简单重复；除非你能给出更深入的原因分析或更具体的做法。
- 订阅工具的 api_equivalent_usd 是折算值，不是真实扣费；只有 paid_usd 是真实花费。
- 提到项目时保留“项目A”这类代号原样，每个项目都写完整代号（写“项目A和项目B”，不要缩写成“项目A/B”）。
- 用简体中文。标题不超过 20 个字，正文 1 到 3 句，evidence 写出这条用到的关键数字。
- level：warn 表示需要注意或有风险，good 表示做得好 / 划算，info 表示参考信息。

只输出下面这个结构的 JSON，外层字段名必须是 items，不要输出其他文字：
{"items":[{"level":"warn","title":"标题","body":"正文","evidence":"关键数字"}]}`;

const SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: ['warn', 'good', 'info'] },
          title: { type: 'string' },
          body: { type: 'string' },
          evidence: { type: 'string' },
        },
        required: ['level', 'title', 'body', 'evidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

class AIError extends Error {}

async function callAnthropic(cfg, key, system, user, { test = false } = {}) {
  const sdk = require('@anthropic-ai/sdk');
  const Anthropic = sdk.default || sdk;
  const official = !cfg.baseUrl || host(cfg.baseUrl) === 'api.anthropic.com';
  const client = new Anthropic({ apiKey: key, baseURL: cfg.baseUrl || undefined, timeout: 180e3, maxRetries: 1 });
  const req = { model: cfg.model, max_tokens: 16000, system, messages: [{ role: 'user', content: user }] };
  const oc = {};
  if (EFFORT_MODELS.test(cfg.model)) oc.effort = test ? 'low' : 'medium';
  if (!test) oc.format = { type: 'json_schema', schema: SCHEMA };
  if (Object.keys(oc).length) req.output_config = oc;
  const send = (r) => (official && FALLBACK_MODELS.has(cfg.model)
    ? client.beta.messages.create({ ...r, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
    : client.messages.create(r));
  let resp;
  try {
    try {
      resp = await send(req);
    } catch (e) {
      // 中转 / 兼容服务可能不支持结构化输出等参数：去掉 output_config 再试一次，改由提示词约束 JSON
      if (e instanceof Anthropic.BadRequestError && req.output_config && !official) {
        const { output_config, ...rest } = req;
        resp = await send({ ...rest, system: system + '\n只输出 JSON：{"items":[{"level","title","body","evidence"}]}，不要输出其他文字。' });
      } else throw e;
    }
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new AIError('API Key 无效或没有权限');
    if (e instanceof Anthropic.PermissionDeniedError) throw new AIError('没有权限使用这个模型');
    if (e instanceof Anthropic.NotFoundError) throw new AIError(`找不到模型 ${cfg.model}，请检查模型名或接口地址`);
    if (e instanceof Anthropic.RateLimitError) throw new AIError('请求太频繁或额度不足，稍后再试');
    if (e instanceof Anthropic.BadRequestError) throw new AIError('请求被拒绝：' + e.message);
    if (e instanceof Anthropic.APIConnectionError) throw new AIError('连不上接口地址，请检查网络或地址');
    if (e instanceof Anthropic.APIError) throw new AIError(`接口错误 ${e.status}：${e.message}`);
    throw e;
  }
  if (resp.stop_reason === 'refusal') throw new AIError('模型拒绝了这次请求' + (resp.stop_details && resp.stop_details.category ? `（${resp.stop_details.category}）` : ''));
  if (resp.stop_reason === 'max_tokens') throw new AIError('输出被截断，请重试');
  return resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

async function callOpenAI(cfg, key, system, user, { test = false } = {}) {
  const base = (cfg.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new AIError('请填写接口地址');
  const body = { model: cfg.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  if (!test) body.response_format = { type: 'json_object' };
  const post = (b) => fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify(b),
    signal: AbortSignal.timeout(180e3),
  });
  let r;
  try {
    r = await post(body);
    // 部分服务不支持 response_format：去掉后重试，靠提示词约束 JSON
    if (r.status === 400 && body.response_format) {
      const { response_format, ...rest } = body;
      r = await post(rest);
    }
  } catch (e) {
    throw new AIError(e.name === 'TimeoutError' ? '请求超时，请稍后再试' : '连不上接口地址，请检查网络或地址');
  }
  const text = await r.text();
  if (!r.ok) {
    let msg = text.slice(0, 300);
    try { const j = JSON.parse(text); msg = (j.error && (j.error.message || j.error)) || j.message || msg; } catch { /* 非 JSON 错误 */ }
    if (r.status === 401 || r.status === 403) throw new AIError('API Key 无效或没有权限');
    if (r.status === 404) throw new AIError(`找不到模型或接口（${msg}）`);
    if (r.status === 429) throw new AIError('请求太频繁或余额不足，稍后再试');
    throw new AIError(`接口错误 ${r.status}：${msg}`);
  }
  let j;
  try { j = JSON.parse(text); } catch { throw new AIError('接口返回的不是 JSON，请检查接口地址'); }
  const choice = j.choices && j.choices[0];
  if (!choice || !choice.message) throw new AIError('接口返回格式不对，请确认是 OpenAI 兼容接口');
  if (choice.finish_reason === 'length') throw new AIError('输出被截断，请重试');
  return choice.message.content || '';
}

function parseItems(text) {
  const s = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  let obj;
  try { obj = JSON.parse(s); } catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) throw new AIError('模型没有按要求返回 JSON，请重试');
    try { obj = JSON.parse(m[0]); } catch { throw new AIError('模型没有按要求返回 JSON，请重试'); }
  }
  // 不同模型对外层字段的命名不一样（items / findings / results…）：没有 items 时，取第一个“元素带标题”的数组
  const looksLikeItems = (a) => Array.isArray(a) && a.length && a.every((x) => x && typeof x === 'object' && (x.title || x.标题));
  let items = Array.isArray(obj) ? obj : obj && obj.items;
  if (!looksLikeItems(items) && obj && typeof obj === 'object') items = Object.values(obj).find(looksLikeItems);
  if (!looksLikeItems(items)) throw new AIError('模型没有按约定格式给出结论，请重试（原始回复已保存到 ~/.token-radar/ai.debug.txt）');
  items = items.map((x) => ({ level: x.level, title: x.title || x.标题, body: x.body || x.content || x.正文 || '', evidence: x.evidence || x.依据 || '' }));
  return items.slice(0, 8).map((x) => ({
    level: ['warn', 'good', 'info'].includes(x.level) ? x.level : 'info',
    title: String(x.title || '').slice(0, 60),
    body: String(x.body || '').slice(0, 400),
    evidence: String(x.evidence || '').slice(0, 300),
  })).filter((x) => x.title);
}

// 把代号换回真实项目名（只在本机显示）
function restore(items, mapping) {
  const aliases = Object.keys(mapping).sort((a, b) => b.length - a.length);
  const sub = (t) => aliases.reduce((s, a) => s.split(a).join(mapping[a]), t);
  return items.map((x) => ({ ...x, title: sub(x.title), body: sub(x.body), evidence: sub(x.evidence) }));
}

function requireReady() {
  const cfg = loadConfig();
  const key = getKey(cfg);
  if (!key) throw new AIError('还没有配置 API Key');
  if (!cfg.model) throw new AIError('还没有填写模型名');
  const preset = PRESETS[cfg.preset] || PRESETS['custom-openai'];
  return { cfg: { ...cfg, protocol: preset.protocol, baseUrl: cfg.baseUrl || preset.baseUrl }, key, label: preset.label };
}

async function test() {
  const { cfg, key } = requireReady();
  const call = cfg.protocol === 'anthropic' ? callAnthropic : callOpenAI;
  const t0 = Date.now();
  const text = await call(cfg, key, '你是连通性测试助手。', '请只回复：OK', { test: true });
  return { ok: true, ms: Date.now() - t0, reply: text.trim().slice(0, 40) };
}

async function analyze(input) {
  const { cfg, key, label } = requireReady();
  const { data, mapping } = buildPayload(input);
  const call = cfg.protocol === 'anthropic' ? callAnthropic : callOpenAI;
  const t0 = Date.now();
  const text = await call(cfg, key, SYSTEM, JSON.stringify(data));
  let parsed;
  try {
    parsed = parseItems(text);
  } catch (e) {
    // 保存原始回复，方便排查模型到底返回了什么
    try { fs.writeFileSync(DEBUG_FILE, text || '(空回复)'); } catch { /* ignore */ }
    throw e;
  }
  const items = restore(parsed, mapping);
  const result = { t: Date.now(), ms: Date.now() - t0, provider: label, model: cfg.model, items };
  writeJson(LAST_FILE, result);
  return result;
}

function lastResult() { return readJson(LAST_FILE, null); }

module.exports = { PRESETS, publicConfig, setConfig, buildPayload, analyze, test, lastResult, AIError };
