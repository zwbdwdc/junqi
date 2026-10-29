import test from 'node:test';
import assert from 'node:assert/strict';
import { createLearningProfile, sanitizeProfile, learnFromGame, serializeProfile, LEARNING_KEYS,
  WEIGHT_MIN, WEIGHT_MAX } from '../dist/learning.js';
import { createGame, randomLayout, makeObservation } from '../dist/engine.js';
import { chooseMove } from '../dist/ai.js';

function seeded(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4294967296; };
}

function episode({ ownType = 'general', enemyType = 'bomb', result = 'both', reason = 'flag', features,
  winner = 'human', actionClass = 'attack' } = {}) {
  const initial = Array(62).fill(null);
  initial[25] = { id: 'own-secret-identity', side: 'ai', type: ownType, origin: 25 };
  initial[30] = { id: 'enemy-secret-identity', side: 'human', type: enemyType, origin: 30 };
  const event = { ply: 1, side: 'ai', from: 25, to: 30, attackerId: initial[25].id,
    defenderId: initial[30].id, result, flagRevealed: [], engineerTurn: false, mountainMove: false };
  const observation = {
    side: 'ai', ply: 1, result: { winner, reason }, history: [event],
    ownRoster: [{ id: initial[25].id, type: ownType, origin: 25 }],
    board: initial.map(piece => piece ? { ...piece, type: piece.side === 'ai' ? piece.type : null } : null),
    enemyRoster: [{ id: initial[30].id, origin: 30 }],
  };
  return { gameId: 'game-private-random-token', observation,
    decisions: [{ ply: 1, from: 25, to: 30, info: { actionClass,
      learningFeatures: features ?? { attack: 1, risk: 0.8, bombCaution: 0.7 } } }],
    completedGame: { result: { winner, reason }, ply: 1, initial, history: structuredClone(observation.history) } };
}

test('profiles whitelist fields and repair corrupted, nonfinite, or incompatible imports', () => {
  const base = createLearningProfile();
  assert.deepEqual(sanitizeProfile(null), base);
  assert.deepEqual(sanitizeProfile('{broken JSON'), base);
  assert.deepEqual(sanitizeProfile({ version: 100, weights: { attack: 99 } }), base);
  const profile = sanitizeProfile({ ...base, games: -5, weights: { attack: 99, risk: -99, bombCaution: NaN,
    scout: Infinity, secretEnemyRank: 'commander' }, initial: [{ type: 'flag', origin: 58 }],
    opponent: { attackRate: 5, campRate: -1, moves: Infinity, secretIdentity: 'do-not-store' },
    lastSummary: { text: 'do-not-store', movesReviewed: NaN, adjustments: [{ key: 'unknown', before: 1, after: 2 }] } });
  assert.equal(profile.weights.attack, WEIGHT_MAX);
  assert.equal(profile.weights.risk, WEIGHT_MIN);
  assert.equal(profile.weights.bombCaution, 1);
  assert.equal(profile.weights.scout, 1);
  assert.equal(profile.games, 0);
  assert.equal(profile.opponent.attackRate, 1);
  assert.equal(profile.opponent.campRate, 0);
  assert.equal(profile.opponent.moves, 0);
  assert.equal(JSON.stringify(profile).includes('do-not-store'), false);
  assert.equal(Object.hasOwn(profile, 'initial'), false);
  assert.deepEqual(sanitizeProfile(serializeProfile(profile)), profile);
});

test('unfinished games do not learn or read a private initial board', () => {
  const input = episode();
  input.observation.result = null;
  Object.defineProperty(input.completedGame, 'initial', { get() { throw new Error('private board was read'); } });
  const profile = createLearningProfile();
  assert.deepEqual(learnFromGame(profile, input), profile);
  input.observation.result = { winner: 'human', reason: 'flag' };
  input.completedGame.result = null;
  const publicOnly = learnFromGame(profile, input);
  assert.equal(publicOnly.games, 1);
  assert.equal(publicOnly.replayGames, 0);
  assert.equal(publicOnly.lastSummary.fullReview, false);
});

test('postgame consolidation actually changes bounded tactical weights and is idempotent', () => {
  const input = episode();
  const base = createLearningProfile();
  const learned = learnFromGame(base, input);
  assert.equal(learned.games, 1);
  assert.equal(learned.replayGames, 1);
  assert.equal(learned.outcomes.losses, 1);
  assert.ok(learned.weights.risk > 1);
  assert.ok(learned.weights.bombCaution > 1);
  assert.ok(learned.weights.attack < 1);
  assert.ok(learned.weights.defend > 1);
  assert.equal(learned.lastSummary.movesReviewed, 1);
  assert.equal(learned.lastSummary.highRankBombTrades, 1);
  assert.ok(learned.lastSummary.text.includes('明棋'));
  assert.deepEqual(learnFromGame(learned, input), learned);
  assert.deepEqual(learnFromGame(sanitizeProfile(serializeProfile(learned)), input), learned);
  assert.deepEqual(base, createLearningProfile(), 'learning must not mutate the old profile');
});

test('updates remain bounded after repeated adverse experience and remember old duplicates', () => {
  const input = episode();
  let profile = createLearningProfile();
  for (let number = 0; number < 180; number++) profile = learnFromGame(profile, { ...input, gameId: `episode-${number}` });
  assert.equal(profile.games, 180);
  assert.equal(profile.weights.risk, WEIGHT_MAX);
  assert.equal(profile.weights.bombCaution, WEIGHT_MAX);
  assert.equal(profile.weights.defend, WEIGHT_MAX);
  assert.equal(profile.weights.attack, WEIGHT_MIN);
  for (const key of LEARNING_KEYS) assert.ok(profile.weights[key] >= WEIGHT_MIN && profile.weights[key] <= WEIGHT_MAX);
  assert.deepEqual(learnFromGame(profile, { ...input, gameId: 'episode-0' }), profile);
  assert.equal(profile.dedup.length, createLearningProfile().dedup.length, 'dedup memory has a fixed size');
});

