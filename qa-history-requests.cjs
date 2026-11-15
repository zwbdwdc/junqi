// Real archive IPC with controlled response ordering in an isolated profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const {randomUUID, createHash} = require('node:crypto');
const {app} = require('electron');
const appRoot = process.env.JUNQI_QA_ASAR || __dirname;
const audit = require('./qa-package-binding.cjs').beginPackageBinding();
const version = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')).version;
const baseline = process.env.JUNQI_HISTORY_BASELINE === '1';
const output = process.env.JUNQI_HISTORY_QA_OUTPUT || path.join(__dirname, 'analysis/package-qa', version,
  process.env.JUNQI_QA_ASAR ? 'history-requests-packaged' : 'history-requests-source');
const directory = path.join(__dirname, 'research', 'qa-history-requests-' + randomUUID());
fs.mkdirSync(output, {recursive: true});
const held = {list: false, load: false};
const pending = {list: [], load: []};
exports.respond = (kind, result) => {
  if (!held[kind]) return result;
  return new Promise(resolve => pending[kind].push({result, resolve}));
};

exports.run = async ({win}) => {
  const run = code => win.webContents.executeJavaScript(code);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const checks = [], errors = [];
  const wait = async predicate => {
    for (let attempt = 0; attempt < 180; attempt++) {
      if (await predicate()) return;
      await delay(50);
    }
    throw Error('History request QA timed out');
  };
  const waitUi = code => wait(() => run(code));
  const click = async selector => {
    const point = await run(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    win.webContents.sendInputEvent({type:'mouseDown', ...point, button:'left', clickCount:1});
    win.webContents.sendInputEvent({type:'mouseUp', ...point, button:'left', clickCount:1});
    await delay(30);
  };
  const key = async keyCode => {
    win.webContents.sendInputEvent({type:'keyDown', keyCode});
    win.webContents.sendInputEvent({type:'keyUp', keyCode});
    await delay(30);
  };
  const release = async (kind, index = 0, replacement) => {
    const request = pending[kind].splice(index, 1)[0];
    assert.ok(request, 'Missing delayed response');
    request.resolve(replacement === undefined ? request.result : replacement);
    await delay(100);
  };
  const open = async () => {
    await click('#history-btn');
    await waitUi("document.querySelector('#history-dialog').open && document.querySelectorAll('.history-entry').length===2");
  };
  const replayOpen = () => run("!document.querySelector('#replay-panel').classList.contains('hidden')");
  const replayPly = () => run("Number(document.querySelector('#replay-range').max)");
  const session = () => run("localStorage.getItem('junqi-session-v2')");
  win.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
  try {
    await win.loadURL('junqi://game/index.html');
    await waitUi("document.querySelectorAll('.cell').length===62&&!document.body.inert");
    assert.equal(app.getPath('userData'), directory);
    await run(`(async()=>{
      const e=await import('./engine.js');
      for(const plies of [2,4]){
        let game=e.createGame(e.randomLayout('human'),e.randomLayout('ai'));
        game.gameId=crypto.randomUUID();
        for(let step=0;step<plies;step++){
          const from=game.board.findIndex((p,i)=>p?.side===game.turn&&e.legalMoves(game.board,i).some(to=>!game.board[to]));
          game=e.applyMove(game,from,e.legalMoves(game.board,from).find(to=>!game.board[to]));
        }
        game.result={winner:'ai',reason:'resign'};
        const saved=await window.junqiArchive.save({game,difficulty:'professional',finishedAt:'2026-01-0'+plies+'T00:00:00.000Z'});
        if(!saved.ok)throw Error(saved.error);
      }
    })()`);
    const initialSession = await session();
    await open();
    held.load = true;
    await click('.history-entry:first-child');
    await wait(() => pending.load.length === 1);
    await click('#history-dialog .icon-button');
    await release('load');
    if (baseline) {
      const report = {reproduced: await replayOpen(), trigger:'close history while a selected archive is loading',
        historyClosed: await run("!document.querySelector('#history-dialog').open"), replayPly: await replayPly(),
        packageBinding: audit.finish(), testSha256:createHash('sha256').update(fs.readFileSync(__filename)).digest('hex')};
      fs.writeFileSync(path.join(output, 'reproduction.json'), JSON.stringify(report, null, 2));
      assert.equal(report.reproduced, true);console.log(JSON.stringify(report));app.exit(0);return;
    }
    assert.equal(await replayOpen(), false);
    checks.push({name:'closing history cancels a delayed archive selection', ok:true});

    await open();await click('.history-entry:first-child');await wait(() => pending.load.length === 1);
    await key('Escape');await release('load');
    assert.equal(await replayOpen(), false);
    checks.push({name:'Escape also cancels a delayed archive selection', ok:true});

    held.load = false;
    held.list = true;
    await click('#history-btn');await wait(() => pending.list.length === 1);
    await key('Escape');await click('#history-btn');await wait(() => pending.list.length === 2);
    await release('list', 1);
    await waitUi("document.querySelectorAll('.history-entry').length===2");
    const currentList = await run("document.querySelector('#history-list').textContent");
    await release('list');
    assert.equal(await run("document.querySelectorAll('.history-entry').length"), 2);
    assert.equal(await run("document.querySelector('#history-list').textContent"), currentList);
    checks.push({name:'an earlier list response cannot duplicate a reopened history list', ok:true});
    held.list = false;

    held.load = true;
    await click('.history-entry:first-child');await wait(() => pending.load.length === 1);
    await click('.history-entry:last-child');await wait(() => pending.load.length === 2);
    await release('load', 1);
    await wait(() => replayOpen());assert.equal(await replayPly(), 2);
    await release('load');assert.equal(await replayPly(), 2);
    checks.push({name:'the latest selected archive wins when responses complete in reverse order', ok:true});

    await click('#replay-exit');await open();
    await click('.history-entry:first-child');await wait(() => pending.load.length === 1);
    await click('#history-dialog .icon-button');await open();
    await release('load');
    assert.equal(await run("document.querySelector('#history-dialog').open"), true);
    assert.equal(await replayOpen(), false);
    checks.push({name:'a selection from a closed history session cannot dismiss its replacement', ok:true});

    await click('.history-entry:first-child');await wait(() => pending.load.length === 1);
    await click('#history-dialog .icon-button');await open();
    const freshMessage = await run("document.querySelector('#history-empty').textContent");
    await release('load', 0, {ok:false,error:'QA stale read failure'});
    assert.equal(await run("document.querySelector('#history-empty').textContent"), freshMessage);
    assert.equal(await run("document.querySelector('#history-dialog').open"), true);
    checks.push({name:'a stale read failure cannot replace the current history message', ok:true});

    held.list = true;
    await run("document.querySelector('#history-dialog .icon-button').click();document.querySelector('#history-btn').click()");
    await wait(() => pending.list.length === 1);
    await release('list');
    assert.equal(await run("document.querySelectorAll('.history-entry').length"), 2);
    assert.equal(await run("document.querySelector('#history-dialog').open"), true);
    held.list = false;
    checks.push({name:'an asynchronous close event does not invalidate an immediately reopened dialog', ok:true});

    await click('.history-entry:first-child');await wait(() => pending.load.length === 1);
    await release('load', 0, {ok:false,error:'QA archive read failure'});
    assert.match(await run("document.querySelector('#history-empty').textContent"), /QA archive read failure/);
    assert.equal(await run("document.querySelector('.history-entry').disabled"), false);
    held.load = false;await click('.history-entry:first-child');
    await wait(() => replayOpen());assert.equal(await replayPly(), 4);
    assert.equal(await session(), initialSession);
    checks.push({name:'a current read failure can be retried and replay leaves the saved session intact', ok:true});
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output,'replay.png'), (await win.webContents.capturePage()).toPNG());
    const report = {passed:true, checks, directory, packageBinding:audit.finish(),
      testSha256:createHash('sha256').update(fs.readFileSync(__filename)).digest('hex')};
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));app.exit(0);
  } catch (error) {
    fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({passed:false, checks, error:error.stack}, null, 2));
    console.error(error.stack);app.exit(1);
  }
};
const source = fs.readFileSync(path.join(appRoot, 'main.cjs'), 'utf8')
  .replace("app.setPath('userData', path.join(app.getPath('appData'), '军棋·暗战'));", `app.setPath('userData',${JSON.stringify(directory)});`)
  .replace("win.once('ready-to-show', () => { win.show(); win.focus(); });", '')
  .replace("win.webContents.on('did-finish-load', () => { win.show(); });", '')
  .replace('sandbox: true, devTools:', 'sandbox: true, backgroundThrottling: false, devTools:')
  .replace('return await (await archiveStore()).list();', `return await require(${JSON.stringify(__filename)}).respond('list', await (await archiveStore()).list());`)
  .replace('return await (await archiveStore()).load(id);', `return await require(${JSON.stringify(__filename)}).respond('load', await (await archiveStore()).load(id));`)
  .replace("win.loadURL('junqi://game/index.html');", `require(${JSON.stringify(__filename)}).run({win});`);
assert.ok(source.includes(`app.setPath('userData',${JSON.stringify(directory)});`));
const compiled = new Module(path.join(appRoot, 'main.cjs'), module);
compiled.filename = path.join(appRoot, 'main.cjs');compiled.paths = Module._nodeModulePaths(appRoot);
compiled._compile(source, compiled.filename);
