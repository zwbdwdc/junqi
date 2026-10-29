import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLayout, TYPES, randomLayout, roadEdges, isHQ, legalMoves } from '../dist/engine.js';
import { createAILayout, permanentlyTrappedUnits } from '../dist/formations.js';

function seeded(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const signature = board => board.map(p => p?.type ?? '-').join(',');
const row = i => Math.floor(i / 5);
const col = i => i % 5;
const sample = Object.fromEntries(['professional', 'hell'].map(level => [level,
  Array.from({ length: 100 }, (_, i) => createAILayout(level, seeded(i + 90210)))]));

// Deployment-only oracle independent of the planner: another movable friend
// can eventually clear a road, while own mines and headquarters cannot.
const important = piece => (TYPES[piece.type].rank || 0) >= 4 || ['bomb','engineer'].includes(piece.type);
function sealedImportant(board) {
  return board.flatMap((piece,at) => {
    if(!piece || isHQ(at) || !important(piece))return [];
    const exits=roadEdges.flatMap(([a,b])=>a===at?[b]:b===at?[a]:[]);
    return exits.some(to=>!board[to] || !isHQ(to)&&!['mine','flag'].includes(board[to].type)) ? [] : [at];
  });
}

test('important units retain an eventual exit through the own mine and HQ screen',()=>{
  for(const boards of Object.values(sample))for(const board of boards)assert.deepEqual(sealedImportant(board),[]);
  for(const level of ['professional','hell'])for(const value of [0,.5,1,NaN]){
    const board=createAILayout(level,()=>value);
    assert.deepEqual(validateLayout(board,'ai'),[]);assert.deepEqual(sealedImportant(board),[]);
  }
});

test('temporary friendly congestion is distinct from permanent self-blocking',()=>{
  for(const type of ['commander','general','division','brigade','regiment','battalion','bomb','engineer']){
    const board=Array(60).fill(null);
    for(const [at,kind] of [[1,'flag'],[2,type],[3,'company'],[7,'mine']])board[at]={id:String(at),side:'ai',type:kind};
    assert.deepEqual(permanentlyTrappedUnits(board),[2]);
    board[7]={...board[7],type:'platoon'};
    assert.deepEqual(legalMoves(board,2),[]);assert.deepEqual(permanentlyTrappedUnits(board),[]);
    assert.ok(legalMoves(board,7).includes(12));board[12]=board[7];board[7]=null;
    assert.ok(legalMoves(board,2).includes(7));
  }
});

test('both levels produce complete legal 60-point AI layouts with opaque unique IDs', () => {
  for (const [level, boards] of Object.entries(sample)) {
    for (const board of boards) {
      assert.equal(board.length, 60, level);
      assert.deepEqual(validateLayout(board, 'ai'), [], level);
      assert.ok(board.slice(30).every(p => p === null));
      assert.equal(new Set(board.filter(Boolean).map(p => p.id)).size, 25);
      board.forEach((p, i) => {
        if (!p) return;
        assert.equal(p.origin, i);
        assert.equal(p.moved, false);
        assert.ok(!Object.keys(TYPES).some(type => p.id.includes(type)));
      });
    }
  }
});

test('every level has high rank-layout diversity and deploys flags in both headquarters', () => {
  for (const [level, boards] of Object.entries(sample)) {
    assert.ok(new Set(boards.map(signature)).size >= 95, `${level} must not cycle through fixed templates`);
    const left = boards.filter(board => board[1].type === 'flag').length;
    assert.ok(left >= 20 && left <= 80, `${level}: ${left} left flags`);
    // Even on a fixed flag side, no movable front-line square is one predetermined identity.
    for (const i of [25, 26, 27, 28, 29]) {
      assert.ok(new Set(boards.filter(b => b[1].type === 'flag').map(b => b[i].type)).size >= 4);
    }
  }
});

test('stronger levels freeze only expendable HQ defenders and retain dispersed engineer reserves', () => {
  for (const level of ['professional', 'hell']) {
    for (const board of sample[level]) {
      const nonFlagHQ = board[1].type === 'flag' ? 3 : 1;
      assert.ok(['mine', 'company', 'platoon'].includes(board[nonFlagHQ].type));
      const engineers = board.flatMap((p, i) => p?.type === 'engineer' ? [i] : []);
      assert.ok(engineers.some(i => row(i) >= 1 && row(i) <= 3));
      if (level === 'hell') assert.ok(new Set(engineers.map(col)).size >= 2);
    }
  }
});

test('professional and hell deployments protect major officers and mix front-line strength more than unstructured random layouts', () => {
  const facts = boards => boards.reduce((sum, board) => {
    sum.backBig += board.slice(0, 5).filter(p => p && TYPES[p.type].rank >= 7).length;
    sum.frontOfficers += board.slice(25, 30).filter(p => p && TYPES[p.type].rank >= 4).length;
    const flag = board[1].type === 'flag' ? 1 : 3;
    sum.guards += [flag - 1, flag + 1, flag + 5].filter(i => board[i].type === 'mine').length;
    return sum;
  }, { backBig: 0, frontOfficers: 0, guards: 0 });
  const basic = facts(Array.from({length:100},(_,i)=>randomLayout('ai',seeded(i+90210))));
  for (const level of ['professional', 'hell']) {
    const strategy = facts(sample[level]);
    assert.ok(strategy.backBig < basic.backBig * 0.35, `${level}: avoid trapping major officers on the rear row`);
    assert.ok(strategy.frontOfficers > basic.frontOfficers + 15, `${level}: organize an officer screen`);
    assert.ok(strategy.guards > basic.guards + 20, `${level}: guard likely flag approaches`);
  }
});

test('hell layouts vary their mine screen, flag side and frontline instead of revealing a fixed strategy', () => {
  const guardPatterns = new Set();
  const guardCounts = new Set();
  for (const board of sample.hell) {
    const flag = board[1].type === 'flag' ? 1 : 3;
    const mask = [flag - 1, flag + 1, flag + 5].map(i => board[i].type === 'mine' ? 1 : 0);
    guardPatterns.add(mask.join(''));
    guardCounts.add(mask.reduce((a, b) => a + b, 0));
  }
  assert.ok(guardPatterns.size >= 5);
  assert.ok(guardCounts.size >= 3);
  assert.ok(sample.hell.some(b => [0, 2, 6].some(i => b[i].type !== 'mine') && b[1].type === 'flag'));
});

test('deployment depends only on difficulty and supplied randomness, never on a human layout', () => {
  const forbidden = new Proxy({}, { get() { throw new Error('human secret was accessed'); }, ownKeys() { throw new Error('human secret was read'); } });
  for (const level of ['professional', 'hell']) {
    const a = createAILayout(level, seeded(1789));
    const b = createAILayout(level, seeded(1789), forbidden);
    assert.equal(signature(a), signature(b));
    // Tokens remain fresh even when a test deliberately repeats the arrangement RNG seed.
    assert.notEqual(a.filter(Boolean)[0].id, b.filter(Boolean)[0].id);
  }
  assert.equal(signature(createAILayout('unknown', seeded(7))), signature(createAILayout('professional', seeded(7))));
});
