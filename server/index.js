// 本地 HTTP 服务：静态页面 + JSON API + SSE 实时推送。只监听 127.0.0.1。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Collector } = require('./collector');
const { summary, tok } = require('./stats');
const pricing = require('./pricing');
const plans = require('./plans');
const tools = require('./tools');
const { Alerts } = require('./alerts');
const { insights } = require('./insights');
const ai = require('./ai');

const BOM = String.fromCharCode(0xfeff); // 让 Excel 按 UTF-8 打开 CSV
const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
let litellmCache = null;

async function fetchLiteLLM() {
  if (litellmCache && Date.now() - litellmCache.t < 3600e3) return litellmCache.data;
  const r = await fetch(LITELLM_URL, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('价格表下载失败：HTTP ' + r.status);
  const data = await r.json();
  litellmCache = { t: Date.now(), data };
  return data;
}

// 优先精确名，其次 openai/ anthropic/ 前缀，最后任意 provider 前缀
function lookupLiteLLM(table, model) {
  const n = pricing.normalize(model);
  const keys = [model, n, 'openai/' + n, 'anthropic/' + n];
  let key = keys.find((k) => table[k] && table[k].input_cost_per_token != null);
  if (!key) key = Object.keys(table).find((k) => k.endsWith('/' + n) && table[k].input_cost_per_token != null);
  // “中转商/模型”查不到时，按模型名查官方价格
  if (!key && n.includes('/')) return lookupLiteLLM(table, n.slice(n.lastIndexOf('/') + 1));
  if (!key) return null;
  const e = table[key];
  const per = (v) => (v == null ? undefined : +(v * 1e6).toFixed(6));
  return {
    matched: key,
    input: per(e.input_cost_per_token),
    output: per(e.output_cost_per_token),
    cacheRead: per(e.cache_read_input_token_cost),
    cacheWrite5m: per(e.cache_creation_input_token_cost),
  };
}

// 本机工具扫描结果缓存 30 秒（检查目录和 PATH，开销不大但没必要每次请求都做）
let toolScan = null;
function scanTools(force) {
  if (!force && toolScan && Date.now() - toolScan.t < 30e3) return toolScan.list;
  const counts = {};
  for (const r of collectorRef.records) counts[r.src] = (counts[r.src] || 0) + 1;
  toolScan = { t: Date.now(), list: tools.scan(counts) };
  return toolScan.list;
}
let collectorRef = { records: [] };

const priceKey = (r) => (r.provider ? r.provider + '/' + r.model : r.model);
// 与 costOf 一致：先按“供应商/模型”，再按模型名
const effectivePrice = (k) => pricing.priceFor(k) || (k.includes('/') ? pricing.priceFor(k.slice(k.lastIndexOf('/') + 1)) : null);

function json(res, code, body, extra) {
  if (extra) body = { ...body, ...extra };
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

async function startServer({ port = Number(process.env.PORT) || 17321 } = {}) {
  const collector = new Collector();
  collectorRef = collector;
  const alerts = new Alerts(collector, () => plans.resolve(collector.limits));
  const clients = new Set();

  collector.on('records', (added) => {
    // 只把最近 5 分钟内发生的请求当作“实时水滴”推送，历史补读不触发动画
    const cutoff = Date.now() - 5 * 60e3;
    const live = added.filter((r) => r.t >= cutoff).map((r) => ({ t: r.t, src: r.src, model: r.model, tokens: tok(r), tools: r.tools || [] }));
    const msg = `event: update\ndata: ${JSON.stringify({ live })}\n\n`;
    for (const res of clients) res.write(msg);
  });

  const insightInput = () => ({ records: collector.records, plans: plans.resolve(collector.limits), limitHist: collector.getLimitHist('codex'), limits: collector.limits });

  alerts.on('alert', (a) => {
    const msg = `event: alert\ndata: ${JSON.stringify(a)}\n\n`;
    for (const res of clients) res.write(msg);
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      // 防止其他网页借浏览器访问本地接口（DNS 重绑定 / 跨站请求）：
      // Host 必须是本机地址；写操作必须带自定义请求头，跨站请求带不上它（会触发 CORS 预检，而这里不响应预检）
      const h = String(req.headers.host || '').toLowerCase();
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(h)) return json(res, 403, { error: 'forbidden host' });
      if (req.method !== 'GET' && req.headers['x-token-radar'] !== '1') return json(res, 403, { error: 'missing header' });
    }
    try {
      if (url.pathname === '/api/summary') {
        if (!collector.ready) return json(res, 200, { loading: true });
        return json(res, 200, summary(collector.records, {
          range: url.searchParams.get('range') || 'today',
          src: url.searchParams.get('src') || 'all',
          plans: plans.resolve(collector.limits),
          limits: collector.limits,
          // 只显示本机装了、或者已经有数据的工具
          visible: scanTools().filter((t) => t.status !== 'absent').map((t) => t.id),
        }), { forecast: alerts.quotaForecast() });
      }
      if (url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(`event: hello\ndata: ${JSON.stringify({ ready: collector.ready })}\n\n`);
        clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 20000);
        req.on('close', () => { clearInterval(ping); clients.delete(res); });
        return;
      }
      if (url.pathname === '/api/pricing') {
        if (req.method === 'POST') {
          const body = await readBody(req);
          pricing.setUser(body.models);
          for (const c of clients) c.write('event: update\ndata: {"live":[]}\n\n');
          return json(res, 200, { ok: true, user: pricing.getUser() });
        }
        const user = pricing.getUser();
        const used = new Set();
        const models = [...new Set(collector.records.map(priceKey))].sort().map((m) => {
          const u = user.find((x) => x.match === pricing.normalize(m)) || null;
          if (u) used.add(u);
          return { model: m, price: effectivePrice(m), user: u };
        });
        return json(res, 200, { models, userOthers: user.filter((u) => !used.has(u)) });
      }
      if (url.pathname === '/api/insights') {
        if (!collector.ready) return json(res, 200, { items: [] });
        return json(res, 200, { items: insights(insightInput()), ai: ai.lastResult() });
      }
      if (url.pathname === '/api/ai') {
        if (req.method === 'POST') {
          try { return json(res, 200, ai.setConfig(await readBody(req))); } catch (e) { return json(res, 400, { error: e.message }); }
        }
        return json(res, 200, { config: ai.publicConfig(), presets: ai.PRESETS, last: ai.lastResult() });
      }
      if (url.pathname === '/api/ai/preview') {
        // 预览将要发送的内容（已匿名化），和真正发送的完全一致
        const input = insightInput();
        return json(res, 200, ai.buildPayload({ ...input, ruleFindings: insights(input) }).data);
      }
      if ((url.pathname === '/api/ai/analyze' || url.pathname === '/api/ai/test') && req.method === 'POST') {
        try {
          if (url.pathname === '/api/ai/test') return json(res, 200, await ai.test());
          const input = insightInput();
          return json(res, 200, await ai.analyze({ ...input, ruleFindings: insights(input) }));
        } catch (e) {
          return json(res, e instanceof ai.AIError ? 400 : 500, { error: e.message });
        }
      }
      if (url.pathname === '/api/alerts') {
        if (req.method === 'POST') alerts.setConfig(await readBody(req));
        return json(res, 200, { config: alerts.config, history: alerts.history });
      }
      if (url.pathname === '/api/alerts/test' && req.method === 'POST') {
        return json(res, 200, alerts.test());
      }
      if (url.pathname === '/api/tools') {
        const list = scanTools(url.searchParams.has('rescan'));
        return json(res, 200, { scannedAt: toolScan.t, tools: list.filter((t) => t.status !== 'absent'), absent: list.filter((t) => t.status === 'absent').map((t) => t.name) });
      }
      if (url.pathname === '/api/prices/sync') {
        // 用户点击“联网同步价格”时才会联网；只为当前未计价的模型给出建议值，不自动保存
        const seen = [...new Set(collector.records.map(priceKey))];
        const table = await fetchLiteLLM();
        const found = {}, missing = [];
        for (const m of seen) {
          if (effectivePrice(m)) continue;
          const hit = lookupLiteLLM(table, m);
          if (hit) found[m] = hit; else missing.push(m);
        }
        return json(res, 200, { found, missing, source: LITELLM_URL });
      }
      if (url.pathname === '/api/plans') {
        if (req.method === 'POST') {
          plans.setUser(await readBody(req));
          for (const c of clients) c.write('event: update\ndata: {"live":[]}\n\n');
        }
        return json(res, 200, plans.resolve(collector.limits));
      }
      if (url.pathname === '/api/export/projects') {
        const d = summary(collector.records, { range: url.searchParams.get('range') || '30d', plans: plans.resolve(collector.limits) });
        const esc = (v) => '"' + String(v).replace(/"/g, '""') + '"';
        const rows = ['project,path,requests,sessions,tokens,api_equivalent_usd,paid_usd,unpriced_tokens,tools,last_active'];
        for (const p of d.projects) {
          const name = p.project.split(/[\\/]/).filter(Boolean).pop() || p.project;
          const toolsUsed = Object.entries(p.bySrc).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' ');
          rows.push([esc(name), esc(p.project), p.requests, p.sessions, p.tokens, p.cost.toFixed(4), p.paid.toFixed(4), p.unpriced, esc(toolsUsed), new Date(p.last).toISOString()].join(','));
        }
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="token-radar-projects-${d.range}.csv"` });
        return res.end(BOM + rows.join('\n'));
      }
      if (url.pathname === '/api/export') {
        const rows = ['time,source,provider,model,session,project,input,output,cache_read,cache_write,cost_usd'];
        for (const r of collector.records) {
          const c = pricing.costOf(r);
          rows.push([new Date(r.t).toISOString(), r.src, r.provider || '', r.model, r.session, JSON.stringify(r.project), r.in, r.out, r.cr, r.cw5 + r.cw1h, c ? c.cost.toFixed(6) : ''].join(','));
        }
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="token-radar.csv"' });
        return res.end(BOM + rows.join('\n'));
      }
      // 静态文件
      const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const file = path.join(PUBLIC, rel);
      if (!file.startsWith(PUBLIC)) return json(res, 403, { error: 'forbidden' });
      fs.readFile(file, (err, buf) => {
        if (err) return json(res, 404, { error: 'not found' });
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        res.end(buf);
      });
    } catch (e) {
      json(res, 500, { error: String(e && e.message || e) });
    }
  });

  const actualPort = await new Promise((resolve, reject) => {
    const tryListen = (p, left) => {
      server.once('error', (e) => (e.code === 'EADDRINUSE' && left > 0 ? tryListen(p + 1, left - 1) : reject(e)));
      server.listen(p, '127.0.0.1', () => resolve(p));
    };
    tryListen(port, 20);
  });

  collector.start().then(() => {
    for (const c of clients) c.write('event: update\ndata: {"live":[]}\n\n');
    alerts.start();
  });

  return { server, port: actualPort, collector, alerts };
}

module.exports = { startServer };

if (require.main === module) {
  startServer().then(({ port }) => {
    const url = `http://127.0.0.1:${port}`;
    console.log(`Token Radar 已启动：${url}`);
    if (process.argv.includes('--open')) {
      const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open ${url}` : `xdg-open ${url}`;
      require('child_process').exec(cmd);
    }
  });
}
