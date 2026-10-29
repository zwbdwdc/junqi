import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { legalMoves } from '../dist/engine.js';
import { parseArgs, planGames, runSelfPlay, sourceHashes } from '../benchmarks/self-play-v2.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => JSON.parse(readFileSync(file, 'utf8'));
function isolated(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'junqi-self-play-test-'));
  t.after(() => {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    rmSync(directory, { recursive: true, force: true });
  });
  const source = path.join(directory, 'candidate-dist');
  mkdirSync(source);
  writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
  cpSync(path.join(root, 'dist'), source, { recursive: true });
  return { directory, source,
    config: parseArgs(['--source-root', source, '--games', '2', '--seeds', '301001', '--max-plies', '4',
      '--output', path.join(directory, 'run.json')]) };
}

function publicPolicy(observation, difficulty, rng, profile, context) {
  assert.equal(arguments.length, 5, 'no hidden sixth argument or reduced budget is supplied');
  assert.equal(profile, null);
  assert.ok(['hell', 'professional'].includes(difficulty));
  for (const key of ['initial', 'repetitions', 'gameId', 'aiDecisions', 'runtime', 'referee', 'trueBoard'])
    assert.equal(Object.hasOwn(observation, key), false, `${key} must stay in the referee process`);
  assert.ok(observation.board.every(piece => !piece || piece.side === observation.side || [null, 'engineer', 'flag'].includes(piece.type)));
  assert.ok(observation.enemyRoster.every(piece => !Object.hasOwn(piece, 'type')));
  assert.deepEqual(Object.keys(context).sort(), ['seed', 'style', 'wing']);
  assert.ok(Object.isFrozen(observation) && Object.isFrozen(observation.board) && Object.isFrozen(context));
  const moves = observation.board.flatMap((piece, from) => piece?.side === observation.side
    ? legalMoves(observation.board, from).map(to => ({ from, to })) : []);
  assert.ok(moves.length);
  const move = moves[Math.floor(rng() * moves.length)];
  return { ...move, info: { testPolicy: true, diagnostics: { completedDepth: 0 } } };
}

test('training and acceptance seed pools are distinct and paired plans swap first move', () => {
  const training = parseArgs([]), acceptance = parseArgs(['--mode', 'acceptance', '--expected-sha', 'a'.repeat(64)]);
  assert.equal(training.games, 4); assert.equal(acceptance.games, 20);
  assert.equal(acceptance.seeds.length, 10);
  assert.ok(acceptance.seeds.every(seed => !training.seeds.includes(seed)));
  const plan = planGames(training);
  assert.equal(plan.length, 4);
  assert.equal(plan[0].seed, plan[1].seed);
  assert.deepEqual(plan.slice(0, 2).map(game => game.challengerSide), ['human', 'ai']);
  assert.throws(() => parseArgs(['--games', '3']), /even/);
  assert.throws(() => parseArgs(['--games', '4', '--seeds', '12']), /Exactly 2/);
  assert.throws(() => parseArgs(['--mode', 'acceptance']), /expected-sha/);
  assert.equal(parseArgs(['--paired', 'false', '--games', '3', '--seed', '2']).seeds.length, 3);
});

test('isolated checkpoints preserve the referee while policies receive only public information', async t => {
  const { directory, config } = isolated(t);
  const report = await runSelfPlay(config, { policy: publicPolicy, signals: false });
  assert.equal(report.completed, true);
  assert.equal(report.sourceUnchanged, true);
  assert.equal(report.protocol.testOnly, true, 'injected short policies are explicitly non-production');
  assert.deepEqual(report.sourceHashes, sourceHashes(config.sourceRoot));
  assert.equal(report.summary.capped, 2);
  assert.equal(report.summary.challengerWins, 0);
  assert.equal(report.summary.terminal, 0);
  assert.equal(report.acceptance.passed, false);
  const first = read(path.join(directory, 'run.games', '00001.json'));
  const second = read(path.join(directory, 'run.games', '00002.json'));
  assert.equal(first.decisions.length, first.game.history.length);
  assert.equal(first.decisions.length, 4);
  assert.equal(first.game.initial.filter(Boolean).length, 50);
  assert.ok(first.game.initial.filter(Boolean).every(piece => piece.type));
  assert.equal(first.game.result, null);
  assert.deepEqual(first.contexts.human, second.contexts.ai);
  for (let at = 0; at < 30; at++) {
    assert.equal(first.game.initial[59 - at]?.type, second.game.initial[at]?.type,
      'challenger keeps its own exact formation when colors swap');
    assert.equal(first.game.initial[at]?.type, second.game.initial[59 - at]?.type,
      'opponent keeps its own exact formation when colors swap');
  }
  assert.equal(report.games[0].recordSha256.length, 64);
  assert.ok(first.decisions.every(row => row.observationSha256.length === 64 && Number.isFinite(row.elapsedMs)));
});

