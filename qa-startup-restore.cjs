// Delay only the experience IPC response. Exercise the real startup/session path.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { randomUUID, createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { app } = require('electron');
const audit = require('./qa-package-binding.cjs').beginPackageBinding();
const appRoot = process.env.JUNQI_QA_ASAR || __dirname;
const version = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'))).version;
const baseline = process.env.JUNQI_STARTUP_BASELINE === '1';
const output = process.env.JUNQI_STARTUP_QA_OUTPUT || path.join(__dirname, 'analysis/package-qa', version,
  process.env.JUNQI_QA_ASAR ? 'startup-restore-packaged' : 'startup-restore-source');
const directory = process.env.JUNQI_STARTUP_PROFILE || path.join(__dirname, 'research', 'qa-startup-restore-' + randomUUID());
const phase = process.env.JUNQI_STARTUP_PHASE;
fs.mkdirSync(output, { recursive: true });
let hold = false, calls = 0, release;
exports.delayExperience = () => {
  calls++;
  return hold ? new Promise(resolve => { release = resolve; }) : Promise.resolve();
};
exports.run = async ({ win }) => {
  const run = code => win.webContents.executeJavaScript(code);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const checks = [], errors = [];
  const wait = async predicate => {
    for (let attempt = 0; attempt < 180; attempt++) {
      if (await predicate()) return;
      await delay(50);
    }
    throw Error('Startup QA timed out');
  };
  const ready = () => wait(() => run("document.querySelectorAll('.cell').length===62&&!document.body.inert"));
  const serialized = () => run("localStorage.getItem('junqi-session-v2')");
  const install = async data => {
    await win.loadURL('junqi://game/fixture.html');
    const json = JSON.stringify(data);
    await run(`localStorage.setItem('junqi-session-v2',${JSON.stringify(json)})`);
    return json;
  };
  const beginHeld = async () => {
    hold = true;
    const prior = calls;
    await win.loadURL('junqi://game/index.html');
    await wait(() => calls > prior && release);
  };
  const releaseHeld = () => { hold = false; release(); release = null; };
  win.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
  try {
    if (phase === 'close' || phase === 'restart') {
      const expected = fs.readFileSync(path.join(directory, 'expected-session.json'), 'utf8');
      if (phase === 'close') {
        await win.loadURL('junqi://game/fixture.html');
        await run(`localStorage.setItem('junqi-session-v2',${JSON.stringify(expected)})`);
        await beginHeld();
        assert.equal(await run('document.body.inert'), true);
        fs.writeFileSync(path.join(directory, 'close-proof.json'), JSON.stringify({ held: true, packageBinding: audit.finish() }));
        // Native close dispatches beforeunload, then the unmodified production
        // window-all-closed and before-quit handlers finish this process.
        win.close();return;
      }
      await win.loadURL('junqi://game/index.html');await ready();
      assert.equal(await serialized(), expected);
      console.log(JSON.stringify({passed:true,phase,packageBinding:audit.finish()}));app.exit(0);return;
    }
    await win.loadURL('junqi://game/index.html');
    await ready();
    assert.equal(app.getPath('userData'), directory);
    const fixture = await run(`(async()=>{
      const e=await import('./engine.js');
      let game=e.createGame(e.randomLayout('human'),e.randomLayout('ai'),{firstTurn:'human',engineerMountains:true});
      game.gameId=crypto.randomUUID();game.startedAt=new Date().toISOString();game.aiDecisions=[];
      for(let step=0;step<2;step++){
        const from=game.board.findIndex((p,i)=>p?.side===game.turn&&e.legalMoves(game.board,i).some(to=>!game.board[to]));
        const to=e.legalMoves(game.board,from).find(to=>!game.board[to]);game=e.applyMove(game,from,to);
      }
      const enemy=game.board.find(p=>p?.side==='ai'&&!e.revealedEngineerIds(game).has(p.id));
      return {version:1,setup:game.initial.slice(0,60).map(p=>p?.side==='human'?p:null),
        game,difficulty:'professional',marks:{[enemy.id]:'bomb'}};
    })()`);
    const expected = await install(fixture);
    await beginHeld();
    const loading = await run("({cells:document.querySelectorAll('.cell').length,inert:document.body.inert,title:document.querySelector('#status-title').textContent})");
    await win.loadURL('junqi://game/fixture.html');
    const after = await serialized();
    if (baseline) {
      const report = { reproduced: after !== expected && JSON.parse(after).game === null,
        trigger: 'navigate away while experience load is awaiting IPC', loading,
        before: { gameId: fixture.game.gameId, ply: fixture.game.ply, marks: fixture.marks },
        after: { game: JSON.parse(after).game, marks: JSON.parse(after).marks },
        packageBinding: audit.finish(), testSha256: createHash('sha256').update(fs.readFileSync(__filename)).digest('hex') };
      fs.writeFileSync(path.join(output, 'reproduction.json'), JSON.stringify(report, null, 2));
      assert.equal(report.reproduced, true);console.log(JSON.stringify(report));releaseHeld();app.exit(0);return;
    }
    assert.equal(after, expected, 'leaving during initial load must not overwrite an existing session');
    assert.equal(loading.cells, 62);assert.equal(loading.inert, true);
    releaseHeld();
    checks.push({ name: 'startup renders the saved board and leaving during experience loading preserves exact session bytes', ok: true });

    await win.loadURL('junqi://game/index.html');await ready();
    assert.deepEqual(JSON.parse(await serialized()), fixture);
    assert.equal(await run("document.querySelector('.piece-mark')?.textContent"), '炸弹？');
    assert.equal(await run("document.querySelectorAll('#battle-log li').length"), 2);
    checks.push({ name: 'reload recovers the same game, marks and battle history', ok: true });

    await install(fixture);await beginHeld();
    const action = await run("(()=>{const r=document.querySelector('#new-btn').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()");
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...action});
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...action});
    await delay(80);
    assert.equal(await run("!!document.querySelector('dialog[open]')"), false);
    assert.equal(await serialized(), expected);
    releaseHeld();await ready();
    assert.equal(await run("document.querySelector('#status-title').textContent"), '轮到你行棋');
    checks.push({ name: 'new-game input is blocked during loading and normal human play resumes afterwards', ok: true });

    const legacy = structuredClone(fixture);delete legacy.game.firstTurn;
    await install(legacy);await beginHeld();releaseHeld();await ready();
    assert.deepEqual(JSON.parse(await serialized()), legacy);
    checks.push({ name: 'legacy records without firstTurn remain intact', ok: true });

    const aiFixture = await run(`(async()=>{const e=await import('./engine.js');const data=${JSON.stringify(fixture)};
      const from=data.game.board.findIndex((p,i)=>p?.side==='human'&&e.legalMoves(data.game.board,i).some(to=>!data.game.board[to]));
      data.game=e.applyMove(data.game,from,e.legalMoves(data.game.board,from).find(to=>!data.game.board[to]));return data;})()`);
    const aiExpected = await install(aiFixture);await beginHeld();
    await delay(250);assert.equal(await serialized(), aiExpected);
    releaseHeld();await ready();
    await wait(async () => JSON.parse(await serialized()).game.ply === aiFixture.game.ply + 1);
    await delay(1000);
    const completed = JSON.parse(await serialized());
    assert.equal(completed.game.gameId, aiFixture.game.gameId);
    assert.equal(completed.game.ply, aiFixture.game.ply + 1);
    assert.equal(completed.game.aiDecisions.length, 1);
    checks.push({ name: 'restored AI turn starts only after experience load and moves exactly once', ok: true });

    await install(fixture);hold = true;
    const prior = calls;
    await win.loadURL('junqi://game/index.html');await wait(() => calls > prior && release);
    // Reject the real preload request after it has reached the IPC handler.
    release(new Error('QA experience read failure'));hold = false;release = null;
    await ready();
    assert.equal(await run("document.querySelector('#status-title').textContent"), '轮到你行棋');
    assert.deepEqual(JSON.parse(await serialized()), fixture);
    assert.match(await run("document.querySelector('#learning-storage').textContent"), /读取失败/);
    checks.push({ name: 'experience-load rejection unlocks the preserved game', ok: true });
    assert.deepEqual(errors, []);

    const childDirectory = path.join(directory, 'close-restart');
    fs.mkdirSync(childDirectory, {recursive:true});
    fs.writeFileSync(path.join(childDirectory, 'expected-session.json'), expected);
    const children = [];
    for (const childPhase of ['close','restart']) {
      const result = await new Promise((resolve,reject) => {
        const child = spawn(process.execPath, [__filename], {windowsHide:true,stdio:['ignore','pipe','pipe'],
          env:{...audit.childEnv,JUNQI_STARTUP_PROFILE:childDirectory,JUNQI_STARTUP_PHASE:childPhase}});
        let stdout='',stderr='';
        const timer=setTimeout(()=>{child.kill();reject(Error('Isolated startup child timed out'));},30000);
        child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
        child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);resolve({phase:childPhase,code,stdout,stderr});});
      });
      children.push(result);assert.equal(result.code,0,JSON.stringify(result));
    }
    const closeProof = JSON.parse(fs.readFileSync(path.join(childDirectory,'close-proof.json')));
    assert.equal(closeProof.held,true);assert.deepEqual(closeProof.packageBinding,audit.finish());
    const restartProof = JSON.parse(children[1].stdout.trim().split(/\r?\n/).findLast(line=>line.startsWith('{')));
    assert.equal(restartProof.passed,true);assert.deepEqual(restartProof.packageBinding,audit.finish());
    checks.push({name:'native window close during loading followed by a new Electron process preserves the session',ok:true});
    const report = { passed: true, checks, directory, packageBinding: audit.finish(),
      children,testSha256: createHash('sha256').update(fs.readFileSync(__filename)).digest('hex') };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));app.exit(0);
  } catch (error) {
    fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({passed:false,checks,error:error.stack},null,2));
    console.error(error.stack);app.exit(1);
  }
};
const source = fs.readFileSync(path.join(appRoot, 'main.cjs'), 'utf8')
  .replace("app.setPath('userData', path.join(app.getPath('appData'), '军棋·暗战'));", `app.setPath('userData',${JSON.stringify(directory)});`)
  .replace("win.once('ready-to-show', () => { win.show(); win.focus(); });", '')
  .replace("win.webContents.on('did-finish-load', () => { win.show(); });", '')
  .replace('sandbox: true, devTools:', 'sandbox: true, backgroundThrottling: false, devTools:')
  .replace("ipcMain.handle('junqi-experience:load', event => {", `ipcMain.handle('junqi-experience:load', async event => { const fault=await require(${JSON.stringify(__filename)}).delayExperience();if(fault)throw fault;`)
  .replace('const url = new URL(request.url);', `const url = new URL(request.url);if(url.hostname==='game'&&url.pathname==='/fixture.html')return new Response('<!doctype html><title>QA</title>',{headers:{'Content-Type':'text/html'}});`)
  .replace("win.loadURL('junqi://game/index.html');", `require(${JSON.stringify(__filename)}).run({win});`);
assert.ok(source.includes(`app.setPath('userData',${JSON.stringify(directory)});`));
const compiled = new Module(path.join(appRoot, 'main.cjs'), module);
compiled.filename = path.join(appRoot, 'main.cjs');compiled.paths = Module._nodeModulePaths(appRoot);
compiled._compile(source, compiled.filename);
