import test from 'node:test';
import assert from 'node:assert/strict';
import { combat, legalMoves } from '../dist/engine.js';
import { flagPreparation } from '../dist/ai.js';

function fixture(entries) {
  const board = Array(62).fill(null);
  for (const [at, side, type] of entries)
    board[at] = { id: `${side}-${at}`, side, type, origin: at, moved: !['flag', 'mine'].includes(type) };
  // The commander has been logically identified from public battles. Its
  // observation token remains dark; only the explicit belief domain knows it.
  const enemies = board.filter(piece => piece?.side === 'human');
  const beliefs = {
    consistent: true,
    domains: Object.fromEntries(enemies.map(piece => [piece.id, [piece.type]])),
    probabilities: Object.fromEntries(enemies.map(piece => [piece.id, { [piece.type]: 1 }])),
  };
  const publicBoard = board.map(piece => piece?.side === 'human' && piece.type !== 'engineer'
    ? { ...piece, type: null } : piece);
  return { board, publicBoard, beliefs };
}

function play(board, from, to, expected) {
  assert.ok(legalMoves(board, from).includes(to), `${from} -> ${to} must be genuinely legal`);
  const attacker = board[from], defender = board[to];
  const outcome = defender ? combat(attacker.type, defender.type) : 'move';
  if (expected) assert.equal(outcome, expected, `combat result of ${from} -> ${to}`);
  const after = board.slice();
  after[from] = null;
  after[to] = outcome === 'lose' ? defender : outcome === 'both' ? null : { ...attacker, moved: true };
  return after;
}

function interceptors(board, target) {
  const invader = board[target];
  return board.flatMap((piece, at) => piece?.side === 'ai' &&
    ['win', 'both'].includes(combat(piece.type, invader.type)) && legalMoves(board, at).includes(target) ? [at] : []);
}

test('a second wave cannot borrow a camp that becomes empty only after taking the flag guard', () => {
  const { board, publicBoard, beliefs } = fixture([
    [1, 'ai', 'flag'], [6, 'ai', 'mine'], [10, 'ai', 'company'],
    [11, 'ai', 'platoon'], [15, 'ai', 'bomb'],
    [7, 'human', 'engineer'], [16, 'human', 'commander'],
  ]);
  let position = play(board, 7, 6, 'win');
  position = play(position, 11, 6, 'win');
  position = play(position, 16, 11, 'move');
  assert.ok(!legalMoves(position, 15).includes(11), 'the occupied camp prevents the supposed bomb preparation');

  // Enumerate real preparation moves while the commander still occupies the
  // camp. None permits an immediate interception after it takes the guard.
  let preparationCount = 0;
  for (let from = 0; from < position.length; from++) {
    if (position[from]?.side !== 'ai') continue;
    for (const to of legalMoves(position, from)) {
      const prepared = play(position, from, to);
      const taken = play(prepared, 11, 6);
      assert.deepEqual(interceptors(taken, 6), [], `preparation ${from} -> ${to} cannot save the flag`);
      assert.ok(legalMoves(taken, 6).includes(1));
      preparationCount++;
    }
  }
  assert.ok(preparationCount > 0, 'the timing check must actually enumerate possible preparations');
  const taken = play(position, 11, 6, 'win');
  assert.ok(legalMoves(taken, 15).includes(11), 'the attractive bomb route exists only after the gate falls');
  const tooLate = play(taken, 15, 11, 'move');
  assert.ok(legalMoves(tooLate, 11).includes(6), 'the hypothetical second bomb move looks possible');
  play(tooLate, 6, 1, 'win');

  assert.ok(flagPreparation(publicBoard, beliefs, 'ai').breach > 0,
    'post-capture geometry must not invent an earlier preparation turn');
});

test('a follower may take the newly occupied flag gate directly without visiting another staging square', () => {
  const { board, publicBoard, beliefs } = fixture([
    [1, 'ai', 'flag'], [6, 'ai', 'mine'], [5, 'ai', 'platoon'],
    [10, 'ai', 'commander'], [12, 'ai', 'bomb'],
    [7, 'human', 'engineer'], [11, 'human', 'commander'],
  ]);
  const opened = play(board, 7, 6, 'win');
  const replied = play(opened, 5, 6, 'win');

  // Both unnecessary detours can be stopped, which used to hide the direct
  // capture when only staging-square continuations were assessed.
  play(play(replied, 11, 5, 'move'), 10, 5, 'both');
  play(play(replied, 11, 7, 'move'), 12, 7, 'both');
  const taken = play(replied, 11, 6, 'win');
  assert.deepEqual(interceptors(taken, 6), [], 'neither defender can exchange the commander on the gate');
  play(taken, 6, 1, 'win');

  assert.ok(flagPreparation(publicBoard, beliefs, 'ai').breach > 0,
    'a direct second-wave capture must be assessed before optional staging moves');
});
