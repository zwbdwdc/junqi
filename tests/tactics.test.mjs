import test from 'node:test';
import assert from 'node:assert/strict';
import { randomLayout, createGame, makeObservation, legalMoves, isCamp } from '../dist/engine.js';
import { DIFFICULTIES, chooseMove, inferBeliefs, inferDomains } from '../dist/ai.js';

function seeded(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function fixture(seed = 41) {
  const rng = seeded(seed), game = createGame(randomLayout('human', rng), randomLayout('ai', rng), { engineerMountains: true });
  const observation = makeObservation(game, 'ai');
  observation.board.fill(null);
  const own = type => structuredClone(game.initial.find(p => p?.side === 'ai' && p.type === type));
  const enemy = type => { const p = structuredClone(game.initial.find(p => p?.side === 'human' && p.type === type)); return { ...p, type: null, moved: true }; };
  observation.board[1] = own('flag');
  observation.board[56] = { ...enemy('flag'), type: 'flag', moved: false };
  return { observation, own, enemy };
}
function event(side, from, to, attackerId, defenderId = null, result = 'move', extra = {}) {
  return { side, from, to, attackerId, defenderId, result, engineerTurn: false, flagRevealed: [], ...extra };
}

test('only professional and hell are offered; old beginner settings migrate without a weak policy', () => {
  assert.deepEqual(Object.keys(DIFFICULTIES), ['professional', 'hell']);
  const { observation, own } = fixture(); observation.board[20] = own('platoon');
  const searchOptions = { clock: () => 0, nodeLimit: 20000, maxDepth: 4 };
  assert.deepEqual(chooseMove(observation, 'beginner', seeded(9), null, null, searchOptions), chooseMove(observation, 'professional', seeded(9), null, null, searchOptions));
});

test('a publicly identified superior chasing a division causes shelter instead of an unrelated pawn push', () => {
  const { observation, own, enemy } = fixture();
  // Isolate shelter from flag emergencies. Mines alone do not achieve this:
  // a rear platoon could trade the rail blocker, letting a hidden engineer
  // take the flag. Public wins below rule out that engineer branch, rather
  // than requiring the policy to save a division at the cost of its flag.
  observation.board[1] = null; observation.board[3] = own('flag');
  for (const at of [2, 4, 8]) observation.board[at] = { ...own('mine'), id: `guard-mine-${at}` };
  const invader = enemy('commander'), deadGeneral = own('general');
  observation.board[20] = own('division'); observation.board[29] = own('platoon');
  observation.board[25] = invader;
  observation.board[54] = enemy('company'); observation.board[51] = enemy('engineer');
  const victims = observation.ownRoster.filter(p => p.type === 'platoon').slice(1);
  observation.history = [event('human', 30, 25, invader.id, deadGeneral.id, 'win'),
    event('human', 59, 54, observation.board[54].id, victims[0].id, 'win'),
    event('human', 52, 51, observation.board[51].id, victims[1].id, 'win')];
  assert.deepEqual(inferDomains(observation)[invader.id], ['commander']);
  for (const at of [51, 54]) assert.ok(!inferDomains(observation)[observation.board[at].id].includes('engineer'));
  for (const difficulty of ['professional', 'hell']) {
    const move = chooseMove(observation, difficulty, seeded(121));
    assert.equal(move.from, 20, 'must save the threatened division instead of moving an unrelated pawn');
    assert.ok(isCamp(move.to), `expected camp escape; got ${move.from}->${move.to}`);
    assert.equal(move.info.actionClass, 'shelter');
  }
});

test('a low officer does not knowingly charge a proven commander when a bomb can intercept it', () => {
  const { observation, own, enemy } = fixture();
  const invader = enemy('commander');
  observation.board[20] = own('platoon'); observation.board[26] = own('bomb'); observation.board[25] = invader;
  observation.history = [event('human', 30, 25, invader.id, own('general').id, 'win')];
  for (const difficulty of ['professional', 'hell']) {
    const move = chooseMove(observation, difficulty, seeded(73));
    assert.deepEqual({ from: move.from, to: move.to }, { from: 26, to: 25 });
  }
});

test('an exposed commander avoids a non-front-row piece that repeatedly approaches it: public bomb suspicion', () => {
  const { observation, own, enemy } = fixture(115);
  const commander = own('commander'), dead = enemy('general'), suspect = enemy('bomb');
  observation.board[20] = commander; observation.board[26] = own('platoon'); observation.board[25] = suspect;
  observation.board[54] = enemy('company'); observation.board[51] = enemy('engineer');
  const approaches = [
    event('ai', 19, 20, commander.id, dead.id, 'win'),
    event('human', suspect.origin, 35, suspect.id),
    event('human', 35, 30, suspect.id),
    event('human', 30, 25, suspect.id),
  ];
  const quiet = structuredClone(observation); quiet.history = [approaches[0]];
  observation.history = approaches;
  const ordinary = inferBeliefs(quiet, { samples: 500, rng: seeded(50) });
  const suspicious = inferBeliefs(observation, { samples: 500, rng: seeded(50) });
  assert.ok(suspicious.probabilities[suspect.id].bomb > ordinary.probabilities[suspect.id].bomb + 0.02);
  assert.ok(suspicious.probabilities[suspect.id].bomb < 0.5, 'movement alone is weak evidence and may be a bluff');
  assert.ok(suspicious.domains[suspect.id].length > 1, 'suspicion must not become certainty');
  for (const difficulty of ['professional', 'hell']) for (const seed of [1, 3, 17]) {
    const move = chooseMove(observation, difficulty, seeded(seed));
    assert.notDeepEqual({ from: move.from, to: move.to }, { from: 20, to: 25 }, 'do not risk the commander to probe the suspicious piece');
  }
});

test('public turning-engineer evidence permits a safe small-piece capture instead of indiscriminate caution', () => {
  const { observation, own, enemy } = fixture(); const engineer = enemy('engineer');
  observation.board[25] = own('company'); observation.board[20] = own('regiment'); observation.board[30] = engineer;
  observation.history = [event('human', 54, 30, engineer.id, null, 'move', { engineerTurn: true })];
  for (const difficulty of ['professional', 'hell']) {
    const move = chooseMove(observation, difficulty, seeded(27));
    assert.deepEqual({ from: move.from, to: move.to }, { from: 25, to: 30 });
  }
});

test('both difficulties defend an imminent flag capture even against extreme learned attacking preferences', () => {
  const { observation, own, enemy } = fixture(); const engineer = enemy('engineer');
  observation.board[5] = own('bomb'); observation.board[29] = own('platoon'); observation.board[6] = engineer;
  observation.history = [event('human', 34, 6, engineer.id, null, 'move', { engineerTurn: true })];
  const profile = { weights: { attack: 1e8, scout: 1e8, defend: -1000, risk: -1000, bombCaution: -1000 } };
  for (const difficulty of ['professional', 'hell']) {
    const move = chooseMove(observation, difficulty, seeded(92), profile);
    assert.deepEqual({ from: move.from, to: move.to }, { from: 5, to: 6 });
    assert.equal(move.info.actionClass, 'defend');
  }
});

test('learning weights actually affect a scored decision and never enter the hidden-information boundary', () => {
  const { observation, own, enemy } = fixture(); const engineer = enemy('engineer');
  observation.board[25] = own('company'); observation.board[30] = engineer;
  observation.board[42] = enemy('company'); // Capturing the engineer is not already a terminal no-moves win.
  observation.history = [event('human', 54, 30, engineer.id, null, 'move', { engineerTurn: true })];
  const cautious = chooseMove(observation, 'professional', seeded(2), { weights: { attack: 0.8 } });
  const aggressive = chooseMove(observation, 'professional', seeded(2), { weights: { attack: 1.25 } });
  assert.ok(aggressive.info.expectedScore > cautious.info.expectedScore);
  assert.ok(Object.values(aggressive.info.learningFeatures).every(value => value >= 0 && value <= 1));
  assert.ok(legalMoves(observation.board, aggressive.from).includes(aggressive.to));
});
