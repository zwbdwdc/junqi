const { forceHumanFirstTurn } = require('./qa-randomness.cjs');
/* Board geometry and hit targets in the actual renderer; isolated player data. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const {randomUUID,createHash}=require('node:crypto'),{app}=require('electron'),rawFs=require('original-fs');
const root=__dirname,appRoot=process.env.JUNQI_QA_ASAR||root,baseline=process.env.JUNQI_GEOMETRY_BASELINE==='1';
const label=process.env.JUNQI_GEOMETRY_LABEL||(baseline?'baseline':'candidate');assert.match(label,/^[a-z0-9.-]+$/);
const output=path.join(root,'analysis','maintenance-2026-10-23-ui-repair','geometry',label);fs.mkdirSync(output,{recursive:true});
const directory=path.join(root,'research','qa-board-geometry-'+randomUUID());
const audit=baseline?null:require('./qa-package-binding.cjs').beginPackageBinding();
const capturedSha=process.env.JUNQI_QA_ASAR?createHash('sha256').update(rawFs.readFileSync(appRoot)).digest('hex'):null;
const actualVersion=JSON.parse(fs.readFileSync(path.join(appRoot,'package.json'),'utf8')).version;
exports.run=async({win})=>{
 const run=s=>win.webContents.executeJavaScript(s).catch(e=>{throw Error(e.message+'\nScript: '+s.slice(0,300));}),delay=ms=>new Promise(r=>setTimeout(r,ms)),checks=[],layouts=[],dialogLayouts=[],viewportChecks=[];
 let currentScenario;
 const check=(name,ok,details)=>checks.push({name,ok:!!ok,...(details?{details}:{})});
 const wait=async s=>{for(let i=0;i<100;i++){if(await run(s))return;await delay(100);}throw Error('Timeout '+s);};
 const settleViewport=async stage=>{
  const [width,height,zoom]=currentScenario;
  const attempts=[];
  for(let attempt=0;attempt<4;attempt++){
   if(attempt){win.webContents.setZoomFactor(zoom);win.setContentSize(width,height);await delay(100);}
   const renderer=await run('({viewport:[innerWidth,innerHeight],devicePixelRatio})');
   const actual={...renderer,contentSize:win.getContentSize(),bounds:win.getBounds(),zoom:win.webContents.getZoomFactor()};
   attempts.push(actual);
   if(Math.abs(actual.zoom-zoom)<0.001&&Math.abs(actual.viewport[0]-width/zoom)<3&&Math.abs(actual.viewport[1]-height/zoom)<3){
    viewportChecks.push({caseName:width+'x'+height+'-z'+Math.round(zoom*100),stage,passed:true,attempts});return;
   }
  }
  viewportChecks.push({caseName:width+'x'+height+'-z'+Math.round(zoom*100),stage,passed:false,attempts});
  throw Error('Requested viewport did not settle: '+JSON.stringify(viewportChecks.at(-1)));
 };
 const capture=async name=>{await win.webContents.capturePage();win.webContents.invalidate();await delay(100);fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG());};
 const install=async(session)=>{await win.loadURL('junqi://game/fixture.html');await run(`localStorage.setItem('junqi-session-v2',${JSON.stringify(JSON.stringify(session))})`);await win.loadURL('junqi://game/index.html');await wait("document.querySelectorAll('.cell').length===62&&!document.body.inert");};
 const geometry=()=>run(`(()=>{
  const box=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
  const overlap=(a,b)=>({width:Math.min(a.right,b.right)-Math.max(a.left,b.left),height:Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)});
  const board=box(document.querySelector('#board')),pieces=[],mountains=[];
  for(const cell of document.querySelectorAll('.cell')){
   const index=Number(cell.dataset.index),piece=cell.querySelector('.piece');
   if(piece){const p=box(piece),text=box(piece.querySelector('span')),x=(p.left+p.right)/2,y=(p.top+p.bottom)/2;
    const edgeHits=[26,28,31,33].includes(index)?[p.top+2,p.bottom-2].map(y=>Number(document.elementFromPoint(x,y)?.closest('.cell')?.dataset.index??-1)):[];
    const cornerHits=[[p.left+2,p.top+2],[p.right-2,p.top+2],[p.left+2,p.bottom-2],[p.right-2,p.bottom-2]].map(([x,y])=>Number(document.elementFromPoint(x,y)?.closest('.cell')?.dataset.index??-1));
    pieces.push({index,box:p,text,hit:Number(document.elementFromPoint(x,y)?.closest('.cell')?.dataset.index??-1),edgeHits,cornerHits,mountain:cell.classList.contains('mountain'),selected:cell.classList.contains('selected')});}
   if(cell.classList.contains('mountain')){const c=box(cell),s=getComputedStyle(cell,'::before');
    const shadow=s.boxShadow==='none'||s.boxShadow.includes('inset')?0:4,w=parseFloat(s.width),h=parseFloat(s.height),visible=s.display!=='none'&&s.visibility!=='hidden';
    mountains.push({index,cell:c,occupied:!!piece,paint:visible?{left:(c.left+c.right-w)/2-shadow,right:(c.left+c.right+w)/2+shadow,top:(c.top+c.bottom-h)/2-shadow,bottom:(c.top+c.bottom+h)/2+shadow}:null,overlaps:[]});}
  }
  for(const m of mountains)if(m.paint)for(const p of pieces.filter(p=>!p.mountain)){const o=overlap(m.paint,p.box);if(o.width>0.5&&o.height>0.5)m.overlaps.push({index:p.index,...o});}
  const decorations=[...document.querySelectorAll('.river>b,.piece-mark')].map(element=>{const owner=Number(element.closest('.cell')?.dataset.index??-1),paint=box(element),overlaps=[];
   for(const p of pieces)if(p.index!==owner){const o=overlap(paint,p.box);if(o.width>0.5&&o.height>0.5)overlaps.push({index:p.index,...o});}
   const kind=element.classList.contains('piece-mark')?'mark':'frontline',ownPiece=pieces.find(p=>p.index===owner),range=document.createRange();range.selectNodeContents(element);
   const text=box(range),style=getComputedStyle(element),visible=style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)>0;
   const hitOwners=kind==='mark'?[[paint.left+1,paint.top+1],[paint.right-1,paint.top+1],[paint.left+1,paint.bottom-1],[paint.right-1,paint.bottom-1],[(paint.left+paint.right)/2,(paint.top+paint.bottom)/2]].map(([x,y])=>Number(document.elementFromPoint(x,y)?.closest('.cell')?.dataset.index??-1)):[];
   return {kind,owner,paint,text,visible,ownPiece:ownPiece?.box??null,ownCell:owner>=0?box(element.closest('.cell')):null,hitOwners,overlaps};});
  const pieceOverlaps=[];for(let a=0;a<pieces.length;a++)for(let b=a+1;b<pieces.length;b++){
   const o=overlap(pieces[a].box,pieces[b].box);if(o.width>0.1&&o.height>0.1)pieceOverlaps.push({a:pieces[a].index,b:pieces[b].index,...o});}
  return {viewport:[innerWidth,innerHeight],board,pieces,mountains,decorations,pieceOverlaps,page:[document.documentElement.scrollWidth,document.documentElement.scrollHeight]};
 })()`);
 const inspect=async(caseName,phase,{snapshot=false}={})=>{
  await settleViewport(phase);
  // Selection transforms take 140 ms: inspect settled geometry, not its first frame.
  await delay(180);
  const g=await geometry();layouts.push({caseName,phase,...g});
  check(caseName+' '+phase+' board proportion',Math.abs(g.board.width/g.board.height-500/665)<0.015);
  check(caseName+' '+phase+' no mountain/piece collision',g.mountains.every(m=>!m.overlaps.length));
  check(caseName+' '+phase+' no piece/piece collision',g.pieceOverlaps.length===0);
  check(caseName+' '+phase+' piece hit centres',g.pieces.every(p=>p.hit===p.index));
  check(caseName+' '+phase+' front rank edge hits',g.pieces.every(p=>p.edgeHits.every(hit=>hit===p.index)));
  check(caseName+' '+phase+' piece corner hits',g.pieces.every(p=>p.cornerHits.every(hit=>hit===p.index)));
  check(caseName+' '+phase+' frontline labels do not overlap pieces',g.decorations.filter(d=>d.kind==='frontline').every(d=>!d.overlaps.length));
  check(caseName+' '+phase+' marks do not cover another piece',g.decorations.filter(d=>d.kind==='mark').every(d=>!d.overlaps.length));
  const inside=(a,b)=>!!b&&a.left>=b.left-0.5&&a.right<=b.right+0.5&&a.top>=b.top-0.5&&a.bottom<=b.bottom+0.5;
  // The transparent label container belongs to its cell; only painted text must fit the token.
  check(caseName+' '+phase+' mark container fits cell and visible text fits own piece',g.decorations.filter(d=>d.kind==='mark').every(d=>d.visible&&d.text.width>0&&d.text.height>0&&inside(d.paint,d.ownCell)&&inside(d.text,d.ownPiece)&&d.hitOwners.every(hit=>hit===d.owner)));
  check(caseName+' '+phase+' labels fit pieces',g.pieces.every(p=>p.text.left>=p.box.left-0.5&&p.text.right<=p.box.right+0.5&&p.text.top>=p.box.top-0.5&&p.text.bottom<=p.box.bottom+0.5));
  check(caseName+' '+phase+' normal token proportion',g.pieces.filter(p=>!p.mountain).every(p=>p.box.width/p.box.height>=1.65&&p.box.width/p.box.height<=2.5));
  check(caseName+' '+phase+' board visible',g.board.left>=0&&g.board.right<=g.viewport[0]+1&&g.board.top>=0&&g.board.bottom<=g.viewport[1]+1);
  if(snapshot)await capture(caseName+'-'+phase);
  return g;
 };
 const popup=async(caseName,id)=>{
  await settleViewport(id+' dialog');
  await run(`document.querySelector('#${id}-btn').click()`);await wait(`document.querySelector('#${id}-dialog').open`);
  const geometry=await run(`(()=>{const d=document.querySelector('#${id}-dialog'),r=d.getBoundingClientRect(),buttons=[...d.querySelectorAll('button[data-close]')].map(b=>{const x=b.getBoundingClientRect();return {bottom:x.bottom,top:x.top,left:x.left,right:x.right};});return {viewport:[innerWidth,innerHeight],rect:{left:r.left,right:r.right,top:r.top,bottom:r.bottom},buttons};})()`);
  dialogLayouts.push({caseName,id,...geometry});const r=geometry.rect,[w,h]=geometry.viewport;
  check(caseName+' '+id+' dialog in viewport',r.left>=0&&r.right<=w+1&&r.top>=0&&r.bottom<=h+1&&geometry.buttons.every(b=>b.top>=0&&b.bottom<=h+1));
  await run(`document.querySelector('#${id}-dialog').close()`);
 };
 let failure=null;
 try{
  await win.loadURL('junqi://game/index.html');await wait("document.querySelectorAll('.cell').length===62&&!document.body.inert");
  const fixtures=await run(`(async()=>{
   const e=await import('./engine.js');let seed=923417;const rng=()=>((seed=Math.imul(seed,1664525)+1013904223>>>0)/4294967296);
   const human=e.randomLayout('human',rng),enemy=e.randomLayout('ai',rng);
   for(const [layout,to] of [[human,30],[enemy,27]]){const from=layout.findIndex(p=>p?.type==='engineer');[layout[from],layout[to]]=[layout[to],layout[from]];}
   if(e.validateLayout(human,'human').length||e.validateLayout(enemy,'ai').length)throw Error('bad fixture layout');
   const initial=e.createGame(human,enemy,{engineerMountains:true});initial.gameId='geometry-'+crypto.randomUUID();initial.startedAt=new Date().toISOString();
   const occupied=e.applyMove(e.applyMove(initial,30,60),27,61);
   if(occupied.turn!=='human'||!occupied.board[60]||!occupied.board[61])throw Error('mountain fixture was not legal');
   return {human,initial,occupied};
  })()`);
  const scenarios=[[920,730,1],[1240,930,1],[1440,900,1],[1440,730,1],[1920,730,1],[2560,1080,1],[1240,930,.9],[1240,930,1.1],[1240,930,1.25],[920,730,1.25]];
  for(const [width,height,zoom] of scenarios){
   currentScenario=[width,height,zoom];
   const caseName=width+'x'+height+'-z'+Math.round(zoom*100),snapshot=(width===1920||zoom===1.25||width===1240&&zoom===1);
   win.setContentSize(width,height);win.webContents.setZoomFactor(zoom);await delay(100);
   await settleViewport('scenario start');
   const session=game=>({version:1,setup:fixtures.human,game:game?{...game,gameId:'geometry-'+randomUUID()}:null,difficulty:'professional',marks:{}});
   await install(session(null));await inspect(caseName,'setup',{snapshot});
   for(const id of ['rules','settings','history'])await popup(caseName,id);
   const start=await run("(()=>{const b=document.querySelector('#start-btn');b.scrollIntoView({block:'nearest'});const r=b.getBoundingClientRect(),x=(r.left+r.right)/2,y=(r.top+r.bottom)/2;return {x,y,hit:document.elementFromPoint(x,y)?.id,visible:r.top>=0&&r.bottom<=innerHeight};})()");
   check(caseName+' start reachable after setup scroll',start.visible&&start.hit==='start-btn');
   if(start.visible&&start.hit==='start-btn'){
    await forceHumanFirstTurn(win);
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:Math.round(start.x*zoom),y:Math.round(start.y*zoom)});
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:Math.round(start.x*zoom),y:Math.round(start.y*zoom)});
    await wait("document.querySelector('#status-title').textContent==='轮到你行棋'");
   }
   await install(session(fixtures.initial));await run("document.querySelector('[data-index=\"30\"]').click()");
   check(caseName+' empty mountain legal target',await run("document.querySelector('[data-index=\"60\"]').classList.contains('target')"));
   await inspect(caseName,'mountain-target',{snapshot});
   await install(session(fixtures.occupied));await run("document.querySelector('[data-index=\"60\"]').click()");
   const g=await inspect(caseName,'mountain-occupied',{snapshot});check(caseName+' both mountains occupied',g.mountains.every(m=>m.occupied));
   check(caseName+' occupied mountain selectable',await run("document.querySelector('[data-index=\"60\"]').classList.contains('selected')"));
   await run("(()=>{const c=document.querySelector('[data-index=\"26\"]'),r=c.getBoundingClientRect();c.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:r.right,clientY:r.bottom}));})()");
   const menu=await run("(()=>{const e=document.querySelector('#mark-menu'),r=e.getBoundingClientRect();return {hidden:e.classList.contains('hidden'),left:r.left,right:r.right,top:r.top,bottom:r.bottom,w:innerWidth,h:innerHeight};})()");
   check(caseName+' mark menu visible',!menu.hidden&&menu.left>=0&&menu.right<=menu.w+1&&menu.top>=0&&menu.bottom<=menu.h+1);
   if(snapshot)await capture(caseName+'-mark-menu');
   await run("document.querySelector('#mark-options [data-mark=general]').click()");check(caseName+' marked dark piece',await run("document.querySelector('[data-index=\"26\"] .piece-mark')?.textContent==='军长？'"));
   await inspect(caseName,'marked',{snapshot});
   for(const id of ['rules','settings'])await popup(caseName,id);
   await run("document.querySelector('#resign-btn').click();document.querySelector('#confirm-ok').click()");await wait("!document.querySelector('#replay-btn').classList.contains('hidden')");
   await popup(caseName,'history');
   await run("document.querySelector('#replay-btn').click();document.querySelector('#replay-last').click()");await wait("!document.querySelector('#replay-panel').classList.contains('hidden')");
   await inspect(caseName,'replay',{snapshot});
   const replay=await run("(()=>{const b=document.querySelector('#replay-panel').getBoundingClientRect();return {bottom:b.bottom,height:innerHeight,hidden:document.querySelectorAll('.piece.covered').length};})()");
   check(caseName+' replay controls and revealed board',replay.bottom<=replay.height+1&&replay.hidden===0);
  }
 }catch(error){failure=error.stack;checks.push({name:'harness completed all scenarios',ok:false,details:failure});}
 const passed=checks.length>0&&checks.every(c=>c.ok),report={schema:1,passed,baseline,actualVersion,checks,layouts,dialogLayouts,viewportChecks,
  geometryProof:{proportionalBoard:passed,noMountainOverlap:passed,frontRankHitTargets:passed,mountainOccupancy:passed,selectionAndTargets:passed,marks:passed,dialogs:passed,replay:passed,zoomChecked:passed,pieceTextFits:passed},
  packageBinding:audit?.finish()||{packaged:!!process.env.JUNQI_QA_ASAR,baselineOnly:baseline,asarPath:appRoot,asarSha256:capturedSha},failure};
 fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({passed,checks:checks.length,failed:checks.filter(c=>!c.ok),layouts:layouts.length,reportPath:path.join(output,'report.json'),packageBinding:report.packageBinding}));app.exit(passed?0:1);
};
const source=fs.readFileSync(path.join(appRoot,'main.cjs'),'utf8')
 .replace("app.setPath('userData', path.join(app.getPath('appData'), '军棋·暗战'));",`app.setPath('userData',${JSON.stringify(directory)});`)
 .replace("win.once('ready-to-show', () => { win.show(); win.focus(); });",'')
 .replace("win.webContents.on('did-finish-load', () => { win.show(); });",'')
 .replace('sandbox: true, devTools:','sandbox: true, backgroundThrottling: false, devTools:')
 .replace('const url = new URL(request.url);',`const url = new URL(request.url);if(url.hostname==='game'&&url.pathname==='/fixture.html')return new Response('<!doctype html><title>QA</title>',{headers:{'Content-Type':'text/html'}});`)
 .replace("win.loadURL('junqi://game/index.html');",`require(${JSON.stringify(__filename)}).run({win});`);
assert.ok(source.includes(`app.setPath('userData',${JSON.stringify(directory)});`));
const compiled=new Module(path.join(appRoot,'main.cjs'),module);compiled.filename=path.join(appRoot,'main.cjs');compiled.paths=Module._nodeModulePaths(appRoot);compiled._compile(source,compiled.filename);
