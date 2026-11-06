/* Real Electron keyboard/mouse replay regression. Uses an isolated profile only.
 * Coverage: long replay focus and scroll, native control keys, playback at end,
 * repeated review entry, and preservation of the current finished game. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const {randomUUID,createHash}=require('node:crypto');
const {app}=require('electron');
const root=__dirname,appRoot=process.env.JUNQI_QA_ASAR||root;
const audit=require('./qa-package-binding.cjs').beginPackageBinding();
const reproduce=process.env.JUNQI_REPLAY_QA_REPRODUCE==='1';
const version=JSON.parse(fs.readFileSync(path.join(appRoot,'package.json'),'utf8')).version;
const directory=path.join(root,'research','qa-replay-controls-'+randomUUID());
const output=process.env.JUNQI_REPLAY_QA_OUTPUT||path.join(root,'analysis',reproduce?'maintenance-2026-11-06':'package-qa',...(reproduce?[]:[version,'replay-controls']));
fs.mkdirSync(output,{recursive:true});
exports.run=async({win})=>{
  const run=code=>win.webContents.executeJavaScript(code),delay=ms=>new Promise(r=>setTimeout(r,ms)),checks=[];
  const wait=async code=>{for(let i=0;i<150;i++){if(await run(code))return;await delay(100);}throw Error('Timeout '+code);};
  const click=async selector=>{
    const point=await run(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});element.scrollIntoView({block:'nearest'});const r=element.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    win.webContents.sendInputEvent({type:'mouseDown',...point,button:'left',clickCount:1});
    win.webContents.sendInputEvent({type:'mouseUp',...point,button:'left',clickCount:1});await delay(50);
  };
  const key=async(keyCode,modifiers=[])=>{win.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});win.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});await delay(50);};
  const step=()=>run("Number(document.querySelector('#replay-range').value)");
  const focus=selector=>run(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  const errors=[];win.webContents.on('console-message',details=>{if(details.level==='error')errors.push(details.message);});
  try{
    await win.loadURL('junqi://game/fixture.html');
    const original=JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/ai-resignation-game.json'),'utf8')).game;
    original.gameId='replay-controls-'+randomUUID();
    original.result||={winner:'human',reason:'resign'};
    const setup=original.initial.slice(0,60).map(p=>p?.side==='human'?p:null);
    await run(`localStorage.setItem('junqi-session-v2',${JSON.stringify(JSON.stringify({version:1,setup,game:original,difficulty:'hell',marks:{}}))})`);
    await win.loadURL('junqi://game/index.html');await wait("document.querySelector('#phase-label').textContent==='战局结束'");
    await wait("document.querySelector('#new-btn').disabled===false");
    win.webContents.focus();
    const saved=await run("localStorage.getItem('junqi-session-v2')");
    await click('#replay-btn');
    assert.equal(await run("document.querySelectorAll('#replay-log button').length"),original.ply+1);
    const target=35;
    await run(`window.__originalRows=[...document.querySelectorAll('#replay-log button')];document.querySelector('#replay-log').scrollTop=window.__originalRows[${target}].offsetTop`);
    await click(`#replay-log li:nth-child(${target+1}) button`);
    assert.equal(await step(),target);
    const rowState=await run(`({same:window.__originalRows.every((node,i)=>node===document.querySelectorAll('#replay-log button')[i]),focused:document.activeElement===document.querySelector('#replay-log li:nth-child(${target+1}) button')})`);
    await run("document.querySelector('#replay-log').scrollTop=0");
    const beforeScroll=await run("document.querySelector('#replay-log').scrollTop");
    await click('#replay-play');
    const afterScroll=await run("document.querySelector('#replay-log').scrollTop");
    await click('#replay-play');
    await focus('#replay-exit');await key('Space');
    const exited=await run("document.querySelector('#replay-panel').classList.contains('hidden')");
    if(reproduce){
      assert.equal(rowState.same,false);assert.equal(rowState.focused,false);assert.notEqual(afterScroll,beforeScroll);assert.equal(exited,false);
      const report={reproduced:true,rowState,beforeScroll,afterScroll,exited,problem:'Replay rendering destroys focused rows and resets scroll on playback toggles; global Space prevents native exit-button activation.',packageBinding:audit.finish()};
      fs.writeFileSync(path.join(output,'replay-controls-reproduction.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));app.exit(0);return;
    }
    assert.deepEqual(rowState,{same:true,focused:true});checks.push({name:'clicking a long replay retains its row nodes and keyboard focus',ok:true});
    assert.equal(afterScroll,beforeScroll);checks.push({name:'play and pause preserve manually scrolled history until the next step',ok:true});
    assert.equal(exited,true);checks.push({name:'Space activates the focused exit button instead of starting playback',ok:true});
    assert.equal(await run("localStorage.getItem('junqi-session-v2')"),saved);
    checks.push({name:'review and keyboard exit preserve the stored finished game',ok:true});
    await click('#replay-btn');assert.equal(await step(),0);
    await run("document.querySelector('#replay-range').value=35;document.querySelector('#replay-range').dispatchEvent(new Event('input',{bubbles:true}))");
    await focus('#replay-range');await key('Right');assert.equal(await step(),36);await key('Left');assert.equal(await step(),35);
    await key('Home');assert.equal(await step(),0);await key('End');assert.equal(await step(),original.ply);
    checks.push({name:'native slider arrows move exactly one step and Home/End reach replay bounds',ok:true});
    await click('#replay-first');await focus('#replay-play');await key('Space');
    assert.equal(await run("document.querySelector('#replay-play').textContent"),'暂停');
    await wait("Number(document.querySelector('#replay-range').value)>0");
    await key('Space');assert.equal(await run("document.querySelector('#replay-play').textContent"),'播放');
    const paused=await step();await delay(1100);assert.equal(await step(),paused);
    checks.push({name:'Space on the play button toggles once and pauses the real playback timer',ok:true});
    await run("document.activeElement.blur()");await key('Space');assert.equal(await run("document.querySelector('#replay-play').textContent"),'暂停');
    await key('Space');assert.equal(await run("document.querySelector('#replay-play').textContent"),'播放');
    await key('Right');assert.equal(await step(),paused+1);await key('Left');assert.equal(await step(),paused);
    checks.push({name:'background Space and arrow replay shortcuts remain available',ok:true});
    await click('#replay-last');await key('Left');assert.equal(await step(),original.ply-1);
    await click('#replay-play');await wait(`Number(document.querySelector('#replay-range').value)===${original.ply}`);
    assert.equal(await run("document.querySelector('#replay-play').textContent"),'播放');
    await click('#replay-play');assert.equal(await step(),0);await click('#replay-play');
    checks.push({name:'playback stops at the final board and restarts from the initial board',ok:true});
    await run("document.querySelector('#replay-range').value=35;document.querySelector('#replay-range').dispatchEvent(new Event('input',{bubbles:true}))");
    await click('#replay-log li:nth-child(36) button');await key('Right');
    assert.equal(await step(),36);assert.equal(await run("document.activeElement===document.querySelector('#replay-log li:nth-child(37) button')"),true);
    await key('Tab');assert.equal(await run("document.activeElement===document.querySelector('#replay-log li:nth-child(38) button')"),true);
    await key('Space');assert.equal(await step(),37);
    assert.equal(await run("document.querySelectorAll('#replay-log [aria-current=\"step\"]').length"),1);
    checks.push({name:'arrow review, Tab and Space continue through stable focused history entries',ok:true});
    await click('#rules-btn');await key('Right');assert.equal(await step(),37);
    await key('Escape');assert.equal(await run("document.querySelector('dialog[open]')===null"),true);
    checks.push({name:'open dialogs retain their keyboard behavior without changing replay',ok:true});
    for(const [width,height]of[[920,730],[1240,930]]){
      win.setContentSize(width,height);await delay(100);
      await focus('#replay-play');await key('Left');await key('Right');
      const currentVisible=await run("(()=>{const row=document.querySelector('#replay-log .current').getBoundingClientRect(),log=document.querySelector('#replay-log').getBoundingClientRect();return row.top>=log.top&&row.bottom<=log.bottom})()");
      assert.equal(currentVisible,true,'the selected replay row must be visible after stepping at '+width+'px');
      const fits=await run("(()=>{const r=document.querySelector('#replay-log').getBoundingClientRect();return document.documentElement.scrollHeight<=innerHeight+1&&r.height>100&&r.bottom<=innerHeight})()");
      assert.equal(fits,true);fs.writeFileSync(path.join(output,`replay-${width}.png`),(await win.webContents.capturePage()).toPNG());
    }
    checks.push({name:'replay and its long history remain within small and default desktop windows',ok:true});
    checks.push({name:'each replay step scrolls the current record into view at both desktop sizes',ok:true});
    assert.deepEqual(errors,[]);
    const report={passed:true,checks,fixturePlies:original.ply,directory,packageBinding:audit.finish(),testSha256:createHash('sha256').update(fs.readFileSync(__filename)).digest('hex')};
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));app.exit(0);
  }catch(error){fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({passed:false,checks,error:error.stack},null,2));console.error(error.stack);app.exit(1);}
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
