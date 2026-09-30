// 应用数据目录：~/.token-radar（首次运行时自动迁移旧版 ~/.token-pulse 的缓存和设置）
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = path.join(os.homedir(), '.token-radar');
const LEGACY_DIR = path.join(os.homedir(), '.token-pulse');

try {
  if (!fs.existsSync(DATA_DIR) && fs.existsSync(LEGACY_DIR)) fs.renameSync(LEGACY_DIR, DATA_DIR);
} catch { /* 迁移失败就从头扫描，不影响使用 */ }

module.exports = { DATA_DIR, dataFile: (name) => path.join(DATA_DIR, name) };
