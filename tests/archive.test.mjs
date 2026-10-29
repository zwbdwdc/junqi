import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { randomLayout, createGame, applyMove, legalMoves } from '../dist/engine.js';
import { buildReplay } from '../dist/replay.js';

const require = createRequire(import.meta.url);
const { createArchiveStore, MAX_GAME_BYTES, MAX_ARCHIVED_GAMES } = require('../archive-store.cjs');

function finishedGame(id = 'test-game', turns = 6) {
  let game = createGame(randomLayout('human'), randomLayout('ai'), { engineerMountains: true });
  game.gameId = id;
  game.aiDecisions = [];
  for (let turn = 0; turn < turns && !game.result; turn++) {
    const from = game.board.findIndex((piece, index) => piece?.side === game.turn && legalMoves(game.board, index).length);
    game = applyMove(game, from, legalMoves(game.board, from)[0]);
  }
  game.result ||= { winner: 'ai', reason: 'resign' };
  return game;
}

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'junqi-archive-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const makeStore = () => createArchiveStore({ directory, buildReplay, createGame, applyMove, ...options });
  return { directory, store: makeStore(), makeStore };
}

test('complete games survive app restarts; lists contain only summaries, loaded replay is exact', async t => {
  const { store, makeStore } = await fixture(t);
  assert.deepEqual(await store.list(), { ok: true, games: [] });
  const game = finishedGame();
  const finishedAt = '2026-10-07T10:11:12.000Z';
  const saved = await store.save({ game, difficulty: 'hell', finishedAt });
  assert.equal(saved.ok, true);
  assert.match(saved.id, /^[a-f0-9]{64}$/);
  const restarted = makeStore();
  const listed = await restarted.list();
  assert.deepEqual(listed, { ok: true, games: [{ id: saved.id, finishedAt, difficulty: 'hell', ply: game.ply, result: game.result }] });
  assert.doesNotMatch(JSON.stringify(listed), /initial|board|attackerId|commander|bomb/);
  const loaded = await restarted.load(saved.id);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.record.schema, 1);
  assert.deepEqual(loaded.record.game, game);
  assert.deepEqual(buildReplay(loaded.record.game).at(-1).board, game.board);
  assert.deepEqual((await fs.readdir(store.directory)), [saved.id + '.json']);
});

test('game IDs are idempotent and concurrent queued saves never replace a prior record', async t => {
  const { store } = await fixture(t);
  const game = finishedGame('same-id');
  const first = store.save({ game, difficulty: 'professional', finishedAt: '2026-10-01T00:00:00.000Z' });
  const second = store.save({ game, difficulty: 'hell', finishedAt: '2026-10-07T00:00:00.000Z' });
  game.history[0].result = 'corrupt';
  await store.waitForIdle();
  const a = await first, b = await second;
  assert.equal(a.ok, true);
  assert.deepEqual(b, { ok: true, id: a.id, duplicate: true });
  const loaded = await store.load(a.id);
  assert.equal(loaded.record.difficulty, 'professional');
  assert.equal(loaded.record.finishedAt, '2026-10-01T00:00:00.000Z');
  assert.notEqual(loaded.record.game.history[0].result, 'corrupt');
  assert.equal((await store.list()).games.length, 1);
});

test('active games, corrupt history, forged terminal results and malformed formats are rejected', async t => {
  const { store } = await fixture(t);
  const game = finishedGame('validation');
  for (const broken of [
    { ...game, result: null },
    { ...game, ply: game.ply + 1 },
    { ...game, turn: game.turn === 'human' ? 'ai' : 'human' },
    { ...game, quiet: game.quiet + 1 },
    { ...game, result: { winner: 'human', reason: 'flag' } },
    { ...game, result: { winner: null, reason: 'resign' } },
    { ...game, gameId: '' },
    { ...game, initial: [] },
    { ...game, board: game.board.map((piece, index) => index === 0 ? { ...piece, type: 'unknown' } : piece) },
    { ...game, history: game.history.map((event, index) => index === 0 ? { ...event, result: event.result === 'both' ? 'win' : 'both' } : event) },
  ]) {
    assert.equal((await store.save({ game: broken, difficulty: 'hell' })).ok, false);
  }
  assert.equal((await store.save({ game, difficulty: 'beginner' })).ok, false);
  assert.equal((await store.save({ game, difficulty: 'hell', finishedAt: 'bad-date' })).ok, false);
  assert.equal((await store.save({ game, difficulty: 'hell', extra: 'x'.repeat(MAX_GAME_BYTES) })).ok, false);
  assert.deepEqual(await store.list(), { ok: true, games: [] });
});

