import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { assessResignation } from '../dist/resignation.js';
import { createGame, randomLayout, applyMove, makeObservation, legalMoves } from '../dist/engine.js';
import { inferDomains, sampleHiddenLayouts } from '../dist/beliefs.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/ai-resignation-public.json', import.meta.url)));
const replayFixture = JSON.parse(fs.readFileSync(new URL('./fixtures/ai-resignation-game.json', import.meta.url))).game;
const earlyFixtures = JSON.parse(fs.readFileSync(new URL('./fixtures/ai-early-resignation.json', import.meta.url))).fixtures;
const seeded = seed => () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 2 ** 32);
const deterministic = { clock: () => 0, nodeLimit: 100000 };
const clone = value => structuredClone(value);

function synthetic(own = [[14, 'platoon']], enemy = [[8, 'engineer']], size = 62) {
  const layout = side => {
    const b = randomLayout(side, seeded(side === 'ai' ? 7 : 13)), target = side === 'ai' ? 3 : 58;
    const flag = b.findIndex(p => p?.type === 'flag'); [b[target], b[flag]] = [b[flag], b[target]];
    b.forEach((p, i) => { if (p) { p.id = `${side}-${i}`; p.origin = i; } }); return b;
  };
  const state = createGame(layout('human'), layout('ai'), { engineerMountains: size === 62 });
  const observation = makeObservation(state, 'ai'); observation.board = Array(size).fill(null);
  const used = new Set();
  const add = (at, type, side) => {
    const p = state.initial.find(p => p?.side === side && p.type === type && !used.has(p.id));
    assert.ok(p, `fixture contains ${side}/${type}`); used.add(p.id);
    observation.board[at] = { ...p, type: side === 'ai' || ['flag', 'engineer'].includes(type) ? type : null,
      moved: !['flag', 'mine'].includes(type) };
  };
  add(3, 'flag', 'ai'); add(58, 'flag', 'human');
  own.forEach(([at, type]) => add(at, type, 'ai')); enemy.forEach(([at, type]) => add(at, type, 'human'));
  observation.turn = 'ai'; observation.quiet = 0; observation.ply = 1; observation.history = [];
  return observation;
}

test('a real archived loss is resigned only after every public escape is ruled out', () => {
  const result = assessResignation(fixture.observation, deterministic);
  assert.equal(result.resign, true); assert.equal(result.reason, 'forced-loss');
  assert.equal(result.proof.ownMoves, 8); assert.equal(result.proof.maxPlies, 2);
  assert.ok(fixture.observation.board.every(p => !p || p.side === 'ai' || [null, 'flag', 'engineer'].includes(p.type)));
  assert.equal(fixture.observation.initial, undefined);
  // This independently replays the real prefix through the referee, keeping
  // private ranks out of the observation and production resignation module.
  const initial = replayFixture.initial;
  let state = createGame(initial.slice(0, 60).map(p => p?.side === 'human' ? p : null),
    initial.slice(0, 60).map(p => p?.side === 'ai' ? p : null), replayFixture.rules);
  for (const event of replayFixture.history) state = applyMove(state, event.from, event.to);
  assert.equal(state.ply, 149); assert.equal(state.result, null);
  assert.deepEqual(makeObservation(state, 'ai'), fixture.observation);
});

test('every proposed escape also loses under independently sampled complete legal armies', () => {
  const observation = fixture.observation, domains = inferDomains(observation);
  const worlds = sampleHiddenLayouts(observation, 32, seeded(20261015), domains);
  assert.equal(worlds.length, 32);
  for (const world of worlds) {
    const board = observation.board.map(p => p ? { ...p, type: p.type || world[p.id] } : null);
    const state = { ...clone(replayFixture), board, result: null };
    for (let from = 0; from < board.length; from++) if (board[from]?.side === 'ai') {
      for (const to of legalMoves(board, from)) {
        const after = applyMove(state, from, to);
        assert.equal(after.result, null, 'AI has neither an immediate win nor a draw');
        const wins = after.board.some((p, at) => p?.side === 'human' && legalMoves(after.board, at)
          .some(end => applyMove(after, at, end).result?.winner === 'human'));
        assert.equal(wins, true);
      }
    }
  }
});

