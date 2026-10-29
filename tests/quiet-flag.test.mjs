import test from 'node:test';
import assert from 'node:assert/strict';
import { quietFlagMate, fastFlagExposed, createFlagDrawGuard } from '../dist/quiet-flag.js';
import { tacticalSearch } from '../dist/ai.js';
import { legalMoves, TYPES } from '../dist/engine.js';

const unit = (id, side, type) => ({ id, side, type, moved: true });
const other = side => side === 'ai' ? 'human' : 'ai';
function board() {
  const b = Array(62).fill(null);
  b[3] = unit('fa', 'ai', 'flag'); b[58] = unit('fh', 'human', 'flag');
  b[8] = unit('h', 'human', 'company'); b[14] = unit('a', 'ai', 'platoon');
  return b;
}
const statistics = () => ({ nodes: 0, replies: 0, flagDrawGuard: createFlagDrawGuard() });
const check = () => {};

test('HQ adjacency matches complete legal flag attacks, including abnormal non-HQ flags', () => {
  const reference = (b, side) => {
    const at = b.findIndex(p => p?.side === side && p.type === 'flag');
    return at >= 0 && b.some((p, from) => p && p.side !== side && legalMoves(b, from).includes(at));
  };
  for (const size of [60, 62]) for (const side of ['ai', 'human'])
    for (const flag of [1, 3, 56, 58, 7, 17]) for (let from = 0; from < size; from++)
      for (const type of Object.keys(TYPES)) {
        if (from === flag) continue;
        const b = Array(size).fill(null);
        b[flag] = unit('f', side, 'flag'); b[from] = unit('e', other(side), type);
        assert.equal(fastFlagExposed(b, side), reference(b, side));
      }
  let seed = 17;
  const rng = () => ((seed = Math.imul(seed, 1664525) + 1013904223 | 0) >>> 0) / 4294967296;
  const types = Object.keys(TYPES).filter(type => type !== 'flag');
  for (let i = 0; i < 2000; i++) {
    const b = Array(i % 2 ? 60 : 62).fill(null);
    for (let at = 0; at < b.length; at++) if (rng() < .45)
      b[at] = unit(`p${at}`, rng() < .5 ? 'ai' : 'human', types[Math.floor(rng() * types.length)]);
    b[1] = unit('fa', 'ai', 'flag'); b[58] = unit('fh', 'human', 'flag');
    for (const side of ['ai', 'human']) assert.equal(fastFlagExposed(b, side), reference(b, side));
  }
});

test('quiet mate requires every legal defence to fail', () => {
  assert.equal(quietFlagMate(board(), 'human', 3, statistics(), check), true);
  const b = board(); b[14] = null; b[13] = unit('r', 'ai', 'regiment');
  assert.equal(quietFlagMate(b, 'human', 3, statistics(), check), false);
});

test('countercapture of flag and no-moves counterwin refute quiet mate', () => {
  let b = board(); b[53] = unit('e', 'ai', 'engineer');
  assert.equal(quietFlagMate(b, 'human', 3, statistics(), check), false);
  b = board(); b[14] = null; b[13] = unit('bomb', 'ai', 'bomb');
  assert.equal(quietFlagMate(b, 'human', 3, statistics(), check), false);
  b = board(); b[14] = null;
  assert.equal(quietFlagMate(b, 'human', 3, statistics(), check), false,
    'existing immediate no-moves terminal belongs to the caller');
});

test('quiet or possible repetition draws refute the extended mate', () => {
  for (const quiet of [99, 100]) assert.equal(quietFlagMate(board(), 'human', quiet, statistics(), check), false);
  const observation = { side: 'ai', board: board(),
    ownRoster: [{ id: 'fa', type: 'flag', origin: 3 }, { id: 'a', type: 'platoon', origin: 14 }],
    enemyRoster: [{ id: 'fh', origin: 58 }, { id: 'h', origin: 7 }], history: [] };
  observation.history = [[7, 8, 'human', 'h'], [14, 19, 'ai', 'a'], [8, 7, 'human', 'h'], [19, 14, 'ai', 'a'],
    [7, 8, 'human', 'h'], [14, 19, 'ai', 'a'], [8, 7, 'human', 'h'], [19, 14, 'ai', 'a']]
    .map(([from, to, side, attackerId]) => ({ from, to, side, attackerId, result: 'move' }));
  const stats = statistics(); stats.flagDrawGuard = createFlagDrawGuard(observation);
  assert.equal(quietFlagMate(board(), 'human', 9, stats, check), false);
});

test('quiet attack survives cache toggles without reusing ordinary leaf values', () => {
  const before = board(); before[5] = before[8]; before[8] = null;
  const config = { beam: 5, rootDepth: 1, qDepth: 2 };
  const stats = { nodes: 0, replies: 0, table: new Map(),
    control: { now: () => 0, deadline: Infinity, nodeLimit: 1000000 } };
  const ordinary = tacticalSearch(before, 'human', 1, config, stats);
  const enabled = { ...config, quietFlagExtension: true };
  const extended = tacticalSearch(before, 'human', 1, enabled, stats);
  const uncached = tacticalSearch(before, 'human', 1, enabled, { ...stats, table: null });
  assert.ok(ordinary < 100); assert.equal(extended, 47045); assert.equal(uncached, extended);
  assert.equal(stats.flagDrawGuard.depth(), 0);
});

test('budget interruption never accepts a partial defence proof and unwinds search history', () => {
  const before = board(); before[5] = before[8]; before[8] = null;
  const stats = { nodes: 0, replies: 0, table: new Map(),
    control: { now: () => 0, deadline: Infinity, nodeLimit: 2 } };
  assert.throws(() => tacticalSearch(before, 'human', 1,
    { beam: 5, rootDepth: 1, qDepth: 2, quietFlagExtension: true }, stats));
  assert.equal(stats.flagDrawGuard.depth(), 0);
  const exhausted = statistics();
  assert.throws(() => quietFlagMate(board(), 'human', 3, exhausted, () => { throw new Error('budget'); }));
  assert.equal(exhausted.flagThreatMates || 0, 0);
});
