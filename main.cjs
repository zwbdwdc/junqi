const { app, BrowserWindow, protocol, Menu, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { createExperienceStore } = require('./storage.cjs');
const { createArchiveStore } = require('./archive-store.cjs');
const { createDiagnosticsStore } = require('./diagnostics-store.cjs');
const { randomUUID } = require('node:crypto');
const runtime = Object.freeze({ appVersion: require('./package.json').version,
  electronVersion: process.versions.electron, launchId: randomUUID() });
protocol.registerSchemesAsPrivileged([{ scheme: 'junqi', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
app.setName('军棋·暗战');
// Stable across portable executable locations and version upgrades.
app.setPath('userData', path.join(app.getPath('appData'), '军棋·暗战'));
app.userAgentFallback = 'JunqiDesktop/1.0';
let storePromise, archivePromise, recoveryPromise, trustedContentsId = null, quitAllowed = false, quitting = false;
let profileQueue = Promise.resolve();
const pendingSaves = new Set();
let diagnostics;
function recordDiagnostic(event, details = {}) {
  diagnostics ||= createDiagnosticsStore({ directory: app.getPath('userData') });
  const task = diagnostics.append({ ...runtime, event, ...details });
  pendingSaves.add(task);
  task.finally(() => pendingSaves.delete(task));
  return task;
}
function experienceStore() {
  storePromise ||= import(pathToFileURL(path.join(__dirname, 'dist', 'learning.js')).href)
    .then(({ sanitizeProfile, LEARNING_VERSION }) => createExperienceStore({
      directory: app.getPath('userData'), sanitizeProfile, version: LEARNING_VERSION,
    }));
  return storePromise;
}
function archiveStore() {
  archivePromise ||= Promise.all([
    import(pathToFileURL(path.join(__dirname, 'dist', 'replay.js')).href),
    import(pathToFileURL(path.join(__dirname, 'dist', 'engine.js')).href),
  ]).then(([{ buildReplay }, { createGame, applyMove }]) => createArchiveStore({
    directory: app.getPath('userData'), buildReplay, createGame, applyMove,
  }));
  return archivePromise;
}
function trusted(event) {
  return !quitting && event.sender.id === trustedContentsId && event.senderFrame?.url === 'junqi://game/index.html';
}
function errorResult(error) { return { ok: false, error: error?.message || String(error) }; }
ipcMain.handle('junqi-app:version', event => trusted(event) ? runtime.appVersion : null);
function profileTask(operation) {
  const task = profileQueue.then(operation).catch(errorResult);
  profileQueue = task.then(() => undefined);
  pendingSaves.add(task);
  task.finally(() => pendingSaves.delete(task));
  return task;
}
function recoveryModule() {
  recoveryPromise ||= import(pathToFileURL(path.join(__dirname, 'dist', 'learning-recovery.js')).href);
  return recoveryPromise;
}
async function completedRecords() {
  const archive = await archiveStore(), listing = await archive.list();
  if (!listing.ok) throw new Error(listing.error);
  const records = [], failed = [];
  for (const item of listing.games) {
    const loaded = await archive.load(item.id);
    if (loaded.ok) records.push(loaded.record);
    else failed.push({ id:item.id, error:loaded.error });
  }
  return { records, failed };
}
async function reviewArchivedGames() {
  let before = 0;
  try {
    const store = await experienceStore();
    before = (await store.load()).profile?.games || 0;
    const result = await consolidateArchivedGames();
    await recordDiagnostic('experience-review', { ok:result.ok, source:result.source,
      before, after:result.profile?.games || before, learned:result.learned || 0,
      failed:result.failed?.length || 0, error:result.error });
    return result;
  } catch (error) {
    await recordDiagnostic('experience-review', { ok:false, before, error:error.message });
    throw error;
  }
}
async function consolidateArchivedGames() {
  const store = await experienceStore(), saved = await store.load();
  // A corrupt pair of experience files must never silently become a blank profile.
  if (!saved.profile && saved.error) return { ...saved, ok:false };
  const { records, failed } = await completedRecords();
  const result = (await recoveryModule()).consolidateCompletedGames(saved.profile, records);
  result.failed.push(...failed);
  const changed = (saved.profile || records.length) && JSON.stringify(result.profile) !== JSON.stringify(saved.profile);
  if (changed) {
    const written = await store.save(result.profile);
    if (!written.ok) return { ...saved, ...written, learned:0, failed:result.failed };
  }
  return { ok:true, profile:changed ? result.profile : saved.profile, source:changed ? 'primary' : saved.source,
    learned:result.learned, failed:result.failed,
    ...(result.failed.length ? { error:'部分棋谱未能复核，已保存其余经验。' } : saved.error && !changed ? {error:saved.error} : {}) };
}
ipcMain.handle('junqi-archive:save', (event, record) => {
  if (!trusted(event)) return { ok: false, error: '请求来源无效' };
  // Archive first: even if experience writing is interrupted, the next load can
  // recover it. This main-process chain survives the renderer closing early.
  const stamped = { ...record, game: { ...record?.game, runtime: { ...runtime } } };
  const save = archiveStore().then(store => store.save(stamped)).then(async saved => {
    await recordDiagnostic('archive-save', { ok:saved.ok, error:saved.error });
    return saved.ok ? { ...saved, learning:await profileTask(reviewArchivedGames) } : saved;
  }).catch(async error => {
    await recordDiagnostic('archive-save', { ok:false, error:error.message });
    return errorResult(error);
  });
  pendingSaves.add(save);
  save.finally(() => pendingSaves.delete(save));
  return save;
});
ipcMain.handle('junqi-archive:list', async event => {
  if (!trusted(event)) return { ok: false, games: [], error: '请求来源无效' };
  try { return await (await archiveStore()).list(); }
  catch (error) { return { ...errorResult(error), games: [] }; }
});
ipcMain.handle('junqi-archive:load', async (event, id) => {
  if (!trusted(event)) return { ok: false, error: '请求来源无效' };
  try { return await (await archiveStore()).load(id); }
  catch (error) { return errorResult(error); }
});
ipcMain.handle('junqi-experience:load', event => {
  if (!trusted(event)) return { profile: null, source: 'none', error: '请求来源无效' };
  return profileTask(reviewArchivedGames);
});
ipcMain.handle('junqi-experience:review', event => {
  if (!trusted(event)) return { ok:false, profile:null, error:'请求来源无效' };
  return profileTask(reviewArchivedGames);
});
ipcMain.handle('junqi-experience:save', (event, profile) => {
  if (!trusted(event)) return { ok: false, error: '请求来源无效' };
  return profileTask(async () => {
    const result = await (await experienceStore()).save(profile);
    await recordDiagnostic('experience-save', { ok:result.ok, after:profile?.games, error:result.error });
    return result;
  });
});
ipcMain.handle('junqi-experience:restore', (event, profile) => {
  if (!trusted(event)) return { ok:false, profile:null, error:'请求来源无效' };
  return profileTask(async () => {
    try {
      const store = await experienceStore(), validated = store.validate(profile);
      const { records, failed } = await completedRecords();
      const restored = (await recoveryModule()).excludeCompletedGames(validated, records);
      const written = await store.save(restored.profile);
      await recordDiagnostic('experience-restore', { ok:written.ok, after:restored.profile.games,
        failed:failed.length + restored.failed.length, error:written.error });
      return written.ok ? { ok:true, profile:restored.profile, failed:[...failed,...restored.failed] } : written;
    } catch (error) {
      await recordDiagnostic('experience-restore', { ok:false, error:error.message });
      throw error;
    }
  });
});
ipcMain.handle('junqi-experience:export', async (event, profile) => {
  if (!trusted(event)) return { ok: false, error: '请求来源无效' };
  try {
    const selection = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
      title: '导出军棋经验备份', defaultPath: path.join(app.getPath('documents'), '军棋经验备份.json'),
      filters: [{ name: '军棋经验 JSON', extensions: ['json'] }],
    });
    if (selection.canceled || !selection.filePath) return { cancelled: true };
    return await (await experienceStore()).exportFile(selection.filePath, profile);
  } catch (error) { return errorResult(error); }
});
ipcMain.handle('junqi-experience:import', async event => {
  if (!trusted(event)) return { profile: null, error: '请求来源无效' };
  try {
    const selection = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: '恢复军棋经验备份', properties: ['openFile'], filters: [{ name: '军棋经验 JSON', extensions: ['json'] }],
    });
    if (selection.canceled || !selection.filePaths.length) return { cancelled: true, profile: null };
    return { profile: await (await experienceStore()).importFile(selection.filePaths[0]), cancelled: false };
  } catch (error) { return { profile: null, cancelled: false, error: error.message }; }
});
app.on('before-quit', event => {
  if (quitAllowed || !pendingSaves.size) return;
  event.preventDefault();
  quitting = true;
  Promise.allSettled([...pendingSaves]).finally(() => { quitAllowed = true; app.quit(); });
});
const gotLock = app.requestSingleInstanceLock({ appVersion:runtime.appVersion,
  portableExecutable:process.env.PORTABLE_EXECUTABLE_FILE || '' });