test('unavoidable immediate flag loss allows resignation with either board size', () => {
  for (const size of [60, 62]) assert.equal(assessResignation(synthetic(undefined, undefined, size), deterministic).resign, true);
});

test('a possible countercapture of the flag and final-unit trade forbid resignation', () => {
  assert.equal(assessResignation(synthetic([[14, 'platoon'], [53, 'engineer']]), deterministic).resign, false);
  // Both last movers disappear, but no-moves is checked on the opponent first:
  // the AI bomber wins immediately instead of allowing the threatened flag fall.
  assert.equal(assessResignation(synthetic([[13, 'bomb']]), deterministic).resign, false);
  assert.equal(assessResignation(synthetic([[13, 'regiment']]), deterministic).resign, false);
});

test('protected surviving pieces alone do not imply an immediate forced loss', () => {
  for (const at of [61, 13]) {
    // Another movable unit allows the mountain occupant to remain sheltered.
    // A lone engineer forced to leave onto a covered railway may truly lose.
    const own = at === 61 ? [[61, 'engineer'], [13, 'engineer']] : [[13, 'engineer']];
    const observation = synthetic(own, [[45, 'engineer'], [44, 'commander'], [49, 'general']]);
    assert.equal(assessResignation(observation, { ...deterministic, maxPlies: 2 }).resign, false);
  }
});

// Independent finite minimax: the real referee supplies every transition and
// terminal, with no resignation projections, domains or scoring functions.
function refereeLoses(game, side, depth) {
  if (game.result) return game.result.winner !== null && game.result.winner !== side;
  if (depth === 0) return false;
  const children = [];
  for (let from = 0; from < game.board.length; from++) if (game.board[from]?.side === game.turn)
    for (const to of legalMoves(game.board, from)) children.push(applyMove(game, from, to));
  children.sort((a, b) => Number(b.result?.winner === game.turn) - Number(a.result?.winner === game.turn));
  if (!children.length) return false;
  return game.turn === side
    ? children.every(child => refereeLoses(child, side, depth - 1))
    : children.some(child => refereeLoses(child, side, depth - 1));
}

test('real games with both small and large armies can resign one full turn earlier', () => {
  for (const { observation, game } of earlyFixtures) {
    assert.deepEqual(makeObservation(game, 'ai'), observation);
    const previous = assessResignation(observation, { ...deterministic, maxPlies: 2 });
    assert.equal(previous.resign, false);
    const result = assessResignation(observation, { ...deterministic, nodeLimit: 500000 });
    assert.equal(result.resign, true); assert.equal(result.proof.maxPlies, 4);
    assert.equal(refereeLoses(game, 'ai', 2), false);
    assert.equal(refereeLoses(game, 'ai', 4), true);
  }
  assert.ok(earlyFixtures.some(({game}) => game.board.filter(Boolean).length >= 25),
    'a crowded board must not disable urgent public flag proofs');
});

test('a later quiet draw in the proof tree keeps playing before a threatened flag can fall', () => {
  const observation = synthetic([[13, 'engineer']], [[45, 'engineer'], [44, 'commander'], [49, 'general']]);
  assert.equal(assessResignation(observation, deterministic).proof.maxPlies, 4);
  observation.quiet = 97;
  const result = assessResignation(observation, { ...deterministic, nodeLimit: 500000 });
  assert.equal(result.resign, false); assert.equal(result.reason, 'escape-possible');
  assert.equal(result.proof.completedPlies, 6);
});

