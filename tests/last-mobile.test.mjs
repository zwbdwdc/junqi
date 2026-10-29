import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chooseMove, inferBeliefs, publicDanger, tacticalSearch } from '../dist/ai.js';
import { legalMoves, combat } from '../dist/engine.js';
import { decisionDiagnostics } from '../dist/ai-context.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/generated-last-engineer.json', import.meta.url)));
const seeded = seed => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
function move(board, from, to) {
  const next = board.slice(); next[to] = next[from]; next[from] = null; return next;
}

test('a public equal exchange of the last mobile unit is a terminal danger, not an even trade', () => {
  const observation = fixture.observation, beliefs = inferBeliefs(observation, { rng: seeded(41), samples: 64 });
  const exposed = move(observation.board, 10, 30), sheltered = move(observation.board, 10, 11);
  assert.equal(exposed[33].type, 'engineer');
  assert.ok(legalMoves(exposed, 33).includes(30));
  assert.equal(combat(exposed[33].type, exposed[30].type), 'both');
  assert.equal(publicDanger(exposed, beliefs, observation.side).lastUnitRisk, 1);
  assert.equal(publicDanger(sheltered, beliefs, observation.side).lastUnitRisk, 0);
  const withReserve = sheltered.slice(); withReserve[30] = { ...sheltered[11], id: 'additional-mobile-reserve' };
  assert.equal(publicDanger(withReserve, beliefs, observation.side).lastUnitRisk, 0);
});

test('both difficulties avoid the generated final-engineer blunder even with zero search nodes', () => {
  for (const level of ['professional', 'hell']) {
    const observation = fixture.observation;
    const chosen = chooseMove(observation, level, seeded(21), null, null, { nodeLimit: 0 });
    assert.ok(legalMoves(observation.board, chosen.from).includes(chosen.to));
    assert.equal(chosen.info.diagnostics.lastUnitRisk, 0);
    assert.notDeepEqual([chosen.from, chosen.to], [10, 30]);
    assert.equal(chosen.info.searchDepth, 0);
  }
});

test('the last search ply recognizes eliminating the opponent last unit as a full win', () => {
  const board = Array(62).fill(null);
  for (const [at, side, type] of [[1, 'ai', 'flag'], [33, 'ai', 'engineer'], [58, 'human', 'flag'], [30, 'human', 'engineer']])
    board[at] = { id: `${side}-${at}`, side, type, origin: at, moved: true };
  assert.equal(tacticalSearch(board, 'ai', 1, { beam: 5 }, { nodes: 0, replies: 0 }), 50000);
  assert.equal(tacticalSearch(board, 'ai', 1, { beam: 5, qDepth: 2 }, { nodes: 0, replies: 0 }), 50000);
});

test('saved decision diagnostics keep bounded terminal facts and reject arbitrary worker fields', () => {
  const saved = decisionDiagnostics({ diagnostics: { quietDraw: true, allowOpponentDraw: true, repetitionDraw: false,
    lastUnitRisk: 7, trueBoard: ['private'] } });
  assert.equal(saved.quietDraw, true); assert.equal(saved.allowOpponentDraw, true);
  assert.equal(saved.repetitionDraw, false); assert.equal(saved.lastUnitRisk, 1);
  assert.equal(Object.hasOwn(saved, 'trueBoard'), false);
});
