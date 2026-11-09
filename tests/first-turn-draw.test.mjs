import test from 'node:test';
import assert from 'node:assert/strict';
import { drawFirstTurn } from '../dist/first-turn.js';

test('every random byte assigns exactly half the outcomes to each first mover', () => {
  const totals = { human: 0, ai: 0 };
  for (let value = 0; value < 256; value++) {
    let calls = 0;
    const side = drawFirstTurn({ getRandomValues(bytes) {
      calls++;
      assert.ok(bytes instanceof Uint8Array);
      assert.equal(bytes.length, 1);
      bytes[0] = value;
      return bytes;
    } });
    assert.equal(calls, 1);
    assert.equal(side, value < 128 ? 'human' : 'ai');
    totals[side]++;
  }
  assert.deepEqual(totals, { human: 128, ai: 128 });
});