test('a six-ply flag proof can include mountain shelter without ignoring a later draw', () => {
  const observation = synthetic([[61, 'engineer'], [13, 'engineer']], [[45, 'engineer'], [44, 'commander'], [49, 'general']]);
  const options = { ...deterministic, nodeLimit: 500000 };
  assert.equal(assessResignation(observation, { ...options, maxPlies: 4 }).resign, false);
  assert.equal(assessResignation(observation, options).proof.maxPlies, 6);
  observation.quiet = 96;
  const draw = assessResignation(observation, options);
  assert.equal(draw.resign, false); assert.equal(draw.reason, 'escape-possible');
});

test('early proof retains a real counterflag capture and cannot use a partial branch proof', () => {
  const observation = clone(earlyFixtures[0].observation);
  const baseline = assessResignation(observation, { ...deterministic, maxPlies: 2 });
  assert.equal(baseline.resign, false);
  const interrupted = assessResignation(observation, { ...deterministic, nodeLimit: baseline.proof.nodes + 5 });
  assert.equal(interrupted.resign, false); assert.equal(interrupted.reason, 'budget');
  assert.equal(interrupted.proof.maxPlies, null);
  // The possible enemy flag is sufficient: a speculative identity must not
  // be hidden by a losing material score or a proven threat at our own flag.
  const counter = synthetic([[13, 'engineer'], [53, 'regiment']], [[45, 'engineer'], [44, 'commander'], [49, 'general']]);
  assert.equal(assessResignation(counter, deterministic).resign, false);
});

test('unknown combat outcomes retain every unexcluded chance of escape', () => {
  const observation = synthetic([[13, 'regiment']], [[8, 'company'], [45, 'engineer']]);
  const domain = inferDomains(observation)[observation.board[8].id];
  assert.ok(domain.includes('commander') && domain.includes('platoon'));
  assert.equal(assessResignation(observation, deterministic).resign, false,
    'the regiment may beat the dark invader; its stronger possibilities do not justify giving up');
  const untouched = clone(observation); assessResignation(observation, deterministic);
  assert.deepEqual(observation, untouched, 'proofs must not mutate public facts or inferred identities');
});

test('a quiet draw is retained but a flag capture takes priority over the next quiet limit', () => {
  const observation = synthetic(); observation.quiet = 99;
  assert.equal(assessResignation(observation, deterministic).resign, false);
  observation.quiet = 98;
  assert.equal(assessResignation(observation, deterministic).resign, true);
});

test('possible repetition draws retain play even when enemy flag capture is otherwise certain', () => {
  const initial = replayFixture.initial;
  let state = createGame(initial.slice(0, 60).map(p => p?.side === 'human' ? p : null),
    initial.slice(0, 60).map(p => p?.side === 'ai' ? p : null), replayFixture.rules);
  for (const event of replayFixture.history.slice(0, 148)) state = applyMove(state, event.from, event.to);
  // An alternative, wholly legal continuation from the real position. The
  // human declines the winning flag capture and permits a repetition instead.
  const cycle = [[11, 6], [13, 18], [6, 11], [18, 13]];
  for (let i = 0; i < 7; i++) state = applyMove(state, ...cycle[i % 4]);
  assert.equal(state.result, null); assert.equal(state.turn, 'ai');
  assert.deepEqual(applyMove(state, 18, 13).result, { winner: null, reason: 'repetition' });
  assert.equal(assessResignation(makeObservation(state, 'ai'), deterministic).resign, false);
});

test('interrupted, malformed, terminal and out-of-turn checks never manufacture a resignation', () => {
  for (const options of [{ nodeLimit: 0 }, { timeLimitMs: 0 }, { clock: (() => { let n = 0; return () => n += 10; })(), timeLimitMs: 20 }]) {
    const result = assessResignation(fixture.observation, options);
    assert.equal(result.resign, false); assert.equal(result.reason, 'budget');
  }
  for (const patch of [{ result: { winner: 'human', reason: 'flag' } }, { turn: 'human' }, { enemyRoster: [] }])
    assert.equal(assessResignation({ ...fixture.observation, ...patch }, deterministic).resign, false);
  const empty = synthetic([]);
  assert.equal(assessResignation(empty, deterministic).resign, false);
});
