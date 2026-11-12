const { forceHumanFirstTurn } = require('./qa-randomness.cjs');
/* Packaged UI/worker/IPC checks. All sessions and learning are isolated from the player. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { randomUUID } = require('node:crypto');
const { app } = require('electron');
const packageAudit = require('./qa-package-binding.cjs').beginPackageBinding();
const appRoot = process.env.JUNQI_QA_ASAR || __dirname;
const directory = path.join(__dirname, 'research', 'qa-features-data-' + randomUUID());
const reportPath = path.join(__dirname, 'research', 'features-qa-result.json');
const fixture = JSON.parse(syncFs.readFileSync(path.join(__dirname, 'tests', 'fixtures', 'ai-resignation-game.json'), 'utf8'));
const checks = [];
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function check(name, callback) { callback(); checks.push({ name, ok: true }); }

exports.run = async ({ win, archiveStore }) => {
  const run = code => win.webContents.executeJavaScript(code);
  const wait = async predicate => {
    for (let i = 0; i < 150; i++) {
      if (await run(predicate)) return;
      await delay(100);
    }
    throw Error('Timeout: ' + predicate);
  };
  const reload = async () => {
    await win.loadURL('junqi://game/index.html');
    await wait("document.querySelectorAll('.cell').length===62&&!document.body.inert");
  };
  const installSession = async data => {
    // Let the previous renderer persist before installing independent QA state.
    await win.loadURL('junqi://game/fixture.html');
    await run(`localStorage.setItem('junqi-session-v2',${JSON.stringify(JSON.stringify(data))})`);
    await reload();
  };
  const rightClick = index => run(`(()=>{const cell=document.querySelector('[data-index="${index}"]');const rect=cell.getBoundingClientRect();cell.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:rect.x+rect.width/2,clientY:rect.y+rect.height/2}));})()`);
  const session = () => run("JSON.parse(localStorage.getItem('junqi-session-v2'))");
  const badge = index => run(`document.querySelector('[data-index="${index}"] .piece-mark')?.textContent||null`);
  const screenshot = async name => {
    // Hidden Windows surfaces may retain the previous compositor frame until
    // capture activates the surface. Prime capture, repaint, then save it.
    await win.webContents.capturePage();
    win.webContents.invalidate();
    await delay(180);
    await fs.writeFile(path.join(__dirname, 'research', name), (await win.webContents.capturePage()).toPNG());
  };
  const errors = [];
  win.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
  try {
    await fs.mkdir(directory, { recursive: true });
    assert.ok(fixture.game, 'QA needs a legally replayed fixture game, not an invented board');
    await reload();
    check('isolated profile and real sandboxed preload', () => assert.equal(app.getPath('userData'), directory));
    assert.equal(await run("typeof window.junqiArchive?.save"), 'function');
    await forceHumanFirstTurn(win);
    await run("document.querySelector('#start-btn').click()");
    await wait("document.querySelector('#status-title').textContent==='轮到你行棋'");
    // Compute two legal quiet moves, then restore that position to test ID tracking
    // deterministically without relying on a particular AI move choice.
    const prepared = await run(`(async()=>{
      const e=await import('./engine.js');const data=JSON.parse(localStorage.getItem('junqi-session-v2'));
      const before=JSON.stringify(e.makeObservation(data.game,'ai'));
      for(let human=0;human<62;human++)if(data.game.board[human]?.side==='human'){
        for(const humanTo of e.legalMoves(data.game.board,human))if(!data.game.board[humanTo]){
          const first=e.applyMove(data.game,human,humanTo);
          for(let enemy=0;enemy<62;enemy++)if(first.board[enemy]?.side==='ai'){
            for(const enemyTo of e.legalMoves(first.board,enemy))if(!first.board[enemyTo]){
              const after=e.applyMove(first,enemy,enemyTo);
              if(!after.result&&!e.revealedEngineerIds(after).has(first.board[enemy].id))return {
                before, original:data, after, from:enemy,to:enemyTo,id:first.board[enemy].id,
                actual:first.board[enemy].type
              };
            }
          }
        }
      }
      throw Error('No deterministic quiet-move pair');
    })()`);
    const point = await run(`(()=>{const r=document.querySelector('[data-index="${prepared.from}"]').getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'right', clickCount: 1, ...point });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'right', clickCount: 1, ...point });
    await wait("!document.querySelector('#mark-menu').classList.contains('hidden')");
    check('right click offers all twelve guesses without exposing the enemy rank', () => {});
    assert.equal(await run("!document.querySelector('#mark-menu').classList.contains('hidden')&&document.querySelectorAll('#mark-menu [data-mark]').length===12"), true);
    assert.equal(await run(`document.querySelector('[data-index="${prepared.from}"] .piece').textContent.trim()`), '暗');
    await run("document.querySelector('[data-mark=general]').click()");
    assert.match(await badge(prepared.from), /军长/);
    const marked = await session();
    check('a guess is separate from referee state and AI public observation', () => {
      assert.equal(marked.marks[prepared.id], 'general');
      assert.deepEqual(marked.game, prepared.original.game);
      assert.equal(marked.game.marks, undefined);
    });
    assert.equal(await run("import('./engine.js').then(e=>JSON.stringify(e.makeObservation(JSON.parse(localStorage.getItem('junqi-session-v2')).game,'ai')))"), prepared.before);
    await rightClick(prepared.from);
    await run("document.querySelector('[data-mark=bomb]').click()");
    assert.match(await badge(prepared.from), /炸弹/);
    await screenshot('qa-features-badge-2.5.0.png');
    await rightClick(prepared.from);
    assert.equal(await run("document.querySelector('[data-mark=bomb]').getAttribute('aria-pressed')==='true'&&!document.querySelector('#clear-mark').disabled"), true);
    await screenshot('qa-features-2.5.0.png');
    await run("document.querySelector('#clear-mark').click()");
    check('a guess can be changed and cleared', () => {});
    assert.equal(await badge(prepared.from), null);
    await rightClick(prepared.from);
    await run("document.querySelector('[data-mark=regiment]').click()");
    await reload();
    assert.match(await badge(prepared.from), /团长/);
    check('annotations survive renderer restart', () => {});
    const movedSession = await session();
    movedSession.game = prepared.after;
    await installSession(movedSession);
    check('annotation follows the piece ID through two valid referee moves', () => {});
    assert.equal(await badge(prepared.from), null);
    assert.match(await badge(prepared.to), /团长/);
    await rightClick(prepared.to);
    await run("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    assert.equal(await run("document.querySelector('#mark-menu').classList.contains('hidden')"), true);
    await rightClick(prepared.to);
    await run("document.querySelector('#status-title').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))");
    assert.equal(await run("document.querySelector('#mark-menu').classList.contains('hidden')"), true);
    check('Escape and outside clicks dismiss the annotation popup', () => {});
    // A new game must never inherit guesses, even when reusing the formation.
    await run("document.querySelector('#new-btn').click();document.querySelector('#confirm-ok').click()");
    check('new game clears all personal annotations', () => assert.deepEqual(Object.keys(movedSession.marks), [prepared.id]));
    assert.deepEqual((await session()).marks, {});
    await forceHumanFirstTurn(win);
    await run("document.querySelector('#start-btn').click()");
    const humanGame = await session();
    const markedIndex = humanGame.game.board.findIndex(p => p?.side === 'ai');
    await rightClick(markedIndex);
    await run("document.querySelector('[data-mark=commander]').click();document.querySelector('#resign-btn').click();document.querySelector('#confirm-ok').click()");
    await wait("window.junqiArchive.list().then(x=>x.ok&&x.games.length===1)");
    await wait("JSON.parse(localStorage.getItem('junqi-learning-v1'))?.games===1");
    assert.deepEqual((await session()).game.result, { winner: 'ai', reason: 'resign' });
    await run("document.querySelector('#replay-btn').click();document.querySelector('#replay-last').click()");
    check('human resignation still archives, learns and reveals a note-free replay', () => {});
    assert.equal(await run("document.querySelector('#phase-label').textContent==='明棋复盘'&&!document.querySelector('.piece-mark')&&!document.querySelector('.piece.enemy.covered')&&document.querySelector('#status-help').textContent.includes('我方认输')"), true);
    const outcomes = [];
    // Real UI -> real worker -> real archive/learning for BOTH difficulties.
    for (const difficulty of ['professional', 'hell']) {
      const restored = { version: 1, setup: fixture.game.initial.slice(0, 60).map(p => p?.side === 'human' ? p : null),
        game: { ...fixture.game, gameId: randomUUID(), startedAt: new Date().toISOString(), aiDecisions: [] }, difficulty, marks: {} };
      const started = Date.now();
      await installSession(restored);
      await wait("JSON.parse(localStorage.getItem('junqi-session-v2'))?.game?.result?.reason==='resign'");
      const final = await session();
      check(`${difficulty}: the actual worker concedes the publicly forced loss without an extra move`, () => {
        assert.deepEqual(final.game.result, { winner: 'human', reason: 'resign' });
        assert.equal(final.game.ply, fixture.game.ply);
        assert.deepEqual(final.game.history, fixture.game.history);
        assert.deepEqual(final.game.board, fixture.game.board);
        assert.deepEqual(final.game.aiDecisions, []);
      });
      assert.match(await run("document.querySelector('#battle-log').textContent"), /电脑认输/);
      const expectedCount = outcomes.length + 2;
      await wait(`window.junqiArchive.list().then(x=>x.ok&&x.games.length===${expectedCount})`);
      await wait(`JSON.parse(localStorage.getItem('junqi-learning-v1'))?.games===${expectedCount}`);
      const listed = await run("window.junqiArchive.list()");
      const stored = await run(`window.junqiArchive.load(${JSON.stringify(listed.games[0].id)})`);
      assert.equal(stored.ok, true, stored.error);
      assert.equal(stored.record.game.gameId, restored.game.gameId);
      assert.deepEqual(stored.record.game.result, final.game.result);
      await run("document.querySelector('#replay-btn').click();document.querySelector('#replay-last').click()");
      assert.equal(await run("document.querySelector('#phase-label').textContent==='明棋复盘'&&!document.querySelector('.piece.enemy.covered')&&document.querySelector('#status-help').textContent.includes('电脑认输')"), true);
      assert.equal(Number(await run("document.querySelector('#replay-range').value")), fixture.game.ply);
      outcomes.push({ difficulty, winner: final.game.result.winner, ply: final.game.ply, elapsedMs: Date.now() - started });
    }
    const experience = await run("JSON.parse(localStorage.getItem('junqi-learning-v1'))");
    await reload();
    assert.equal((await run("window.junqiArchive.list()")).games.length, 3);
    assert.deepEqual(await run("JSON.parse(localStorage.getItem('junqi-learning-v1'))"), experience);
    check('AI resignation survives reload without duplicate archives or learning', () => {});
    await (await archiveStore()).waitForIdle();
    assert.equal((await fs.readdir(path.join(directory, 'games'))).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).length, 3);
    assert.deepEqual(errors, []);
    const report = { passed: true, checks, featureProof: { annotation: true, resignation: true },
      packageBinding: packageAudit.finish(), outcomes, directory,
      fixture: { source: fixture.source, legalReplay: true, publicWorkerOnly: true },
      annotationMoveFixture: 'Two legal quiet moves applied by the production referee for deterministic ID tracking.' };
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    app.exit(0);
  } catch (error) {
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify({ passed: false, checks, directory, error: error.stack }, null, 2));
    console.error(error.stack);
    app.exit(1);
  }
};

// Exercise the unchanged production renderer, worker and IPC; redirect only
// the profile directory, window visibility and QA entry point in the main process.
const original = syncFs.readFileSync(path.join(appRoot, 'main.cjs'), 'utf8');
const source = original
  .replace("app.setPath('userData', path.join(app.getPath('appData'), '军棋·暗战'));", `app.setPath('userData', ${JSON.stringify(directory)});`)
  .replace("win.once('ready-to-show', () => { win.show(); win.focus(); });", '')
  .replace("win.webContents.on('did-finish-load', () => { win.show(); });", '')
  .replace('sandbox: true, devTools:', 'sandbox: true, backgroundThrottling: false, devTools:')
  .replace('const url = new URL(request.url);', `const url = new URL(request.url);
    if(url.hostname==='game'&&url.pathname==='/fixture.html')return new Response('<!doctype html><title>QA fixture</title>',{headers:{'Content-Type':'text/html'}});`)
  .replace("win.loadURL('junqi://game/index.html');", `require(${JSON.stringify(__filename)}).run({win,archiveStore});`);
assert.ok(source.includes(`app.setPath('userData', ${JSON.stringify(directory)});`), 'isolated profile override must match');
assert.ok(source.includes('.run({win,archiveStore})'), 'QA entry point must match');
const compiled = new Module(path.join(appRoot, 'main.cjs'), module);
compiled.filename = path.join(appRoot, 'main.cjs');
compiled.paths = Module._nodeModulePaths(appRoot);
compiled._compile(source, compiled.filename);
