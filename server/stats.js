// 聚合：把请求记录按时间范围 / 来源汇总成面板需要的数据
const { costOf } = require('./pricing');
const { SOURCES } = require('./collector');

const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;

const tok = (r) => r.in + r.out + r.cr + r.cw5 + r.cw1h;

// Claude Code / Codex 的记录不带供应商字段，按工具归属
const DEFAULT_PROVIDER = { claude: 'anthropic', codex: 'openai' };

function projectKey(p) {
  if (!p) return '(未知)';
  let k = p.replace(/\\/g, '/').replace(/\/+$/, '');
  if (process.platform === 'win32' || /^[a-z]:\//i.test(k)) k = k.toLowerCase();
  return k;
}

function startOfDay(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }

// 第一个 t >= x 的下标（records 按 t 升序）
function lowerBound(rs, x) {
  let lo = 0, hi = rs.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (rs[m].t < x) lo = m + 1; else hi = m; }
  return lo;
}

function rangeBounds(range, now, rs) {
  const sod = startOfDay(now);
  switch (range) {
    case '7d': return { start: sod - 6 * DAY, len: 7 * DAY, bucket: 6 * HOUR };
    case '30d': return { start: sod - 29 * DAY, len: 30 * DAY, bucket: DAY };
    case 'all': {
      const first = rs.length ? startOfDay(rs[0].t) : sod;
      const span = Math.max(DAY, sod + DAY - first);
      return { start: first, len: null, bucket: span > 120 * DAY ? 7 * DAY : DAY };
    }
    default: return { start: sod, len: DAY, bucket: HOUR };
  }
}

function blank() {
  return { tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, saved: 0, requests: 0, unpriced: 0, sessions: new Set() };
}

function acc(a, r) {
  const c = costOf(r);
  a.tokens += tok(r); a.input += r.in; a.output += r.out; a.cacheRead += r.cr; a.cacheWrite += r.cw5 + r.cw1h;
  a.requests++; a.sessions.add(r.src + r.session);
  if (c) { a.cost += c.cost; a.saved += c.saved; } else a.unpriced += tok(r);
  return c;
}

function fin(a) { const { sessions, ...o } = a; o.sessions = sessions.size; return o; }

