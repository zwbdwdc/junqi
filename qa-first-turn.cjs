// Exercises the desktop entry point, real Worker, and isolated persistent stores.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { randomUUID, createHash } = require('node:crypto');
const { app } = require('electron');
const root = __dirname;
const appRoot = process.env.JUNQI_QA_ASAR || root;
const audit = require('./qa-package-binding.cjs').beginPackageBinding();
const version = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')).version;
const directory = path.join(root, 'research', 'qa-first-turn-' + randomUUID());
const output = process.env.JUNQI_FIRST_TURN_QA_OUTPUT || path.join(root, 'analysis/package-qa', version,
  process.env.JUNQI_QA_ASAR ? 'first-turn-packaged' : 'first-turn-source');
fs.mkdirSync(output, { recursive: true });

exports.run = async ({ win }) => {
  const run = code => win.webContents.executeJavaScript(code);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const checks = [], played = [], errors = [];
  const wait = async condition => {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (await run(condition)) return;
      await delay(100);
    }
    throw new Error('Timed out waiting for ' + condition);
  };
  const session = () => run("JSON.parse(localStorage.getItem('junqi-session-v2'))");
  const ready = () => wait("document.querySelectorAll('.cell').length === 62 && document.querySelector('#new-btn').disabled === false");
  const reload = async () => {
    await win.loadURL('junqi://game/index.html');
    await ready();
  };
  const forceDraw = byte => run(`(() => {
    window.__nativeRandom ||= crypto.getRandomValues.bind(crypto);
    window.__drawCalls = 0;
    crypto.getRandomValues = values => {
      if (values instanceof Uint8Array && values.length === 1) {
        window.__drawCalls++;
        values[0] = ${byte};
        return values;
      }
      return window.__nativeRandom(values);
    };
  })()`);
  const start = async byte => {
    await forceDraw(byte);
    return run(`(() => {
      document.querySelector('#start-btn').click();
      document.querySelector('#start-btn').click();
      return { session: JSON.parse(localStorage.getItem('junqi-session-v2')), draws: window.__drawCalls,
        log: document.querySelector('#battle-log').textContent, message: document.querySelector('#message').textContent };
    })()`);
  };
  const resign = () => run("document.querySelector('#resign-btn').click();document.querySelector('#confirm-ok').click()");
  const inspectCompleted = async (firstTurn, expectedGames) => {
    await wait(`JSON.parse(localStorage.getItem('junqi-learning-v1'))?.games === ${expectedGames}`);
    const saved = await session();
    assert.equal(saved.game.firstTurn, firstTurn);
    const archived = await run(`(async () => {
      const listing = await window.junqiArchive.list();
      for (const item of listing.games) {
        const loaded = await window.junqiArchive.load(item.id);
        if (loaded.record?.game.gameId === ${JSON.stringify(saved.game.gameId)}) return loaded;
      }
      return null;
    })()`);
    assert.equal(archived?.ok, true);
    assert.equal(archived.record.game.firstTurn, firstTurn);
    assert.deepEqual(archived.record.game.board, saved.game.board);
    assert.deepEqual(archived.record.game.history, saved.game.history);
    const replay = await run(`(async () => {
      const { buildReplay } = await import('./replay.js');
      const game = JSON.parse(localStorage.getItem('junqi-session-v2')).game;
      return buildReplay(game);
    })()`);
    assert.equal(replay.length, saved.game.ply + 1);
    assert.deepEqual(replay.at(-1).board, saved.game.board);
    const registered = await run(`(async () => {
      const { hasLearnedGame } = await import('./learning.js');
      const profile = JSON.parse(localStorage.getItem('junqi-learning-v1'));
      return hasLearnedGame(profile, ${JSON.stringify(saved.game.gameId)});
    })()`);
    assert.equal(registered, true);
    await run("document.querySelector('#replay-btn').click();document.querySelector('#replay-last').click()");
    assert.equal(await run("Number(document.querySelector('#replay-range').value)"), saved.game.ply);
    assert.equal(await run("document.querySelectorAll('.piece.enemy.covered').length"), 0);
    await reload();
    assert.equal((await session()).game.firstTurn, firstTurn);
    const profile = await run("JSON.parse(localStorage.getItem('junqi-learning-v1'))");
    assert.equal(profile.games, expectedGames);
    assert.equal(profile.replayGames, expectedGames);
    played.push({ gameId: saved.game.gameId, firstTurn, plies: saved.game.ply,
      decisionPlies: saved.game.aiDecisions.map(d => d.ply), learningGames: profile.games });
  };
  win.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
  try {
    await reload();
    const invalid = await run("document.querySelector('#clear-btn').click();document.querySelector('#start-btn').disabled");
    assert.equal(invalid, true);
    await forceDraw(0);
    await run("document.querySelector('#start-btn').click();document.querySelector('#random-btn').click()");
    assert.equal(await run('window.__drawCalls'), 0);
    checks.push({ name: 'incomplete deployment does not draw a first mover', ok: true });

    const humanStart = await start(0);
    assert.equal(humanStart.draws, 1);
    assert.equal(humanStart.session.game.firstTurn, 'human');
    assert.equal(humanStart.session.game.turn, 'human');
    assert.equal(humanStart.session.game.ply, 0);
    assert.ok(humanStart.log.includes('本局你先手'));
    await delay(1100);
    assert.equal((await session()).game.ply, 0);
    await reload();
    assert.equal((await session()).game.gameId, humanStart.session.game.gameId);
    assert.equal((await session()).game.firstTurn, 'human');
    await run(`(async () => {
      const { legalMoves } = await import('./engine.js');
      const game = JSON.parse(localStorage.getItem('junqi-session-v2')).game;
      const from = game.board.findIndex((p, i) => p?.side === 'human' && legalMoves(game.board, i).length);
      const to = legalMoves(game.board, from)[0];
      document.querySelector('[data-index="' + from + '"]').click();
      document.querySelector('[data-index="' + to + '"]').click();
    })()`);
    await wait("JSON.parse(localStorage.getItem('junqi-session-v2')).game.ply === 2");
    assert.deepEqual((await session()).game.history.map(e => e.side), ['human', 'ai']);
    checks.push({ name: 'human first is drawn once, restored, and followed by a real AI reply', ok: true });
    await resign();
    await inspectCompleted('human', 1);
    checks.push({ name: 'human-first game archives, replays, learns and reloads once', ok: true });

    await run("document.querySelector('#again-btn').click()");
    await run(`(() => {
      window.__workerInputs = [];
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        postMessage(data) { window.__workerInputs.push(structuredClone(data)); return super.postMessage(data); }
      };
    })()`);
    const aiStart = await start(255);
    assert.equal(aiStart.draws, 1);
    assert.equal(aiStart.session.game.firstTurn, 'ai');
    assert.equal(aiStart.session.game.turn, 'ai');
    assert.equal(aiStart.session.game.ply, 0);
    assert.ok(aiStart.log.includes('本局电脑先手'));
    await wait('window.__workerInputs.length === 1');
    const request = await run('window.__workerInputs[0]');
    assert.equal(request.observation.firstTurn, 'ai');
    assert.equal(request.observation.ply, 0);
    assert.equal(request.game, undefined);
    assert.equal(request.setup, undefined);
    assert.ok(request.observation.board.filter(p => p?.side === 'human').every(p => p.type === null));
    assert.equal((await session()).game.ply, 0);
    await reload();
    await wait("JSON.parse(localStorage.getItem('junqi-session-v2')).game.ply === 1");
    const aiMoved = (await session()).game;
    assert.equal(aiMoved.firstTurn, 'ai');
    assert.equal(aiMoved.gameId, aiStart.session.game.gameId);
    assert.equal(aiMoved.history[0].side, 'ai');
    assert.equal(aiMoved.aiDecisions[0].ply, 1);
    assert.equal(aiMoved.aiDecisions[0].info.diagnostics.timeLimitMs, 900);
    assert.ok(aiMoved.aiDecisions[0].info.diagnostics.searchedNodes > 0);
    assert.equal(aiMoved.turn, 'human');
    await delay(1100);
    assert.equal((await session()).game.ply, 1);
    await reload();
    assert.deepEqual((await session()).game.history, aiMoved.history);
    checks.push({ name: 'AI first immediately receives public observation and resumes its first move exactly once', ok: true });
    await resign();
    await inspectCompleted('ai', 2);
    checks.push({ name: 'AI decision at ply one survives archive, replay and deduplicated learning', ok: true });
    fs.writeFileSync(path.join(output, 'ai-first-finished.png'), (await win.webContents.capturePage()).toPNG());

    await run("document.querySelector('#again-btn').click()");
    await forceDraw(255);
    await run("document.querySelector('#start-btn').click();document.querySelector('#resign-btn').click();document.querySelector('#confirm-ok').click()");
    assert.equal((await session()).game.ply, 0);
    await inspectCompleted('ai', 3);
    checks.push({ name: 'resigning before the first AI move saves a zero-move AI-first replay', ok: true });

    await run("document.querySelector('#again-btn').click()");
    await start(255);
    await wait("document.querySelector('#status-title').textContent === '电脑思考中'");
    await run("document.querySelector('#new-btn').click();document.querySelector('#confirm-ok').click()");
    const replacement = await start(0);
    await delay(1300);
    assert.equal((await session()).game.gameId, replacement.session.game.gameId);
    assert.equal((await session()).game.ply, 0);
    assert.equal((await session()).game.firstTurn, 'human');
    checks.push({ name: 'a cancelled AI opening cannot apply to the replacement game', ok: true });

    // A historical record can legitimately omit firstTurn. Exercise the real
    // load/archive path using a generated human-first game with that field absent.
    await run("document.querySelector('#new-btn').click();document.querySelector('#confirm-ok').click()");
    const legacy = await run(`(async () => {
      const { createGame, randomLayout } = await import('./engine.js');
      const game = createGame(randomLayout('human'), randomLayout('ai'), { engineerMountains: true });
      game.gameId = 'legacy-first-' + crypto.randomUUID();
      game.startedAt = new Date().toISOString();game.result = { winner: 'ai', reason: 'resign' };
      game.aiDecisions = [];delete game.firstTurn;
      return { version: 1, setup: game.initial.slice(0, 60).map(p => p?.side === 'human' ? p : null),
        game, difficulty: 'professional', marks: {} };
    })()`);
    await win.loadURL('junqi://game/fixture.html');
    await run(`localStorage.setItem('junqi-session-v2', ${JSON.stringify(JSON.stringify(legacy))})`);
    await reload();
    await wait("JSON.parse(localStorage.getItem('junqi-learning-v1'))?.games === 4");
    await run("document.querySelector('#replay-btn').click()");
    assert.equal(await run("document.querySelector('#phase-label').textContent"), '明棋复盘');
    assert.equal(await run("Number(document.querySelector('#replay-range').value)"), 0);
    await reload();
    assert.equal((await session()).game.gameId, legacy.game.gameId);
    assert.equal(await run("JSON.parse(localStorage.getItem('junqi-learning-v1')).games"), 4);
    checks.push({ name: 'legacy human-first records without firstTurn restore, archive and review once', ok: true });
    assert.deepEqual(errors, []);
    const report = { passed: true, checks, played, directory, packageBinding: audit.finish(),
      testSha256: createHash('sha256').update(fs.readFileSync(__filename)).digest('hex') };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));app.exit(0);
  } catch (error) {
    fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ passed: false, checks, error: error.stack }, null, 2));
    console.error(error.stack);app.exit(1);
  }
};

const source = fs.readFileSync(path.join(appRoot, 'main.cjs'), 'utf8')
  .replace("app.setPath('userData', path.join(app.getPath('appData'), '军棋·暗战'));", `app.setPath('userData',${JSON.stringify(directory)});`)
  .replace("win.once('ready-to-show', () => { win.show(); win.focus(); });", '')
  .replace("win.webContents.on('did-finish-load', () => { win.show(); });", '')
  .replace('sandbox: true, devTools:', 'sandbox: true, backgroundThrottling: false, devTools:')
  .replace('const url = new URL(request.url);', `const url = new URL(request.url);if(url.hostname==='game'&&url.pathname==='/fixture.html')return new Response('<!doctype html><title>QA</title>',{headers:{'Content-Type':'text/html'}});`)
  .replace("win.loadURL('junqi://game/index.html');", `require(${JSON.stringify(__filename)}).run({win});`);
assert.ok(source.includes(`app.setPath('userData',${JSON.stringify(directory)});`));
const compiled = new Module(path.join(appRoot, 'main.cjs'), module);
compiled.filename = path.join(appRoot, 'main.cjs');
compiled.paths = Module._nodeModulePaths(appRoot);
compiled._compile(source, compiled.filename);
