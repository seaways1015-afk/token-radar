// 洞察：基于近 30 天数据生成几条可以直接用来做决定的结论（订阅值不值、额度压力、按量花费、隐藏消耗、缓存效率）。
// 纯规则计算，不联网、不调用模型。
const { costOf } = require('./pricing');
const { SOURCES } = require('./collector');

const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
const tok = (r) => r.in + r.out + r.cr + r.cw5 + r.cw1h;
const usd = (n) => '$' + (n >= 100 || Number.isInteger(n) ? Math.round(n).toLocaleString() : n.toFixed(n >= 10 ? 1 : 2));
const fmt = (n) => (n >= 1e8 ? (n / 1e8).toFixed(1) + ' 亿' : n >= 1e4 ? (n / 1e4).toFixed(n >= 1e6 ? 0 : 1) + ' 万' : String(Math.round(n)));
const pct = (x) => Math.round(x * 100) + '%';
const projName = (p) => (p || '').split(/[\\/]/).filter(Boolean).pop() || '未知项目';
function dur(ms) {
  const h = ms / HOUR;
  return h < 1 ? `${Math.round(ms / MIN)} 分钟` : h < 48 ? `${Math.round(h)} 小时` : `${(h / 24).toFixed(1)} 天`;
}

function insights({ records, plans = {}, limitHist = [], limits = {}, now = Date.now() }) {
  const since = now - 30 * DAY;
  const label = (src) => (SOURCES[src] ? SOURCES[src].label : src);
  const paid = (src) => !(plans[src] && plans[src].subscription);

  // 一次遍历收集所需聚合
  const bySrc = {}, byProj = {}, bySession = {};
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r.t < since) break;
    const c = costOf(r);
    const s = bySrc[r.src] || (bySrc[r.src] = { cost: 0, unpriced: 0, tokens: 0, side: 0, sideModels: {}, first: r.t, providers: {}, cost7: 0 });
    s.tokens += tok(r); s.first = Math.min(s.first, r.t);
    if (c) { s.cost += c.cost; if (r.t >= now - 7 * DAY) s.cost7 += c.cost; } else s.unpriced += tok(r);
    if (r.side) { s.side += tok(r); s.sideModels[r.model] = (s.sideModels[r.model] || 0) + tok(r); }
    if (c && r.provider) s.providers[r.provider] = (s.providers[r.provider] || 0) + c.cost;
    const pk = (r.project || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    if (pk) {
      const p = byProj[pk] || (byProj[pk] = { name: projName(r.project), in: 0, cr: 0, cw: 0, tokens: 0 });
      p.in += r.in; p.cr += r.cr; p.cw += r.cw5 + r.cw1h; p.tokens += tok(r);
    }
    if (r.t >= now - 7 * DAY) {
      const k = r.src + ':' + r.session;
      const ss = bySession[k] || (bySession[k] = { src: r.src, project: r.project, cost: 0, n: 0, t0: r.t, t1: r.t });
      ss.n++; ss.t0 = Math.min(ss.t0, r.t); ss.t1 = Math.max(ss.t1, r.t); if (c) ss.cost += c.cost;
    }
  }

  const out = [];

  // A. 订阅值不值
  for (const [src, s] of Object.entries(bySrc)) {
    const plan = plans[src];
    if (!plan || !plan.subscription || !plan.monthly) continue;
    if (!s.cost && s.unpriced) continue;
    const days = Math.max(1, Math.min(30, (now - s.first) / DAY));
    if (days < 7) {
      // 数据太少，按天数外推会严重失真：只陈述事实，不下结论
      out.push({ id: 'sub:' + src, level: 'info', title: `${plan.label}：数据还不够判断`,
        body: `目前只有 ${Math.ceil(days)} 天的 ${label(src)} 数据，已按 API 价折合 ${usd(s.cost)}，相当于月费 ${usd(plan.monthly)} 的 ${pct(s.cost / plan.monthly)}。满一周后会给出是否划算的判断。` });
      continue;
    }
    const monthly = (s.cost / days) * 30;
    const basis = days >= 27 ? `近 30 天按 API 价折合 ${usd(s.cost)}` : `按最近 ${Math.round(days)} 天推算，一个月约折合 ${usd(monthly)}`;
    const ratio = monthly / plan.monthly;
    if (ratio >= 1.5) {
      out.push({ id: 'sub:' + src, level: 'good', title: `${plan.label} 很划算`, body: `${basis}，是月费 ${usd(plan.monthly)} 的 ${ratio.toFixed(ratio >= 10 ? 0 : 1)} 倍。` });
    } else if (ratio >= 0.8) {
      out.push({ id: 'sub:' + src, level: 'info', title: `${plan.label} 基本回本`, body: `${basis}，和月费 ${usd(plan.monthly)} 差不多。` });
    } else {
      const extra = src === 'claude' ? '不过订阅还包含网页版和 App 里的聊天，要一起算。' : src === 'codex' ? '不过订阅还包含 ChatGPT 本身的使用，要一起算。' : '';
      out.push({ id: 'sub:' + src, level: 'warn', title: `${plan.label} 可能不划算`, body: `${basis}，低于月费 ${usd(plan.monthly)}。只看 ${label(src)} 的话，按量付费每月约省 ${usd(plan.monthly - monthly)}。${extra}` });
    }
  }

  // B. Codex 额度压力
  const lim = limits.codex;
  if (limitHist.length) {
    const wins = new Map();
    for (const x of limitHist) {
      if (x.t < since || x.pr == null || x.p == null) continue;
      const k = Math.round(x.pr / 1800);
      wins.set(k, Math.max(wins.get(k) || 0, x.p));
    }
    const hot = [...wins.values()].filter((v) => v >= 95).length;
    if (hot >= 3) {
      out.push({ id: 'quota:hot', level: 'warn', title: 'Codex 5 小时额度经常触顶',
        body: `近 30 天有 ${hot} 个 5 小时窗口用到 95% 以上（共 ${wins.size} 个有使用的窗口）。如果经常被限流打断，可以考虑升级套餐，或者把大任务放在额度刚重置之后。` });
    }
  }
  if (lim && lim.secondary && lim.secondary.window_minutes && lim.secondary.resets_at * 1000 > now) {
    const w = lim.secondary, span = w.window_minutes * MIN;
    const left = w.resets_at * 1000 - now;
    const elapsed = 1 - left / span;
    if (elapsed > 0.1 && w.used_percent > 20 && w.used_percent < 100) {
      const pace = w.used_percent / (elapsed * 100);
      if (pace > 1.15) {
        const runOut = (elapsed * span) * (100 / w.used_percent) - elapsed * span; // 从现在起按同样节奏还能用多久
        if (runOut < left) {
          out.push({ id: 'quota:weekly', level: 'warn', title: 'Codex 每周额度用得偏快',
            body: `这周才过去 ${pct(elapsed)} 就用了 ${Math.round(w.used_percent)}%。照这个节奏，大约 ${dur(runOut)}后用完，而离重置还有 ${dur(left)}。` });
        }
      }
    }
  }

  // C. 按量计费花费
  const paidSrcs = Object.entries(bySrc).filter(([src, s]) => paid(src) && s.cost > 0);
  if (paidSrcs.length) {
    const total = paidSrcs.reduce((a, [, s]) => a + s.cost, 0);
    const week = paidSrcs.reduce((a, [, s]) => a + s.cost7, 0);
    const parts = [];
    for (const [src, s] of paidSrcs) {
      const pv = Object.entries(s.providers).sort((a, b) => b[1] - a[1]);
      if (pv.length) for (const [name, c] of pv.slice(0, 2)) parts.push(`${name}（${label(src)}）${usd(c)}`);
      else parts.push(`${label(src)} ${usd(s.cost)}`);
    }
    out.push({ id: 'paid', level: 'info', title: `按量计费近 30 天花了 ${usd(total)}`,
      body: `${parts.slice(0, 4).join('、')}。${week > 0 ? `按最近 7 天的速度，一个月约 ${usd(week / 7 * 30)}。` : '最近 7 天没有按量花费。'}` });
  }

  // D. 隐藏的后台消耗（子代理、自动审查、上下文压缩等）
  for (const [src, s] of Object.entries(bySrc)) {
    if (!s.tokens || s.side / s.tokens < 0.05 || s.side < 5e6) continue;
    const top = Object.entries(s.sideModels).sort((a, b) => b[1] - a[1])[0];
    out.push({ id: 'side:' + src, level: 'info', title: `${label(src)} 的后台任务占了 ${pct(s.side / s.tokens)} 用量`,
      body: `近 30 天 ${fmt(s.side)} token 花在子代理 / 自动审查这类不在对话里显示的任务上${top ? `，最多的是 ${top[0]}` : ''}。它们同样消耗额度和费用。` });
  }

  // E. 缓存效率偏低的项目
  const projs = Object.values(byProj).filter((p) => p.tokens >= 5e6);
  const all = projs.reduce((a, p) => ({ in: a.in + p.in, cr: a.cr + p.cr, cw: a.cw + p.cw }), { in: 0, cr: 0, cw: 0 });
  const avg = all.cr / Math.max(1, all.in + all.cr + all.cw);
  const low = projs.map((p) => ({ ...p, hit: p.cr / Math.max(1, p.in + p.cr + p.cw) }))
    .filter((p) => p.hit < 0.75 && p.hit < avg - 0.1).sort((a, b) => b.tokens - a.tokens)[0];
  if (low) {
    out.push({ id: 'cache:' + low.name, level: 'warn', title: `项目 ${low.name} 的缓存命中率偏低（${pct(low.hit)}）`,
      body: `所有项目平均 ${pct(avg)}。没命中缓存的输入按全价计费。常见原因：两次请求间隔超过缓存有效期、频繁切换模型、改动了系统提示或项目说明文件。` });
  }

  // F. 最近 7 天最贵的会话
  const top = Object.values(bySession).sort((a, b) => b.cost - a.cost)[0];
  if (top && top.cost >= 1) {
    out.push({ id: 'session', level: 'info', title: `最近 7 天最贵的会话折合 ${usd(top.cost)}`,
      body: `${label(top.src)} · ${projName(top.project)}，${top.n} 次请求，时间跨度 ${dur(Math.max(MIN, top.t1 - top.t0))}${paid(top.src) ? '（按量计费，真实花费）' : '（订阅内，按 API 价折算）'}。` });
  }

  const order = { warn: 0, good: 1, info: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level]).slice(0, 8);
}

module.exports = { insights };
