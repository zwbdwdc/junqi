import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chooseMove, DIFFICULTIES, inferBeliefs, flagPreparation } from '../dist/ai.js';
import { legalMoves } from '../dist/engine.js';
import { decisionDiagnostics } from '../dist/ai-context.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/player-endgame-20261013.json', import.meta.url)));
const observation = fixture.observation;
const seeded = initial => { let seed = initial; return () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296); };

test('both levels actually enable the short flag-route warning on the recorded public endgame', () => {
  assert.equal(fixture.sourcePly, 131);
  assert.equal(observation.board[58].type, 'flag');
  assert.equal(observation.board[30].type, null, 'the player company must remain unknown');
  const beliefs = inferBeliefs(observation, { samples: 160, rng: seeded(131) });
  for (const level of Object.values(DIFFICULTIES)) {
    const risk = flagPreparation(observation.board, beliefs, 'ai', new Map(), level.routeDepth).route;
    assert.ok(risk > 0.1, 'the configured detector must see the live threat, not silently disable all its routes');
  }
});

test('the recorded final engineer shuffle is rejected without exposing the player ranks', () => {
  const original = JSON.stringify(observation);
  for (const level of ['professional', 'hell']) for (const seed of [131, 20261013]) {
    const move = chooseMove(observation, level, seeded(seed), null, null, { clock: () => 0, maxDepth: 4 });
    assert.ok(legalMoves(observation.board, move.from).includes(move.to));
    assert.notDeepEqual([move.from, move.to], [36, 42], 'the original move abandoned the attack and left the return railway blocked');
    const after = observation.board.slice();
    after[move.to] = after[move.from]; after[move.from] = null;
    assert.ok((move.from === 46 && move.to === 52) || legalMoves(after, 49).includes(9),
      `clear the regiment's actual return railway or advance the flag route, got ${move.from}->${move.to}`);
    assert.equal(move.info.diagnostics.flagPlannerEnabled, true);
    assert.ok(move.info.diagnostics.retainedFlagAdvance, 'an attack continuation must reach the search comparison');
  }
  assert.equal(JSON.stringify(observation), original, 'planning must not fill in unknown ranks in its input');
});

test('archived offensive decisions preserve bounded public facts without hidden boards or arbitrary plans', () => {
  const saved = decisionDiagnostics({ diagnostics: {
    flagPlannerEnabled: true, flagAttackProgress: 999, flagAttackTurns: 3,
    retainedFlagAdvance: { from: 46, to: 52, hiddenRank: 'commander' },
    flagPlannerReason: 'private text', flagPlannerNodes: 999999, trueBoard: ['private'],
  } });
  assert.equal(saved.flagAttackProgress, 256); assert.equal(saved.flagAttackTurns, 3);
  assert.equal(saved.flagPlannerNodes, 12000); assert.equal(saved.flagPlannerReason, null);
  assert.deepEqual(saved.retainedFlagAdvance, { from: 46, to: 52 });
  assert.equal(Object.hasOwn(saved, 'trueBoard'), false);
  assert.equal(decisionDiagnostics({ diagnostics: { retainedFlagAdvance: { from: -1, to: 52 }, flagAttackTurns: 999 } }).retainedFlagAdvance, null);
});
