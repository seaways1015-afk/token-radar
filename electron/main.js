// Electron 外壳：在主进程里启动本地服务，用无边框窗口加载面板
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, nativeTheme, shell } = require('electron');
const path = require('path');
const { startServer } = require('../server/index');

let win, tray, serverUrl;
let normalBounds = null;

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });

function iconImage() {
  return nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png'));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 420,
    minHeight: 110,
    frame: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1d1a18' : '#f3eee6',
    title: 'Token Radar',
    icon: iconImage(),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadURL(serverUrl);
  win.once('ready-to-show', () => win.show());
  // 外部链接用系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  // 关闭按钮 = 隐藏到托盘，继续后台监听
  win.on('close', (e) => { if (!app.isQuitting) { e.preventDefault(); win.hide(); } });
}

function createTray() {
  tray = new Tray(iconImage().resize({ width: 16, height: 16 }));
  tray.setToolTip('Token Radar');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示面板', click: () => { win.show(); win.focus(); } },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', () => { win.isVisible() ? win.hide() : (win.show(), win.focus()); });
}

ipcMain.on('win', (_, action) => {
  if (!win) return;
  if (action === 'min') win.minimize();
  else if (action === 'max') win.isMaximized() ? win.unmaximize() : win.maximize();
  else if (action === 'close') win.close();
});
ipcMain.handle('toggle-pin', () => { const v = !win.isAlwaysOnTop(); win.setAlwaysOnTop(v, 'floating'); return v; });
ipcMain.on('mini', (_, on) => {
  if (on) {
    normalBounds = win.getBounds();
    if (win.isMaximized()) win.unmaximize();
    win.setAlwaysOnTop(true, 'floating');
    win.setBounds({ x: normalBounds.x + normalBounds.width - 480, y: normalBounds.y + 20, width: 460, height: 84 });
  } else {
    win.setAlwaysOnTop(false);
    if (normalBounds) win.setBounds(normalBounds);
  }
});
ipcMain.on('theme', (_, t) => { nativeTheme.themeSource = t === 'auto' ? 'system' : t; });

app.whenReady().then(async () => {
  const { port } = await startServer();
  serverUrl = `http://127.0.0.1:${port}`;
  createWindow();
  createTray();
});

app.on('before-quit', () => { app.isQuitting = true; });
app.on('window-all-closed', () => { /* 常驻托盘 */ });