test('public-only learning never consults hidden boards, enemy rosters, or rank labels', () => {
  const first = episode({ reason: 'no-moves' });
  delete first.completedGame;
  const second = structuredClone(first);
  for (const key of ['board', 'initial', 'enemyRoster', 'enemyCounts', 'casualties'])
    Object.defineProperty(second.observation, key, { get() { throw new Error(`read forbidden field ${key}`); } });
  assert.deepEqual(learnFromGame(null, first), learnFromGame(null, second));
  const learned = learnFromGame(null, second);
  assert.equal(learned.replayGames, 0);
  assert.equal(learned.opponent.encounters, 0, 'anonymous deaths must not become labeled experience');
  assert.equal(learned.lastSummary.highRankBombTrades, 0);
});

test('finished full review learns actual exchanges differently without retaining identities', () => {
  const large = episode({ ownType: 'bomb', enemyType: 'general', reason: 'no-moves' });
  const small = episode({ ownType: 'bomb', enemyType: 'platoon', reason: 'no-moves' });
  assert.deepEqual(large.observation, small.observation, 'the live observation cannot reveal either rank');
  const a = learnFromGame(null, large), b = learnFromGame(null, small);
  assert.ok(a.weights.attack > b.weights.attack, 'a bomb trading for a general is better than trading for a platoon');
  assert.ok(a.opponent.encounterStrongRate > b.opponent.encounterStrongRate);
  assert.equal(a.opponent.encounters, 1);
  const serialized = serializeProfile(a);
  for (const secret of ['own-secret-identity', 'enemy-secret-identity', 'game-private-random-token',
    'initial', 'board', 'general', 'origin', 'attackerId', 'defenderId'])
    assert.equal(serialized.includes(secret), false, `profile must not retain ${secret}`);
  assert.deepEqual(a, sanitizeProfile(serialized));
});

test('mismatched completed games are never opened for private review', () => {
  for (const mismatch of ['history', 'result', 'ply']) {
    const input = episode();
    if (mismatch === 'history') input.completedGame.history[0].to = 31;
    if (mismatch === 'result') input.completedGame.result.winner = 'ai';
    if (mismatch === 'ply') input.completedGame.ply = 2;
    Object.defineProperty(input.completedGame, 'initial', { get() { throw new Error('mismatched secret was read'); } });
    const learned = learnFromGame(null, input);
    assert.equal(learned.lastSummary.fullReview, false);
    assert.equal(learned.replayGames, 0);
    assert.equal(learned.opponent.encounters, 0);
  }
});

test('large own losses weigh more than small probes using only our roster', () => {
  const large = episode({ ownType: 'general', result: 'lose', reason: 'no-moves' });
  const small = episode({ ownType: 'platoon', result: 'lose', reason: 'no-moves' });
  delete large.completedGame; delete small.completedGame;
  assert.ok(learnFromGame(null, large).weights.risk > learnFromGame(null, small).weights.risk);
});

test('survival alone does not reward camping, while public opponent habits are still learned', () => {
  const input = episode({ result: 'move', actionClass: 'shelter', features: { shelter: 0.9 }, winner: null, reason: 'quiet' });
  delete input.completedGame;
  input.observation.history[0].to = 21;
  input.observation.history[0].defenderId = null;
  input.decisions[0].to = 21;
  input.observation.history.push({ ply: 2, side: 'human', from: 30, to: 36, attackerId: 'anonymous-opponent',
    defenderId: null, result: 'move', flagRevealed: [], engineerTurn: false, mountainMove: false });
  input.observation.ply = 2;
  const learned = learnFromGame(null, input);
  assert.equal(learned.weights.shelter, 1);
  assert.ok(learned.opponent.campRate > createLearningProfile().opponent.campRate);
  assert.equal(learned.opponent.moves, 1);
  assert.equal(learned.outcomes.draws, 1);
});

test('forged, duplicated, or unmatched decision features cannot inflate episode evidence', () => {
  const original = episode();
  const duplicate = structuredClone(original);
  duplicate.decisions.push(structuredClone(original.decisions[0]), { ply: 99, from: 25, to: 30,
    info: { actionClass: 'attack', learningFeatures: { attack: 999, risk: 999 } } });
  assert.deepEqual(learnFromGame(null, original), learnFromGame(null, duplicate));
  original.decisions = [{ ...original.decisions[0], to: 31 }];
  const learned = learnFromGame(null, original);
  assert.equal(learned.lastSummary.movesReviewed, 0);
  assert.equal(learned.weights.risk, 1);
  assert.equal(learned.weights.bombCaution, 1);
});

test('a profile learned from a real loss signal actually changes the next-game AI evaluation', () => {
  const baseline = createLearningProfile(), learned = learnFromGame(baseline, episode());
  const rng = seeded(1), game = createGame(randomLayout('human', rng), randomLayout('ai', rng));
  const observation = makeObservation(game, 'ai');
  const before = structuredClone(observation);
  const first = chooseMove(observation, 'professional', seeded(80), baseline);
  const next = chooseMove(observation, 'professional', seeded(80), learned);
  assert.notEqual(first.info.expectedScore, next.info.expectedScore,
    'experience must feed the move evaluator, not only increment a games counter');
  assert.deepEqual(observation, before, 'using a learned profile must not modify the hidden-information boundary');
});
