import test from 'node:test';
import assert from 'node:assert/strict';
import { TYPES, randomLayout, createGame, makeObservation, legalMoves, applyMove, isMountain, mountainNeighbors } from '../dist/engine.js';
import { chooseMove, inferDomains, inferBeliefs, sampleHiddenLayouts } from '../dist/ai.js';

function seeded(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function game(seed = 123) {
  const rng = seeded(seed);
  return createGame(randomLayout('human', rng), randomLayout('ai', rng));
}
function choices(state) {
  return state.board.flatMap((p, from) => p?.side === state.turn ? legalMoves(state.board, from).map(to => ({ from, to })) : []);
}

test('fairness: changing every hidden rank behind an identical observation cannot change the move', () => {
  const first = game();
  const second = structuredClone(first);
  const a = second.board.findIndex(p => p?.side === 'human' && p.type === 'general');
  const b = second.board.findIndex(p => p?.side === 'human' && p.type === 'division');
  [second.board[a].type, second.board[b].type] = [second.board[b].type, second.board[a].type];
  [second.initial[a].type, second.initial[b].type] = [second.initial[b].type, second.initial[a].type];
  const visibleA = makeObservation(first, 'ai'), visibleB = makeObservation(second, 'ai');
  assert.deepEqual(visibleA, visibleB);
  assert.ok(visibleA.board.filter(p => p?.side === 'human').every(p => p.type === null));
  for (const difficulty of ['professional', 'hell']) {
    const searchOptions = { clock: () => 0, nodeLimit: 20000, maxDepth: 4 };
    const moveA = chooseMove(visibleA, difficulty, seeded(81), null, null, searchOptions);
    const moveB = chooseMove(visibleB, difficulty, seeded(81), null, null, searchOptions);
    assert.deepEqual(moveA, moveB);
    assert.ok(legalMoves(first.board, moveA.from).includes(moveA.to));
  }
});

test('all sampled armies retain the exact 25 initial counts, including an unknown dead piece', () => {
  const observation = makeObservation(game(45), 'ai');
  const deadAt = observation.board.findIndex(p => p?.side === 'human' && p.origin === 30);
  const deadId = observation.board[deadAt].id;
  observation.board[deadAt] = null;
  const beliefs = inferBeliefs(observation, { samples: 32, rng: seeded(55) });
  assert.ok(beliefs.worlds.length >= 32, 'include valid witness layouts when random samples miss a feasible identity');
  assert.ok(beliefs.domains[deadId].length > 1, 'unknown death does not disclose the dead rank');
  for (const world of beliefs.worlds) {
    assert.equal(Object.keys(world).length, 25);
    assert.ok(world[deadId]);
    for (const [type, spec] of Object.entries(TYPES)) {
      assert.equal(Object.values(world).filter(t => t === type).length, spec.count);
      assert.ok(Math.abs(Object.values(beliefs.probabilities).reduce((sum, probabilities) => sum + probabilities[type], 0) - spec.count) < 1e-7);
    }
  }
});

test('only public move evidence identifies a turning engineer and excludes immovable types', () => {
  const state = game(46);
  const observation = makeObservation(state, 'ai');
  const engineerAt = state.board.findIndex(p => p?.side === 'human' && p.type === 'engineer');
  const engineer = observation.board[engineerAt];
  const other = observation.board.find(p => p?.side === 'human' && p.id !== engineer.id && p.origin >= 50 && ![56, 58].includes(p.origin));
  engineer.moved = true; other.moved = true;
  observation.history = [{ side: 'human', from: 30, to: 54, attackerId: engineer.id, defenderId: null,
    result: 'move', engineerTurn: true, flagRevealed: [] }];
  const domains = inferDomains(observation);
  assert.deepEqual(domains[engineer.id], ['engineer']);
  assert.ok(!domains[other.id].includes('flag'));
  assert.ok(!domains[other.id].includes('mine'));
});

test('public battle evidence never rules out the real rank over played legal games', () => {
  for (let seed = 1; seed <= 5; seed++) {
    const rng = seeded(seed + 300);
    let state = game(seed);
    for (let ply = 0; ply < 140 && !state.result; ply++) {
      const all = choices(state);
      const attacks = all.filter(move => state.board[move.to]);
      const pool = attacks.length && rng() < 0.8 ? attacks : all;
      const move = pool[Math.floor(rng() * pool.length)];
      state = applyMove(state, move.from, move.to);
      for (const side of ['ai', 'human']) {
        const observation = makeObservation(state, side);
        const domains = inferDomains(observation);
        for (const piece of state.initial.filter(p => p && p.side !== side))
          assert.ok(domains[piece.id].includes(piece.type), `seed ${seed}, ply ${ply}, ${piece.type} must remain possible`);
        if (ply % 17 === 0) assert.equal(sampleHiddenLayouts(observation, 3, rng, domains).length, 3);
      }
    }
  }
});

test('both levels return legal moves after captures and search opponent replies', () => {
  let state = game(5);
  const rng = seeded(90);
  for (let ply = 0; ply < 65 && !state.result; ply++) {
    const all = choices(state);
    const attacks = all.filter(move => state.board[move.to]);
    const pool = attacks.length ? attacks : all;
    const selected = pool[Math.floor(rng() * pool.length)];
    state = applyMove(state, selected.from, selected.to);
    if (state.result || ply % 13) continue;
    const observation = makeObservation(state, state.turn);
    for (const difficulty of ['professional', 'hell']) {
      // Check reply-search correctness independently of concurrent test load.
      // Real worker wall-clock budgets are checked by the packaged smoke QA.
      const move = chooseMove(observation, difficulty, seeded(991), null, null,
        { clock: () => 0, nodeLimit: 100000, maxDepth: 4 });
      assert.ok(move && state.board[move.from].side === state.turn);
      assert.ok(legalMoves(state.board, move.from).includes(move.to));
      assert.equal(move.info.beliefConsistent, true);
      assert.ok(move.info.searchWorlds > 0 && move.info.searchedReplies > 0);
      assert.ok([2, 4, 6, 8].includes(move.info.searchDepth));
      assert.equal(move.info.searchDepth, move.info.diagnostics.completedDepth);
      assert.ok(move.info.diagnostics.attemptedDepth >= move.info.searchDepth);
    }
  }
});

test('a visible undefended enemy flag is captured at every difficulty', () => {
  const state = game(88);
  const observation = makeObservation(state, 'ai');
  const own = observation.board.find(p => p?.side === 'ai' && p.type === 'platoon');
  const enemyFlag = state.board.find(p => p?.side === 'human' && p.type === 'flag');
  observation.board.fill(null);
  observation.board[51] = { ...own, moved: true };
  observation.board[56] = { ...enemyFlag, type: 'flag' };
  observation.revealedFlags.human = true;
  for (const difficulty of ['professional', 'hell']) {
    assert.equal(chooseMove(observation, difficulty, seeded(17)).to, 56);
  }
});

test('hell reply search sacrifices a bomb to stop the next-turn capture of its own flag', () => {
  const state = game(22);
  const observation = makeObservation(state, 'ai');
  const ownFlag = observation.board.find(p => p?.side === 'ai' && p.type === 'flag');
  const bomb = observation.board.find(p => p?.side === 'ai' && p.type === 'bomb');
  const platoon = observation.board.find(p => p?.side === 'ai' && p.type === 'platoon');
  const enemyEngineer = state.board.find(p => p?.side === 'human' && p.type === 'engineer');
  const enemyBattalion = state.board.find(p => p?.side === 'human' && p.type === 'battalion');
  const enemyFlag = state.board.find(p => p?.side === 'human' && p.type === 'flag');
  observation.board.fill(null);
  observation.board[1] = ownFlag;
  observation.board[5] = bomb;
  observation.board[29] = platoon;
  observation.board[6] = { ...enemyEngineer, type: null, moved: true };
  observation.board[50] = { ...enemyBattalion, type: null, moved: true };
  observation.board[56] = { ...enemyFlag, type: 'flag' };
  observation.history = [{ side: 'human', from: 34, to: 6, attackerId: enemyEngineer.id,
    defenderId: null, result: 'move', engineerTurn: true, flagRevealed: [] }];
  const move = chooseMove(observation, 'hell', seeded(992));
  assert.deepEqual({ from: move.from, to: move.to }, { from: 5, to: 6 });
  assert.ok(move.info.searchedReplies > 0);
});

test('62-node observation infers a protected mountain engineer and every difficulty legally leaves the mountain', () => {
  const rng = seeded(103);
  const state = createGame(randomLayout('human', rng), randomLayout('ai', rng), { engineerMountains: true });
  const aiEngineer = state.board.find(p => p?.side === 'ai' && p.type === 'engineer');
  const humanEngineer = state.board.find(p => p?.side === 'human' && p.type === 'engineer');
  const flags = state.board.filter(p => p?.type === 'flag');
  state.board.fill(null);
  state.board[60] = { ...aiEngineer, moved: true };
  state.board[61] = { ...humanEngineer, moved: true };
  for (const flag of flags) state.board[flag.origin] = flag;
  const observation = makeObservation(state, 'ai');
  assert.equal(observation.board.length, 62);
  assert.equal(observation.board[61].type, null);
  assert.deepEqual(inferDomains(observation)[humanEngineer.id], ['engineer']);
  for (const difficulty of ['professional', 'hell']) {
    const move = chooseMove(observation, difficulty, seeded(104));
    assert.equal(move.from, 60);
    assert.ok(mountainNeighbors[60].includes(move.to));
    assert.ok(legalMoves(state.board, move.from).includes(move.to));
    assert.notEqual(move.to, 61, 'a protected mountain piece cannot be captured');
    assert.equal(move.info.beliefConsistent, true);
  }
});

test('mountain variant AI uses a legal shelter in actual play and public mountain moves identify engineers', () => {
  const rng = seeded(774);
  let state = createGame(randomLayout('human', rng), randomLayout('ai', rng), { engineerMountains: true });
  let entry = null;
  for (let ply = 0; ply < 35 && !state.result; ply++) {
    const side = state.turn;
    const move = chooseMove(makeObservation(state, side), 'professional', rng);
    assert.ok(legalMoves(state.board, move.from).includes(move.to));
    state = applyMove(state, move.from, move.to);
    if (isMountain(move.to)) {
      entry = state.history.at(-1);
      const opponentSide = side === 'ai' ? 'human' : 'ai';
      const observation = makeObservation(state, opponentSide);
      assert.equal(observation.board[move.to].type, 'engineer');
      assert.equal(entry.engineerTurn, true);
      assert.deepEqual(inferDomains(observation)[entry.attackerId], ['engineer']);
      break;
    }
  }
  assert.ok(entry, 'the AI should consider a safe mountain entrance, not discard node 60/61');
});


test('public engineer identity remains known in the roster after a fatal turning attack', () => {
  const state=game(774), observation=makeObservation(state,'ai');
  const engineer=state.board.find(p=>p?.side==='human'&&p.type==='engineer');
  const commander=state.board.find(p=>p?.side==='ai'&&p.type==='commander');
  observation.board=observation.board.map(p=>p?.id===engineer.id?null:p);
  observation.history=[{ply:1,side:'human',from:54,to:5,attackerId:engineer.id,defenderId:commander.id,result:'lose',engineerTurn:true,mountainMove:false,flagRevealed:[]}];
  assert.deepEqual(inferDomains(observation)[engineer.id],['engineer']);
});
