const { forceHumanFirstTurn } = require('./qa-randomness.cjs');
/* Real Electron/main/preload integration with only synthetic games. Each
 * phase runs in its own process against an isolated temporary profile. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const packageAudit = require('./qa-package-binding.cjs').beginPackageBinding();
const Module = require('node:module');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { app, dialog } = require('electron');
const appRoot = process.env.JUNQI_QA_ASAR || __dirname;
const phase = process.env.JUNQI_QA_CONSOLIDATION_PHASE;
const directory = process.env.JUNQI_QA_CONSOLIDATION_DIRECTORY || path.join(__dirname, 'research', 'qa-consolidation-' + randomUUID());
const reportPath = path.join(__dirname, 'research', 'consolidation-qa-result.json');
const checks = [];
let restoreGate = null;
function check(name, callback) { callback(); checks.push({name,ok:true}); }
exports.waitForRestore = () => {
  if (!restoreGate) return;
  restoreGate.enter();
  return restoreGate.wait;
};

exports.run = async ({win,archiveStore,experienceStore}) => {
  const run = code => win.webContents.executeJavaScript(code);
  async function wait(predicate) {
    for(let attempt=0;attempt<150;attempt++) {
      if(await run(predicate))return;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw new Error('Timeout: '+predicate);
  }
  const e = await import(pathToFileURL(path.join(appRoot,'dist','engine.js')).href);
  const {createLearningProfile} = await import(pathToFileURL(path.join(appRoot,'dist','learning.js')).href);
  const seeded = seed => () => ((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
  function episode(id, seed) {
    let game=e.createGame(e.randomLayout('human',seeded(seed)),e.randomLayout('ai',seeded(seed+100)),{engineerMountains:true});
    game.gameId=id;
    for(let n=0;n<4&&!game.result;n++) {
      const from=game.board.findIndex((piece,at)=>piece?.side===game.turn&&e.legalMoves(game.board,at).length);
      game=e.applyMove(game,from,e.legalMoves(game.board,from)[0]);
    }
    game.result||={winner:'human',reason:'resign'};
    game.aiDecisions=game.history.filter(event=>event.side==='ai').map(event=>({ply:event.ply,from:event.from,to:event.to,
      info:{actionClass:'develop',learningFeatures:{develop:1}}}));
    return {game,difficulty:'professional',finishedAt:`2026-10-${String(seed).padStart(2,'0')}T00:00:00.000Z`};
  }
  try {
    await win.loadURL('junqi://game/index.html');
    const initial=await run('window.junqiExperience.load()');
    check('real production profile path is redirected to isolated test data',()=>assert.equal(app.getPath('userData'),directory));
    if(phase==='write') {
      const first=episode('synthetic-consolidation-a',1),second=episode('synthetic-consolidation-b',2);
      const store=await archiveStore();
      assert.equal((await store.save(first)).ok,true);
      // Simulate a crash after successful archive persistence but before the
      // learning transaction. Startup/load must recover that exact record.
      const recovered=await run('window.junqiExperience.load()');
      check('a durable completed archive repairs missed experience on load',()=>{
        assert.equal(recovered.profile.games,1);assert.equal(recovered.profile.replayGames,1);
        assert.equal(recovered.learned,1);
      });
      const concurrent=await run(`Promise.all([
        window.junqiExperience.review(),window.junqiArchive.save(${JSON.stringify(first)}),
        window.junqiArchive.save(${JSON.stringify(second)}),window.junqiExperience.review(),
        window.junqiArchive.save(${JSON.stringify(second)})
      ])`);
      const committed=await run('window.junqiExperience.load()');
      check('concurrent duplicate archives and reviews consolidate each game exactly once',()=>{
        for(const response of concurrent)assert.equal(response.ok,true,response.error);
        assert.equal(committed.profile.games,2);assert.equal(committed.profile.replayGames,2);
        assert.equal(JSON.parse(require('node:fs').readFileSync(path.join(directory,'learning-profile.json'))).games,2);
      });
      const stamped=await run(`window.junqiArchive.load(${JSON.stringify(concurrent[2].id)})`);
      check('finished archives record their actual runtime without placing metadata in a live AI observation',()=>{
        assert.equal(stamped.ok,true);assert.equal(stamped.record.game.runtime.appVersion,require(path.join(appRoot,'package.json')).version);
        assert.equal(stamped.record.game.runtime.electronVersion,process.versions.electron);
        assert.match(stamped.record.game.runtime.launchId,/^[a-f0-9-]{36}$/);
        assert.equal(Object.hasOwn(e.makeObservation(stamped.record.game,'ai'),'runtime'),false);
      });
      const live=episode('synthetic-not-finished',3);live.game.result=null;
      const denied=await run(`window.junqiArchive.save(${JSON.stringify(live)})`);
      check('an unfinished game cannot enter the archive or learning stream',()=>{
        assert.equal(denied.ok,false);assert.match(denied.error,/结束/);
      });
      const bad=await run('window.junqiExperience.restore({version:999,games:1})');
      check('strict restore rejects invalid profiles without resetting learned experience',()=>assert.equal(bad.ok,false));
      assert.equal((await run('window.junqiExperience.load()')).profile.games,2);
      const backup=createLearningProfile();backup.games=13;backup.replayGames=12;backup.weights.attack=1.07;
      backup.outcomes={wins:5,losses:6,draws:2};
      const restored=await run(`window.junqiExperience.restore(${JSON.stringify(backup)})`);
      const reread=await run('window.junqiExperience.load()');
      check('intentional backup restore is not reversed by automatic archive recovery',()=>{
        assert.equal(restored.ok,true,restored.error);assert.equal(reread.profile.games,13);
        assert.equal(reread.profile.weights.attack,1.07);assert.equal(reread.learned,0);
      });
      const third=episode('synthetic-after-restore',3);
      assert.equal((await run(`window.junqiArchive.save(${JSON.stringify(third)})`)).ok,true);
      const after=await run('window.junqiExperience.load()');
      check('a new game after explicit restoration still learns and persists',()=>{
        assert.equal(after.profile.games,14);assert.equal(after.profile.replayGames,13);
      });
      await forceHumanFirstTurn(win);
      await run("document.querySelector('#start-btn').click();");
      await wait("document.querySelector('#status-title').textContent==='轮到你行棋'");
      await run("document.querySelector('#resign-btn').click();document.querySelector('#confirm-ok').click();");
      await wait("document.querySelector('#phase-label').textContent==='战局结束'");
      await wait("window.junqiExperience.load().then(result=>result.profile?.games===15)");
      await wait("JSON.parse(localStorage.getItem('junqi-learning-v1'))?.games===15");
      const terminal=await run('window.junqiExperience.load()');
      check('ending a real UI game saves the consolidated profile and updates the renderer cache together',()=>{
        assert.equal(terminal.profile.games,15);assert.equal(terminal.profile.replayGames,14);
      });
      await run("document.querySelector('#again-btn').click();");
      await wait("document.querySelector('#phase-label').textContent==='布阵'");
      const importProfile=createLearningProfile();importProfile.games=7;importProfile.replayGames=7;
      importProfile.outcomes={wins:4,losses:3,draws:0};importProfile.weights.attack=1.09;
      const importPath=path.join(directory,'synthetic-ui-backup.json');
      await fs.writeFile(importPath,JSON.stringify(importProfile));
      let importCalls=0;
      const previousOpenDialog=dialog.showOpenDialog;
      dialog.showOpenDialog=async()=>{importCalls++;return {canceled:false,filePaths:[importPath]};};
      let entered,release;
      const restoreEntered=new Promise(resolve=>entered=resolve);
      restoreGate={enter:entered,wait:new Promise(resolve=>release=resolve)};
      await run("document.querySelector('#settings-btn').click();document.querySelector('#import-experience').click();");
      await wait("document.querySelector('#confirm-dialog').open");
      await run("document.querySelector('#confirm-ok').click();");
      await restoreEntered;
      const locked=await run(`(()=>{
        const ids=['start-btn','new-btn','again-btn','replay-again','import-experience','export-experience'];
        const before=localStorage.getItem('junqi-session-v2');
        const disabled=Object.fromEntries(ids.map(id=>[id,document.querySelector('#'+id).disabled]));
        // Invoke handlers directly as well: disabled buttons protect ordinary
        // clicks, while the function guards must reject already queued events.
        for(const id of ['start-btn','new-btn','again-btn','replay-again','import-experience'])
          document.querySelector('#'+id).onclick();
        document.querySelector('[data-index="30"]').click();
        return {disabled,before,after:localStorage.getItem('junqi-session-v2'),
          phase:document.querySelector('#phase-label').textContent};
      })()`);
      check('confirmed UI restore blocks immediate start, new game, replay restart and duplicate import',()=>{
        assert.ok(Object.values(locked.disabled).every(Boolean),JSON.stringify(locked.disabled));
        assert.equal(locked.phase,'布阵');assert.equal(locked.after,locked.before);
        assert.equal(importCalls,1);
      });
      release();restoreGate=null;
      await wait("document.querySelector('#message').textContent==='已恢复电脑经验。'");
      dialog.showOpenDialog=previousOpenDialog;
      const restoredUI=await run(`(async()=>({saved:await window.junqiExperience.load(),
        cache:JSON.parse(localStorage.getItem('junqi-learning-v1')),startDisabled:document.querySelector('#start-btn').disabled,
        newDisabled:document.querySelector('#new-btn').disabled}))()`);
      check('UI restore unlocks only after both disk and renderer use the selected backup',()=>{
        assert.equal(restoredUI.saved.profile.games,7);assert.equal(restoredUI.cache.games,7);
        assert.equal(restoredUI.saved.profile.weights.attack,1.09);
        assert.equal(restoredUI.saved.learned,0);assert.equal(restoredUI.startDisabled,false);assert.equal(restoredUI.newDisabled,false);
      });
      await forceHumanFirstTurn(win);
      await run("document.querySelector('#start-btn').click();document.querySelector('#resign-btn').click();document.querySelector('#confirm-ok').click();");
      await wait("JSON.parse(localStorage.getItem('junqi-learning-v1'))?.games===8");
      const afterUIRestore=await run('window.junqiExperience.load()');
      check('a game started after UI restoration is learned once instead of excluded as an older archive',()=>{
        assert.equal(afterUIRestore.profile.games,8);assert.equal(afterUIRestore.profile.replayGames,8);
      });
      await fs.writeFile(path.join(directory,'expected-profile.json'),JSON.stringify(afterUIRestore.profile));
    } else {
      const expected=JSON.parse(await fs.readFile(path.join(directory,'expected-profile.json'),'utf8'));
      check('a separate app process restores exact saved weights and counts without duplicate learning',()=>{
        assert.deepEqual(initial.profile,expected);assert.equal(initial.profile.games,8);assert.equal(initial.learned,0);
      });
      const again=await run('window.junqiExperience.review()');
      check('explicit review after restart is idempotent',()=>{
        assert.equal(again.ok,true);assert.deepEqual(again.profile,expected);assert.equal(again.learned,0);
      });
      await (await experienceStore()).waitForIdle();
      check('only aggregate information appears in the persistent experience file',()=>{
        const saved=JSON.stringify(again.profile);
        for(const forbidden of ['synthetic-consolidation','synthetic-after-restore','initial','board','history','attackerId'])
          assert.equal(saved.includes(forbidden),false,forbidden);
      });
      const diagnostic=JSON.parse(await fs.readFile(path.join(directory,'runtime-diagnostics.json'),'utf8'));
      check('bounded diagnostics prove runtime starts, committed learning and rejected restoration across processes',()=>{
        assert.equal(diagnostic.schema,1);assert.ok(diagnostic.entries.length<=64);
        assert.ok(diagnostic.entries.filter(item=>item.event==='startup').length>=2);
        assert.ok(diagnostic.entries.some(item=>item.event==='experience-review'&&item.ok&&item.learned>0));
        assert.ok(diagnostic.entries.some(item=>item.event==='experience-restore'&&item.ok===false));
        for(const item of diagnostic.entries)for(const key of ['game','board','initial','history','profile','stack','gameId'])
          assert.equal(Object.hasOwn(item,key),false,key);
      });
    }
    await fs.writeFile(path.join(directory,`qa-${phase}.json`),JSON.stringify({ok:true,phase,checks,packageBinding:packageAudit.finish()},null,2));
    win.destroy();app.quit();
  } catch(error) {
    await fs.mkdir(directory,{recursive:true});
    await fs.writeFile(path.join(directory,`qa-${phase}.json`),JSON.stringify({ok:false,phase,checks,error:error.stack},null,2));
    console.error(error.stack);app.exit(1);
  }
};
if(!phase) {
  app.setPath('userData',path.join(directory,'driver'));
  app.whenReady().then(async()=>{
    const results=[];
    try {
      await fs.mkdir(directory,{recursive:true});
      for(const stage of ['write','read']) {
        await new Promise((resolve,reject)=>{
          const child=spawn(process.execPath,[__filename],{windowsHide:true,stdio:['ignore','pipe','pipe'],
            env:{...packageAudit.childEnv,JUNQI_QA_CONSOLIDATION_PHASE:stage,JUNQI_QA_CONSOLIDATION_DIRECTORY:directory}});
          let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
          child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`Consolidation ${stage}: ${code}: ${output}`)));
        });
        results.push(JSON.parse(await fs.readFile(path.join(directory,`qa-${stage}.json`),'utf8')));
      }
      const packageBinding=packageAudit.finish();
      for(const result of results){assert.equal(result.ok,true);assert.deepEqual(result.packageBinding,packageBinding,'all child phases must use the same unchanged package');}
      const report={ok:true,packageBinding,checks:results.reduce((sum,item)=>sum+item.checks.length,0),directory,results};
      await fs.writeFile(reportPath,JSON.stringify(report,null,2));
      console.log(JSON.stringify({ok:true,checks:report.checks,reportPath,packageBinding}));app.exit(0);
    } catch(error) {await fs.writeFile(reportPath,JSON.stringify({ok:false,directory,results,error:error.stack},null,2));console.error(error.stack);app.exit(1);}
  });
} else {
  const original=require('node:fs').readFileSync(path.join(appRoot,'main.cjs'),'utf8');
  const source=original
    .replace("app.setPath('userData', path.join(app.getPath('appData'), '军棋·暗战'));",`app.setPath('userData', ${JSON.stringify(directory)});`)
    .replace("win.once('ready-to-show', () => { win.show(); win.focus(); });",'')
    .replace("win.webContents.on('did-finish-load', () => { win.show(); });",'')
    .replace('const store = await experienceStore(), validated = store.validate(profile);',
      `await require(${JSON.stringify(__filename)}).waitForRestore(); const store = await experienceStore(), validated = store.validate(profile);`)
    .replace("win.loadURL('junqi://game/index.html');",`require(${JSON.stringify(__filename)}).run({win,archiveStore,experienceStore});`)
    .replace("app.on('window-all-closed', () => app.quit());","app.on('window-all-closed', () => {});");
  assert.ok(source.includes(`app.setPath('userData', ${JSON.stringify(directory)});`));
  const compiled=new Module(path.join(appRoot,'main.cjs'),module);
  compiled.filename=path.join(appRoot,'main.cjs');compiled.paths=Module._nodeModulePaths(appRoot);
  compiled._compile(source,compiled.filename);
}
