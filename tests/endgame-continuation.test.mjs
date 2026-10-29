import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { chooseMove, inferBeliefs, publicDanger } from '../dist/ai.js';
import { legalMoves, combat } from '../dist/engine.js';
import { seeded } from '../benchmarks/self-play-v2.mjs';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/endgame-continuation-failures.json', import.meta.url)));
const rngFor = f => seeded(createHash('sha256').update(Object.values(f.decisionSeed).join(':')).digest().readUInt32LE());

test('rare sampled no-moves wins do not make a weak piece or final engineer charge a stronger unknown', () => {
  for (const f of fixtures.filter(f => f.id.endsWith('132'))) {
    const level = f.id.includes('professional') ? 'professional' : 'hell';
    const move = chooseMove(f.observation, level, rngFor(f), null, f.context, { clock: () => 0, maxDepth: level === 'hell' ? 6 : 4 });
    assert.ok(legalMoves(f.observation.board, move.from).includes(move.to));
    assert.notDeepEqual({ from: move.from, to: move.to }, f.actualMove, `${f.id}: a few hypothetical terminals must not finance sending this unit to die`);
    assert.equal(move.info.diagnostics.provenWin, false);
  }
});

test('a necessary last-officer flag guard is considered even when an unknown stronger rank could take it', () => {
  const f = fixtures.find(f => f.id.endsWith('216'));
  const beliefs = inferBeliefs(f.observation, { samples: 256, rng: rngFor(f) });
  assert.ok(beliefs.domains[f.observation.board[5].id].includes('company'));
  assert.ok(beliefs.domains[f.observation.board[5].id].includes('division'));
  for (const level of ['professional', 'hell']) for (const nodeLimit of [0, 200000]) {
    const move = chooseMove(f.observation, level, rngFor(f), null, f.context, { clock: () => 0, maxDepth: 4, nodeLimit });
    assert.equal(move.from, 13);
    assert.ok([7, 8, 9].includes(move.to), `${level} must retain a fighting defense, not allow the certain two-step flag capture`);
    const after = f.observation.board.slice(); after[move.to] = after[move.from]; after[move.from] = null;
    assert.ok(publicDanger(after, beliefs, 'ai').approachRisk < 1);
    // The same public choice must still be legal if the hidden rank differs.
    for (const type of ['company', 'division']) {
      const hypothesis = after.slice(); hypothesis[5] = { ...hypothesis[5], type };
      if (legalMoves(hypothesis, 5).includes(move.to))
        assert.equal(combat(type, 'regiment'), type === 'company' ? 'lose' : 'win');
    }
  }
});

test('a probabilistic flag guard remains available to deeper search instead of forcing an engineer sacrifice', () => {
  const f = JSON.parse(readFileSync(new URL('./fixtures/endgame-probabilistic-guard.json', import.meta.url)));
  const rng = () => seeded(createHash('sha256').update(f.rngParts.join(':')).digest().readUInt32LE());
  const beliefs = inferBeliefs(f.observation, { samples: 256, rng: rng() });
  const defended = f.observation.board.slice(); defended[9] = defended[44]; defended[44] = null;
  const risk = publicDanger(defended, beliefs, 'ai').approachRisk;
  assert.ok(risk > 0 && risk < 1, 'the unknown attacker presents a probability, not a certain lost flag');
  for (const nodeLimit of [0, Infinity]) {
    const move = chooseMove(f.observation, 'hell', rng(), null, f.context, { clock: () => 0, maxDepth: 6, nodeLimit });
    assert.deepEqual({ from: move.from, to: move.to }, { from: 44, to: 9 });
    assert.equal(move.info.diagnostics.provenWin, false);
    assert.equal(move.info.searchDepth, nodeLimit === 0 ? 0 : 6);
  }
});
