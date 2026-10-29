import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, cpSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { scoreBatch, validatePlan, collectExclusions, verifyPart, runBatch } from '../benchmarks/self-play-batch.mjs';
import { parseArgs, runSelfPlay, sourceHashes } from '../benchmarks/self-play-v2.mjs';
import { legalMoves } from '../dist/engine.js';

const plan = { config: { games: 20, mode: 'acceptance', opponent: 'professional', paired: true,
  trainingReports: ['training.json'], seeds: Array.from({ length: 10 }, (_, i) => i + 1) },
  parts: Array.from({ length: 10 }, (_, i) => ({ seed: i + 1 })) };
function reports(outcomes) {
  return Array.from({ length: 10 }, (_, pair) => ({ completed: true, sourceUnchanged: true,
    protocol: { testOnly: false, seeds: [pair + 1] }, summary: { errors: 0 },
    games: outcomes.slice(pair * 2, pair * 2 + 2).map((winner, index) => ({ seed: pair + 1,
      challengerSide: index ? 'ai' : 'human', winner, status: 'finished', terminal: winner !== 'capped' })) }));
}
test('batch counts every planned game and requires more than nine wins per ten', () => {
  assert.equal(scoreBatch(plan, reports([...Array(19).fill('challenger'), 'opponent'])).passed, true);
  assert.equal(scoreBatch(plan, reports([...Array(18).fill('challenger'), 'opponent', 'opponent'])).passed, false);
  assert.equal(scoreBatch(plan, reports([...Array(19).fill('challenger'), 'draw'])).passed, true);
});
test('caps, missing pairs, source changes, errors and test policies cannot pass acceptance', () => {
  const capped = scoreBatch(plan, reports([...Array(19).fill('challenger'), 'capped']));
  assert.equal(capped.passed, false); assert.equal(capped.capped, 1); assert.equal(capped.winRate, .95);
  const allWins = reports(Array(20).fill('challenger'));
  assert.equal(scoreBatch(plan, allWins.slice(0, 9)).passed, false);
  for (const modify of [r => r[0].sourceUnchanged = false, r => r[0].summary.errors++, r => r[0].protocol.testOnly = true]) {
    const bad = structuredClone(allWins); modify(bad); assert.equal(scoreBatch(plan, bad).passed, false);
  }
  assert.equal(scoreBatch({ ...plan, config: { ...plan.config, mode: 'training' } }, allWins).passed, false);
  assert.equal(scoreBatch({ ...plan, config: { ...plan.config, trainingReports: [] } }, allWins).passed, false);
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function temporary(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'junqi-batch-test-'));
  t.after(() => {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
const partsFor = config => config.seeds.map((seed, index) => ({ seed,
  output: path.join(config.output.replace(/\.json$/i, '.parts'), `${index + 1}-${seed}.json`) }));

test('duplicate reports or repeated games cannot satisfy the complete seed plan', () => {
  const all = reports(Array(20).fill('challenger'));
  const repeated = Array(10).fill(all[0]);
  assert.equal(scoreBatch(plan, repeated).complete, false);
  assert.equal(scoreBatch(plan, repeated).passed, false);
  const missingColor = structuredClone(all);
  missingColor[0].games[1] = structuredClone(missingColor[0].games[0]);
  assert.equal(scoreBatch(plan, missingColor).coverageValid, false);
  assert.equal(scoreBatch(plan, missingColor).passed, false);
});

test('training exclusion snapshots include unfinished parallel plans and previously exposed acceptance seeds', t => {
  const directory = temporary(t), output = path.join(directory, 'training-batch.json');
  const config = { mode: 'training', paired: true, games: 4, seeds: [101, 102], output };
  const trainingPlan = { schema: 1, config, parts: partsFor(config) };
  const planFile = path.join(directory, 'training-batch.plan.json');
  writeFileSync(planFile, JSON.stringify(trainingPlan));
  // Only one part has started, but both planned seeds are excluded.
  writeFileSync(output, JSON.stringify({ schema: 1, plan: planFile, verified: false, parts: [trainingPlan.parts[0]] }));
  const oldAcceptance = path.join(directory, 'old-acceptance.json');
  writeFileSync(oldAcceptance, JSON.stringify({ schema: 1, completed: true,
    protocol: { mode: 'acceptance', games: 2, seeds: [103] } }));
  const oldComparison = path.join(directory, 'old-comparison.json');
  writeFileSync(oldComparison, JSON.stringify({ completed: true, protocol: { seeds: { professional: [104], hell: [105] } } }));
  const snapshot = collectExclusions([output, oldAcceptance, oldComparison], [201]);
  assert.deepEqual(snapshot.protocol.seeds, [101, 102, 103, 104, 105]);
  assert.equal(snapshot.purpose, 'seed-exclusion-snapshot-only-not-training-results');
  assert.ok(snapshot.sources.some(source => source.file === planFile && source.purpose === 'complete-batch-plan'));
  assert.ok(snapshot.sources.some(source => source.file === oldAcceptance && source.sourceMode === 'acceptance'));
  assert.equal(read(oldAcceptance).protocol.mode, 'acceptance', 'a seed exclusion must not relabel the original evaluation');
  assert.ok(snapshot.sources.every(source => source.sha256.length === 64));
  assert.throws(() => collectExclusions([output], [102]), /overlap/);
  const broken = structuredClone(trainingPlan); broken.parts[1] = broken.parts[0];
  assert.throws(() => validatePlan(broken), /unique frozen seed plan/);
});

async function shortPart(t) {
  const directory = temporary(t), source = path.join(directory, 'source');
  mkdirSync(source); writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
  cpSync(path.join(root, 'dist'), source, { recursive: true });
  const config = parseArgs(['--source-root', source, '--games', '2', '--seeds', '601001', '--max-plies', '1',
    '--output', path.join(directory, 'batch.json')]);
  const part = partsFor(config)[0];
  const policy = (observation, level) => {
    for (let from = 0; from < observation.board.length; from++) {
      if (observation.board[from]?.side !== observation.side) continue;
      const moves = legalMoves(observation.board, from);
      if (moves.length) return { from, to: moves[0], info: { searchDepth: 2, searchedNodes: 1,
        diagnostics: { completedDepth: 2, attemptedDepth: 2, elapsedMs: 1, timeLimitMs: level === 'hell' ? 5000 : 900 } } };
    }
  };
  const report = await runSelfPlay({ ...config, output: part.output }, { policy, signals: false });
  // This synthetic report only exercises the verifier. It never becomes a
  // delivered run, and its capped games cannot satisfy acceptance.
  report.protocol.testOnly = false;
  const batchPlan = { schema: 1, config, sourceHashes: report.sourceHashes, exclusions: [], parts: [part] };
  return { directory, source, config, part, report, plan: batchPlan };
}

test('raw record failures cannot be hidden by editing the summary and rehashing the record', async t => {
  const fixture = await shortPart(t);
  await verifyPart(fixture.plan, fixture.part, fixture.report);
  const item = fixture.report.games[0], recordPath = path.resolve(path.dirname(fixture.part.output), item.file);
  const record = read(recordPath);
  record.failures.push({ ply: 1, error: 'A policy failed before retry' });
  writeFileSync(recordPath, JSON.stringify(record)); item.recordSha256 = hash(readFileSync(recordPath));
  assert.equal(fixture.report.summary.errors, 0);
  await assert.rejects(verifyPart(fixture.plan, fixture.part, fixture.report), /summary disagrees with raw outcomes or policy failures/);
});

test('a report cannot turn a capped referee record into a win or replace a planned game identity', async t => {
  const fixture = await shortPart(t), bad = structuredClone(fixture.report);
  bad.games[0].winner = 'challenger'; bad.games[0].terminal = true;
  bad.summary.challengerWins = 1; bad.summary.capped = 1;
  await assert.rejects(verifyPart(fixture.plan, fixture.part, bad), /Report disagrees with replay/);
  const identity = structuredClone(fixture.report); identity.games[1].id = '00001';
  await assert.rejects(verifyPart(fixture.plan, fixture.part, identity), /Missing paired colors/);
  const reduced = structuredClone(fixture.report); reduced.protocol.budgets.professional = 1;
  await assert.rejects(verifyPart(fixture.plan, fixture.part, reduced), /Different protocol/);
  const foreign = structuredClone(fixture.report); foreign.sourceHashes['engine.js'] = '0'.repeat(64);
  await assert.rejects(verifyPart(fixture.plan, fixture.part, foreign), /Different source/);
  const engine = path.join(fixture.source, 'engine.js');
  writeFileSync(engine, readFileSync(engine, 'utf8') + '\n// Changed after the run\n');
  await assert.rejects(verifyPart(fixture.plan, fixture.part, fixture.report), /Validation source differs/);
});

test('resume rejects repeated part paths before launching children', async t => {
  const fixture = await shortPart(t);
  const config = { ...fixture.config, games: 4, seeds: [601001, 601002], resume: true,
    output: path.join(fixture.directory, 'resume.json') };
  const bad = { schema: 1, config: { ...config, resume: false }, sourceHashes: sourceHashes(config.sourceRoot), exclusions: [],
    parts: partsFor(config) };
  bad.parts[1] = bad.parts[0];
  writeFileSync(config.output.replace('.json', '.plan.json'), JSON.stringify(bad));
  await assert.rejects(runBatch(config, 1), /unique frozen seed plan/);
  assert.equal(existsSync(config.output), false);
});

test('the batch itself rejects real userData before creating a plan', async () => {
  if (!process.env.APPDATA) return;
  await assert.rejects(runBatch({ output: path.join(process.env.APPDATA, '军棋·暗战', 'batch-forbidden.json') }), /real game userData/);
});

test('parallel child runners consume the frozen exclusion snapshot and aggregation replays every capped record', async t => {
  const directory = temporary(t), source = path.join(directory, 'fixture-source');
  mkdirSync(source); writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
  for (const file of ['engine.js', 'formations.js', 'beliefs.js', 'ai-context.js'])
    copyFileSync(path.join(root, 'dist', file), path.join(source, file));
  // A source bundle dedicated to this process-plumbing test, never a playing
  // strength result. It still uses the real referee and redacted observation.
  writeFileSync(path.join(source, 'ai.js'), `import {legalMoves} from './engine.js';
export const DIFFICULTIES={hell:{timeLimitMs:5000},professional:{timeLimitMs:900}};
export function chooseMove(o,d,r,p,c){
 if(arguments.length!==5||o.initial||o.repetitions||p!==null)throw Error('Private state leaked');
 for(let from=0;from<o.board.length;from++)if(o.board[from]?.side===o.side){
  const moves=legalMoves(o.board,from);if(moves.length)return{from,to:moves[0],info:{searchDepth:0,searchedNodes:0,
   diagnostics:{completedDepth:0,attemptedDepth:0,elapsedMs:0,timeLimitMs:DIFFICULTIES[d].timeLimitMs}}};
 }
}`);
  const oldEvaluation = path.join(directory, 'previous-acceptance.json');
  writeFileSync(oldEvaluation, JSON.stringify({ schema: 1, completed: false, protocol: { mode: 'acceptance', seeds: [50] } }));
  const config = parseArgs(['--mode', 'training', '--source-root', source, '--games', '4', '--seeds', '61,62',
    '--max-plies', '1', '--training-reports', oldEvaluation, '--output', path.join(directory, 'batch.json')]);
  const report = await runBatch(config, 2);
  assert.equal(report.verified, true); assert.equal(report.summary.complete, true);
  assert.equal(report.summary.capped, 4); assert.equal(report.summary.terminal, 0); assert.equal(report.summary.passed, false);
  const manifest = read(config.output.replace('.json', '.plan.json'));
  const snapshot = read(manifest.exclusions[0].file);
  assert.deepEqual(snapshot.protocol.seeds, [50]); assert.equal(snapshot.sources[0].sourceMode, 'acceptance');
  for (const part of manifest.parts) {
    const child = read(part.output);
    assert.equal(child.protocol.trainingReports[0].file, manifest.exclusions[0].file);
    assert.equal(child.protocol.trainingReports[0].sha256, manifest.exclusions[0].sha256);
    assert.deepEqual(child.protocol.trainingReports[0].seeds, [50]);
    assert.equal(child.games.length, 2);
  }
  const resumed = await runBatch({ ...config, resume: true }, 2);
  assert.equal(resumed.verified, true); assert.equal(resumed.summary.capped, 4);
  assert.equal(resumed.summary.pending, 0, 'resuming must preserve the same four games, without duplication');
});
