// 提醒：额度快用完 / 预计耗尽、按量花费超预算、单个会话花费异常。
// 每条提醒按 key 去重（同一额度窗口、同一天只提醒一次），状态持久化，重启后不会重复弹出。
const fs = require('fs');
const { EventEmitter } = require('events');
const { dataFile } = require('./paths');
const { costOf } = require('./pricing');

const CONFIG_FILE = dataFile('alerts.json');
const STATE_FILE = dataFile('alerts.state.json');

const DEFAULTS = {
  enabled: true,
  quota: 80,          // 额度使用率达到该百分比时提醒（95% 时会再提醒一次）
  predict: true,      // 按当前速度预计 1 小时内耗尽时提醒
  dailyBudget: null,  // 今日按量计费花费上限（美元），null 为关闭
  hourlyCost: null,   // 近 1 小时按量花费上限
  sessionCost: null,  // 单个会话今日按量花费上限
};

const MIN = 60e3, HOUR = 60 * MIN;
const WINDOW_NAME = (w) => (w === 300 ? '5 小时额度' : w === 10080 ? '每周额度' : `${Math.round(w / 60)} 小时额度`);

function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } }
function writeJson(p, v) { try { fs.mkdirSync(require('path').dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2)); } catch { /* ignore */ } }
function dur(ms) {
  const m = Math.max(0, Math.round(ms / MIN));
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} 小时 ${m % 60} 分` : `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
}
const usd = (n) => '$' + (n >= 100 ? n.toFixed(0) : n.toFixed(2));

// 用当前窗口最近 30 分钟的快照估算使用率增速，预测多久后到 100%
function predict(hist, key, now) {
  const resetKey = key === 'p' ? 'pr' : 'sr';
  const last = hist[hist.length - 1];
  if (!last || last[key] == null) return null;
  const pts = [];
  for (let i = hist.length - 1; i >= 0; i--) {
    const x = hist[i];
    if (x[resetKey] !== last[resetKey] || now - x.t > 30 * MIN) break;
    pts.push(x);
  }
  if (pts.length < 2) return null;
  const first = pts[pts.length - 1];
  const dp = last[key] - first[key], dt = last.t - first.t;
  if (dp <= 0 || dt < 3 * MIN) return null;
  const eta = ((100 - last[key]) / dp) * dt; // 毫秒
  return { eta, at: last.t + eta };
}

class Alerts extends EventEmitter {
  constructor(collector, getPlans) {
    super();
    this.collector = collector;
    this.getPlans = getPlans;
    this.config = { ...DEFAULTS, ...readJson(CONFIG_FILE, {}) };
    this.fired = readJson(STATE_FILE, {});
    this.history = [];
  }

  setConfig(c) {
    const next = { ...this.config };
    if (typeof c.enabled === 'boolean') next.enabled = c.enabled;
    if (typeof c.predict === 'boolean') next.predict = c.predict;
    for (const k of ['quota', 'dailyBudget', 'hourlyCost', 'sessionCost']) {
      if (!(k in c)) continue;
      const v = c[k];
      next[k] = v === null || v === '' ? (k === 'quota' ? DEFAULTS.quota : null) : Math.max(0, Number(v)) || null;
    }
    this.config = next;
    writeJson(CONFIG_FILE, next);
    this.check();
    return next;
  }

  start() {
    this.collector.on('records', () => { clearTimeout(this._t); this._t = setTimeout(() => this.check(), 2000); });
    this._iv = setInterval(() => this.check(), MIN);
    this.check();
  }

  fire(key, level, title, body, src) {
    if (this.fired[key]) return;
    this.fired[key] = Date.now();
    // 清理 10 天前的去重记录
    for (const [k, t] of Object.entries(this.fired)) if (Date.now() - t > 10 * 86400e3) delete this.fired[k];
    writeJson(STATE_FILE, this.fired);
    const a = { key, level, title, body, src, t: Date.now() };
    this.history.unshift(a);
    this.history.length = Math.min(this.history.length, 50);
    this.emit('alert', a);
  }

  // 供面板显示：额度预测
  quotaForecast(now = Date.now()) {
    const lim = this.collector.limits.codex;
    if (!lim) return null;
    const hist = this.collector.getLimitHist('codex');
    const out = {};
    for (const [name, key] of [['primary', 'p'], ['secondary', 's']]) {
      const w = lim[name];
      if (!w || w.resets_at * 1000 <= now) continue;
      const pr = predict(hist, key, now);
      if (pr && pr.at < w.resets_at * 1000) out[name] = { exhaustAt: pr.at };
    }
    return out;
  }

