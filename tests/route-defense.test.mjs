import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chooseMove, inferBeliefs, publicDanger, publicRouteRisk, mineObjectives } from '../dist/ai.js';
import { combat, legalMoves } from '../dist/engine.js';

const observation = JSON.parse(fs.readFileSync(new URL('./fixtures/generated-late-flag-cover.json', import.meta.url)))[0].observation;
const seeded = initial => { let seed = initial; return () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296); };
function play(board, from, to) {
  assert.ok(legalMoves(board, from).includes(to), `${from} -> ${to} is legal`);
  const p = board[from], target = board[to], result = target ? combat(p.type, target.type) : 'move';
  const after = board.slice(); after[from] = null;
  after[to] = result === 'lose' ? target : result === 'both' ? null : { ...p, moved: true };
  return after;
}
function publicQuiet(o, from, to) {
  const next = structuredClone(o), p = next.board[from];
  const legality = next.board.slice(); legality[from] = { ...p, type: p.type || 'company' };
  assert.ok(legalMoves(legality, from).includes(to));
  next.board[from] = null; next.board[to] = { ...p, moved: true }; next.ply++; next.quiet++; next.turn = p.side === 'ai' ? 'human' : 'ai';
  next.history.push({ ply: next.ply, side: p.side, from, to, attackerId: p.id, defenderId: null, result: 'move',
    flagRevealed: [], engineerTurn: false, mountainMove: false });
  return next;
}

test('a permanent headquarters occupant contributes no mobility pressure or attack route', () => {
  const board = Array(62).fill(null);
  board[1] = { id: 'flag', side: 'ai', type: 'flag' };
  board[3] = { id: 'frozen', side: 'human', type: null, moved: true };
  const beliefs = { consistent: true, domains: { frozen: ['commander'] }, probabilities: { frozen: { commander: 1 } } };
  const danger = publicDanger(board, beliefs, 'ai');
  assert.equal(danger.pressure, 0); assert.equal(danger.risk, 0); assert.equal(danger.attacks.length, 0);
  assert.equal(publicRouteRisk(board, beliefs, 'ai'), 0);
  board[7] = board[3]; board[3] = null;
  assert.ok(publicDanger(board, beliefs, 'ai').pressure > 0);
});

test('an HQ mine is excluded from engineer route jobs, ordinary mines retain their value', () => {
  const board = Array(62).fill(null);
  board[56] = { id: 'dead-end', side: 'human', type: null };
  board[57] = { id: 'gate', side: 'human', type: null };
  const beliefs = { probabilities: { 'dead-end': { mine: .7, flag: .3 }, gate: { mine: 1 } } };
  const tasks = mineObjectives({ board, side: 'ai' }, beliefs, [{ index: 58, probability: 1 }]);
  assert.deepEqual(tasks.map(task => task.id), ['gate']);
  assert.ok(tasks[0].value > 45);
});

test('the bomb preparation intercepts every publicly possible invader rank on the actual alternating route', () => {
  const beliefs = inferBeliefs(observation, { samples: 32, rng: seeded(193) });
  const intruder = observation.board[10];
  assert.deepEqual(new Set(beliefs.domains[intruder.id]), new Set(['division', 'brigade', 'regiment', 'battalion', 'company', 'platoon', 'bomb']));
  for (const type of beliefs.domains[intruder.id]) {
    let board = observation.board.slice(); board[10] = { ...intruder, type };
    for (const [from, to] of [[21,17],[10,11],[17,12],[11,7],[12,7]]) board = play(board, from, to);
    assert.equal(board[7], null, type); assert.equal(board[1].type, 'flag', type);
  }
  const bad = play(observation.board, 21, 16), good = play(observation.board, 21, 17);
  assert.ok(publicRouteRisk(bad, beliefs, 'ai') > .05);
  assert.equal(publicRouteRisk(good, beliefs, 'ai'), 0);
});

test('hell starts the viable bomb route and continues it after the public camp move', () => {
  const options = { clock: () => 0, nodeLimit: 160000, maxDepth: 4 };
  const first = chooseMove(observation, 'hell', seeded(193), null, null, options);
  assert.deepEqual([first.from,first.to], [21,17]);
  const afterFirst = publicQuiet(publicQuiet(observation, first.from, first.to), 10, 11);
  const second = chooseMove(afterFirst, 'hell', seeded(193), null, null, options);
  assert.equal(second.from, 17);
  assert.ok([12,13].includes(second.to), 'both legal staging squares cover 7 in one reply');
  const afterSecond = publicQuiet(publicQuiet(afterFirst, second.from, second.to), 11, 7);
  const third = chooseMove(afterSecond, 'hell', seeded(193), null, null, options);
  assert.deepEqual([third.from,third.to], [second.to,7]);
});