test('only the latest 100 valid game files are retained; unrelated files and directories survive', async t => {
  const { store } = await fixture(t);
  assert.equal(MAX_ARCHIVED_GAMES, 100);
  await fs.mkdir(store.directory, { recursive: true });
  const sentinel = path.join(store.directory, 'notes.json');
  await fs.writeFile(sentinel, 'keep me');
  const fakeDirectory = path.join(store.directory, 'f'.repeat(64) + '.json');
  await fs.mkdir(fakeDirectory);
  const invalidFile = path.join(store.directory, 'e'.repeat(64) + '.json');
  await fs.writeFile(invalidFile, '{broken');
  const original = finishedGame('retained', 0);
  let firstId;
  for (let index = 0; index <= 100; index++) {
    const game = { ...original, gameId: 'retention-' + index };
    const saved = await store.save({ game, difficulty: 'professional', finishedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString() });
    assert.equal(saved.ok, true, saved.error);
    if (index === 0) firstId = saved.id;
  }
  const listed = await store.list();
  assert.equal(listed.games.length, 100);
  assert.equal(listed.games[0].finishedAt, '2026-01-01T01:40:00.000Z');
  assert.equal(listed.games.at(-1).finishedAt, '2026-01-01T00:01:00.000Z');
  assert.equal((await store.load(firstId)).ok, false);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'keep me');
  assert.equal((await fs.stat(fakeDirectory)).isDirectory(), true);
  assert.equal(await fs.readFile(invalidFile, 'utf8'), '{broken');
});

test('path traversal, foreign schema, oversized and damaged files cannot be loaded', async t => {
  const { directory, store } = await fixture(t);
  const sentinel = path.join(directory, 'outside.json');
  await fs.writeFile(sentinel, 'keep');
  for (const id of ['../outside', '..\\outside', '/tmp/record', '', null, 123, 'a'.repeat(65)]) {
    assert.equal((await store.load(id)).ok, false);
  }
  const saved = await store.save({ game: finishedGame('tamper'), difficulty: 'hell' });
  const file = path.join(store.directory, saved.id + '.json');
  const record = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, JSON.stringify({ ...record, schema: 99 }));
  assert.equal((await store.load(saved.id)).ok, false);
  assert.equal((await store.list()).games.length, 0);
  await fs.writeFile(file, 'x'.repeat(MAX_GAME_BYTES + 1));
  assert.match((await store.load(saved.id)).error, /大小/);
  await fs.writeFile(file, '{broken');
  assert.equal((await store.load(saved.id)).ok, false);
  // A broken file is not silently replaced on an idempotent save.
  assert.equal((await store.save({ game: record.game, difficulty: 'hell' })).ok, false);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'keep');
});

test('save failure leaves completed game and existing files untouched', async t => {
  const { directory } = await fixture(t);
  const blocked = path.join(directory, 'blocked');
  await fs.writeFile(blocked, 'keep');
  const store = createArchiveStore({ directory: blocked, buildReplay, createGame, applyMove });
  const game = finishedGame();
  const original = JSON.stringify(game);
  const result = await store.save({ game, difficulty: 'hell' });
  assert.equal(result.ok, false);
  assert.match(result.error, /保存失败/);
  assert.equal(JSON.stringify(game), original);
  assert.equal(await fs.readFile(blocked, 'utf8'), 'keep');
});