  check(now = Date.now()) {
    if (!this.config.enabled || !this.collector.ready) return;
    const cfg = this.config;

    // 1. Codex 额度
    const lim = this.collector.limits.codex;
    if (lim && now - lim.t < 6 * HOUR) {
      const fc = cfg.predict ? this.quotaForecast(now) || {} : {};
      for (const name of ['primary', 'secondary']) {
        const w = lim[name];
        if (!w || w.resets_at * 1000 <= now) continue;
        const label = 'Codex ' + WINDOW_NAME(w.window_minutes);
        const win = Math.round(w.resets_at / 1800); // resets_at 会有几秒抖动，按半小时归并
        const reset = dur(w.resets_at * 1000 - now);
        for (const th of [cfg.quota, 95].filter((x, i, a) => x && a.indexOf(x) === i)) {
          if (w.used_percent >= th) {
            this.fire(`quota:${name}:${win}:${th}`, th >= 95 ? 'warn' : 'info',
              `${label}已用 ${Math.round(w.used_percent)}%`, `${reset}后重置`, 'codex');
          }
        }
        const f = fc[name];
        if (f && f.exhaustAt - now < HOUR && w.used_percent >= 40) {
          this.fire(`predict:${name}:${win}`, 'warn',
            `${label}预计 ${dur(f.exhaustAt - now)}后用完`, `按最近 30 分钟的速度推算，而额度要 ${reset}后才重置`, 'codex');
        }
      }
    }

    // 2~4. 按量计费（非订阅）的花费
    if (cfg.dailyBudget || cfg.hourlyCost || cfg.sessionCost) {
      const plans = this.getPlans();
      const paid = (src) => !(plans[src] && plans[src].subscription);
      const sod = new Date(now); sod.setHours(0, 0, 0, 0);
      const day = sod.toISOString().slice(0, 10);
      let today = 0, hour = 0;
      const sessions = new Map();
      const rs = this.collector.records;
      for (let i = rs.length - 1; i >= 0 && rs[i].t >= sod.getTime(); i--) {
        const r = rs[i];
        if (!paid(r.src)) continue;
        const c = costOf(r);
        if (!c) continue;
        today += c.cost;
        if (r.t >= now - HOUR) hour += c.cost;
        const k = r.src + ':' + r.session;
        const s = sessions.get(k) || { cost: 0, src: r.src, project: r.project };
        s.cost += c.cost; sessions.set(k, s);
      }
      if (cfg.dailyBudget) {
        if (today >= cfg.dailyBudget * 0.8 && today < cfg.dailyBudget) {
          this.fire(`budget80:${day}`, 'info', `今日按量花费已达预算的 80%`, `已花 ${usd(today)}，预算 ${usd(cfg.dailyBudget)}`);
        }
        if (today >= cfg.dailyBudget) {
          this.fire(`budget:${day}`, 'warn', `今日按量花费超出预算`, `已花 ${usd(today)}，预算 ${usd(cfg.dailyBudget)}`);
        }
      }
      if (cfg.hourlyCost && hour >= cfg.hourlyCost) {
        this.fire(`hour:${Math.floor(now / HOUR)}`, 'warn', `近 1 小时按量花费 ${usd(hour)}`, `超过你设置的 ${usd(cfg.hourlyCost)} / 小时`);
      }
      if (cfg.sessionCost) {
        for (const [k, s] of sessions) {
          if (s.cost < cfg.sessionCost) continue;
          const name = (s.project || '').split(/[\\/]/).filter(Boolean).pop() || '未知项目';
          this.fire(`session:${day}:${k}`, 'warn', `单个会话花费 ${usd(s.cost)}`, `${name} 的一个会话今天已超过 ${usd(cfg.sessionCost)}`, s.src);
        }
      }
    }
  }

  test() {
    const a = { key: 'test:' + Date.now(), level: 'info', title: 'Token Radar 提醒测试', body: '看到这条说明系统通知工作正常', t: Date.now() };
    this.emit('alert', a);
    return a;
  }
}

module.exports = { Alerts, DEFAULTS };
