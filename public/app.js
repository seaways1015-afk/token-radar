/* Token Radar 前端：拉取 /api/summary 渲染面板，订阅 /api/events 播放实时水滴 */
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const NS = 'http://www.w3.org/2000/svg';
  const bridge = window.tp; // Electron preload 暴露；浏览器模式下为 undefined
  if (bridge) document.body.classList.add('electron');

  const state = {
    range: load('tp-range', 'today'),
    src: load('tp-src', 'all'),
    data: null,
    connected: false,
  };
  function load(k, d) { try { return localStorage.getItem(k) || d; } catch { return d; } }
  function save(k, v) { try { localStorage.setItem(k, v); } catch { /* 隐私模式 */ } }

  // ---------- 格式化 ----------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function split(n) {
    const a = Math.abs(n);
    if (a >= 1e9) return [(n / 1e9).toFixed(a >= 1e11 ? 0 : a >= 1e10 ? 1 : 2), 'B'];
    if (a >= 1e6) return [(n / 1e6).toFixed(a >= 1e8 ? 0 : 1), 'M'];
    if (a >= 1e3) return [(n / 1e3).toFixed(a >= 1e5 ? 0 : 1), 'K'];
    return [String(Math.round(n)), ''];
  }
  const fmt = (n) => split(n).join('');
  const fmtH = (n) => { const [v, u] = split(n); return u ? `${v}<span class="u">${u}</span>` : v; };
  const usd = (n) => n >= 1000 ? '$' + Math.round(n).toLocaleString() : n >= 100 ? '$' + n.toFixed(1) : '$' + n.toFixed(2);
  const usdH = (n) => `<span class="u" style="font-variant:normal;font-size:.6em">$</span>${usd(n).slice(1)}`;
  const pct = (x) => (x * 100).toFixed(x >= 0.995 || x < 0.1 ? 1 : 1) + '%';
  const pad = (n) => String(n).padStart(2, '0');
  const WEEK = '日一二三四五六';
  function ago(t) {
    const s = (Date.now() - t) / 1000;
    if (s < 60) return '刚刚';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    return Math.floor(s / 86400) + ' 天前';
  }
  function hms(t) { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
  function md(t) { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}`; }
  function bucketLabel(t, size) {
    const d = new Date(t), e = new Date(t + size);
    if (size <= 3600e3) return `${pad(d.getHours())}:00 – ${pad(e.getHours())}:00`;
    if (size < 86400e3) return `${md(t)} ${pad(d.getHours())}:00 – ${pad(e.getHours() || 24)}:00`;
    if (size === 86400e3) return `${md(t)} 周${WEEK[d.getDay()]}`;
    return `${md(t)} 起一周`;
  }
  function axisLabel(t, size, range) {
    const d = new Date(t);
    if (range === 'today') return `${pad(d.getHours())}:00`;
    if (size < 86400e3 && d.getHours() !== 0) return `${pad(d.getHours())}:00`;
    return md(t);
  }
  const color = (src) => `var(--c-${src === 'claude' || src === 'codex' ? src : 'other'})`;
  const SRC_META = {
    claude: { mark: '✳', angle: -135 },
    codex: { mark: '◎', angle: -45 },
    pi: { mark: 'π', angle: 90 },
  };
  const svg = (tag, attrs = {}) => { const el = document.createElementNS(NS, tag); for (const k in attrs) el.setAttribute(k, attrs[k]); return el; };

  // ---------- 浮层提示 ----------
  const tip = $('#tip');
  function showTip(html, x, y) {
    tip.innerHTML = html; tip.hidden = false;
    const r = tip.getBoundingClientRect();
    let left = x + 14, top = y + 14;
    if (left + r.width > innerWidth - 8) left = x - r.width - 14;
    if (top + r.height > innerHeight - 8) top = y - r.height - 14;
    tip.style.left = Math.max(8, left) + 'px'; tip.style.top = Math.max(8, top) + 'px';
  }
  const hideTip = () => { tip.hidden = true; };

  // ---------- 平滑曲线（单调三次插值，不会冲出数据范围）----------
  function monotone(pts) {
    const n = pts.length;
    if (n < 2) return n ? `M${pts[0][0]},${pts[0][1]}` : '';
    const dx = [], m = [], t = [];
    for (let i = 0; i < n - 1; i++) { dx[i] = pts[i + 1][0] - pts[i][0]; m[i] = (pts[i + 1][1] - pts[i][1]) / (dx[i] || 1); }
    t[0] = m[0]; t[n - 1] = m[n - 2];
    for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (m[i] === 0) { t[i] = t[i + 1] = 0; continue; }
      const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
      if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
    }
    let d = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 0; i < n - 1; i++) {
      const h = dx[i] / 3;
      d += `C${pts[i][0] + h},${pts[i][1] + t[i] * h} ${pts[i + 1][0] - h},${pts[i + 1][1] - t[i + 1] * h} ${pts[i + 1][0]},${pts[i + 1][1]}`;
    }
    return d;
  }

  // ---------- 数据 ----------
  let loadTimer = null, inflight = false;
  async function refresh() {
    if (inflight) { scheduleRefresh(); return; }
    inflight = true;
    try {
      const r = await fetch(`/api/summary?range=${state.range}&src=${state.src}`);
      const d = await r.json();
      if (d.loading) { setLive('loading'); setTimeout(refresh, 800); return; }
      state.data = d;
      render(d);
      if (state.connected) setLive('on');
    } catch { setLive('off'); } finally { inflight = false; }
  }
  function scheduleRefresh(ms = 500) { clearTimeout(loadTimer); loadTimer = setTimeout(refresh, ms); }

  function setLive(s) {
    const el = $('#live');
    el.classList.toggle('on', s === 'on'); el.classList.toggle('off', s === 'off');
    $('#liveText').textContent = s === 'on' ? '实时监听中' : s === 'off' ? '连接断开，重试中…' : '正在读取日志…';
  }

  function connect() {
    const es = new EventSource('/api/events');
    es.addEventListener('hello', () => { state.connected = true; refresh(); });
    es.addEventListener('update', (e) => {
      const { live } = JSON.parse(e.data);
      for (const it of live) if (state.src === 'all' || it.src === state.src) spawnDrop(it);
      scheduleRefresh(live.length ? 400 : 100);
    });
    es.onerror = () => { state.connected = false; setLive('off'); };
    es.onopen = () => { state.connected = true; };
  }

  // ---------- 渲染 ----------
  function render(d) {
    renderRealtime(d);
    renderKpis(d);
    renderSources(d);
    renderTrend(d);
    renderLists(d);
    renderMini(d);
  }

  function deltaHTML(cur, prev, label) {
    if (!prev || prev <= 0) return cur > 0 && prev === 0 ? `${label}<b>新增</b>` : '';
    const r = cur / prev - 1;
    const arrow = r >= 0 ? '↑' : '↓';
    return `${label}<b>${arrow}${Math.abs(r * 100).toFixed(0)}%</b>`;
  }
  const PREV_LABEL = { today: '较昨日同期', '7d': '较前 7 天', '30d': '较前 30 天' };

  function renderKpis(d) {
    const t = d.totals, p = d.prev, lbl = PREV_LABEL[d.range];
    $('#vTotal').innerHTML = fmtH(t.tokens);
    $('#sTotal').textContent = `${t.requests.toLocaleString()} 次请求 · ${t.sessions} 个会话`;
    $('#dTotal').innerHTML = p ? deltaHTML(t.tokens, p.tokens, lbl) : '';
    $('#dTotal').hidden = !$('#dTotal').innerHTML;

    $('#vCost').innerHTML = usdH(t.cost);
    const active = d.sources.filter((s) => s.requests > 0 && (state.src === 'all' || s.id === state.src));
    const allSub = active.length > 0 && active.every((s) => s.plan && s.plan.subscription);
    $('#costTitle').textContent = allSub ? '等价 API 费用' : '预估费用';
    $('#kCost').title = allSub ? '你使用的是订阅，这里是按 API 公开价折算的等价值，不会额外扣费' : '';
    $('#sCost').textContent = `缓存已帮你省下 ${usd(t.saved)}${allSub ? ' · 订阅不额外计费' : ''}`;
    $('#dCost').innerHTML = p ? deltaHTML(t.cost, p.cost, lbl) : '';
    $('#dCost').hidden = !$('#dCost').innerHTML;
    const bu = $('#bUnpriced');
    bu.hidden = !t.unpriced; bu.textContent = `${fmt(t.unpriced)} 未计价`;
    bu.title = '部分模型没有价格，点击设置';

    const now = d.now;
    const pts = d.series.filter((s) => s.t <= now);
    sparkline($('#spTotal'), pts.map((s) => [s.t, s.tokens]), d.bucket, fmt);
    sparkline($('#spCost'), pts.map((s) => [s.t, s.cost]), d.bucket, usd);

    $('#vIn').innerHTML = fmtH(t.input);
    $('#vOut').innerHTML = fmtH(t.output);
    const io = t.input + t.output;
    $('#ioShare').textContent = io ? `输出占 ${pct(t.output / io)}` : '';
    $('#ioBar .in').style.flexGrow = io ? t.input / io : 1;
    $('#ioBar .out').style.flexGrow = io ? t.output / io : 1;
    $('#ioCw').textContent = t.cacheWrite ? `· 缓存写入 ${fmt(t.cacheWrite)}` : '';

    const denom = t.cacheRead + t.input + t.cacheWrite;
    const hit = denom ? t.cacheRead / denom : 0;
    $('#vHit').innerHTML = denom ? `${(hit * 100).toFixed(1)}<span class="u" style="font-variant:normal">%</span>` : '—';
    $('#sHit').textContent = `读取 ${fmt(t.cacheRead)} · 写入 ${fmt(t.cacheWrite)}`;
    gauge(hit);
  }

  function sparkline(host, pts, bucket, f) {
    const W = host.clientWidth || 300, H = host.clientHeight || 74;
    host.innerHTML = '';
    if (!pts.length) return;
    const max = Math.max(...pts.map((p) => p[1])) || 1;
    const n = pts.length;
    const xy = pts.map((p, i) => [n === 1 ? W / 2 : (i / (n - 1)) * W, H - 4 - (p[1] / max) * (H - 14)]);
    const line = monotone(xy);
    const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none' });
    s.append(svg('path', { class: 'area', d: `${line}L${W},${H}L0,${H}Z` }), svg('path', { class: 'line', d: line }));
    const cur = svg('line', { class: 'cursor', y1: 0, y2: H, visibility: 'hidden' });
    const dot = svg('circle', { class: 'pt', r: 4, visibility: 'hidden' });
    s.append(cur, dot);
    host.append(s);
    host.onmousemove = (e) => {
      const r = host.getBoundingClientRect();
      const i = Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width) * (n - 1))));
      cur.setAttribute('x1', xy[i][0]); cur.setAttribute('x2', xy[i][0]); cur.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', xy[i][0]); dot.setAttribute('cy', xy[i][1]); dot.setAttribute('visibility', 'visible');
      showTip(`<div class="muted">${bucketLabel(pts[i][0], bucket)}</div><b>${f(pts[i][1])}</b>`, e.clientX, e.clientY);
    };
    host.onmouseleave = () => { cur.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); hideTip(); };
  }

  function arc(cx, cy, r, a0, a1) {
    const p = (a) => [cx + r * Math.cos(a * Math.PI / 180), cy + r * Math.sin(a * Math.PI / 180)];
    const [x0, y0] = p(a0), [x1, y1] = p(a1);
    return `M${x0},${y0}A${r},${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1},${y1}`;
  }
  function gauge(v) {
    const a0 = 135, sweep = 270, a1 = a0 + sweep * Math.max(0.001, Math.min(1, v));
    $('#gTrack').setAttribute('d', arc(50, 50, 40, a0, a0 + sweep));
    $('#gVal').setAttribute('d', arc(50, 50, 40, a0, a1));
    const rad = a1 * Math.PI / 180;
    $('#gDot').setAttribute('cx', 50 + 40 * Math.cos(rad));
    $('#gDot').setAttribute('cy', 50 + 40 * Math.sin(rad));
  }

  // ---------- 实时环 ----------
  const R_DOT = 150, R_TICK = 150, R_INNER = 124;
  let ringBuilt = false;
  function buildRing() {
    const dots = $('#ringDots');
    for (let i = 0; i < 120; i++) {
      const a = (i / 120) * Math.PI * 2;
      dots.append(svg('circle', { cx: (R_INNER * Math.cos(a)).toFixed(2), cy: (R_INNER * Math.sin(a)).toFixed(2), r: 1.1 }));
    }
    for (let i = 0; i < 60; i++) {
      const a = ((i + 1) / 60) * Math.PI * 2 - Math.PI / 2;
      dots.append(svg('circle', { cx: (R_DOT * Math.cos(a)).toFixed(2), cy: (R_DOT * Math.sin(a)).toFixed(2), r: 1.6 }));
    }
    drawSpark($('#spark'), 1);
    drawSpark($('#miniSpark'), 1.35);
    ringBuilt = true;
  }
  const RAYS = [66, 54, 72, 58, 68, 52, 70, 60, 64, 56, 71, 55];
  function drawSpark(g, scale) {
    g.innerHTML = '';
    if (g.id === 'spark') g.append(svg('circle', { class: 'glow', r: 46 }));
    RAYS.forEach((len, i) => {
      const a = (i / RAYS.length) * Math.PI * 2 + 0.2;
      const r0 = 10 * scale, r1 = len * scale;
      g.append(svg('path', { d: `M${(r0 * Math.cos(a)).toFixed(1)},${(r0 * Math.sin(a)).toFixed(1)}L${(r1 * Math.cos(a)).toFixed(1)},${(r1 * Math.sin(a)).toFixed(1)}` }));
    });
  }

  function renderRealtime(d) {
    if (!ringBuilt) buildRing();
    const rt = d.realtime;
    $('#rtPerMin').innerHTML = fmtH(rt.perMin);
    $('#rtCost').innerHTML = `<b>${usd(rt.lastHourCost)}</b> / 小时`;
    $('#rtHour').innerHTML = `近 1 小时 <b>${fmt(rt.lastHourTokens)}</b> tokens`;
    activity = rt.perMin;

    const g = $('#ringTicks');
    g.innerHTML = '';
    const max = Math.max(...rt.minutes, 1);
    rt.minutes.forEach((v, i) => {
      const a = ((i + 1) / 60) * Math.PI * 2 - Math.PI / 2;
      const len = v > 0 ? 8 + 46 * Math.sqrt(v / max) : 0;
      const c = Math.cos(a), s = Math.sin(a);
      const x1 = (R_TICK + 6) * c, y1 = (R_TICK + 6) * s, x2 = (R_TICK + 6 + len) * c, y2 = (R_TICK + 6 + len) * s;
      if (len) g.append(svg('line', { x1, y1, x2, y2, 'data-i': i, style: `opacity:${0.35 + 0.65 * ((i + 1) / 60)}` }));
      // 更大的透明命中区
      const hit = svg('line', { class: 'hit', x1: (R_TICK - 8) * c, y1: (R_TICK - 8) * s, x2: (R_TICK + 58) * c, y2: (R_TICK + 58) * s });
      hit.addEventListener('mousemove', (e) => {
        const t = rt.minuteStart + i * 60e3;
        const dt = new Date(t);
        g.querySelectorAll('.hover').forEach((x) => x.classList.remove('hover'));
        const vis = g.querySelector(`line[data-i="${i}"]`); if (vis) vis.classList.add('hover');
        showTip(`<div class="muted">${pad(dt.getHours())}:${pad(dt.getMinutes())}（${59 - i ? (59 - i) + ' 分钟前' : '本分钟'}）</div><b>${fmt(v)}</b> tokens`, e.clientX, e.clientY);
      });
      hit.addEventListener('mouseleave', () => { hideTip(); g.querySelectorAll('.hover').forEach((x) => x.classList.remove('hover')); });
      g.append(hit);
    });

    // 水滴图例：只列出有数据的来源
    const srcs = d.sources.filter((s) => s.requests > 0 && (state.src === 'all' || s.id === state.src));
    $('#heroLegend').innerHTML = srcs.map((s) => `<span><i style="background:${color(s.id)}"></i>${esc(s.label)}</span>`).join('');
  }

  // 动画循环：星芒按活跃度旋转，水滴向心飞入，到达时星芒脉动
  let activity = 0, rot = 0, pulse = 0, lastFrame = performance.now();
  const drops = [];
  function spawnDrop(it) {
    const base = (SRC_META[it.src] || { angle: 90 }).angle;
    const angle = (base + (Math.random() - 0.5) * 36) * Math.PI / 180;
    const el = svg('circle', { r: Math.min(9, 2.5 + Math.log10(Math.max(10, it.tokens)) * 1.1), fill: color(it.src) });
    $('#drops').append(el);
    drops.push({ el, angle, t0: performance.now(), dur: 1400 + Math.random() * 500, tokens: it.tokens });
  }
  function frame(now) {
    const dt = Math.min(100, now - lastFrame); lastFrame = now;
    const speed = 4 + Math.min(60, Math.log10(1 + activity) * 12); // 度/秒
    rot = (rot + speed * dt / 1000) % 360;
    pulse *= Math.pow(0.04, dt / 1000);
    const s = 1 + pulse * 0.22;
    $('#spark').setAttribute('transform', `rotate(${rot.toFixed(2)}) scale(${s.toFixed(3)})`);
    $('#miniSpark').style.transform = `rotate(${rot.toFixed(2)}deg)`;
    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      const p = Math.min(1, (now - d.t0) / d.dur);
      const e = p * p * (3 - 2 * p);
      const r = 205 - e * 175;
      const wob = Math.sin(p * Math.PI) * 0.25;
      d.el.setAttribute('cx', (r * Math.cos(d.angle + wob)).toFixed(1));
      d.el.setAttribute('cy', (r * Math.sin(d.angle + wob)).toFixed(1));
      d.el.setAttribute('opacity', (p < 0.1 ? p * 10 : p > 0.85 ? (1 - p) / 0.15 : 1).toFixed(2));
      if (p >= 1) { d.el.remove(); drops.splice(i, 1); pulse = Math.min(1.4, pulse + 0.5 + Math.log10(Math.max(10, d.tokens)) / 12); }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ---------- 订阅 / 额度 ----------
  function dur(ms) {
    const m = Math.max(0, Math.round(ms / 60e3));
    if (m < 60) return `${m} 分钟`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} 小时 ${m % 60} 分`;
    return `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
  }
  function subscriptionHTML(s, d) {
    const plan = s.plan;
    if (!plan || !plan.subscription) return '';
    const m = s.month;
    if (!m.cost && m.unpriced) return `<div class="subline">本月 ${fmt(m.tokens)} tokens · 模型未计价，<span class="link" data-pricing>填写价格</span>后可折算</div>`;
    if (plan.monthly == null) return `<div class="subline">本月折算 ${usd(m.cost)} · <span class="link" data-pricing>填写月费</span>后可算回本比例</div>`;
    const ratio = m.cost / plan.monthly;
    const now = new Date(d.now);
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const proj = d.dayOfMonth >= 1 ? m.cost / d.dayOfMonth * daysInMonth : null;
    const verdict = ratio >= 1 ? `<b class="good">已回本 ${ratio.toFixed(1)}×</b>` : `已用出 <b>${Math.round(ratio * 100)}%</b> 月费`;
    return `<div class="subline" title="${proj != null ? `按当前速度，月底约折合 ${usd(proj)}` : ''}">本月折算 <b>${usd(m.cost)}</b> / 月费 ${usd(plan.monthly)} · ${verdict}</div>`;
  }
  function quotaHTML(lim) {
    if (!lim || !(lim.primary || lim.secondary)) return '';
    const now = Date.now();
    const row = (w) => {
      if (!w) return '';
      const name = w.window_minutes === 300 ? '5 小时额度' : w.window_minutes === 10080 ? '每周额度' : `${Math.round(w.window_minutes / 60)} 小时额度`;
      const resetAt = w.resets_at * 1000;
      const reset = resetAt <= now;
      const p = reset ? 0 : Math.min(100, w.used_percent);
      const cls = p >= 90 ? 'hot' : p >= 75 ? 'warm' : '';
      return `<div class="quota ${cls}"><span>${name}</span><span class="qb"><i style="width:${p}%"></i></span>
        <span class="qv">${reset ? '已重置' : `${Math.round(p)}%`}</span><span class="qr">${reset ? '' : dur(resetAt - now) + '后重置'}</span></div>`;
    };
    return `<div class="quotas" title="来自最近一次请求的上报 · ${ago(lim.t)}">${row(lim.primary)}${row(lim.secondary)}</div>`;
  }

  // ---------- Agent 工具卡片 ----------
  function renderSources(d) {
    const host = $('#sources');
    const total = d.sources.reduce((a, s) => a + s.tokens, 0) || 1;
    host.innerHTML = '';
    for (const s of d.sources) {
      const on = state.src === s.id;
      const b = document.createElement('button');
      b.className = 'card src' + (on ? ' on' : state.src !== 'all' ? ' dim' : '');
      b.style.setProperty('--c', color(s.id));
      const active = s.last && Date.now() - s.last < 3 * 60e3;
      const plan = s.plan;
      const planTag = plan && plan.detected.plan !== 'unknown' || plan && plan.mode !== 'auto'
        ? `<span class="plan ${plan.subscription ? 'sub' : ''}" title="${esc(plan.detected.via ? '识别自 ' + plan.detected.via : '手动设置')}">${esc(plan.label)}</span>` : '';
      b.innerHTML = `
        <div class="top"><span class="logo">${(SRC_META[s.id] || {}).mark || '•'}</span><span class="name">${esc(s.label)}</span>${planTag}
          <span class="ago ${active ? 'active' : ''}">${s.last ? ago(s.last) : '无记录'}</span></div>
        <div class="big">${fmtH(s.tokens)}</div>
        <div class="meta"><span>${s.unpriced && !s.cost ? '未计价' : (plan && plan.subscription ? '等价 ' : '') + usd(s.cost)}</span><span>${s.requests.toLocaleString()} 次请求</span><span>${s.sessions} 个会话</span></div>
        ${s.providers && s.providers.length ? `<div class="subline">供应商：${s.providers.slice(0, 3).map((p) => `<b>${esc(p.name)}</b> <span class="muted">${esc(p.models.slice(0, 2).join('、'))}</span>`).join(' · ')}</div>` : ''}
        ${subscriptionHTML(s, d)}
        ${quotaHTML(s.limits)}
        <div class="share" title="占比 ${pct(s.tokens / total)}"><i style="width:${(s.tokens / total) * 100}%"></i></div>`;
      b.onclick = () => { state.src = on ? 'all' : s.id; save('tp-src', state.src); refresh(); };
      host.append(b);
    }
  }

  // ---------- 趋势（按来源堆叠面积，单一 y 轴）----------
  function niceMax(v) {
    if (v <= 0) return 1;
    const e = Math.pow(10, Math.floor(Math.log10(v))), f = v / e;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e;
  }
  function renderTrend(d) {
    const host = $('#trend');
    const W = host.clientWidth || 600, H = host.clientHeight || 260;
    const L = 46, Rp = 8, T = 10, B = 26;
    const series = d.series;
    const n = series.length;
    const ids = d.sources.map((s) => s.id).filter((id) => (state.src === 'all' || id === state.src) && series.some((b) => b.bySrc[id]));
    $('#trendLegend').innerHTML = ids.length > 1 ? ids.map((id) => `<span><i class="sw" style="background:${color(id)}"></i>${esc(d.sources.find((s) => s.id === id).label)}</span>`).join('') : '';
    const visible = series.filter((b) => b.t <= d.now);
    const max = niceMax(Math.max(...visible.map((b) => b.tokens), 0));
    const x = (i) => L + (n === 1 ? (W - L - Rp) / 2 : (i / (n - 1)) * (W - L - Rp));
    const y = (v) => T + (1 - v / max) * (H - T - B);
    const s = svg('svg', { viewBox: `0 0 ${W} ${H}` });
    const grid = svg('g', { class: 'grid' }), axis = svg('g', { class: 'axis' });
    for (let k = 0; k <= 4; k++) {
      const v = (max / 4) * k;
      grid.append(svg('line', { x1: L, x2: W - Rp, y1: y(v), y2: y(v) }));
      const tx = svg('text', { x: L - 8, y: y(v) + 4, 'text-anchor': 'end' }); tx.textContent = fmt(v); axis.append(tx);
    }
    const step = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((W - L) / 70))));
    for (let i = 0; i < n; i += step) {
      const tx = svg('text', { x: x(i), y: H - 6, 'text-anchor': 'middle' }); tx.textContent = axisLabel(series[i].t, d.bucket, d.range); axis.append(tx);
    }
    s.append(grid, axis);
    // 堆叠：自下而上
    const m = visible.length;
    const base = new Array(m).fill(0);
    for (const id of ids) {
      const top = visible.map((b, i) => base[i] + (b.bySrc[id] || 0));
      const up = monotone(top.map((v, i) => [x(i), y(v)]));
      const downPts = base.map((v, i) => [x(i), y(v)]).reverse();
      const down = monotone(downPts).replace(/^M/, 'L');
      const g = svg('g');
      g.append(svg('path', { d: up + down + 'Z', fill: color(id), 'fill-opacity': 0.22 }));
      g.append(svg('path', { d: up, fill: 'none', stroke: color(id), 'stroke-width': 2, 'stroke-linejoin': 'round' }));
      s.append(g);
      top.forEach((v, i) => { base[i] = v; });
    }
    const cur = svg('line', { class: 'cursor', y1: T, y2: H - B, visibility: 'hidden' });
    s.append(cur);
    host.innerHTML = ''; host.append(s);
    host.onmousemove = (e) => {
      if (!m) return;
      const r = host.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * W;
      const i = Math.max(0, Math.min(m - 1, Math.round(((px - L) / (W - L - Rp)) * (n - 1))));
      cur.setAttribute('x1', x(i)); cur.setAttribute('x2', x(i)); cur.setAttribute('visibility', 'visible');
      const b = visible[i];
      const rows = ids.map((id) => `<div class="r"><span><i style="background:${color(id)}"></i>${esc(d.sources.find((s) => s.id === id).label)}</span><b>${fmt(b.bySrc[id] || 0)}</b></div>`).join('');
      showTip(`<div class="muted">${bucketLabel(b.t, d.bucket)}</div>${rows}<div class="r"><span>合计</span><b>${fmt(b.tokens)} · ${usd(b.cost)}</b></div>`, e.clientX, e.clientY);
    };
    host.onmouseleave = () => { cur.setAttribute('visibility', 'hidden'); hideTip(); };
  }

  // ---------- 列表 ----------
  function rowsHTML(items, render, empty = '暂无数据') {
    return items.length ? items.map(render).join('') : `<li class="empty">${empty}</li>`;
  }
  function renderLists(d) {
    const mm = d.models.slice(0, 8), mMax = mm[0] ? mm[0].tokens : 1;
    $('#modelCount').textContent = d.models.length ? `${d.models.length} 个模型` : '';
    $('#models').innerHTML = rowsHTML(mm, (m) => `
      <li style="--c:${color(m.src)}"><span class="nm"><i class="sw" style="background:${color(m.src)}"></i>${m.provider ? `<span class="muted">${esc(m.provider)} ·</span>` : ''}${esc(m.model)}${m.priced ? '' : '<button class="tag" data-pricing>未计价</button>'}</span>
      <span class="v">${fmt(m.tokens)}${m.priced ? ' · ' + usd(m.cost) : ''}</span><span class="bar"><i style="width:${(m.tokens / mMax) * 100}%"></i></span></li>`);

    const pp = d.projects, pMax = pp[0] ? pp[0].tokens : 1;
    $('#projects').innerHTML = rowsHTML(pp, (p) => {
      const name = p.project.split(/[\\/]/).filter(Boolean).pop() || p.project;
      return `<li title="${esc(p.project)}"><span class="nm">${esc(name)}<span class="muted">${p.sessions} 会话</span></span>
        <span class="v">${fmt(p.tokens)} · ${!p.cost && p.unpriced ? '未计价' : usd(p.cost)}</span><span class="bar"><i style="width:${(p.tokens / pMax) * 100}%"></i></span></li>`;
    });

    const tt = d.tools, tMax = tt[0] ? tt[0].count : 1;
    $('#tools').innerHTML = rowsHTML(tt, (t) => `
      <li><span class="nm">${esc(t.name)}</span><span class="v">${t.count.toLocaleString()} 次</span><span class="bar"><i style="width:${(t.count / tMax) * 100}%"></i></span></li>`);

    const seen = renderLists.seen || new Set();
    const first = !renderLists.seen;
    $('#recent').innerHTML = rowsHTML(d.recent, (r) => {
      const k = r.t + r.model + r.tokens;
      const isNew = !first && !seen.has(k);
      const when = Date.now() - r.t < 86400e3 ? hms(r.t).slice(0, 5) : md(r.t);
      const tools = r.tools.length ? `<small>${esc(r.tools.slice(0, 3).join(' · '))}</small>` : r.side ? '<small>子代理</small>' : '';
      return `<li class="${isNew ? 'new' : ''}" style="--c:${color(r.src)}" title="${esc(`${new Date(r.t).toLocaleString()}\n新输入 ${fmt(r.in)} · 输出 ${fmt(r.out)} · 缓存读 ${fmt(r.cr)} · 缓存写 ${fmt(r.cw)}\n${r.project}`)}">
        <i class="d"></i><span class="tm">${when}</span><span class="md">${r.provider ? esc(r.provider) + ' · ' : ''}${esc(r.model)}${tools}</span>
        <span class="tk">${fmt(r.tokens)}<small>${r.cost == null ? '—' : usd(r.cost)}</small></span></li>`;
    }, '这个范围内还没有请求');
    renderLists.seen = new Set(d.recent.map((r) => r.t + r.model + r.tokens));
  }

  function renderMini(d) {
    $('#mPerMin').innerHTML = fmtH(d.realtime.perMin);
    $('#mToday').innerHTML = fmtH(d.totals.tokens);
    $('#mCost').textContent = usd(d.totals.cost);
  }

  // ---------- 定价设置 ----------
  async function openPricing() {
    const r = await fetch('/api/pricing').then((x) => x.json());
    const rows = r.models.map((m) => {
      const u = m.user;
      const p = m.price;
      const val = (k) => (u && u[k] != null ? u[k] : '');
      const ph = (k) => (p ? +p[k].toFixed(4) : '');
      const tag = u ? '自定义' : p ? '内置' : '<span class="tag">未计价</span>';
      return `<tr data-model="${esc(m.model)}"><td>${esc(m.model)}</td>
        <td><input data-k="input" inputmode="decimal" value="${val('input')}" placeholder="${ph('input')}"></td>
        <td><input data-k="output" inputmode="decimal" value="${val('output')}" placeholder="${ph('output')}"></td>
        <td><input data-k="cacheRead" inputmode="decimal" value="${val('cacheRead')}" placeholder="${ph('cacheRead')}"></td>
        <td><input data-k="cacheWrite5m" inputmode="decimal" value="${val('cacheWrite5m')}" placeholder="${ph('cacheWrite5m')}"></td>
        <td class="src-tag">${tag}</td></tr>`;
    });
    $('#pricingRows').innerHTML = rows.join('') || '<tr><td colspan="6" class="muted">还没有读取到任何模型</td></tr>';
    state.pricingOthers = r.userOthers || [];
    $('#planMsg').textContent = ''; $('#priceMsg').textContent = '';
    renderPlans(await fetch('/api/plans').then((x) => x.json()));
    $('#pricingDlg').showModal();
  }

  const SRC_LABEL = { claude: 'Claude Code', codex: 'Codex' };
  function renderPlans(plans, fromScan) {
    $('#plansRows').innerHTML = Object.entries(plans).map(([id, p]) => {
      const det = p.detected;
      const detText = det.plan === 'unknown' ? '<span class="muted">未识别</span>'
        : `${esc(det.label)}${det.via ? ` <span class="src-tag">来自 ${esc(det.via)}</span>` : ''}`;
      const mode = fromScan ? 'auto' : p.mode;
      const monthly = fromScan ? (det.monthly ?? '') : (p.monthly ?? '');
      const opt = (v, t) => `<option value="${v}" ${mode === v ? 'selected' : ''}>${t}</option>`;
      return `<tr data-src="${id}"><td>${SRC_LABEL[id] || id}</td><td>${detText}</td>
        <td><select>${opt('auto', '自动识别')}${opt('subscription', '订阅')}${opt('api', 'API 按量')}</select></td>
        <td class="${fromScan && det.monthly != null ? 'filled' : ''}"><input data-k="monthly" inputmode="decimal" value="${monthly}" placeholder="${det.monthly ?? '如 20'}"></td></tr>`;
    }).join('');
  }
  async function scanPlans() {
    $('#planMsg').textContent = '扫描中…';
    const plans = await fetch('/api/plans').then((x) => x.json());
    renderPlans(plans, true);
    const found = Object.entries(plans).filter(([, p]) => p.detected.plan !== 'unknown').map(([, p]) => p.detected.label);
    $('#planMsg').textContent = found.length ? `已识别：${found.join('、')}（点保存生效）` : '没有识别到订阅，请手动选择';
  }
  async function syncPrices() {
    const btn = $('#btnSyncPrices');
    btn.disabled = true; $('#priceMsg').textContent = '正在下载价格表…';
    try {
      const r = await fetch('/api/prices/sync');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.status);
      let n = 0;
      for (const [model, p] of Object.entries(d.found)) {
        const tr = document.querySelector(`#pricingRows tr[data-model="${CSS.escape(model)}"]`);
        if (!tr) continue;
        for (const inp of tr.querySelectorAll('input')) {
          const v = p[inp.dataset.k];
          if (v != null && inp.value.trim() === '') { inp.value = v; inp.parentElement.classList.add('filled'); }
        }
        tr.lastElementChild.innerHTML = `<span title="LiteLLM: ${esc(p.matched)}">已同步</span>`;
        n++;
      }
      $('#priceMsg').textContent = n || d.missing.length
        ? `已填入 ${n} 个模型${d.missing.length ? `，未找到：${d.missing.join('、')}` : ''}（点保存生效）`
        : '所有模型都已有价格';
    } catch (e) {
      $('#priceMsg').textContent = '同步失败：' + e.message;
    } finally { btn.disabled = false; }
  }
  async function savePricing() {
    const models = [...state.pricingOthers];
    for (const tr of document.querySelectorAll('#pricingRows tr[data-model]')) {
      const o = { match: tr.dataset.model };
      for (const inp of tr.querySelectorAll('input')) if (inp.value.trim() !== '') o[inp.dataset.k] = Number(inp.value);
      if (o.input != null && o.output != null) models.push(o);
    }
    const plans = {};
    for (const tr of document.querySelectorAll('#plansRows tr[data-src]')) {
      const v = tr.querySelector('input').value.trim();
      plans[tr.dataset.src] = { mode: tr.querySelector('select').value, monthly: v === '' ? null : Number(v) };
    }
    await Promise.all([
      fetch('/api/pricing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ models }) }),
      fetch('/api/plans', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(plans) }),
    ]);
    refresh();
  }

  // ---------- 主题 ----------
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    if (bridge && bridge.setTheme) bridge.setTheme(t);
  }
  function effectiveDark() {
    const t = document.documentElement.dataset.theme;
    return t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  }

  // ---------- 事件绑定 ----------
  function bind() {
    for (const b of document.querySelectorAll('#range button')) {
      b.classList.toggle('on', b.dataset.range === state.range);
      b.onclick = () => {
        state.range = b.dataset.range; save('tp-range', state.range);
        document.querySelectorAll('#range button').forEach((x) => x.classList.toggle('on', x === b));
        refresh();
      };
    }
    $('#btnExport').onclick = () => { location.href = '/api/export'; };
    $('#btnPricing').onclick = openPricing;
    $('#bUnpriced').onclick = openPricing;
    document.addEventListener('click', (e) => { if (e.target.closest('[data-pricing]')) openPricing(); });
    $('#pricingSave').onclick = () => { savePricing(); };
    $('#btnScanPlans').onclick = scanPlans;
    $('#btnSyncPrices').onclick = syncPrices;
    $('#btnTheme').onclick = () => {
      const t = effectiveDark() ? 'light' : 'dark';
      save('tp-theme', t); applyTheme(t); if (state.data) render(state.data);
    };
    if (bridge) {
      for (const b of document.querySelectorAll('[data-win]')) b.onclick = () => bridge.win(b.dataset.win);
      $('#btnPin').onclick = async () => { $('#btnPin').classList.toggle('on', await bridge.togglePin()); };
      $('#btnMini').onclick = () => { document.body.classList.add('mini'); bridge.mini(true); if (state.range !== 'today') { state.range = 'today'; bind(); refresh(); } };
      $('#btnUnmini').onclick = () => { document.body.classList.remove('mini'); bridge.mini(false); setTimeout(() => state.data && render(state.data), 120); };
    }
    let rt;
    addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => state.data && render(state.data), 120); });
  }

  applyTheme(load('tp-theme', 'auto'));
  bind();
  setLive('loading');
  connect();
  refresh();
  setInterval(refresh, 15000); // 让“近 10 分钟”等滑动窗口自然衰减
})();