test('interrupted short games resume without replaying a decision or changing the fixed-seed moves', async t => {
  const { directory, config } = isolated(t);
  let calls = 0;
  const policy = (...args) => { calls++; return publicPolicy(...args); };
  const paused = await runSelfPlay(config, { policy, signals: false, stopAfterPlies: 2 });
  assert.equal(paused.interrupted, true); assert.equal(paused.completed, false);
  assert.equal(paused.games[0].plies, 2); assert.equal(calls, 2);
  const completed = await runSelfPlay({ ...config, resume: true }, { policy, signals: false });
  assert.equal(completed.completed, true); assert.equal(calls, 8);
  await runSelfPlay({ ...config, resume: true }, { policy, signals: false });
  assert.equal(calls, 8, 'resuming a finished run must not decide or count games again');
  const freshConfig = { ...config, output: path.join(directory, 'fresh.json') };
  await runSelfPlay(freshConfig, { policy: publicPolicy, signals: false });
  for (const id of ['00001', '00002']) {
    const resumed = read(path.join(directory, 'run.games', id + '.json'));
    const fresh = read(path.join(directory, 'fresh.games', id + '.json'));
    assert.deepEqual(resumed.game, fresh.game);
    const decisions = record => record.decisions.map(({ from, to, rngSeed, observationSha256 }) => ({ from, to, rngSeed, observationSha256 }));
    assert.deepEqual(decisions(resumed), decisions(fresh));
  }
});

test('resume rejects tampered referee state and changed frozen source hashes', async t => {
  const { directory, config } = isolated(t);
  await runSelfPlay(config, { policy: publicPolicy, signals: false, stopAfterPlies: 1 });
  const file = path.join(directory, 'run.games', '00001.json'), saved = readFileSync(file, 'utf8');
  const broken = JSON.parse(saved); broken.game.board.fill(null); writeFileSync(file, JSON.stringify(broken));
  await assert.rejects(runSelfPlay({ ...config, resume: true }, { policy: publicPolicy, signals: false }), /state mismatch/);
  writeFileSync(file, saved);
  const report = read(config.output); report.sourceHashes['ai.js'] = '0'.repeat(64); writeFileSync(config.output, JSON.stringify(report));
  await assert.rejects(runSelfPlay({ ...config, resume: true }, { policy: publicPolicy, signals: false }), /identical source hashes/);
});

test('acceptance refuses test policies and rejects any seed present in supplied training reports', async t => {
  const { directory, config, source } = isolated(t);
  await runSelfPlay(config, { policy: publicPolicy, signals: false });
  const acceptance = parseArgs(['--mode', 'acceptance', '--source-root', source, '--games', '2', '--seeds', '301001',
    '--training-reports', config.output, '--expected-sha', sourceHashes(source)['ai.js'], '--output', path.join(directory, 'acceptance.json')]);
  await assert.rejects(runSelfPlay(acceptance, { policy: publicPolicy, signals: false }), /Test policies/);
  await assert.rejects(runSelfPlay(acceptance, { signals: false }), /overlap/);
  assert.equal(existsSync(acceptance.output), false, 'rejected protocols must not start a game');
});

test('self-play cannot write into the real desktop game profile', async t => {
  const { config } = isolated(t);
  if (!process.env.APPDATA) return;
  const output = path.join(process.env.APPDATA, '军棋·暗战', 'self-play-must-not-exist.json');
  await assert.rejects(runSelfPlay({ ...config, output }, { policy: publicPolicy, signals: false }), /real game userData/);
});

test('v2 freezes every new and nested JavaScript dependency in stable path order', t => {
  const { source } = isolated(t);
  mkdirSync(path.join(source, 'tactics'));
  writeFileSync(path.join(source, 'extra-helper.js'), 'export const version=1;');
  writeFileSync(path.join(source, 'tactics', 'follow-up.js'), 'export const version=1;');
  const before = sourceHashes(source);
  assert.ok(before['extra-helper.js']); assert.ok(before['tactics/follow-up.js']);
  const paths = Object.keys(before).filter(key => key !== 'harness');
  assert.deepEqual(paths, paths.slice().sort());
  writeFileSync(path.join(source, 'tactics', 'follow-up.js'), 'export const version=2;');
  const after = sourceHashes(source);
  assert.notEqual(after['tactics/follow-up.js'], before['tactics/follow-up.js']);
  assert.equal(after['ai.js'], before['ai.js'], 'a changed helper must be detectable even when the AI entry is unchanged');
  writeFileSync(path.join(source, 'new-policy.js'), 'export const extra=true;');
  assert.ok(sourceHashes(source)['new-policy.js'], 'new files join the frozen bundle automatically');
});

test('changing an added dependency during play invalidates the run without losing its last saved move', async t => {
  const { source, config, directory } = isolated(t);
  const helper = path.join(source, 'extra-helper.js');
  writeFileSync(helper, 'export const version=1;');
  await assert.rejects(runSelfPlay(config, { policy: publicPolicy, signals: false, onProgress: row => {
    if (row.ply === 1) writeFileSync(helper, 'export const version=2;');
  } }), /Source changed during this run/);
  const report = read(config.output), record = read(path.join(directory, 'run.games', '00001.json'));
  assert.equal(report.sourceUnchanged, false); assert.equal(report.completed, false); assert.equal(report.acceptance.passed, false);
  assert.equal(record.game.ply, 1); assert.equal(record.decisions.length, 1);
});
