// 日志采集器：增量读取 Claude Code / Codex / Pi / DeepSeek Harness 的 JSONL 会话日志和 OpenCode 的 SQLite 数据库，归一化成请求记录。
// 每个文件只记录已消费的字节偏移，追加写入时只读新增部分；解析结果缓存到磁盘，重启秒开。
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const zlib = require('zlib');
const { dataFile } = require('./paths');

const CACHE_VERSION = 5;
const CHUNK = 4 << 20;
const NL = 10;

const SOURCES = {
  claude: { label: 'Claude Code', dir: () => process.env.CLAUDE_CONFIG_DIR
    ? path.join(process.env.CLAUDE_CONFIG_DIR, 'projects')
    : path.join(os.homedir(), '.claude', 'projects') },
  codex: { label: 'Codex', dir: () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions') },
  pi: { label: 'Pi', dir: () => path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'), 'sessions') },
  opencode: { label: 'OpenCode', kind: 'sqlite', dir: () => path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode'), db: 'opencode.db' },
  dsh: { label: 'DeepSeek Harness', dir: () => path.join(os.homedir(), '.dsh', 'sessions') },
};

async function walkJsonl(dir, out = []) {
  let ents;
  try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walkJsonl(p, out);
    else if (e.name.endsWith('.jsonl') || e.name.endsWith('.jsonl.zstd')) out.push(p);
  }
  return out;
}

// 从 start 读到文件末尾，按行回调；返回最后一个完整行之后的偏移（半行留到下次）
async function readLines(file, start, onLine) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    if (size < start) start = 0; // 文件被截断/重写
    let pos = start, carry = null;
    while (pos < size) {
      const buf = Buffer.allocUnsafe(Math.min(CHUNK, size - pos));
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (!bytesRead) break;
      pos += bytesRead;
      const data = carry ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      let s = 0, i;
      while ((i = data.indexOf(NL, s)) !== -1) {
        if (i > s) onLine(data, s, i);
        s = i + 1;
      }
      carry = s < data.length ? Buffer.from(data.subarray(s)) : null;
    }
    return { offset: pos - (carry ? carry.length : 0), size };
  } finally {
    await fh.close();
  }
}

const head = (data, s, e, n = 320) => data.toString('utf8', s, Math.min(e, s + n));
function normalizeUsage(u) {
  if (!u || typeof u !== 'object') return null;
  if ('input' in u || 'output' in u) { // pi 风格：input 不含缓存命中
    return { in: num(u.input), out: num(u.output), cr: num(u.cacheRead), cw5: num(u.cacheWrite), ...(u.cost && num(u.cost.total) > 0 ? { pc: u.cost.total } : {}) };
  }
  if ('input_tokens' in u) { // Anthropic 风格
    return { in: num(u.input_tokens), out: num(u.output_tokens), cr: num(u.cache_read_input_tokens), cw5: num(u.cache_creation_input_tokens) };
  }
  if ('prompt_tokens' in u) { // OpenAI / DeepSeek API：prompt_tokens 包含缓存命中
    const cached = num(u.prompt_cache_hit_tokens) || num(u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens);
    return { in: Math.max(0, num(u.prompt_tokens) - cached), out: num(u.completion_tokens), cr: cached, cw5: 0 };
  }
  return null;
}

const has = (data, s, e, str) => { const i = data.indexOf(str, s); return i !== -1 && i < e; };
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);

