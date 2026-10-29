import test from 'node:test';
import assert from 'node:assert/strict';
import { decisionDiagnostics } from '../dist/ai-context.js';

const phaseKeys = ['resignationCheckMs', 'searchTimeLimitMs'];

test('saved worker timings retain resignation duration and the remaining search budget', () => {
  // ai-worker reports total wall time separately from its split phase budget.
  const info = Object.freeze({ diagnostics: Object.freeze({
    elapsedMs: 5001, timeLimitMs: 5000,
    resignationCheckMs: 240.32, searchTimeLimitMs: 4759.682400000001,
  }) });
  const saved = decisionDiagnostics(info);
  assert.equal(saved.elapsedMs, 5001);
  assert.equal(saved.timeLimitMs, 5000);
  assert.equal(saved.resignationCheckMs, 240.32);
  assert.equal(saved.searchTimeLimitMs, 4759.682400000001);
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), saved, 'archive serialization retains both values');
});

test('legacy and missing phase timings remain unknown instead of becoming measured zero', () => {
  for (const info of [undefined, null, {}, { diagnostics: null },
    { diagnostics: { elapsedMs: 5000, timeLimitMs: 5000 } }]) {
    const saved = decisionDiagnostics(info);
    for (const key of phaseKeys) assert.equal(saved[key], null, key);
    const restored = JSON.parse(JSON.stringify(saved));
    for (const key of phaseKeys) assert.equal(restored[key], null, key);
  }
  const partial = decisionDiagnostics({ diagnostics: { resignationCheckMs: 1.25 } });
  assert.equal(partial.resignationCheckMs, 1.25);
  assert.equal(partial.searchTimeLimitMs, null, 'missing budget must not be derived from another field');
});

test('phase timing whitelist rejects invalid and unrepresentable durations without coercion', () => {
  const invalid = [undefined, null, NaN, Infinity, -Infinity, -0.01, -1, '240.32', true,
    {}, [], 12n, Number.MAX_VALUE, Number.MAX_SAFE_INTEGER + 1];
  for (const key of phaseKeys) for (const value of invalid) {
    const saved = decisionDiagnostics({ diagnostics: { [key]: value } });
    assert.equal(saved[key], null, `${key}: ${String(value)}`);
    assert.doesNotThrow(() => JSON.stringify(saved));
  }
});

test('zero search budget and real overruns are retained without hiding them at nominal limits', () => {
  const saved = decisionDiagnostics({ diagnostics: {
    elapsedMs: 5007, timeLimitMs: 5000, resignationCheckMs: 5006.51, searchTimeLimitMs: 0,
  } });
  assert.equal(saved.resignationCheckMs, 5006.51, 'duration can exceed the normal proof budget during a stall');
  assert.equal(saved.searchTimeLimitMs, 0, 'zero is a measured exhausted budget, not missing data');
  for (const key of phaseKeys) {
    assert.equal(decisionDiagnostics({ diagnostics: { [key]: 0 } })[key], 0);
    assert.equal(decisionDiagnostics({ diagnostics: { [key]: Number.MAX_SAFE_INTEGER } })[key], Number.MAX_SAFE_INTEGER);
  }
});

test('adding phase timings does not copy arbitrary worker fields or mutate an archived legacy record', () => {
  const legacy = { expectedScore: 7, diagnostics: { elapsedMs: 901, timeLimitMs: 900,
    trueBoard: [{ type: 'commander' }], hiddenIdentities: { enemy: 'flag' } } };
  const before = JSON.stringify(legacy), saved = decisionDiagnostics(legacy);
  assert.equal(JSON.stringify(legacy), before);
  assert.equal(saved.expectedScore, 7);
  assert.equal(Object.hasOwn(saved, 'trueBoard'), false);
  assert.equal(Object.hasOwn(saved, 'hiddenIdentities'), false);
  assert.equal(saved.resignationCheckMs, null);
  assert.equal(saved.searchTimeLimitMs, null);
});
