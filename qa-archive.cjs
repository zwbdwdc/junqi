const { forceHumanFirstTurn } = require('./qa-randomness.cjs');
/* Real Electron/preload/renderer/disk integration, always using a fresh isolated
 * userData directory. Two child processes prove persistence across app exit. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const packageAudit = require('./qa-package-binding.cjs').beginPackageBinding();
const Module = require('node:module');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { app, BrowserWindow } = require('electron');
const appRoot = process.env.JUNQI_QA_ASAR || __dirname;
const phase = process.env.JUNQI_QA_ARCHIVE_PHASE;
const directory = process.env.JUNQI_QA_ARCHIVE_DIRECTORY || path.join(__dirname, 'research', 'qa-archive-data-' + randomUUID());
const expectedPath = path.join(directory, 'qa-expected.json');
const reportPath = path.join(__dirname, 'research', 'archive-qa-result.json');
const checks = [];

function check(name, callback) { callback(); checks.push({ name, ok: true }); }
async function delay(milliseconds) { await new Promise(resolve => setTimeout(resolve, milliseconds)); }

exports.run = async ({ win, archiveStore, setTrusted }) => {
  let current = win;
  const run = code => current.webContents.executeJavaScript(code);
  const wait = async predicate => {
    for (let index = 0; index < 150; index++) {
      if (await run(predicate)) return;
      await delay(100);
    }
    throw new Error('Timeout: ' + predicate);
  };
  try {
    await current.loadURL('junqi://game/index.html');
    await wait("document.querySelectorAll('.cell').length===62&&!document.body.inert");
    check('test process uses isolated userData', () => assert.equal(app.getPath('userData'), directory));
    const bridge = await run("({api:Object.keys(window.junqiArchive).sort(),nodeType:typeof require})");
    check('sandboxed preload exposes only the archive API', () => {
      assert.deepEqual(bridge.api, ['list', 'load', 'save']);
      assert.equal(bridge.nodeType, 'undefined');
    });

    if (phase === 'write') {
      const fixture = await run(`(async()=>{
        const e=await import('./engine.js');
        let game=e.createGame(e.randomLayout('human'),e.randomLayout('ai'),{engineerMountains:true});
        game.gameId=crypto.randomUUID();
        const active=await window.junqiArchive.save({game,difficulty:'hell'});
        for(let n=0;n<6&&!game.result;n++){
          const from=game.board.findIndex((p,i)=>p?.side===game.turn&&e.legalMoves(game.board,i).length);
          game=e.applyMove(game,from,e.legalMoves(game.board,from)[0]);
        }
        game.result||={winner:'ai',reason:'resign'};
        const saved=await window.junqiArchive.save({game,difficulty:'hell',finishedAt:'2000-01-01T00:00:00.000Z'});
        return {game,active,saved};
      })()`);
      check('real IPC refuses an active game and stores a valid completed record', () => {
        assert.equal(fixture.active.ok, false);
        assert.match(fixture.active.error, /结束/);
        assert.equal(fixture.saved.ok, true, fixture.saved.error);
      });
      await forceHumanFirstTurn(win);
      await run("document.querySelector('#start-btn').click();");
      await wait("document.querySelector('#status-title').textContent==='轮到你行棋'");
      const liveHistoryDisabled = await run("document.querySelector('#history-btn').disabled");
      check('history is unavailable during a live game', () => assert.equal(liveHistoryDisabled, true));
      await run("document.querySelector('#resign-btn').click();document.querySelector('#confirm-ok').click();");
      await wait("document.querySelector('#phase-label').textContent==='战局结束'");
      await wait("window.junqiArchive.list().then(result=>result.ok&&result.games.length===2)");
      const snapshot = await run(`(async()=>({
        session:JSON.parse(localStorage.getItem('junqi-session-v2')),
        listed:await window.junqiArchive.list()
      }))()`);
      check('ending a game through the UI automatically archives it', () => {
        assert.equal(snapshot.session.game.result.reason, 'resign');
        assert.equal(snapshot.listed.games.length, 2);
        assert.equal(snapshot.listed.games.at(-1).id, fixture.saved.id);
      });
      const duplicate = await run("window.junqiArchive.save({game:JSON.parse(localStorage.getItem('junqi-session-v2')).game,difficulty:'hell'})");
      check('repeated endgame saves are idempotent through preload', () => {
        assert.equal(duplicate.ok, true);
        assert.equal(duplicate.duplicate, true);
      });
      const store = await archiveStore();
      await store.waitForIdle();
      const entries = await fs.readdir(path.join(directory, 'games'));
      check('two completed JSON files were committed without temporary leftovers', () => {
        assert.equal(entries.length, 2);
        assert.ok(entries.every(name => /^[a-f0-9]{64}\.json$/.test(name)));
      });
      await fs.writeFile(expectedPath, JSON.stringify({oldGame:fixture.game,oldId:fixture.saved.id,
        currentId:duplicate.id,currentGame:snapshot.session.game}, null, 2));
    } else if (phase === 'read') {
      const expected = JSON.parse(await fs.readFile(expectedPath, 'utf8'));
      await wait("document.querySelector('#phase-label').textContent==='战局结束'");
      const restored = await run("window.junqiArchive.list()");
      check('a new Electron process restores both finished games from disk', () => {
        assert.equal(restored.ok, true);
        assert.equal(restored.games.length, 2);
        assert.deepEqual(new Set(restored.games.map(item => item.id)), new Set([expected.oldId,expected.currentId]));
        assert.doesNotMatch(JSON.stringify(restored), /initial|board|attackerId/);
      });
      const before = await run("({session:localStorage.getItem('junqi-session-v2'),experience:localStorage.getItem('junqi-learning-v1')})");
      await run("document.querySelector('#history-btn').click();");
      await wait("document.querySelector('#history-dialog').open && document.querySelectorAll('#history-list .history-entry').length===2");
      await run("[...document.querySelectorAll('#history-list .history-entry')].at(-1).click();");
      await wait("document.querySelector('#phase-label').textContent==='明棋复盘'");
      check('history opens an older game rather than the current endgame', () => {
        assert.ok(expected.oldGame.ply > expected.currentGame.ply);
      });
      assert.equal(Number(await run("document.querySelector('#replay-range').max")), expected.oldGame.ply);
      const shownInitial = await run("[...document.querySelectorAll('.cell')].map(cell=>cell.querySelector('.piece')?.textContent.trim()||null)");
      const typeNames = await run("import('./engine.js').then(e=>Object.fromEntries(Object.entries(e.TYPES).map(([key,value])=>[key,value.name])))");
      check('historical initial formation is revealed accurately on every cell', () => {
        assert.deepEqual(shownInitial, expected.oldGame.initial.map(piece => piece ? typeNames[piece.type] : null));
      });
      await run("document.querySelector('#replay-last').click();");
      const shownFinal = await run("[...document.querySelectorAll('.cell')].map(cell=>cell.querySelector('.piece')?.textContent.trim()||null)");
      check('historical final board agrees with the stored referee record', () => {
        assert.deepEqual(shownFinal, expected.oldGame.board.map(piece => piece ? typeNames[piece.type] : null));
      });
      await run("document.querySelector('#replay-exit').click();");
      await wait("document.querySelector('#phase-label').textContent==='战局结束'");
      const after = await run("({session:localStorage.getItem('junqi-session-v2'),experience:localStorage.getItem('junqi-learning-v1')})");
      check('leaving historical review preserves the current game and experience', () => {
        assert.deepEqual(JSON.parse(after.session), JSON.parse(before.session));
        assert.deepEqual(JSON.parse(after.experience), JSON.parse(before.experience));
      });
      await run("document.querySelector('#again-btn').click();");
      await wait("!document.querySelector('#setup-panel').classList.contains('hidden')");
      const setup = await run("[...document.querySelectorAll('.cell')].map(cell=>cell.querySelector('.piece')?.textContent.trim()||null)");
      await run("document.querySelector('#history-btn').click();");
      await wait("document.querySelector('#history-dialog').open && document.querySelectorAll('#history-list .history-entry').length===2");
      await run("[...document.querySelectorAll('#history-list .history-entry')].at(-1).click();");
      await wait("document.querySelector('#phase-label').textContent==='明棋复盘'");
      await run("document.querySelector('#replay-exit').click();");
      await wait("!document.querySelector('#setup-panel').classList.contains('hidden')");
      const setupAfter = await run("[...document.querySelectorAll('.cell')].map(cell=>cell.querySelector('.piece')?.textContent.trim()||null)");
      check('leaving historical review also returns safely to deployment', () => assert.deepEqual(setupAfter, setup));
      await forceHumanFirstTurn(win);
      await run("document.querySelector('#start-btn').click();");
      await wait("document.querySelector('#status-title').textContent==='轮到你行棋'");
      const activeGate = await run("(()=>{const button=document.querySelector('#history-btn');button.click();return {disabled:button.disabled,open:document.querySelector('#history-dialog').open,replaying:!document.querySelector('#replay-panel').classList.contains('hidden')}})()");
      check('starting a new live game disables the historical replay entry', () => {
        assert.deepEqual(activeGate, {disabled:true,open:false,replaying:false});
      });

      const foreign = new BrowserWindow({show:false,webPreferences:{preload:path.join(appRoot,'preload.cjs'),
        nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
      await foreign.loadURL('junqi://game/index.html');
      const denied = await foreign.webContents.executeJavaScript(`Promise.all([
        window.junqiArchive.list(),window.junqiArchive.load(${JSON.stringify(expected.oldId)}),
        window.junqiArchive.save({game:JSON.parse(localStorage.getItem('junqi-session-v2')).game,difficulty:'hell'})
      ])`);
      check('another sender cannot read or write archives at the same app URL', () => {
        for (const response of denied) { assert.equal(response.ok,false);assert.match(response.error,/来源/); }
      });
      foreign.destroy();
      await current.loadURL('about:blank');
      const wrongOrigin = await run("window.junqiArchive.list()");
      check('a trusted sender at a foreign origin cannot read archives', () => {
        assert.equal(wrongOrigin.ok,false);assert.match(wrongOrigin.error,/来源/);
      });
    } else throw new Error('Unknown archive test phase');
    await fs.writeFile(path.join(directory, `qa-${phase}.json`), JSON.stringify({ok:true,phase,checks,packageBinding:packageAudit.finish()},null,2));
    current.destroy();
    app.quit();
  } catch (error) {
    await fs.mkdir(directory,{recursive:true});
    await fs.writeFile(path.join(directory, `qa-${phase}.json`),JSON.stringify({ok:false,phase,checks,error:error.stack},null,2));
    console.error(error.stack);
    app.exit(1);
  }
};

if (!phase) {
  // This coordinating Electron process never creates a browser window or opens
  // the real game profile. Its two child runs are separate application starts.
  app.setPath('userData',path.join(directory,'driver'));
  app.whenReady().then(async()=>{
    const results=[];
    try {
      await fs.mkdir(directory,{recursive:true});
      for (const stage of ['write','read']) {
        await new Promise((resolve,reject)=>{
          const child=spawn(process.execPath,[__filename],{windowsHide:true,stdio:['ignore','pipe','pipe'],
            env:{...packageAudit.childEnv,JUNQI_QA_ARCHIVE_PHASE:stage,JUNQI_QA_ARCHIVE_DIRECTORY:directory}});
          let output='';
          child.stdout.on('data',chunk=>{output+=chunk;});
          child.stderr.on('data',chunk=>{output+=chunk;});
          child.once('error',reject);
          child.once('exit',code=>code===0?resolve():reject(new Error(`Archive ${stage} process exited ${code}: ${output}`)));
        });
        results.push(JSON.parse(await fs.readFile(path.join(directory,`qa-${stage}.json`),'utf8')));
      }
      const packageBinding=packageAudit.finish();
      for(const result of results){assert.equal(result.ok,true);assert.deepEqual(result.packageBinding,packageBinding,'all child phases must use the same unchanged package');}
      const report={ok:true,packageBinding,checks:results.reduce((sum,result)=>sum+result.checks.length,0),directory,results};
      await fs.writeFile(reportPath,JSON.stringify(report,null,2));
      console.log(JSON.stringify({ok:true,checks:report.checks,reportPath,directory,packageBinding}));
      app.exit(0);
    } catch(error) {
      await fs.writeFile(reportPath,JSON.stringify({ok:false,directory,results,error:error.stack},null,2));
      console.error(error.stack);
      app.exit(1);
    }
  });
} else {
  // Exercise the real main-process implementation; only the profile directory,
  // window visibility and test entry point are redirected.
  const original=require('node:fs').readFileSync(path.join(appRoot,'main.cjs'),'utf8');
  const source=original
    .replace("app.setPath('userData', path.join(app.getPath('appData'), '军棋·暗战'));",`app.setPath('userData', ${JSON.stringify(directory)});`)
    .replace("win.once('ready-to-show', () => { win.show(); win.focus(); });",'')
    .replace("win.webContents.on('did-finish-load', () => { win.show(); });",'')
    .replace("win.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('junqi://game/')) event.preventDefault(); });",'')
    .replace("win.loadURL('junqi://game/index.html');",`require(${JSON.stringify(__filename)}).run({win,archiveStore,setTrusted:id=>{trustedContentsId=id;}});`)
    .replace("app.on('window-all-closed', () => app.quit());","app.on('window-all-closed', () => {});");
  assert.notEqual(source,original);
  assert.ok(source.includes(`app.setPath('userData', ${JSON.stringify(directory)});`),'isolated userData override must match');
  const compiled=new Module(path.join(appRoot,'main.cjs'),module);
  compiled.filename=path.join(appRoot,'main.cjs');compiled.paths=Module._nodeModulePaths(appRoot);
  compiled._compile(source,compiled.filename);
}
