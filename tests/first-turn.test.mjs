import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomLayout, createGame, applyMove, legalMoves, makeObservation } from '../dist/engine.js';
import { buildReplay } from '../dist/replay.js';
import { publicRepetitions } from '../dist/ai.js';
import { createFlagDrawGuard } from '../dist/quiet-flag.js';
import { consolidateCompletedGames } from '../dist/learning-recovery.js';

const { createArchiveStore } = createRequire(import.meta.url)('../archive-store.cjs');
const other = side => side === 'ai' ? 'human' : 'ai';
const seeded = seed => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);

function newGame(firstTurn) {
  const rng = seeded(71109);
  return createGame(randomLayout('human', rng), randomLayout('ai', rng),
    { engineerMountains: true, firstTurn });
}

function quietMove(game, side = game.turn) {
  for (let from = 0; from < game.board.length; from++) {
    if (game.board[from]?.side !== side) continue;
    for (const to of legalMoves(game.board, from)) {
      if (game.board[to]) continue;
      const board = game.board.slice();
      board[to] = board[from];
      board[from] = null;
      if (legalMoves(board, to).includes(from)) return { from, to };
    }
  }
  throw new Error('Synthetic fixture needs a reversible quiet move');
}

function finish(firstTurn, count = 3) {
  let game = newGame(firstTurn);
  game.gameId = `synthetic-first-turn-${firstTurn}-${count}`;
  game.aiDecisions = [];
  for (let index = 0; index < count; index++) {
    const move = quietMove(game);
    game = applyMove(game, move.from, move.to);
    if (game.history.at(-1).side === 'ai') {
      game.aiDecisions.push({ ply: game.ply, ...move,
        info: { actionClass: 'develop', learningFeatures: { develop: 1 } } });
    }
  }
  game.result = { winner: 'human', reason: 'resign' };
  return game;
}

test('both starting sides initialize the referee, observation and repetition entry consistently', () => {
  for (const firstTurn of ['human', 'ai']) {
    const game = newGame(firstTurn);
    assert.equal(game.firstTurn, firstTurn);
    assert.equal(game.turn, firstTurn);
    assert.equal(game.ply, 0);
    assert.equal(Object.keys(game.repetitions).length, 1);
    assert.ok(Object.keys(game.repetitions)[0].startsWith(firstTurn + '|'));
    for (const side of ['human', 'ai']) {
      const observation = makeObservation(game, side);
      assert.equal(observation.firstTurn, firstTurn);
      assert.equal(observation.turn, firstTurn);
      assert.ok(observation.board.filter(piece => piece?.side === other(side)).every(piece => piece.type === null));
      assert.ok(!('initial' in observation) && !('repetitions' in observation));
    }
    const move = quietMove(game);
    const after = applyMove(game, move.from, move.to);
    assert.equal(after.history[0].side, firstTurn);
    assert.equal(after.firstTurn, firstTurn);
    assert.equal(after.turn, other(firstTurn));
  }
});

test('missing initial-side metadata retains legacy human-first behavior and invalid values are rejected', () => {
  const game = newGame();
  assert.equal(game.turn, 'human');
  delete game.firstTurn;
  const move = quietMove(game);
  const after = applyMove(game, move.from, move.to);
  assert.equal(after.turn, 'ai');
  assert.equal(makeObservation(after, 'ai').firstTurn, 'human');
  for (const invalid of [null, '', false, 0, 'computer', 'AI', {}]) {
    assert.throws(() => newGame(invalid), /先手/);
  }
});

test('AI-first and human-first completed games replay exactly, including zero-step resignations', () => {
  for (const firstTurn of ['human', 'ai']) {
    for (const count of [0, 1, 4]) {
      const game = finish(firstTurn, count);
      const before = JSON.stringify(game);
      const frames = buildReplay(game);
      assert.equal(frames.length, count + 1);
      assert.deepEqual(frames.at(-1).board, game.board);
      assert.deepEqual(frames.at(-1).result, game.result);
      assert.equal(JSON.stringify(game), before);
      assert.throws(() => buildReplay({ ...game, firstTurn: other(firstTurn) }), /不一致/);
      assert.throws(() => buildReplay({ ...game, firstTurn: null }), /先手/);
    }
  }
  const legacy = finish('human');
  delete legacy.firstTurn;
  assert.deepEqual(buildReplay(legacy).at(-1).board, legacy.board);
});

