// 订阅识别：判断每个工具是订阅制还是 API 按量计费。
// 只读取账号类型字段，不读取任何含登录凭证的文件（.credentials.json / auth.json）。
const fs = require('fs');
const path = require('path');
const os = require('os');

const { dataFile } = require('./paths');

const USER_FILE = dataFile('plans.user.json');

// 月费默认值（美元），可在设置中修改
const CLAUDE_PLANS = {
  pro: { label: 'Claude Pro', monthly: 20 },
  max5x: { label: 'Claude Max 5x', monthly: 100 },
  max20x: { label: 'Claude Max 20x', monthly: 200 },
  team: { label: 'Claude Team', monthly: null },
  enterprise: { label: 'Claude Enterprise', monthly: null },
};
const CODEX_PLANS = {
  plus: { label: 'ChatGPT Plus', monthly: 20 },
  pro: { label: 'ChatGPT Pro', monthly: 200 },
  team: { label: 'ChatGPT Team', monthly: null },
  business: { label: 'ChatGPT Business', monthly: null },
  enterprise: { label: 'ChatGPT Enterprise', monthly: null },
  edu: { label: 'ChatGPT Edu', monthly: null },
};

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

function detectClaude() {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    return { plan: 'api', label: 'API 按量', subscription: false, via: '环境变量 ANTHROPIC_API_KEY' };
  }
  const file = process.env.CLAUDE_CONFIG_DIR
    ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')
    : path.join(os.homedir(), '.claude.json');
  const d = readJson(file);
  const a = d && d.oauthAccount;
  if (!a) return { plan: 'unknown', label: '未识别', subscription: false, via: null };
  const type = String(a.organizationType || '');
  const tier = String(a.organizationRateLimitTier || a.userRateLimitTier || '');
  let plan = null;
  if (/max_20x|20x/.test(tier)) plan = 'max20x';
  else if (/max_5x|5x/.test(tier) || /max/.test(type)) plan = 'max5x';
  else if (/pro/.test(type)) plan = 'pro';
  else if (/team/.test(type)) plan = 'team';
  else if (/enterprise/.test(type)) plan = 'enterprise';
  if (!plan) return { plan: 'api', label: 'API 按量（Console 账号）', subscription: false, via: '~/.claude.json' };
  return { plan, ...CLAUDE_PLANS[plan], subscription: true, via: '~/.claude.json', extraUsage: !!a.hasExtraUsageEnabled };
}

// Codex 的套餐来自日志里最近一次 rate_limits.plan_type
function detectCodex(limits) {
  const t = limits && limits.plan_type ? String(limits.plan_type).toLowerCase() : null;
  if (!t) return { plan: 'unknown', label: '未识别', subscription: false, via: null };
  if (t === 'api' || t === 'free') return { plan: t, label: t === 'free' ? 'ChatGPT Free' : 'API 按量', subscription: false, via: 'Codex 日志' };
  const known = CODEX_PLANS[t] || { label: 'ChatGPT ' + t, monthly: null };
  return { plan: t, ...known, subscription: true, via: 'Codex 日志' };
}

function getUser() { return readJson(USER_FILE) || {}; }

function setUser(obj) {
  const clean = {};
  for (const src of ['claude', 'codex']) {
    const o = obj && obj[src];
    if (!o) continue;
    const c = {};
    if (['auto', 'subscription', 'api'].includes(o.mode)) c.mode = o.mode;
    if (o.monthly !== '' && o.monthly != null && isFinite(o.monthly)) c.monthly = +o.monthly;
    clean[src] = c;
  }
  fs.mkdirSync(path.dirname(USER_FILE), { recursive: true });
  fs.writeFileSync(USER_FILE, JSON.stringify(clean, null, 2));
}

// 合并自动识别结果和用户设置
function resolve(limits) {
  const user = getUser();
  const out = {};
  const detected = { claude: detectClaude(), codex: detectCodex(limits.codex) };
  for (const src of Object.keys(detected)) {
    const det = detected[src];
    const u = user[src] || {};
    const mode = u.mode || 'auto';
    const subscription = mode === 'auto' ? det.subscription : mode === 'subscription';
    out[src] = {
      detected: det,
      mode,
      subscription,
      label: mode === 'api' ? 'API 按量' : mode === 'subscription' && !det.subscription ? '订阅' : det.label,
      monthly: u.monthly != null ? u.monthly : subscription ? (det.monthly ?? null) : null,
    };
  }
  return out;
}

module.exports = { resolve, getUser, setUser };
