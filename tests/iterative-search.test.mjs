import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseMove, tacticalSearch, publicDanger } from '../dist/ai.js';
import { createGame, randomLayout, makeObservation, legalMoves, combat } from '../dist/engine.js';

function seeded(seed) { return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }; }
function opening() {
  const rng = seeded(871);
  return makeObservation(createGame(randomLayout('human', rng), randomLayout('ai', rng)), 'ai');
}
const stable = { clock: () => 0 };
const decision = move => ({ from: move.from, to: move.to, score: move.info.expectedScore });
function boardOf(entries) {
  const board = Array(62).fill(null);
  for (const [at, side, type] of entries) board[at] = { id: `${side}-${at}`, side, type, origin: at, moved: type !== 'flag' };
  return board;
}

test('an interrupted iteration cannot replace any result from the last fully compared layer', () => {
  const observation = opening();
  const complete = chooseMove(observation, 'hell', seeded(12), null, null, { ...stable, maxDepth: 2 });
  const limit = complete.info.searchedNodes + 7000;
  const interrupted = chooseMove(observation, 'hell', seeded(12), null, null, { ...stable, nodeLimit: limit });
  assert.equal(complete.info.searchDepth, 2);
  assert.equal(interrupted.info.searchDepth, 2);
  assert.equal(interrupted.info.diagnostics.attemptedDepth, 4);
  assert.equal(interrupted.info.diagnostics.searchAborted, true);
  assert.equal(interrupted.info.diagnostics.budgetReason, 'nodes');
  assert.equal(interrupted.info.searchedNodes, limit);
  assert.deepEqual(decision(interrupted), decision(complete), 'partly updated candidates must never leak into selection');
});

test('the deadline includes public inference and candidate preparation, with a legal fallback at zero search budget', () => {
  let elapsed = 0;
  const observation = opening();
  const move = chooseMove(observation, 'hell', seeded(4), null, null, { timeLimitMs: 10, clock: () => elapsed++ * 11 });
  assert.equal(move.info.searchDepth, 0);
  assert.equal(move.info.searchedNodes, 0);
  assert.equal(move.info.diagnostics.budgetReason, 'time');
  assert.ok(legalMoves(observation.board, move.from).includes(move.to));
});

test('a public immediate win survives a zero node budget and is never delayed by a deeper iteration', () => {
  const observation = opening(), own = observation.board.find(p => p?.side === 'ai' && p.type === 'engineer');
  const enemyFlag = observation.board.find(p => p?.side === 'human' && p.origin === 58);
  observation.board.fill(null);
  observation.board[53] = own;
  observation.board[58] = { ...enemyFlag, type: 'flag' };
  const move = chooseMove(observation, 'hell', seeded(81), null, null, { ...stable, nodeLimit: 0 });
  assert.deepEqual([move.from, move.to], [53, 58]);
  assert.equal(move.info.diagnostics.provenWin, true);
  assert.equal(move.info.searchDepth, 0);
  assert.equal(move.info.searchedNodes, 0);
});

test('leaf capture extension sees the recapture behind apparently free material', () => {
  const board = boardOf([[1, 'ai', 'flag'], [25, 'ai', 'general'], [56, 'human', 'flag'],
    [26, 'human', 'platoon'], [27, 'human', 'commander']]);
  assert.ok(legalMoves(board, 25).includes(26));
  assert.equal(combat('general', 'platoon'), 'win');
  const after = board.slice(); after[26] = after[25]; after[25] = null;
  assert.ok(legalMoves(after, 27).includes(26));
  assert.equal(combat('commander', 'general'), 'win');
  const naive = tacticalSearch(board, 'ai', 1, { beam: 5 }, { nodes: 0, replies: 0 });
  const statistics = { nodes: 0, replies: 0 };
  const extended = tacticalSearch(board, 'ai', 1, { beam: 5, qDepth: 2 }, statistics);
  assert.ok(naive > 25, 'stopping at the first capture wrongly counts the platoon as free');
  assert.ok(extended < 10, 'the quiet alternative is better once the commander reply is included');
  assert.ok(statistics.extensions > 0);
});

test('quiet evacuation is included in a narrow tactical beam instead of inventing a trapped bomb', () => {
  const board = boardOf([[1, 'ai', 'flag'], [6, 'ai', 'bomb'], [16, 'ai', 'platoon'], [39, 'ai', 'general'],
    [56, 'human', 'flag'], [17, 'human', 'company'], [31, 'human', 'general'], [46, 'human', 'division']]);
  const evaluate = config => tacticalSearch(board, 'human', 3, config, { nodes: 0, replies: 0 });
  const narrow = evaluate({ beam: 5 });
  const all = evaluate({ beam: 999 });
  const ordered = evaluate({ beam: 5, escapeOrdering: true });
  assert.ok(narrow > all + 40, 'the old static beam drops the quiet 6→8 bomb escape');
  assert.ok(Math.abs(ordered - all) < 1e-8, 'escape ordering restores the independently full-width reply in this position');
});

test('transposition reuse preserves the tactical value while actually avoiding repeated expansion', () => {
  const board = boardOf([[1, 'ai', 'flag'], [25, 'ai', 'general'], [56, 'human', 'flag'],
    [26, 'human', 'platoon'], [27, 'human', 'commander']]);
  const statistics = { nodes: 0, replies: 0, table: new Map() };
  const config = { beam: 5, rootDepth: 3, qDepth: 2, escapeOrdering: true };
  const value = tacticalSearch(board, 'ai', 3, config, statistics);
  const expanded = statistics.nodes;
  assert.equal(tacticalSearch(board, 'ai', 3, config, statistics), value);
  assert.equal(statistics.nodes, expanded);
  assert.ok(statistics.cacheHits > 0);
});

test('inconsistent evidence keeps an unknown attacker dangerous rather than treating zero posterior mass as safety', () => {
  const board = boardOf([[1, 'ai', 'flag'], [5, 'ai', 'general'], [6, 'human', 'company']]);
  board[6].type = null;
  const beliefs = { consistent: false, domains: { 'human-6': [] }, probabilities: { 'human-6': {} } };
  const danger = publicDanger(board, beliefs, 'ai');
  assert.equal(danger.flagRisk, 1, 'an empty domain is an inconsistent observation, never an immovable enemy');
  assert.ok(danger.risk > 0);
});
