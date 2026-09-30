// 生成打包用的 PNG 图标和 README 截图：npx electron scripts/render-assets.js
const { app, BrowserWindow, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');
const { startServer } = require('../server/index');

const root = path.join(__dirname, '..');
if (!process.argv.includes('--screenshot')) app.disableHardwareAcceleration();

async function capture(url, width, height, out, { wait = 0, clip, transparent = true } = {}) {
  const win = new BrowserWindow({ width, height, x: 0, y: 0, show: true, skipTaskbar: true, frame: false, transparent, useContentSize: true });
  await win.loadURL(url);
  await new Promise((r) => setTimeout(r, wait));
  const img = await win.webContents.capturePage(clip);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, img.toPNG());
  win.destroy();
  console.log('wrote', path.relative(root, out), img.getSize());
}

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'light';
  if (!process.argv.includes('--screenshot')) {
  const svg = fs.readFileSync(path.join(root, 'public', 'icon.svg'), 'utf8');
  const html = `<html><body style="margin:0;background:transparent">${svg.replace('<svg ', '<svg width="512" height="512" ')}</body></html>`;
  await capture('data:text/html;base64,' + Buffer.from(html).toString('base64'), 512, 512, path.join(root, 'build', 'icon.png'));
  }

  if (process.argv.includes('--screenshot')) {
    const { port } = await startServer({ port: 17399 });
    // 只截顶部（实时环 + 指标卡片），不包含项目名等列表
    await capture(`http://127.0.0.1:${port}/`, 1440, 900, path.join(root, 'docs', 'screenshot.png'), { wait: 4000, transparent: false, clip: { x: 0, y: 0, width: 1440, height: 560 } });
  }
  app.quit();
});
