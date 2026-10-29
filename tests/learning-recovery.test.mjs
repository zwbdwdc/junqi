import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomLayout, createGame, applyMove, legalMoves, makeObservation } from '../dist/engine.js';
import { createLearningProfile, sanitizeProfile, learnFromGame, hasLearnedGame, LEARNING_VERSION } from '../dist/learning.js';
import { consolidateCompletedGames, excludeCompletedGames } from '../dist/learning-recovery.js';
const { createExperienceStore } = createRequire(import.meta.url)('../storage.cjs');
function seeded(seed) { return () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32); }
function episode(id, day = 1) {
  let game = createGame(randomLayout('human', seeded(day)), randomLayout('ai', seeded(day + 200)), { engineerMountains: true });
  game.gameId = id;
  for (let index = 0; index < 4 && !game.result; index++) {
    const from = game.board.findIndex((piece, at) => piece?.side === game.turn && legalMoves(game.board, at).length);
    game = applyMove(game, from, legalMoves(game.board, from)[0]);
  }
  game.result ||= { winner: 'human', reason: 'resign' };
  game.aiDecisions = game.history.filter(event => event.side === 'ai').map(event => ({
    ply: event.ply, from: event.from, to: event.to, info: { actionClass: 'develop', learningFeatures: { develop: 1 } },
  }));
  return { id: `synthetic-record-${id}`, schema: 1, difficulty: 'professional',
    finishedAt: `2026-10-${String(day).padStart(2, '0')}T00:00:00.000Z`, game };
}

test('missed completed records consolidate once in chronological order without erasing previous experience', () => {
  const records = [episode('synthetic-old', 1), episode('synthetic-new-a', 2), episode('synthetic-new-b', 3)];
  let base = createLearningProfile();
  base = learnFromGame(base, { gameId: records[0].game.gameId, observation: makeObservation(records[0].game, 'ai'),
    decisions: records[0].game.aiDecisions, completedGame: records[0].game });
  const before = JSON.stringify({ base, records });
  const recovered = consolidateCompletedGames(base, [records[2], records[0], records[1], records[2]]);
  assert.equal(recovered.profile.games, 3);
  assert.equal(recovered.profile.replayGames, 3);
  assert.equal(recovered.learned, 2);
  assert.equal(recovered.skipped, 2);
  assert.deepEqual(recovered.failed, []);
  assert.deepEqual(recovered.profile, consolidateCompletedGames(base, records).profile);
  const restart = consolidateCompletedGames(sanitizeProfile(JSON.stringify(recovered.profile)), records);
  assert.equal(restart.learned, 0);
  assert.equal(restart.skipped, 3);
  assert.deepEqual(restart.profile, recovered.profile);
  assert.equal(JSON.stringify({ base, records }), before);
  const serialized = JSON.stringify(recovered.profile);
  for (const record of records) {
    assert.equal(serialized.includes(record.game.gameId), false);
    for (const piece of record.game.initial.filter(Boolean)) assert.equal(serialized.includes(piece.id), false);
  }
});

test('active or broken archives do not expose active identities or stop valid later recovery', () => {
  const active = { game: { gameId: 'synthetic-active', result: null } };
  Object.defineProperty(active.game, 'initial', { get() { throw new Error('active initial board read'); } });
  const broken = episode('synthetic-broken', 2);
  broken.game.history[0].attackerId = 'wrong-record';
  const valid = episode('synthetic-valid', 3);
  const result = consolidateCompletedGames(null, [active, broken, valid]);
  assert.equal(result.learned, 1);
  assert.equal(result.profile.games, 1);
  assert.equal(result.failed.length, 2);
  assert.match(result.failed[0].error, /已结束/);
  assert.equal(hasLearnedGame(result.profile, 'synthetic-active'), false);
  assert.equal(hasLearnedGame(result.profile, 'synthetic-broken'), false);
  assert.equal(hasLearnedGame(result.profile, 'synthetic-valid'), true);
});

test('intentional backup restoration excludes retained archives without altering counts or weights', () => {
  const records = [episode('synthetic-existing-a', 1), episode('synthetic-existing-b', 2)];
  const backup = createLearningProfile();
  backup.games = 13; backup.replayGames = 12; backup.outcomes = { wins: 5, losses: 6, draws: 2 };
  backup.weights.attack = 1.07;
  const restored = excludeCompletedGames(backup, records);
  assert.equal(restored.excluded, 2);
  assert.deepEqual(restored.failed, []);
  assert.deepEqual(restored.profile.weights, backup.weights);
  assert.deepEqual(restored.profile.outcomes, backup.outcomes);
  assert.equal(restored.profile.games, 13);
  assert.equal(restored.profile.replayGames, 12);
  assert.deepEqual(consolidateCompletedGames(restored.profile, records).profile, restored.profile);
  const next = consolidateCompletedGames(restored.profile, [...records, episode('synthetic-future', 3)]);
  assert.equal(next.learned, 1);
  assert.equal(next.profile.games, 14);
});

test('legacy restored-game exclusions survive startup repair and do not consume a learning count', () => {
  const record = episode('synthetic-intentional-skip');
  record.game.skipRestoredExperience = true;
  const result = consolidateCompletedGames(null, [record]);
  assert.equal(result.learned, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.profile.games, 0);
  assert.equal(hasLearnedGame(result.profile, record.game.gameId), true);
});

test('a failed write can retry from the durable profile and a fresh process never learns it twice', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'junqi-recovery-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createExperienceStore({ directory, sanitizeProfile, version: LEARNING_VERSION });
  const initial = createLearningProfile();
  assert.equal((await store.save(initial)).ok, true);
  const records = [episode('synthetic-retry')];
  const uncommitted = consolidateCompletedGames((await store.load()).profile, records);
  assert.equal(uncommitted.learned, 1);
  // Simulate a renderer/process exit before committing its result: the durable
  // profile remains unchanged and the archive remains sufficient to recover.
  const retry = consolidateCompletedGames((await store.load()).profile, records);
  assert.deepEqual(retry.profile, uncommitted.profile);
  assert.equal((await store.save(retry.profile)).ok, true);
  const restarted = createExperienceStore({ directory, sanitizeProfile, version: LEARNING_VERSION });
  const final = consolidateCompletedGames((await restarted.load()).profile, records);
  assert.equal(final.learned, 0);
  assert.equal(final.profile.games, 1);
});
