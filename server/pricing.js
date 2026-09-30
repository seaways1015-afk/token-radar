// 模型定价：内置表 + 用户覆盖（~/.token-radar/pricing.user.json，可在设置里编辑）
const fs = require('fs');
const path = require('path');
const os = require('os');

const { dataFile } = require('./paths');

const USER_FILE = dataFile('pricing.user.json');
const BUILTIN = require('./pricing.json');

let table = [];
let userModels = [];
const memo = new Map();

function load() {
  try { userModels = JSON.parse(fs.readFileSync(USER_FILE, 'utf8')).models || []; } catch { userModels = []; }
  // 用户条目优先；同优先级内最长前缀优先
  table = [...userModels.map((m) => ({ ...m, user: true })), ...BUILTIN.models]
    .sort((a, b) => (b.user ? 1 : 0) - (a.user ? 1 : 0) || b.match.length - a.match.length);
  memo.clear();
}

function normalize(model) {
  return String(model || '').toLowerCase()
    .replace(/^(anthropic\.|us\.anthropic\.|eu\.anthropic\.|openai\/|anthropic\/)/, '')
    .replace(/[@-]\d{8}$/, '')
    .replace(/-v\d+(:\d+)?$/, '')
    .replace(/\[.*\]$/, '');
}

function priceFor(model) {
  if (memo.has(model)) return memo.get(model);
  const n = normalize(model);
  const hit = table.find((p) => n === p.match || n.startsWith(p.match));
  const res = hit ? {
    input: hit.input,
    output: hit.output,
    cacheRead: hit.cacheRead ?? hit.input * 0.1,
    cacheWrite5m: hit.cacheWrite5m ?? hit.input * 1.25,
    cacheWrite1h: hit.cacheWrite1h ?? hit.input * 2,
  } : null;
  memo.set(model, res);
  return res;
}

// 返回 { cost, saved }；未知模型返回 null
function costOf(r) {
  const p = priceFor(r.model);
  if (!p) return null;
  const mult = r.fast ? BUILTIN.fastModeMultiplier : 1;
  const cost = (r.in * p.input + r.out * p.output + r.cr * p.cacheRead + r.cw5 * p.cacheWrite5m + r.cw1h * p.cacheWrite1h) / 1e6 * mult;
  const saved = r.cr * (p.input - p.cacheRead) / 1e6 * mult;
  return { cost, saved };
}

function getUser() { return userModels; }

function setUser(models) {
  const clean = (models || [])
    .filter((m) => m && typeof m.match === 'string' && m.match.trim() && isFinite(m.input) && isFinite(m.output))
    .map((m) => {
      const o = { match: normalize(m.match.trim()), input: +m.input, output: +m.output };
      for (const k of ['cacheRead', 'cacheWrite5m', 'cacheWrite1h']) if (m[k] !== '' && m[k] != null && isFinite(m[k])) o[k] = +m[k];
      return o;
    });
  fs.mkdirSync(path.dirname(USER_FILE), { recursive: true });
  fs.writeFileSync(USER_FILE, JSON.stringify({ models: clean }, null, 2));
  load();
}

load();
module.exports = { priceFor, costOf, getUser, setUser, normalize };
