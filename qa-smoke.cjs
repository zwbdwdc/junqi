const { forceHumanFirstTurn } = require('./qa-randomness.cjs');
// Isolated integration test: exercises our renderer and worker, never a user's session.
const {app,BrowserWindow,protocol}=require('electron');
const fs=require('node:fs/promises');
const path=require('node:path');
const packageAudit = require('./qa-package-binding.cjs').beginPackageBinding();
app.setPath('userData',path.join(__dirname,'qa-profile'));
app.userAgentFallback='JunqiIntegrationTest/1.0';
protocol.registerSchemesAsPrivileged([{scheme:'junqi',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
app.whenReady().then(async()=>{
 const failures=[];
 protocol.handle('junqi',async req=>{
  const file=path.join(process.env.JUNQI_QA_ASAR ? path.join(process.env.JUNQI_QA_ASAR,'dist') : path.join(__dirname,'dist'),new URL(req.url).pathname);
  return new Response(await fs.readFile(file),{headers:{'Content-Type':({'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png'})[path.extname(file)]||'text/plain'}});
 });
 const win=new BrowserWindow({show:false,width:1240,height:930,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
 win.webContents.on('console-message',(details)=>{if(details.level==='error')failures.push(details.message);});
 try{
  await win.webContents.session.clearStorageData();
  await win.loadURL('junqi://game/index.html');
  const run=code=>win.webContents.executeJavaScript(code);
  const wait=async predicate=>{for(let i=0;i<150;i++){if(await run(predicate))return;await new Promise(r=>setTimeout(r,100));}throw Error('Timeout '+predicate);};
  await wait("document.querySelectorAll('.cell').length===62");
  if(!await run("document.querySelectorAll('[data-level]').length===2 && !document.querySelector('[data-level=\"beginner\"]')"))throw Error('Difficulty removal failed');
  await run("document.querySelector('#clear-btn').click();");
  if(!await run("document.querySelector('#placed-count').textContent.includes('0 / 25')"))throw Error('Clear layout failed');
  // Pointer drag from the flag reserve to its permitted headquarters.
  await run(`(()=>{const source=document.querySelector('.reserve-piece');const target=document.querySelector('[data-index="56"]');const a=source.getBoundingClientRect(),b=target.getBoundingClientRect();source.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,clientX:a.x+10,clientY:a.y+10}));document.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:b.x+b.width/2,clientY:b.y+b.height/2}));document.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,clientX:b.x+b.width/2,clientY:b.y+b.height/2}));})()`);
  if(!await run("document.querySelector('[data-index=\"56\"]').textContent.includes('军旗')"))throw Error('Pointer placement failed');
  await new Promise(r=>setTimeout(r,120));
  await run("document.querySelectorAll('.reserve-piece')[1].click();document.querySelector('[data-index=\"30\"]').click();");
  if(!await run("document.querySelector('#message').textContent.includes('后两排') && document.querySelector('#placed-count').textContent.includes('1 / 25')"))throw Error('Mine placement restriction failed');
  await run("document.querySelector('#random-btn').click();document.querySelector('[data-level=\"hell\"]').click();document.querySelector('#save-layout').click();");
  if(!await run("document.querySelector('#placed-count').textContent.includes('25 / 25') && document.querySelector('#difficulty-caption').textContent.includes('地狱')"))throw Error('Random deployment or difficulty change failed');
  await new Promise(r=>setTimeout(r,200));
  await fs.writeFile(path.join(__dirname,'qa-setup.png'),(await win.webContents.capturePage()).toPNG());
  await forceHumanFirstTurn(win);
  await run("document.querySelector('#start-btn').click();");
  if(!await run("document.querySelector('#status-title').textContent==='轮到你行棋'"))throw Error('Start failed');
  const playingStyle=await run("JSON.parse(localStorage.getItem('junqi-session-v2')).game.aiContext");
  if(!['balanced','pressure','maneuver'].includes(playingStyle?.style)||![-1,1].includes(playingStyle.wing)||!Number.isInteger(playingStyle.seed))throw Error('Missing per-game playing style');
  if(!await run("document.querySelector('#replay-btn').classList.contains('hidden')"))throw Error('Active replay exposed');
  await run("document.querySelector('#replay-btn').click()");
  if(!await run("document.querySelector('#replay-panel').classList.contains('hidden')"))throw Error('Active replay gate failed');
  for(const result of ['win','lose','both']){
   const effect=await run(`(async()=>{const fx=await import('./battle-effects.js');const board=document.querySelector('#board');fx.playBattleEffect(board,{from:30,to:25,result:'${result}'},fx.captureBattlePieces(board,30,25));const box=board.querySelector('.battle-effect'),cell=board.querySelector('[data-index="25"]');const a=box.getBoundingClientRect(),b=cell.getBoundingClientRect();return {className:box.className,clipped:getComputedStyle(box).overflow==='hidden',within:Math.abs(a.left-b.left)<=1&&Math.abs(a.top-b.top)<=1&&Math.abs(a.width-b.width)<=1&&Math.abs(a.height-b.height)<=1,symbol:box.querySelector('.battle-symbol')?.textContent,smoke:box.querySelectorAll('.smoke-puff').length,leaks:[...box.querySelectorAll('.piece.enemy')].some(p=>!['暗','军旗','工兵'].includes(p.textContent.trim()))};})()`);
   if(!effect.className.includes('battle-'+result)||!effect.clipped||!effect.within||effect.leaks)throw Error('Combat effect boundary or identity failed '+JSON.stringify(effect));
   if(result==='both'?effect.smoke!==8:!effect.symbol)throw Error('Combat effect kind failed');
   await new Promise(r=>setTimeout(r,280));
   if(!await run("!!document.querySelector('.battle-effect')"))throw Error('Effect ended before 0.5 seconds');
   await new Promise(r=>setTimeout(r,280));
   if(await run("!!document.querySelector('.battle-effect')"))throw Error('Effect exceeded 0.5 seconds');
  }
  let turns=0;
  for(;turns<8;turns++){
   const moved=await run(`(()=>{if(document.querySelector('#phase-label').textContent==='战局结束')return false;const own=[...document.querySelectorAll('.cell')].filter(x=>x.getAttribute('aria-label').includes('我方'));for(const p of own){p.click();const t=[...document.querySelectorAll('.cell.target')];if(t.length){(t.find(x=>x.querySelector('.enemy'))||t[0]).click();return true;}}return false;})()`);
   if(!moved)break;
   const combatEffect=await run("(()=>{const e=JSON.parse(localStorage.getItem('junqi-session-v2')).game.history.at(-1);return {result:e.result,className:document.querySelector('.battle-effect')?.className}})()");
   if(combatEffect.result!=='move'&&!combatEffect.className?.includes('battle-'+combatEffect.result))throw Error('Actual move did not show combat effect');
   await wait("document.querySelector('#status-title').textContent==='轮到你行棋'||document.querySelector('#phase-label').textContent==='战局结束'");
   if(await run("[...document.querySelectorAll('.piece.enemy')].some(x=>!['暗','军旗','工兵'].includes(x.textContent.trim()))"))throw Error('Hidden identity leak');
  }
  const timingsBeforeReload=await run("JSON.parse(localStorage.getItem('junqi-session-v2')).game.aiDecisions.map(d=>d.info.diagnostics)");
  const before=await run("JSON.parse(localStorage.getItem('junqi-session-v2')).game.ply");
  await win.webContents.reload();await new Promise(r=>setTimeout(r,400));
  await wait("document.querySelectorAll('.cell').length===62");
  const after=await run("JSON.parse(localStorage.getItem('junqi-session-v2')).game.ply");
  if(before!==after)throw Error('Session resume mismatch');
  require('node:assert/strict').deepEqual(await run("JSON.parse(localStorage.getItem('junqi-session-v2')).game.aiContext"),playingStyle,'Resuming must preserve the playing style');
  if(!await run("JSON.parse(localStorage.getItem('junqi-session-v2')).game.aiDecisions.every(d=>typeof d.info.diagnostics?.provenWin==='boolean'&&Number.isFinite(d.info.diagnostics.selectionGap))"))throw Error('Missing bounded decision diagnostics');
  const searchDecisions=await run("JSON.parse(localStorage.getItem('junqi-session-v2')).game.aiDecisions.map(d=>d.info.diagnostics)");
  require('node:assert/strict').deepEqual(searchDecisions,timingsBeforeReload,'Reload must preserve the actual worker phase timings');
  if(!searchDecisions.length||!searchDecisions.every(d=>d.timeLimitMs===5000&&d.completedDepth<=d.attemptedDepth&&d.elapsedMs>0&&d.elapsedMs<6500&&Number.isInteger(d.searchedNodes)))throw Error('Timed search diagnostics failed '+JSON.stringify(searchDecisions));
  if(!searchDecisions.every(d=>Number.isFinite(d.resignationCheckMs)&&d.resignationCheckMs>=0&&Number.isFinite(d.searchTimeLimitMs)&&d.searchTimeLimitMs>=0&&Math.abs(d.resignationCheckMs+d.searchTimeLimitMs-d.timeLimitMs)<0.02))throw Error('Worker phase timing was lost or changed during persistence '+JSON.stringify(searchDecisions));
  if(!searchDecisions.some(d=>d.completedDepth>=4&&d.searchedNodes>0))throw Error('Worker did not complete a substantive search');
  await fs.writeFile(path.join(__dirname,'qa-game.png'),(await win.webContents.capturePage()).toPNG());
  const finishedBefore = await run("!!JSON.parse(localStorage.getItem('junqi-session-v2')).game.result");
  if(!finishedBefore)await run("document.querySelector('#resign-btn').click();document.querySelector('#confirm-ok').click();");
  await wait("JSON.parse(localStorage.getItem('junqi-learning-v1'))?.games===1");
  const experienceBefore=await run("localStorage.getItem('junqi-learning-v1')");
  if(!await run("(()=>{const p=JSON.parse(localStorage.getItem('junqi-learning-v1'));return p.replayGames===1 && p.lastSummary.fullReview && p.lastSummary.movesReviewed>0})()"))throw Error('Full review learning missing decision features');
  if(!await run("!document.querySelector('#replay-btn').classList.contains('hidden')"))throw Error('Missing completed replay');
  await run("document.querySelector('#replay-btn').click();");
  if(!await run("document.querySelector('#phase-label').textContent==='明棋复盘' && document.querySelectorAll('.piece.enemy').length===25 && !document.querySelector('.piece.enemy.covered')"))throw Error('Replay initial full reveal failed');
  await run("document.querySelector('#replay-next').click();");
  if(!await run("document.querySelector('#replay-range').value==='1'"))throw Error('Replay next failed');
  await run("document.querySelector('#replay-last').click();");
  if(!await run("Number(document.querySelector('#replay-range').value)===JSON.parse(localStorage.getItem('junqi-session-v2')).game.ply"))throw Error('Replay final failed');
  await run("document.querySelector('#replay-first').click();document.querySelector('#replay-play').click();");
  await new Promise(r=>setTimeout(r,1150));
  if(!await run("Number(document.querySelector('#replay-range').value)>=1"))throw Error('Replay auto failed');
  await run("document.querySelector('#replay-play').click();");
  await fs.writeFile(path.join(__dirname,'qa-replay.png'),(await win.webContents.capturePage()).toPNG());
  if(experienceBefore!==await run("localStorage.getItem('junqi-learning-v1')"))throw Error('Viewing replay modified experience');
  await win.webContents.reload();await new Promise(r=>setTimeout(r,400));
  await wait("document.querySelectorAll('.cell').length===62");
  require('node:assert/strict').deepEqual(JSON.parse(await run("localStorage.getItem('junqi-learning-v1')")),JSON.parse(experienceBefore),'Repeated endgame learned twice or lost experience');
  require('node:assert/strict').deepEqual(await run("JSON.parse(localStorage.getItem('junqi-session-v2')).game.aiDecisions.map(d=>d.info.diagnostics)"),searchDecisions,'Completed replay and another reload must preserve decision timings');
  await forceHumanFirstTurn(win);
  await run("document.querySelector('#again-btn').click();document.querySelector('#start-btn').click();");
  if(!await run("document.querySelector('#learning-count').textContent.includes('1 局') && !document.querySelector('.piece.enemy:not(.covered)')"))throw Error('New game lost learning or leaked ranks');
  await run(`(()=>{for(const p of [...document.querySelectorAll('.cell')].filter(x=>x.getAttribute('aria-label').includes('我方'))){p.click();const target=document.querySelector('.cell.target');if(target){target.click();return;}}throw Error('No move to start cancellation check');})()`);
  await wait("document.querySelector('#status-title').textContent.includes('电脑')");
  await run("document.querySelector('#new-btn').click();document.querySelector('#confirm-ok').click();");
  if(!await run("JSON.parse(localStorage.getItem('junqi-session-v2')).game===null"))throw Error('Search blocked new-game controls');
  await new Promise(r=>setTimeout(r,5300));
  if(!await run("JSON.parse(localStorage.getItem('junqi-session-v2')).game===null && !document.querySelector('#message').textContent.includes('推演中断')"))throw Error('Cancelled worker altered the reset board');
  if(failures.length)throw Error(failures.join('\n'));
  const aiSha256=require('node:crypto').createHash('sha256').update(await fs.readFile(path.join(process.env.JUNQI_QA_ASAR||__dirname,'dist','ai.js'))).digest('hex');
  const beliefsSha256=require('node:crypto').createHash('sha256').update(await fs.readFile(path.join(process.env.JUNQI_QA_ASAR||__dirname,'dist','beliefs.js'))).digest('hex');
  const sourceHashes={};
  const distRoot=path.join(process.env.JUNQI_QA_ASAR||__dirname,'dist');
  async function hashModules(directory,prefix=''){
   for(const entry of (await fs.readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
    const relative=prefix+entry.name,filename=path.join(directory,entry.name);
    if(entry.isDirectory())await hashModules(filename,relative+'/');
    else if(entry.isFile()&&entry.name.endsWith('.js'))sourceHashes[relative]=require('node:crypto').createHash('sha256').update(await fs.readFile(filename)).digest('hex');
   }
  }
  await hashModules(distRoot);
  console.log(JSON.stringify({passed:true,packaged:!!process.env.JUNQI_QA_ASAR,packageBinding:packageAudit.finish(),sourceHashes,aiSha256,beliefsSha256,manualPlacement:true,invalidMineRejected:true,difficulty:'hell',humanTurns:turns,totalPlies:after,resume:true,playingStylePersists:true,decisionDiagnostics:true,diagnosticTimingPersists:true,searchDecisions,searchCancellation:true,enemyHidden:true,worker:true,twoDifficulties:true,completedReplay:true,replayNavigation:true,learningPersists:true,noDuplicateLearning:true,combatEffects:true,effectDurationMs:500,effectClippedToCell:true}));
  app.exit(0);
 }catch(e){console.error(e);app.exit(1);}
});