test('AI-first archives survive a restart and reject inconsistent or invalid initial-side metadata', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'junqi-first-turn-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = () => createArchiveStore({ directory, buildReplay, createGame, applyMove });
  for (const firstTurn of ['human', 'ai']) {
    for (const count of [0, 3]) {
      const game = finish(firstTurn, count);
      const saved = await store().save({ game, difficulty: 'hell' });
      assert.equal(saved.ok, true, saved.error);
      const loaded = await store().load(saved.id);
      assert.equal(loaded.ok, true, loaded.error);
      assert.deepEqual(loaded.record.game, game);
      for (const invalid of [other(firstTurn), null, 'invalid']) {
        const broken = { ...game, firstTurn: invalid };
        assert.equal((await store().save({ game: broken, difficulty: 'hell' })).ok, false);
      }
    }
  }
  const legacy = finish('human', 2);
  delete legacy.firstTurn;
  const saved = await store().save({ game: legacy, difficulty: 'professional' });
  const loaded = await store().load(saved.id);
  assert.equal(loaded.ok, true, loaded.error);
  assert.equal(Object.hasOwn(loaded.record.game, 'firstTurn'), false);
  assert.deepEqual(loaded.record.game, legacy);
});

test('AI-first repetition and proof guards count the initial position for the correct player', () => {
  for (const firstTurn of ['human', 'ai']) {
    let game = newGame(firstTurn);
    const first = quietMove(game);
    game = applyMove(game, first.from, first.to);
    const second = quietMove(game);
    game = applyMove(game, second.from, second.to);
    game = applyMove(game, first.to, first.from);
    game = applyMove(game, second.to, second.from);
    assert.equal(game.result, null);
    assert.equal(game.turn, firstTurn);
    const observation = makeObservation(game, 'ai');
    const counts = publicRepetitions(observation);
    const guard = createFlagDrawGuard(observation);
    assert.equal(counts.count(observation.board, firstTurn), 2);
    assert.equal(counts.possibleCount(observation.board, firstTurn), 2);
    assert.equal(counts.count(observation.board, other(firstTurn)), 0);
    assert.equal(guard.wouldDraw(observation.board, firstTurn), true);
    assert.equal(guard.wouldDraw(observation.board, other(firstTurn)), false);
    for (const [from, to] of [[first.from, first.to], [second.from, second.to], [first.to, first.from], [second.to, second.from]]) {
      game = applyMove(game, from, to);
    }
    assert.deepEqual(game.result, { winner: null, reason: 'repetition' });
  }
});

test('legacy observations use the human-first repetition origin', () => {
  const observation = makeObservation(newGame('human'), 'ai');
  delete observation.firstTurn;
  assert.equal(publicRepetitions(observation).count(observation.board, 'human'), 1);
  const guard = createFlagDrawGuard(observation);
  guard.withPosition(observation.board, 'human', () => {
    assert.equal(guard.wouldDraw(observation.board, 'human'), true);
  });
  assert.equal(guard.depth(), 0);
});

test('first-ply AI decisions participate in completed replay learning exactly once', () => {
  const game = finish('ai', 3);
  assert.deepEqual(game.aiDecisions.map(decision => decision.ply), [1, 3]);
  const record = { id: 'synthetic-ai-first-learning', schema: 1, difficulty: 'hell',
    finishedAt: '2026-11-09T00:00:00.000Z', game };
  const recovered = consolidateCompletedGames(null, [record]);
  assert.deepEqual(recovered.failed, []);
  assert.equal(recovered.learned, 1);
  assert.equal(recovered.profile.replayGames, 1);
  assert.equal(recovered.profile.lastSummary.movesReviewed, 2);
  const again = consolidateCompletedGames(recovered.profile, [record]);
  assert.equal(again.learned, 0);
  assert.deepEqual(again.profile, recovered.profile);
});
