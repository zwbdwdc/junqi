const { forceHumanFirstTurn } = require('./qa-randomness.cjs');
/* Storage fault injection against the real renderer. No real player data is used. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { randomUUID, createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { app } = require('electron');
const packageAudit = require('./qa-package-binding.cjs').beginPackageBinding();
const appRoot = process.env.JUNQI_QA_ASAR || __dirname;
const directory = process.env.JUNQI_SAVE_QA_PROFILE || path.join(__dirname, 'research', 'qa-session-save-data-' + randomUUID());
const phase = process.env.JUNQI_SAVE_QA_PHASE || 'verify';
const userData = phase==='verify'?path.join(directory,'controller'):directory;
const reportPath = path.join(__dirname, 'research', phase === 'reproduce' ? 'session-save-reproduction.json' : 'session-save-qa-result.json');
const checks = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = name => checks.push({name, ok:true});

exports.run = async ({win}) => {
  const run = code => win.webContents.executeJavaScript(code);
  const wait = async predicate => {
    for (let i=0;i<180;i++) { if(await run(predicate))return; await delay(100); }
    throw Error('Timeout: '+predicate);
  };
  const session = () => run("JSON.parse(localStorage.getItem('junqi-session-v2'))");
  const click = selector => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const marked = () => run("[...document.querySelectorAll('.piece-mark')].map(x=>({index:Number(x.closest('.cell').dataset.index),text:x.textContent}))");
  const warningVisible = () => run("!!document.querySelector('#session-save-warning')");
  const screenshot=async name=>{
    await win.webContents.capturePage();win.webContents.invalidate();await delay(150);
    await fs.writeFile(path.join(__dirname,'research',name),(await win.webContents.capturePage()).toPNG());
  };
  const rightMark = async (index, type) => {
    await run(`document.querySelector('[data-index="${index}"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:50,clientY:50}))`);
    await click(`[data-mark="${type}"]`);
  };
  const faults = async values => run(`Object.assign(window.__storageFaults,${JSON.stringify(values)})`);
  const errors=[];
  win.webContents.on('console-message', details=>{if(details.level==='error')errors.push(details.message);});
  try {
    await fs.mkdir(directory,{recursive:true});
    if(phase==='verify') {
      await win.close();
      const invoke=childPhase=>new Promise((resolve,reject)=>{
        const profile=childPhase==='layout'?path.join(directory,'layout'):directory;
        const child=spawn(process.execPath,[__filename],{env:{...packageAudit.childEnv,JUNQI_SAVE_QA_PHASE:childPhase,JUNQI_SAVE_QA_PROFILE:profile},windowsHide:true,stdio:['ignore','pipe','pipe']});
        let stdout='',stderr='';const timer=setTimeout(()=>{child.kill();reject(Error(childPhase+' QA timed out'));},60000);
        child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);child.on('error',reject);
        child.on('exit',code=>{clearTimeout(timer);code===0?resolve({code,stdout,stderr}):reject(Error(childPhase+' failed: '+stdout+'\n'+stderr));});
      });
      const play=await invoke('play'),restart=await invoke('restart'),layout=await invoke('layout');
      const played=JSON.parse(await fs.readFile(path.join(directory,'play.json'),'utf8'));
      const layoutChecks=JSON.parse(await fs.readFile(path.join(directory,'layout','layout.json'),'utf8'));
      const binding=packageAudit.finish();
      for(const child of [play,restart,layout]){
        const childReport=JSON.parse(child.stdout.trim().split(/\r?\n/).findLast(line=>line.startsWith('{')));
        assert.equal(childReport.passed,true);assert.deepEqual(childReport.packageBinding,binding);
      }
      const report={passed:true,checks:[...played.checks,{name:'a new Electron process restores the exact game, marks and battle record',ok:true},...layoutChecks.checks],storageProof:{persistentWarning:true,manualRetry:true,recoveryPersists:true,layoutReadFailure:true,invalidLayoutRejected:true,normalUiClean:true},directory,children:{play,restart,layout},packageBinding:binding,testSha256:createHash('sha256').update(syncFs.readFileSync(__filename)).digest('hex')};
      await fs.writeFile(reportPath,JSON.stringify(report,null,2));console.log(JSON.stringify(report));app.exit(0);return;
    }
    await win.loadURL('junqi://game/index.html');
    await wait("document.querySelectorAll('.cell').length===62&&!document.body.inert");
    assert.equal(app.getPath('userData'),directory);
    if(phase==='restart') {
      const expected=JSON.parse(await fs.readFile(path.join(directory,'expected.json'),'utf8'));
      await wait("document.querySelector('#status-title').textContent==='轮到你行棋'");
      assert.deepEqual(await session(),expected.session);
      assert.deepEqual(await marked(),expected.marks);
      assert.equal(await warningVisible(),false);
      assert.equal(await run("document.querySelectorAll('#battle-log li').length"),expected.session.game.history.length);
      assert.equal(await run("document.querySelectorAll('.piece.enemy.covered').length>0"),true);
      assert.deepEqual(errors,[]);
      console.log(JSON.stringify({passed:true,phase,packageBinding:packageAudit.finish()}));
      app.exit(0);return;
    }
    await run(`(()=>{
      const originalSet=Storage.prototype.setItem,originalGet=Storage.prototype.getItem;
      window.__storageFaults={session:false,layoutWrite:false,layoutRead:false};
      Storage.prototype.setItem=function(key,value){
        if((key==='junqi-session-v2'&&window.__storageFaults.session)||(key==='junqi-layout-v1'&&window.__storageFaults.layoutWrite))throw new DOMException('QA storage is full','QuotaExceededError');
        return originalSet.call(this,key,value);
      };
      Storage.prototype.getItem=function(key){
        if(key==='junqi-layout-v1'&&window.__storageFaults.layoutRead)throw new DOMException('QA storage denied','SecurityError');
        return originalGet.call(this,key);
      };
    })()`);
    if(phase==='layout') {
      await click('#save-layout');
      const layout=await run("localStorage.getItem('junqi-layout-v1')");assert.ok(layout);
      await faults({layoutWrite:true});await click('#random-btn');
      await click('#save-layout');
      assert.match(await run("document.querySelector('#message').textContent"),/保存失败/);
      assert.equal(await run("localStorage.getItem('junqi-layout-v1')"),layout);
      check('failed layout write preserves the previous saved layout and reports failure');
      await faults({layoutWrite:false,layoutRead:true});await click('#random-btn');
      assert.equal(await run("document.querySelectorAll('.cell').length"),62);
      const beforeDenied=await session();await click('#load-layout');
      assert.match(await run("document.querySelector('#message').textContent"),/没有可用/);
      assert.deepEqual(await session(),beforeDenied);
      check('layout read denial neither interrupts setup rendering nor replaces the board');
      await faults({layoutRead:false});await run("localStorage.setItem('junqi-layout-v1','{bad json')");await click('[data-level="hell"]');
      const beforeBad=await session();await click('#load-layout');
      assert.match(await run("document.querySelector('#message').textContent"),/没有可用/);
      assert.deepEqual(await session(),beforeBad);
      check('malformed saved layout is rejected without changing the current formation');
      await run(`localStorage.setItem('junqi-layout-v1',${JSON.stringify(layout)})`);
      await faults({session:true});await click('#load-layout');
      assert.equal(await warningVisible(),true);assert.match(await run("document.querySelector('#message').textContent"),/尚未保存/);
      await faults({session:false});await click('#retry-session-save');
      assert.equal(await warningVisible(),false);assert.deepEqual((await session()).setup,JSON.parse(layout));
      check('loading a valid formation still reports failed session persistence until retry succeeds');
      await faults({session:true});await click('#random-btn');assert.equal(await warningVisible(),true);
      await faults({session:false});await click('[data-level="professional"]');assert.equal(await warningVisible(),false);
      check('the next normal successful save also clears the persistent warning');
      assert.deepEqual(errors,[]);
      const report={passed:true,checks,packageBinding:packageAudit.finish()};await fs.writeFile(path.join(directory,'layout.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));app.exit(0);return;
    }
    await forceHumanFirstTurn(win);
    await click('#start-btn');
    await wait("document.querySelector('#status-title').textContent==='轮到你行棋'");
    assert.equal(await warningVisible(),false);
    assert.equal(await run("!!document.querySelector('#retry-session-save')"),false);
    check('normal play adds no storage notice or retry control');
    const original=await session(),target=original.game.board.findIndex(p=>p?.side==='ai'&&p.type==='flag');
    await faults({session:true});
    await rightMark(target,'general');
    const unpersisted=await session();
    assert.deepEqual(unpersisted,original);
    assert.match((await marked())[0].text,/军长/);
    if(phase==='reproduce') {
      assert.equal(await warningVisible(),false);
      assert.match(await run("document.querySelector('#message').textContent"),/已标记/);
      const report={reproduced:true,problem:'QuotaExceededError is silently swallowed while a new annotation is shown as successful; persisted data lacks the annotation.',message:await run("document.querySelector('#message').textContent"),storedMarks:unpersisted.marks,visibleMarks:await marked(),packageBinding:packageAudit.finish(),directory};
      await fs.writeFile(reportPath,JSON.stringify(report,null,2));console.log(JSON.stringify(report));app.exit(0);return;
    }
    assert.equal(await warningVisible(),true);
    assert.match(await run("document.querySelector('#session-save-warning').textContent"),/尚未保存/);
    check('storage-full marking keeps the board usable and exposes unsaved changes');
    const move=await run(`(async()=>{const e=await import('./engine.js'),s=JSON.parse(localStorage.getItem('junqi-session-v2'));for(let from=0;from<62;from++)if(s.game.board[from]?.side==='human')for(const to of e.legalMoves(s.game.board,from))if(!s.game.board[to])return{from,to};throw Error('No quiet move');})()`);
    await click(`[data-index="${move.from}"]`);await click(`[data-index="${move.to}"]`);
    await wait("document.querySelector('#status-title').textContent==='轮到你行棋'&&document.querySelector('#turn-number').textContent.includes('2 步')");
    assert.equal(await warningVisible(),true);
    assert.deepEqual(await session(),original);
    assert.equal(await run("document.querySelectorAll('#battle-log li').length"),2);
    assert.equal(await run("document.querySelectorAll('.piece.enemy.covered').length>0"),true);
    await rightMark(target,'bomb');
    assert.equal(await warningVisible(),true);
    assert.match(await run("document.querySelector('#message').textContent"),/已标记/);
    check('normal move, real AI worker reply and another mark cannot erase the save warning');
    await screenshot('session-save-warning.png');
    await click('#retry-session-save');
    assert.equal(await warningVisible(),true);
    assert.deepEqual(await session(),original);
    check('retry during storage failure remains visible and does not claim success');
    await faults({session:false});await click('#retry-session-save');
    assert.equal(await warningVisible(),false);
    const recovered=await session();
    assert.equal(recovered.game.ply,2);assert.equal(recovered.marks[original.game.board[target].id],'bomb');
    assert.equal(recovered.game.gameId,original.game.gameId);
    assert.equal(recovered.game.history.length,2);
    check('successful retry persists the current game and marks, then removes the warning');
    await screenshot('session-save-recovered.png');
    await fs.writeFile(path.join(directory,'expected.json'),JSON.stringify({session:recovered,marks:await marked()}));
    await win.loadURL('junqi://game/fixture.html');
    win.webContents.session.flushStorageData();
    assert.deepEqual(errors,[]);
    const report={passed:true,checks,directory,packageBinding:packageAudit.finish()};
    await fs.writeFile(path.join(directory,'play.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));app.exit(0);
  }catch(error){
    await fs.writeFile(reportPath,JSON.stringify({passed:false,checks,directory,phase,error:error.stack},null,2));console.error(error.stack);app.exit(1);
  }
};

const original=syncFs.readFileSync(path.join(appRoot,'main.cjs'),'utf8');
const source=original
  .replace("app.setPath('userData', path.join(app.getPath('appData'), '军棋·暗战'));",`app.setPath('userData',${JSON.stringify(userData)});`)
  .replace("win.once('ready-to-show', () => { win.show(); win.focus(); });",'')
  .replace("win.webContents.on('did-finish-load', () => { win.show(); });",'')
  .replace('sandbox: true, devTools:','sandbox: true, backgroundThrottling: false, devTools:')
  .replace('const url = new URL(request.url);',`const url = new URL(request.url);if(url.hostname==='game'&&url.pathname==='/fixture.html')return new Response('<!doctype html><title>QA fixture</title>',{headers:{'Content-Type':'text/html'}});`)
  .replace("win.loadURL('junqi://game/index.html');",`require(${JSON.stringify(__filename)}).run({win});`)
  .replace("app.on('window-all-closed', () => app.quit());","app.on('window-all-closed', () => {});");
assert.ok(source.includes(`app.setPath('userData',${JSON.stringify(userData)});`));
assert.ok(source.includes('.run({win})'));
const compiled=new Module(path.join(appRoot,'main.cjs'),module);compiled.filename=path.join(appRoot,'main.cjs');compiled.paths=Module._nodeModulePaths(appRoot);compiled._compile(source,compiled.filename);