function summary(allRecords, { range = 'today', src = 'all', now = Date.now(), plans = {}, limits = {}, visible = null } = {}) {
  const match = src === 'all' ? () => true : (r) => r.src === src;
  const rs = allRecords;
  const b = rangeBounds(range, now, rs);
  const end = now;

  // 当前范围
  const cur = blank();
  const bySrc = {}, byModel = {}, byProject = {}, byTool = {}, byProvider = {};
  const nb = Math.max(1, Math.ceil(((b.len ? b.start + b.len : startOfDay(now) + DAY) - b.start) / b.bucket));
  const series = Array.from({ length: nb }, (_, i) => ({ t: b.start + i * b.bucket, tokens: 0, cost: 0, bySrc: {} }));

  for (let i = lowerBound(rs, b.start); i < rs.length && rs[i].t <= end; i++) {
    const r = rs[i];
    const s = bySrc[r.src] || (bySrc[r.src] = { ...blank(), last: 0, providers: {} });
    acc(s, r); s.last = Math.max(s.last, r.t);
    if (r.provider) {
      const pv = s.providers[r.provider] || (s.providers[r.provider] = { name: r.provider, tokens: 0, models: new Set() });
      pv.tokens += tok(r); pv.models.add(r.model);
    }
    if (!match(r)) continue;
    const c = acc(cur, r);
    const k = Math.min(nb - 1, Math.floor((r.t - b.start) / b.bucket));
    series[k].tokens += tok(r); series[k].cost += c ? c.cost : 0;
    series[k].bySrc[r.src] = (series[k].bySrc[r.src] || 0) + tok(r);
    const mk = r.provider ? r.provider + '/' + r.model : r.model;
    const m = byModel[mk] || (byModel[mk] = { model: r.model, provider: r.provider || '', src: r.src, tokens: 0, cost: 0, requests: 0, priced: !!c });
    m.tokens += tok(r); m.requests++; if (c) m.cost += c.cost;
    // 同一目录在不同工具里的写法不同（D:\x 与 D:/x、大小写），归并成一个项目
    const pk = projectKey(r.project);
    const p = byProject[pk] || (byProject[pk] = { project: r.project || '(未知)', tokens: 0, cost: 0, paid: 0, unpriced: 0, requests: 0, sessions: new Set(), last: 0, bySrc: {} });
    p.tokens += tok(r); p.requests++; p.sessions.add(r.src + r.session); p.last = Math.max(p.last, r.t);
    p.bySrc[r.src] = (p.bySrc[r.src] || 0) + tok(r);
    if (c) { p.cost += c.cost; if (!(plans[r.src] && plans[r.src].subscription)) p.paid += c.cost; } else p.unpriced += tok(r);
    if (r.tools) for (const t of r.tools) byTool[t] = (byTool[t] || 0) + 1;
    // 供应商：订阅内的用量和按量计费的真实花费分开统计
    const pvKey = (r.provider || DEFAULT_PROVIDER[r.src] || 'unknown').toLowerCase();
    const pv = byProvider[pvKey] || (byProvider[pvKey] = { id: pvKey, subTokens: 0, subCost: 0, paidTokens: 0, paidCost: 0, unpriced: 0, requests: 0, via: {}, models: {} });
    const isSub = !!(plans[r.src] && plans[r.src].subscription);
    pv.requests++;
    pv.via[r.src] = (pv.via[r.src] || 0) + tok(r);
    pv.models[r.model] = (pv.models[r.model] || 0) + tok(r);
    if (isSub) { pv.subTokens += tok(r); if (c) pv.subCost += c.cost; } else { pv.paidTokens += tok(r); if (c) pv.paidCost += c.cost; }
    if (!c) pv.unpriced += tok(r);
  }

  // 同期对比：上一个等长区间的同一时刻
  let prev = null;
  if (b.len) {
    const ps = b.start - b.len, pe = end - b.len;
    prev = blank();
    for (let i = lowerBound(rs, ps); i < rs.length && rs[i].t <= pe; i++) if (match(rs[i])) acc(prev, rs[i]);
    prev = fin(prev);
  }

  // 实时：最近 60 分钟逐分钟
  const minuteStart = Math.floor(now / MIN) * MIN - 59 * MIN;
  const minutes = new Array(60).fill(0);
  let last10 = 0, lastHourTok = 0, lastHourCost = 0;
  for (let i = lowerBound(rs, minuteStart); i < rs.length; i++) {
    const r = rs[i];
    if (!match(r)) continue;
    const k = Math.floor((r.t - minuteStart) / MIN);
    if (k >= 0 && k < 60) minutes[k] += tok(r);
    if (r.t >= now - 10 * MIN) last10 += tok(r);
    if (r.t >= now - HOUR) { lastHourTok += tok(r); const c = costOf(r); if (c) lastHourCost += c.cost; }
  }

  const recent = [];
  for (let i = rs.length - 1; i >= 0 && recent.length < 40; i--) {
    const r = rs[i];
    if (r.t < b.start) break;
    if (!match(r)) continue;
    const c = costOf(r);
    recent.push({ t: r.t, src: r.src, model: r.model, provider: r.provider || '', tokens: tok(r), in: r.in, out: r.out, cr: r.cr, cw: r.cw5 + r.cw1h, cost: c ? c.cost : null, tools: r.tools || [], project: r.project, side: r.side });
  }

  // 本月（自然月）按 API 价折算的等价费用，用于和订阅月费比较
  const som = new Date(now); som.setDate(1); som.setHours(0, 0, 0, 0);
  const month = {};
  for (let i = lowerBound(rs, som.getTime()); i < rs.length; i++) {
    const r = rs[i];
    const m = month[r.src] || (month[r.src] = { cost: 0, unpriced: 0, tokens: 0 });
    const c = costOf(r);
    m.tokens += tok(r);
    if (c) m.cost += c.cost; else m.unpriced += tok(r);
  }
  const dayOfMonth = (now - som.getTime()) / DAY;

  const sources = Object.keys(SOURCES).filter((k) => !visible || visible.includes(k) || bySrc[k]).map((k) => {
    const s = bySrc[k];
    const providers = s ? Object.values(s.providers).map((p) => ({ name: p.name, tokens: p.tokens, models: [...p.models] })).sort((a, b) => b.tokens - a.tokens) : [];
    if (s) delete s.providers;
    return {
      id: k, label: SOURCES[k].label, ...(s ? fin(s) : fin({ ...blank(), last: 0 })), providers,
      plan: plans[k] || null,
      limits: limits[k] || null,
      month: month[k] || { cost: 0, unpriced: 0, tokens: 0 },
    };
  });

  return {
    now, range, src, dayOfMonth,
    start: b.start, bucket: b.bucket,
    totals: fin(cur),
    prev,
    series,
    realtime: { perMin: last10 / 10, lastHourTokens: lastHourTok, lastHourCost, minutes, minuteStart },
    sources,
    models: Object.values(byModel).sort((a, b) => b.tokens - a.tokens),
    projects: Object.values(byProject).map((p) => ({ ...p, sessions: p.sessions.size })).sort((a, b) => b.cost - a.cost || b.tokens - a.tokens).slice(0, 200),
    tools: Object.entries(byTool).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 10),
    providers: Object.values(byProvider).map((p) => ({
      ...p,
      tokens: p.subTokens + p.paidTokens,
      via: Object.entries(p.via).sort((a, b) => b[1] - a[1]).map(([k]) => k),
      models: Object.entries(p.models).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k),
    })).sort((a, b) => b.paidCost + b.subCost - (a.paidCost + a.subCost) || b.tokens - a.tokens),
    recent,
  };
}

module.exports = { summary, tok, projectKey };