class Collector extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.cacheFile = opts.cacheFile || dataFile('cache.json');
    this.records = [];      // 按时间大致有序的请求记录
    this.byId = new Map();  // 去重 id -> record
    this.files = new Map(); // path -> { offset, size, mtimeMs, src, st }
    this.ready = false;
    this.scanning = false;
    this.limits = {};      // 各工具最近一次上报的额度信息（目前只有 Codex 会写入日志）
    this.cursors = {};     // 数据库类来源的增量游标
    this.limitHist = {};   // 额度使用率的历史快照，用于预测耗尽时间和统计触顶次数
  }

  // ---------- 缓存 ----------
  async loadCache() {
    try {
      const raw = JSON.parse(await fsp.readFile(this.cacheFile, 'utf8'));
      if (raw.v !== CACHE_VERSION) return;
      for (const r of raw.records) { this.records.push(r); this.byId.set(r.id, r); }
      for (const [p, f] of Object.entries(raw.files)) this.files.set(p, f);
      this.cursors = raw.cursors || {};
      this.limits = raw.limits || {};
      this.limitHist = raw.limitHist || {};
    } catch { /* 首次运行或缓存损坏：全量扫描 */ }
  }

  saveCacheSoon() {
    clearTimeout(this._saveT);
    this._saveT = setTimeout(() => this.saveCache().catch(() => {}), 5000);
  }

  async saveCache() {
    await fsp.mkdir(path.dirname(this.cacheFile), { recursive: true });
    const tmp = this.cacheFile + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify({ v: CACHE_VERSION, records: this.records, files: Object.fromEntries(this.files), limits: this.limits, limitHist: this.limitHist, cursors: this.cursors }));
    await fsp.rename(tmp, this.cacheFile);
  }

  // ---------- 生命周期 ----------
  async start() {
    await this.loadCache();
    await this.fullScan();
    await this.pollOpencode();
    this.ready = true;
    this.emit('ready');
    this.saveCacheSoon();

    for (const [src, def] of Object.entries(SOURCES)) {
      if (def.kind === 'sqlite') continue;
      try {
        fs.watch(def.dir(), { recursive: true }, (_, name) => {
          if (name && String(name).endsWith('.jsonl')) this.markDirty(path.join(def.dir(), String(name)), src);
        });
      } catch { /* 目录不存在或平台不支持递归 watch：靠轮询兜底 */ }
    }
    this.dirty = new Map();
    // 热文件（最近 15 分钟改过的）高频轮询；全量目录扫描低频兜底
    this._hot = setInterval(() => { this.pollHot(); this.pollOpencode(); }, 1500);
    this._full = setInterval(() => this.fullScan(), 30000);
  }

  stop() { clearInterval(this._hot); clearInterval(this._full); }

  markDirty(p, src) {
    this.dirty.set(p, src);
    clearTimeout(this._dirtyT);
    this._dirtyT = setTimeout(() => this.flushDirty(), 150);
  }

  async flushDirty() {
    const list = [...this.dirty]; this.dirty.clear();
    await this.run(list.map(([p, src]) => ({ p, src })));
  }

  async pollHot() {
    const now = Date.now();
    const hot = [];
    for (const [p, f] of this.files) if (now - f.mtimeMs < 15 * 60e3) hot.push({ p, src: f.src });
    await this.run(hot);
  }

  async fullScan() {
    const list = [];
    for (const [src, def] of Object.entries(SOURCES)) {
      if (def.kind !== 'sqlite') for (const p of await walkJsonl(def.dir())) list.push({ p, src });
    }
    await this.run(list);
  }

  // 串行执行，避免同一文件被并发读取
  async run(list) {
    if (this.scanning) { this._queued = (this._queued || []).concat(list); return; }
    this.scanning = true;
    const added = [];
    try {
      for (const { p, src } of list) {
        try { await this.ingestFile(p, src, added); } catch (e) { /* 文件被删/占用，下次再试 */ }
      }
    } finally { this.scanning = false; }
    if (this.limitsChanged && !added.length && this.ready) { this.limitsChanged = false; this.emit('records', []); this.saveCacheSoon(); }
    this.limitsChanged = false;
    if (added.length) {
      this.records.sort((a, b) => a.t - b.t);
      if (this.ready) this.emit('records', added);
      this.saveCacheSoon();
    }
    if (this._queued) { const q = this._queued; this._queued = null; await this.run(q); }
  }

  async ingestFile(p, src, added) {
    const st = await fsp.stat(p);
    let f = this.files.get(p);
    if (f && f.size === st.size && f.mtimeMs === st.mtimeMs) return;
    if (!f) { f = { offset: 0, size: 0, mtimeMs: 0, src, st: {} }; this.files.set(p, f); }
    const parse = { claude: this.parseClaude, pi: this.parsePi, dsh: this.parseGeneric }[src] || this.parseCodex;
    const onLine = (data, s, e) => parse.call(this, data, s, e, f.st, p, added);
    if (p.endsWith('.zstd')) {
      // 压缩文件无法从中间续读：变化后整体解压重读，靠 id 去重
      const data = zlib.zstdDecompressSync(await fsp.readFile(p));
      let s0 = 0, i;
      while ((i = data.indexOf(NL, s0)) !== -1) { if (i > s0) onLine(data, s0, i); s0 = i + 1; }
      if (s0 < data.length) onLine(data, s0, data.length);
      f.offset = f.size = st.size; f.mtimeMs = st.mtimeMs;
      return;
    }
    const { offset, size } = await readLines(p, f.offset, onLine);
    f.offset = offset; f.size = size; f.mtimeMs = st.mtimeMs;
  }

  add(rec, added) {
    const old = this.byId.get(rec.id);
    if (old) {
      // 同一条消息被拆成多行写入（每个内容块一行）：取最大值，合并工具名
      for (const k of ['in', 'out', 'cr', 'cw5', 'cw1h', 'pc']) if (rec[k] != null) old[k] = Math.max(old[k] || 0, rec[k]);
      if (rec.tools) old.tools = [...new Set([...(old.tools || []), ...rec.tools])];
      return;
    }
    this.byId.set(rec.id, rec);
    this.records.push(rec);
    added.push(rec);
  }

  noteLimits(src, t, rl) {
    // 历史快照：文件读取顺序不定，先追加，查询时再排序去重
    const h = this.limitHist[src] || (this.limitHist[src] = []);
    const pw = rl.primary || {}, sw = rl.secondary || {};
    h.push({ t, p: pw.used_percent ?? null, pr: pw.resets_at ?? null, pw: pw.window_minutes ?? null, s: sw.used_percent ?? null, sr: sw.resets_at ?? null });
    this.histDirty = true;
    const cur = this.limits[src];
    if (cur && cur.t >= t) return;
    this.limits[src] = { t, plan_type: rl.plan_type || null, primary: rl.primary || null, secondary: rl.secondary || null, credits: rl.credits || null, reached: rl.rate_limit_reached_type || null };
    this.limitsChanged = true;
  }

  // 排好序、去掉相邻重复、只保留最近 35 天的额度历史
  getLimitHist(src) {
    const h = this.limitHist[src] || [];
    if (this.histDirty) {
      for (const k of Object.keys(this.limitHist)) {
        const arr = this.limitHist[k].sort((a, b) => a.t - b.t);
        const cutoff = Date.now() - 35 * 86400e3;
        const out = [];
        for (const x of arr) {
          if (x.t < cutoff) continue;
          const last = out[out.length - 1];
          if (last && last.p === x.p && last.pr === x.pr && last.s === x.s && last.sr === x.sr) continue;
          out.push(x);
        }
        this.limitHist[k] = out;
      }
      this.histDirty = false;
    }
    return this.limitHist[src] || h;
  }

  // ---------- Claude Code ----------
  parseClaude(data, s, e, st, file, added) {
    if (!has(data, s, e, '"type":"assistant"') || !has(data, s, e, '"usage"')) return;
    let d;
    try { d = JSON.parse(data.toString('utf8', s, e)); } catch { return; }
    if (d.type !== 'assistant' || !d.message || !d.message.usage) return;
    const m = d.message, u = m.usage;
    if (m.model === '<synthetic>') return;
    const cc = u.cache_creation || {};
    const cwTotal = num(u.cache_creation_input_tokens);
    const cw1h = num(cc.ephemeral_1h_input_tokens);
    const rec = {
      id: 'c:' + (m.id || d.uuid) + ':' + (d.requestId || ''),
      t: Date.parse(d.timestamp) || Date.now(),
      src: 'claude',
      model: m.model || 'unknown',
      session: d.sessionId || path.basename(file, '.jsonl'),
      project: d.cwd || '',
      in: num(u.input_tokens),
      out: num(u.output_tokens),
      cr: num(u.cache_read_input_tokens),
      cw5: Math.max(0, cwTotal - cw1h),
      cw1h,
      fast: u.speed === 'fast' ? 1 : 0,
      side: d.isSidechain ? 1 : 0,
    };
    if (Array.isArray(m.content)) {
      const tools = m.content.filter((c) => c && c.type === 'tool_use').map((c) => c.name);
      if (tools.length) rec.tools = tools;
    }
    if (rec.in + rec.out + rec.cr + rec.cw5 + rec.cw1h === 0) return;
    this.add(rec, added);
  }

  // ---------- Pi（pi-coding-agent，支持 DeepSeek 等任意供应商）----------
  // usage.input 不含缓存命中；usage.cost 是 pi 按自己的模型配置算好的费用（未配置价格时为 0）
  parsePi(data, s, e, st, file, added) {
    const h = head(data, s, e, 200);
    const isSession = h.indexOf('"type":"session"') !== -1;
    const isCompaction = h.indexOf('"type":"compaction"') !== -1;
    if (!isSession && !isCompaction && !(h.indexOf('"type":"message"') !== -1 && has(data, s, e, '"role":"assistant"') && has(data, s, e, '"usage"'))) return;
    let d;
    try { d = JSON.parse(data.toString('utf8', s, e)); } catch { return; }
    if (d.type === 'session') { st.session = d.id || st.session; st.cwd = d.cwd || st.cwd; return; }
    let u, m = null;
    if (d.type === 'compaction') {
      u = d.usage; // 压缩上下文时生成摘要的那次调用
    } else {
      m = d.message;
      if (!m || m.role !== 'assistant') return;
      u = m.usage;
      st.model = m.model || st.model;
      st.provider = m.provider || st.provider;
    }
    if (!u) return;
    const rec = {
      // 分叉会话会复制历史条目：优先按 responseId 去重，其次按条目 id + 时间
      id: 'p:' + ((m && m.responseId) || (d.type === 'compaction' ? 'c:' : '') + d.id + ':' + d.timestamp),
      t: Date.parse(d.timestamp) || (m && m.timestamp) || Date.now(),
      src: 'pi',
      model: (m && m.model) || st.model || 'unknown',
      provider: (m && m.provider) || st.provider || '',
      session: st.session || path.basename(file, '.jsonl'),
      project: st.cwd || '',
      in: num(u.input),
      out: num(u.output),
      cr: num(u.cacheRead),
      cw5: num(u.cacheWrite),
      cw1h: 0,
      fast: 0,
      side: d.type === 'compaction' ? 1 : 0,
    };
    const pc = u.cost && num(u.cost.total);
    if (pc > 0) rec.pc = pc;
    if (m && Array.isArray(m.content)) {
      const tools = m.content.filter((c) => c && c.type === 'toolCall' && c.name).map((c) => c.name);
      if (tools.length) rec.tools = tools;
    }
    if (rec.in + rec.out + rec.cr + rec.cw5 === 0) return;
    this.add(rec, added);
  }

  // ---------- 通用解析（DeepSeek Harness 等 pi 风格日志）----------
  // 兼容三种 usage 字段命名：pi / OpenAI（DeepSeek API）/ Anthropic
  parseGeneric(data, s, e, st, file, added) {
    const h = head(data, s, e, 200);
    const isSession = h.indexOf('"type":"session"') !== -1;
    if (!isSession && !has(data, s, e, 'usage')) return;
    let d;
    try { d = JSON.parse(data.toString('utf8', s, e)); } catch { return; }
    if (d.type === 'session') { st.session = d.id || st.session; st.cwd = d.cwd || st.cwd; return; }
    const m = d.message && typeof d.message === 'object' ? d.message : d;
    if (m.role && m.role !== 'assistant') return;
    const u = normalizeUsage(m.usage || d.usage || (d.response && d.response.usage));
    if (!u) return;
    st.model = m.model || d.model || st.model;
    st.provider = m.provider || d.provider || st.provider;
    const tsv = d.timestamp || m.timestamp || d.createdAt;
    const rec = {
      id: 'g:' + (m.responseId || m.id || d.id || '') + ':' + tsv,
      t: typeof tsv === 'number' ? tsv : Date.parse(tsv) || Date.now(),
      src: 'dsh', model: st.model || 'unknown', provider: st.provider || '',
      session: st.session || path.basename(path.dirname(file)), project: st.cwd || '',
      ...u, cw1h: 0, fast: 0, side: d.type === 'compaction' ? 1 : 0,
    };
    if (Array.isArray(m.content)) {
      const tools = m.content.filter((c) => c && (c.type === 'toolCall' || c.type === 'tool_use') && c.name).map((c) => c.name);
      if (tools.length) rec.tools = tools;
    }
    if (rec.in + rec.out + rec.cr + rec.cw5 === 0) return;
    this.add(rec, added);
  }

  // ---------- OpenCode（SQLite，只读打开，按 time_updated 增量查询）----------
  async pollOpencode() {
    const def = SOURCES.opencode;
    const file = path.join(def.dir(), def.db);
    if (this._ocBusy) return;
    this._ocBusy = true;
    const added = [];
    try {
      const st = await fsp.stat(file).catch(() => null);
      const wal = await fsp.stat(file + '-wal').catch(() => null);
      const sig = st ? st.mtimeMs + ':' + st.size + ':' + (wal ? wal.mtimeMs + ':' + wal.size : '') : null;
      if (!sig || sig === this._ocSig) return;
      this._ocSig = sig;
      if (!this._oc) {
        const { DatabaseSync } = require('node:sqlite');
        this._oc = new DatabaseSync(file, { readOnly: true });
      }
      const since = this.cursors.opencode || 0;
      const rows = this._oc.prepare(`select m.id, m.session_id, m.time_updated, m.data, s.directory
        from message m left join session s on s.id = m.session_id
        where m.time_updated > ? and json_extract(m.data, '$.role') = 'assistant' order by m.time_updated`).all(since);
      if (!rows.length) return;
      const tools = new Map();
      for (const r of this._oc.prepare(`select message_id, json_extract(data, '$.tool') tool from part
        where time_updated > ? and json_extract(data, '$.type') = 'tool'`).all(Math.max(0, since - 60e3))) {
        if (!tools.has(r.message_id)) tools.set(r.message_id, []);
        tools.get(r.message_id).push(r.tool);
      }
      let max = since;
      for (const row of rows) {
        max = Math.max(max, row.time_updated);
        let d;
        try { d = JSON.parse(row.data); } catch { continue; }
        const tk = d.tokens || {};
        const cache = tk.cache || {};
        const rec = {
          id: 'o:' + row.id,
          t: (d.time && d.time.created) || row.time_updated,
          src: 'opencode', model: d.modelID || 'unknown', provider: d.providerID || '',
          session: row.session_id, project: row.directory || '',
          // opencode 的 output 不含 reasoning，这里合并为输出
          in: num(tk.input), out: num(tk.output) + num(tk.reasoning), cr: num(cache.read), cw5: num(cache.write), cw1h: 0,
          fast: 0, side: d.summary ? 1 : 0,
        };
        if (num(d.cost) > 0) rec.pc = d.cost;
        if (tools.has(row.id)) rec.tools = tools.get(row.id);
        if (rec.in + rec.out + rec.cr + rec.cw5 === 0) continue;
        this.add(rec, added);
      }
      this.cursors.opencode = max;
    } catch (e) {
      // 数据库被锁或版本不兼容：关掉句柄，下次重试
      try { if (this._oc) this._oc.close(); } catch { /* ignore */ }
      this._oc = null; this._ocSig = null;
    } finally {
      this._ocBusy = false;
    }
    if (added.length) {
      this.records.sort((a, b) => a.t - b.t);
      if (this.ready) this.emit('records', added);
      this.saveCacheSoon();
    }
  }

  // ---------- Codex ----------
  parseCodex(data, s, e, st, file, added) {
    const h = head(data, s, e);
    const tm = /"type":"([a-z_]+)"/.exec(h);
    if (!tm) return;
    const type = tm[1];
    if (type === 'response_item') {
      const m = /"payload":\{"type":"(function_call|custom_tool_call|local_shell_call|web_search_call)"/.exec(h);
      if (m) {
        const nm = /"name":"([^"]{1,80})"/.exec(head(data, s, e, 4096));
        (st.tools || (st.tools = [])).push(m[1] === 'local_shell_call' ? 'shell' : m[1] === 'web_search_call' ? 'web_search' : (nm ? nm[1] : m[1]));
      }
      return;
    }
    const want = type === 'token_usage_record' || type === 'turn_context' || type === 'session_meta'
      || (type === 'event_msg' && h.indexOf('"type":"token_count"') !== -1);
    if (!want) return;
    let d;
    try { d = JSON.parse(data.toString('utf8', s, e)); } catch { return; }
    const p = d.payload || {};
    if (type === 'session_meta') {
      st.session = p.id || st.session;
      st.cwd = p.cwd || st.cwd;
      st.sub = p.source && p.source.subagent ? 1 : 0;
      return;
    }
    if (type === 'turn_context') {
      if (p.model) st.model = p.model;
      if (p.cwd) st.cwd = p.cwd;
      return;
    }
    let u, id;
    if (type === 'token_usage_record') {
      st.tur = 1;
      u = p.usage;
      id = 'x:' + (p.response_id || (p.thread_id + ':' + d.ordinal));
      if (p.thread_id && !st.session) st.session = p.thread_id;
    } else {
      if (p.rate_limits) this.noteLimits('codex', Date.parse(d.timestamp) || 0, p.rate_limits);
      // 旧版 Codex 只有 token_count 事件；同一响应可能重复上报，按累计值去重
      if (st.tur || !p.info || !p.info.last_token_usage) return;
      const tot = p.info.total_token_usage && p.info.total_token_usage.total_tokens;
      if (tot === st.lastTotal) return;
      st.lastTotal = tot;
      u = p.info.last_token_usage;
      id = 'x:' + (st.session || file) + ':' + tot;
    }
    if (!u) return;
    const input = num(u.input_tokens), cached = num(u.cached_input_tokens), cw = num(u.cache_write_input_tokens);
    const rec = {
      id,
      t: Date.parse(d.timestamp) || Date.now(),
      src: 'codex',
      model: st.model || 'unknown',
      session: st.session || path.basename(file, '.jsonl'),
      project: st.cwd || '',
      in: Math.max(0, input - cached - cw),
      out: num(u.output_tokens),
      cr: cached,
      cw5: cw,
      cw1h: 0,
      fast: 0,
      side: st.sub || 0,
    };
    if (st.tools && st.tools.length) { rec.tools = st.tools; st.tools = []; }
    if (rec.in + rec.out + rec.cr + rec.cw5 === 0) return;
    this.add(rec, added);
  }
}

module.exports = { Collector, SOURCES };