if (!gotLock) app.quit();
app.on('second-instance', (event, argv, cwd, additionalData) => {
  recordDiagnostic('second-instance', { requestedVersion:additionalData?.appVersion,
    portableExecutable:additionalData?.portableExecutable });
  const window = BrowserWindow.getAllWindows()[0]; if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
});
app.whenReady().then(() => {
  if (!gotLock) return;
  recordDiagnostic('startup', { executable:app.getPath('exe'),
    portableExecutable:process.env.PORTABLE_EXECUTABLE_FILE || '' });
  protocol.handle('junqi', async request => {
    const url = new URL(request.url);
    const file = path.resolve(__dirname, 'dist', '.' + decodeURIComponent(url.pathname));
    const root = path.resolve(__dirname, 'dist') + path.sep;
    if (url.hostname !== 'game' || !file.startsWith(root)) return new Response('Not found', { status: 404 });
    try {
      const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.png':'image/png' }[path.extname(file)] || 'application/octet-stream';
      return new Response(await fs.readFile(file), { headers: { 'Content-Type': mime } });
    } catch { return new Response('Not found', {status:404}); }
  });
  Menu.setApplicationMenu(null);
  const win = new BrowserWindow({ width: 1240, height: 930, minWidth: 920, minHeight: 730, show: false, title: '军棋·暗战', icon: path.join(__dirname, 'dist/icon.png'), backgroundColor: '#101c1a', autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, devTools: !app.isPackaged } });
  trustedContentsId = win.webContents.id;
  win.webContents.on('render-process-gone', (event, details) =>
    recordDiagnostic('renderer-failed', { ok:false, error:details.reason }));
  win.once('ready-to-show', () => { win.show(); win.focus(); });
  win.webContents.on('did-finish-load', () => { win.show(); });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('junqi://game/')) event.preventDefault(); });
  win.webContents.session.setPermissionRequestHandler((contents, permission, callback) => callback(false));
  win.loadURL('junqi://game/index.html');
});
app.on('window-all-closed', () => app.quit());
