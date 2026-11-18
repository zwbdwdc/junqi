// Native pointer/keyboard regression with the real renderer and isolated storage.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const Module=require('node:module');
const {randomUUID,createHash}=require('node:crypto');
const {app}=require('electron');
const appRoot=process.env.JUNQI_QA_ASAR||__dirname;
const audit=require('./qa-package-binding.cjs').beginPackageBinding();
const version=JSON.parse(fs.readFileSync(path.join(appRoot,'package.json'),'utf8')).version;
const baseline=process.env.JUNQI_DRAG_BASELINE==='1';
const output=process.env.JUNQI_DRAG_QA_OUTPUT||path.join(__dirname,'analysis/package-qa',version,
  process.env.JUNQI_QA_ASAR?'drag-cancel-packaged':'drag-cancel-source');
const directory=path.join(__dirname,'research','qa-drag-cancel-'+randomUUID());
fs.mkdirSync(output,{recursive:true});
exports.run=async({win})=>{
  const run=code=>win.webContents.executeJavaScript(code);
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const checks=[],errors=[];
  const waitUi=async code=>{
    for(let attempt=0;attempt<180;attempt++){if(await run(code))return;await delay(50);}
    throw Error('Drag cancellation QA timed out: '+code);
  };
  const point=selector=>run(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  let held=false;
  const mouse=async(type,p)=>{if(type==='mouseDown')held=true;if(type==='mouseUp')held=false;win.webContents.sendInputEvent({type,...p,button:'left',clickCount:1,modifiers:held?['leftButtonDown']:[]});await win.webContents.capturePage();await delay(75);};
  const click=async selector=>{const p=await point(selector);await mouse('mouseDown',p);await mouse('mouseUp',p);await delay(100);};
  const key=async keyCode=>{win.webContents.sendInputEvent({type:'keyDown',keyCode});win.webContents.sendInputEvent({type:'keyUp',keyCode});await delay(35);};
  const cell=i=>`.cell[data-index="${i}"]`;
  const session=()=>run("localStorage.getItem('junqi-session-v2')");
  const setupPair=()=>run(`(async()=>{const {canPlace}=await import('./engine.js');const b=JSON.parse(localStorage.getItem('junqi-session-v2')).setup;for(let a=30;a<60;a++)for(let z=30;z<60;z++)if(a!==z&&b[a]&&b[z]&&b[a].type!==b[z].type&&canPlace(b[a].type,'human',z)&&canPlace(b[z].type,'human',a))return[a,z];throw Error('No setup pair');})()`);
  const clearSelection=()=>run("document.querySelectorAll('.cell.selected,.reserve-piece.active').length===0");
  win.webContents.on('console-message',details=>{if(details.level==='error')errors.push(details.message);});
  try{
    await win.loadURL('junqi://game/index.html');
    await waitUi("document.querySelectorAll('.cell').length===62&&!document.body.inert");
    await run("window.__qaPointers=[];for(const type of ['pointerdown','pointermove','pointerup','click'])document.addEventListener(type,e=>window.__qaPointers.push({type,x:e.clientX,y:e.clientY,index:e.target.closest?.('.cell')?.dataset.index,button:e.button,buttons:e.buttons}),true)");
    assert.equal(app.getPath('userData'),directory);
    await click('#random-btn');
    const pair=await setupPair(),from=await point(cell(pair[0])),to=await point(cell(pair[1]));
    const before=await session();
    await mouse('mouseDown',from);await key('Escape');await delay(250);
    await mouse('mouseMove',to);await mouse('mouseUp',to);await delay(110);
    const after=await session();
    if(baseline){
      assert.notEqual(after,before,'3.0.6 must reproduce the canceled drag mutating the saved formation');
      const original=fs.readFileSync(path.join(appRoot,'dist/app.js'));
      fs.writeFileSync(path.join(output,'app.before.js'),original);
      fs.copyFileSync(__filename,path.join(output,'qa-drag-cancel.before.cjs'));
      fs.writeFileSync(path.join(output,'after.png'),(await win.webContents.capturePage()).toPNG());
      const report={reproduced:true,version,trigger:'pointerdown, Escape before drag activation, hold 250ms, move to legal target, release',pair,before:JSON.parse(before),after:JSON.parse(after),directory,packageBinding:audit.finish(),appSha256:createHash('sha256').update(original).digest('hex'),testSha256:createHash('sha256').update(fs.readFileSync(__filename)).digest('hex')};
      fs.writeFileSync(path.join(output,'reproduction.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({reproduced:true,version,pair}));app.exit(0);return;
    }
    assert.equal(after,before);assert.equal(await clearSelection(),true);
    checks.push({name:'Escape before activation survives a long hold and release without changing formation or selection',ok:true});

    const activeFrom=await point(cell(pair[0])),activeTo=await point(cell(pair[1]));
    await mouse('mouseMove',activeFrom);await mouse('mouseDown',activeFrom);await mouse('mouseMove',activeTo);
    assert.equal(await clearSelection(),false,JSON.stringify(await run('window.__qaPointers')));
    await key('Escape');await delay(250);await mouse('mouseMove',activeFrom);await mouse('mouseUp',activeFrom);await delay(110);
    assert.equal(await session(),before);assert.equal(await clearSelection(),true);
    checks.push({name:'Escape after activation clears the drag and its delayed release click',ok:true});

    await mouse('mouseMove',activeFrom);await mouse('mouseDown',activeFrom);await mouse('mouseMove',activeTo);
    await run("document.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true,pointerId:1,pointerType:'mouse'}))");
    await delay(250);assert.equal(await clearSelection(),true);
    // Queue a genuinely new click immediately after the canceled release, well
    // before its compatibility-click suppression timeout can expire.
    for(const [type,p] of [['mouseUp',activeTo],['mouseDown',activeFrom],['mouseUp',activeFrom]])
      win.webContents.sendInputEvent({type,...p,button:'left',clickCount:1});
    held=false;await waitUi(`document.querySelector(${JSON.stringify(cell(pair[0]))}).classList.contains('selected')`);
    await key('Escape');
    assert.equal(await session(),before);assert.equal(await clearSelection(),true);
    checks.push({name:'injected OS pointercancel clears board selection while an immediate new click remains usable',ok:true});

    await click('#clear-btn');
    const empty=await session(),reserveSelector='.reserve-piece[aria-label^="工兵"]',reservePoint=await point(reserveSelector),emptyPoint=await point(cell(30));
    for(const cancel of ['Escape','pointercancel']){
      await mouse('mouseDown',reservePoint);await mouse('mouseMove',emptyPoint);
      if(cancel==='Escape')await key('Escape');
      else await run("document.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true,pointerId:1,pointerType:'mouse'}))");
      await delay(250);await mouse('mouseUp',emptyPoint);await delay(110);
      assert.equal(await session(),empty);assert.equal(await clearSelection(),true);
      await click(cell(30));assert.equal(await session(),empty);assert.equal(await clearSelection(),true);
    }
    checks.push({name:'canceled reserve drags cannot place a piece on release or on a later empty-cell click',ok:true});

    await click('#random-btn');
    const normalPair=await setupPair(),normalBefore=JSON.parse(await session()).setup;
    const a=await point(cell(normalPair[0])),b=await point(cell(normalPair[1]));
    await mouse('mouseDown',a);await mouse('mouseMove',b);await mouse('mouseUp',b);await delay(110);
    const dragged=JSON.parse(await session()).setup;
    assert.equal(dragged[normalPair[1]].id,normalBefore[normalPair[0]].id);
    assert.equal(dragged[normalPair[0]].id,normalBefore[normalPair[1]].id);
    await click(cell(normalPair[0]));await click(cell(normalPair[1]));
    assert.deepEqual(JSON.parse(await session()).setup,normalBefore);
    checks.push({name:'normal board drag and ordinary click-to-swap still update and persist the formation',ok:true});

    await click('#clear-btn');
    const rp=await point(reserveSelector),target=await point(cell(30));
    await mouse('mouseDown',rp);await mouse('mouseMove',target);await mouse('mouseUp',target);await delay(110);
    assert.equal(JSON.parse(await session()).setup[30].type,'engineer');
    await key('Escape');await click(reserveSelector);await click(cell(31));
    assert.equal(JSON.parse(await session()).setup[31].type,'engineer');
    assert.equal(await run(`document.querySelector(${JSON.stringify(reserveSelector)}).querySelector('b').textContent`),'1');
    checks.push({name:'normal reserve drag and click placement remain available after cancellation and update counts',ok:true});

    await click('#random-btn');await require('./qa-randomness.cjs').forceHumanFirstTurn(win);await click('#start-btn');
    await waitUi("JSON.parse(localStorage.getItem('junqi-session-v2')).game?.turn==='human'");
    const move=await run(`(async()=>{const {legalMoves}=await import('./engine.js');const game=JSON.parse(localStorage.getItem('junqi-session-v2')).game;for(let from=0;from<62;from++)if(game.board[from]?.side==='human'){const to=legalMoves(game.board,from).find(i=>!game.board[i]);if(to!==undefined)return[from,to];}throw Error('No human quiet move');})()`);
    const gameBefore=await session(),m1=await point(cell(move[0])),m2=await point(cell(move[1]));
    for(const activated of [false,true]){
      await mouse('mouseDown',m1);if(activated)await mouse('mouseMove',m2);
      await key('Escape');await delay(250);await mouse('mouseMove',m2);await mouse('mouseUp',m2);await delay(110);
      assert.equal(await session(),gameBefore);assert.equal(await clearSelection(),true);
      assert.equal(JSON.parse(await session()).game.ply,0);
    }
    checks.push({name:'canceling a human-turn drag before or after activation preserves board, turn and ply without starting the AI',ok:true});
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(output,'canceled-game.png'),(await win.webContents.capturePage()).toPNG());
    const report={passed:true,checks,directory,packageBinding:audit.finish(),testSha256:createHash('sha256').update(fs.readFileSync(__filename)).digest('hex')};
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));app.exit(0);
  }catch(error){fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({passed:false,checks,error:error.stack},null,2));console.error(error.stack);app.exit(1);}
};
const source=fs.readFileSync(path.join(appRoot,'main.cjs'),'utf8')
  .replace("app.setPath('userData', path.join(app.getPath('appData'), '军棋·暗战'));",`app.setPath('userData',${JSON.stringify(directory)});`)
  .replace("win.once('ready-to-show', () => { win.show(); win.focus(); });",'')
  .replace("win.webContents.on('did-finish-load', () => { win.show(); });",'')
  .replace('sandbox: true, devTools:','sandbox: true, backgroundThrottling: false, devTools:')
  .replace("win.loadURL('junqi://game/index.html');",`require(${JSON.stringify(__filename)}).run({win});`);
assert.ok(source.includes(`app.setPath('userData',${JSON.stringify(directory)});`));
const compiled=new Module(path.join(appRoot,'main.cjs'),module);
compiled.filename=path.join(appRoot,'main.cjs');compiled.paths=Module._nodeModulePaths(appRoot);compiled._compile(source,compiled.filename);
