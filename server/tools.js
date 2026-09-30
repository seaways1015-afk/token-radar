// 本机 AI 编程工具扫描：检测装了哪些工具、有没有会话数据、能否读取 token 用量。
// 只检查目录 / 文件是否存在和命令是否在 PATH 上，不读取任何凭证文件。
const fs = require('fs');
const path = require('path');
const os = require('os');

const home = os.homedir();
const H = (...p) => path.join(home, ...p);
const APPDATA = process.env.APPDATA || H('AppData', 'Roaming');
const XDG_DATA = process.env.XDG_DATA_HOME || H('.local', 'share');
const XDG_CONFIG = process.env.XDG_CONFIG_HOME || H('.config');

// usage: 'supported' 已接入用量解析；'none' 本地没有 token 用量记录（通常在服务端计费）
// id 与 collector.SOURCES 对应的工具才会被实际监控
const REGISTRY = [
  { id: 'claude', name: 'Claude Code', vendor: 'Anthropic', usage: 'supported', bins: ['claude'],
    dirs: [process.env.CLAUDE_CONFIG_DIR || H('.claude')], data: [process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, 'projects') : H('.claude', 'projects')] },
  { id: 'codex', name: 'Codex', vendor: 'OpenAI', usage: 'supported', bins: ['codex'],
    dirs: [process.env.CODEX_HOME || H('.codex')], data: [path.join(process.env.CODEX_HOME || H('.codex'), 'sessions')] },
  { id: 'pi', name: 'Pi', vendor: '多供应商', usage: 'supported', bins: ['pi'],
    dirs: [process.env.PI_CODING_AGENT_DIR || H('.pi', 'agent')], data: [path.join(process.env.PI_CODING_AGENT_DIR || H('.pi', 'agent'), 'sessions')] },
  { id: 'opencode', name: 'OpenCode', vendor: '多供应商', usage: 'supported', bins: ['opencode'],
    dirs: [path.join(XDG_DATA, 'opencode'), path.join(XDG_CONFIG, 'opencode')], data: [path.join(XDG_DATA, 'opencode', 'opencode.db')] },
  { id: 'dsh', name: 'DeepSeek Harness', vendor: 'DeepSeek', usage: 'supported', bins: ['dsh'],
    dirs: [H('.dsh')], data: [H('.dsh', 'sessions')], note: '实验性：按会话日志中的 usage 字段解析' },
  { id: 'kimi', name: 'Kimi Code', vendor: 'Moonshot', usage: 'none', bins: ['kimi'],
    dirs: [H('.kimi-code'), H('.kimi')], note: '暂未接入（未发现会话日志）' },
  { id: 'gemini', name: 'Gemini CLI', vendor: 'Google', usage: 'none', bins: ['gemini'],
    dirs: [H('.gemini', 'tmp')], note: '暂未接入' },
  { id: 'antigravity', name: 'Antigravity', vendor: 'Google', usage: 'none', bins: ['antigravity'],
    dirs: [H('.gemini', 'antigravity')], note: '本地未找到可读的 token 用量记录' },
  { id: 'qwen', name: 'Qwen Code', vendor: '阿里', usage: 'none', bins: ['qwen'], dirs: [H('.qwen')], note: '暂未接入' },
  { id: 'copilot', name: 'GitHub Copilot', vendor: 'GitHub', usage: 'none', bins: ['copilot'],
    dirs: [H('.copilot'), path.join(APPDATA, 'Code', 'User', 'globalStorage', 'github.copilot-chat')], note: '用量在 GitHub 服务端计费，本地无记录' },
  { id: 'cursor', name: 'Cursor', vendor: 'Anysphere', usage: 'none', bins: ['cursor', 'cursor-agent'],
    dirs: [H('.cursor'), path.join(APPDATA, 'Cursor')], note: '用量在 Cursor 服务端计费，本地无记录' },
  { id: 'qoder', name: 'Qoder', vendor: '阿里', usage: 'none', bins: ['qoder'], dirs: [H('.qoder-cn'), H('.qoder')], note: '本地未找到 token 用量记录（可能在服务端计费）' },
  { id: 'trae', name: 'Trae / MarsCode', vendor: '字节', usage: 'none', bins: ['trae'], dirs: [H('.marscode'), H('.trae'), H('.trae-cn')], note: '本地未找到 token 用量记录（可能在服务端计费）' },
  { id: 'windsurf', name: 'Windsurf', vendor: 'Codeium', usage: 'none', bins: ['windsurf'], dirs: [H('.codeium', 'windsurf')], note: '本地未找到 token 用量记录（可能在服务端计费）' },
  { id: 'cline', name: 'Cline / Roo Code', vendor: '多供应商', usage: 'none', bins: [],
    dirs: ['saoudrizwan.claude-dev', 'rooveterinaryinc.roo-cline', 'kilocode.kilo-code'].flatMap((x) => ['Code', 'Cursor'].map((ed) => path.join(APPDATA, ed, 'User', 'globalStorage', x))), note: '暂未接入' },
  { id: 'crush', name: 'Crush', vendor: 'Charm', usage: 'none', bins: ['crush'], dirs: [path.join(XDG_DATA, 'crush'), H('.crush')], note: '暂未接入' },
  { id: 'iflow', name: 'iFlow CLI', vendor: '阿里', usage: 'none', bins: ['iflow'], dirs: [H('.iflow')], note: '暂未接入' },
  { id: 'droid', name: 'Factory Droid', vendor: 'Factory', usage: 'none', bins: ['droid'], dirs: [H('.factory')], note: '暂未接入' },
  { id: 'codebuddy', name: 'CodeBuddy', vendor: '腾讯', usage: 'none', bins: ['codebuddy'], dirs: [H('.codebuddy')], note: '暂未接入' },
  { id: 'aider', name: 'Aider', vendor: '多供应商', usage: 'none', bins: ['aider'], dirs: [H('.aider')], note: '暂未接入' },
];

const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };

function onPath(bin) {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').concat(['']) : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, bin + ext.toLowerCase());
      if (exists(p)) return p;
    }
  }
  return null;
}

function hasData(p) {
  try {
    const st = fs.statSync(p);
    if (st.isFile()) return st.size > 0;
    return fs.readdirSync(p).length > 0;
  } catch { return false; }
}

// counts: { [sourceId]: 已统计到的请求数 }
function scan(counts = {}) {
  return REGISTRY.map((t) => {
    const dir = t.dirs.find(exists) || null;
    const bin = t.bins.map(onPath).find(Boolean) || null;
    const data = (t.data || []).find(hasData) || null;
    const installed = !!(dir || bin);
    const requests = counts[t.id] || 0;
    let status;
    if (!installed && !requests) status = 'absent';
    else if (t.usage !== 'supported') status = 'unsupported';
    else if (requests) status = 'monitoring';
    else status = 'ready'; // 已接入，但还没有产生带用量的请求
    return { id: t.id, name: t.name, vendor: t.vendor, status, installed, dir, bin, data: !!data, requests, note: t.note || '' };
  });
}

module.exports = { scan, REGISTRY };
