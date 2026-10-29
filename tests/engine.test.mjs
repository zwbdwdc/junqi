import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROWS, COLS, TYPES, isCamp, isHQ, isMountain, mountainNeighbors, roadEdges, railEdges,
  canPlace, randomLayout, validateLayout, legalMoves, combat,
  createGame, applyMove, makeObservation, revealedEngineerIds,
} from '../dist/engine.js';

const at = (r, c) => r * COLS + c;
const boardOf = (entries, length = 60) => {
  const board = Array(length).fill(null);
  entries.forEach(([i, side, type], n) => { board[i] = { id: `test-${n}`, side, type, origin: i, moved: false }; });
  return board;
};
function stateOf(entries, turn = 'human', engineerMountains = false) {
  const board = boardOf(entries, engineerMountains ? 62 : 60);
  return {
    board, initial: board.map(p => p ? { ...p } : null), turn, ply: 0, quiet: 0,
    result: null, history: [], revealedFlags: { human: false, ai: false }, repetitions: {},
    rules: { engineerMountains },
  };
}

test('piece roster, camps, headquarters and three mountain passages match two-player board', () => {
  assert.equal(ROWS * COLS, 60);
  assert.equal(Object.values(TYPES).reduce((s, p) => s + p.count, 0), 25);
  assert.equal(Array.from({ length: 60 }, (_, i) => i).filter(isCamp).length, 10);
  assert.equal(Array.from({ length: 60 }, (_, i) => i).filter(isHQ).length, 4);
  assert.deepEqual(roadEdges.filter(([a, b]) => Math.floor(a / 5) === 5 && Math.floor(b / 5) === 6), [[25, 30], [27, 32], [29, 34]]);
  assert.equal(railEdges.length, 35);
});

test('placement restrictions enforce camp, side, flag HQ, mines rear and bombs front', () => {
  for (const side of ['human', 'ai']) {
    const front = side === 'human' ? 6 : 5;
    const back = side === 'human' ? 11 : 0;
    assert.equal(canPlace('bomb', side, at(front, 0)), false);
    assert.equal(canPlace('commander', side, at(front, 0)), true);
    assert.equal(canPlace('mine', side, at(front, 0)), false);
    assert.equal(canPlace('mine', side, at(back, 0)), true);
    assert.equal(canPlace('flag', side, at(back, 1)), true);
    assert.equal(canPlace('flag', side, at(back, 0)), false);
    assert.equal(canPlace('engineer', side, at(2, 1)), false);
    assert.equal(canPlace('commander', side, at(7, 1)), false);
    assert.equal(canPlace('commander', side === 'human' ? 'ai' : 'human', at(front, 0)), false);
  }
});

test('500 seeded random layouts are legal, complete and IDs reveal no ranks', () => {
  let seed = 614;
  const rng = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  for (let n = 0; n < 500; n++) {
    const side = n % 2 ? 'human' : 'ai', board = randomLayout(side, rng);
    assert.deepEqual(validateLayout(board, side), []);
    assert.equal(board.filter(Boolean).length, 25);
    assert.equal(new Set(board.filter(Boolean).map(p => p.id)).size, 25);
    assert.ok(board.filter(Boolean).every(p => !p.id.includes(p.type)));
  }
});

test('ordinary road steps and camp diagonals; no other diagonal movement', () => {
  const board = boardOf([[at(3, 1), 'human', 'company']]);
  const moves = legalMoves(board, at(3, 1));
  assert.ok(moves.includes(at(3, 2)));
  assert.ok(moves.includes(at(4, 1)));
  assert.ok(!moves.includes(at(4, 2)));
  const camp = boardOf([[at(3, 2), 'human', 'company']]);
  assert.equal(legalMoves(camp, at(3, 2)).length, 8);
  assert.ok(legalMoves(camp, at(3, 2)).includes(at(2, 1)));
});

test('camps protect occupied tokens from attack but allow entry while empty', () => {
  const board = boardOf([[at(3, 1), 'human', 'commander'], [at(3, 2), 'ai', 'engineer']]);
  assert.ok(!legalMoves(board, at(3, 1)).includes(at(3, 2)));
  board[at(3, 2)] = null;
  assert.ok(legalMoves(board, at(3, 1)).includes(at(3, 2)));
});

test('all pieces become immobile in HQ; mines and flags are always immobile', () => {
  for (const type of Object.keys(TYPES)) {
    assert.deepEqual(legalMoves(boardOf([[56, 'human', type]]), 56), []);
  }
  for (const type of ['mine', 'flag']) {
    assert.deepEqual(legalMoves(boardOf([[40, 'human', type]]), 40), []);
  }
  assert.ok(legalMoves(boardOf([[51, 'human', 'company']]), 51).includes(56));
});

test('ordinary railway movement is straight and cannot pass through pieces', () => {
  const board = boardOf([[25, 'human', 'company'], [28, 'ai', 'engineer'], [15, 'human', 'company']]);
  const moves = legalMoves(board, 25);
  assert.ok(moves.includes(28));
  assert.ok(!moves.includes(29));
  assert.ok(moves.includes(20));
  assert.ok(!moves.includes(15));
  assert.ok(!moves.includes(10));
  assert.ok(moves.includes(50));
  assert.ok(!moves.includes(54));
  assert.ok(!moves.includes(32));
});

test('engineers turn on connected railways without crossing occupied nodes', () => {
  const board = boardOf([[25, 'human', 'engineer']]);
  const moves = legalMoves(board, 25);
  assert.ok(moves.includes(54));
  assert.ok(moves.includes(32));
  // Block all three exits from the starting rail intersection.
  board[20] = { id: 'x', side: 'human', type: 'company' };
  board[26] = { id: 'y', side: 'human', type: 'company' };
  board[30] = { id: 'z', side: 'human', type: 'company' };
  assert.deepEqual(legalMoves(board, 25), [21]);
});

test('no moves cross the blocked two mountain columns', () => {
  for (const c of [1, 3]) {
    const from = at(5, c), to = at(6, c);
    const board = boardOf([[from, 'human', 'company']]);
    assert.ok(!legalMoves(board, from).includes(to));
  }
  assert.ok(legalMoves(boardOf([[27, 'human', 'company']]), 27).includes(32));
});

test('referee covers all officer ranks, bombs, mines, engineers and flags', () => {
  const ordinary = Object.keys(TYPES).filter(t => TYPES[t].rank > 0);
  for (const a of ordinary) {
    for (const d of ordinary) {
      assert.equal(combat(a, d), TYPES[a].rank > TYPES[d].rank ? 'win' : TYPES[a].rank < TYPES[d].rank ? 'lose' : 'both');
    }
    assert.equal(combat(a, 'flag'), 'win');
    assert.equal(combat(a, 'mine'), a === 'engineer' ? 'win' : 'lose');
    assert.equal(combat(a, 'bomb'), 'both');
    assert.equal(combat('bomb', a), 'both');
  }
  assert.equal(combat('bomb', 'mine'), 'both');
  assert.equal(combat('bomb', 'flag'), 'both');
});

test('applyMove is immutable and resolves attacker defeat without removing defender', () => {
  const state = stateOf([[30, 'human', 'platoon'], [25, 'ai', 'general'], [56, 'human', 'flag'], [1, 'ai', 'flag']]);
  const before = JSON.stringify(state);
  const next = applyMove(state, 30, 25);
  assert.equal(JSON.stringify(state), before);
  assert.equal(next.board[30], null);
  assert.equal(next.board[25].type, 'general');
  assert.equal(next.history[0].result, 'lose');
  assert.equal(next.turn, 'ai');
  assert.equal(next.quiet, 0);
});

test('commander death reveals its flag, including bomb or mine death', () => {
  for (const defense of ['bomb', 'mine', 'commander']) {
    const state = stateOf([[30, 'human', 'commander'], [25, 'ai', defense], [56, 'human', 'flag'], [1, 'ai', 'flag'], [9, 'ai', 'company']]);
    const next = applyMove(state, 30, 25);
    assert.equal(next.revealedFlags.human, true);
    assert.ok(next.history[0].flagRevealed.some(f => f.side === 'human' && f.index === 56));
    assert.equal(makeObservation(next, 'ai').board[56].type, 'flag');
    if (defense === 'commander') assert.equal(next.revealedFlags.ai, true);
  }
});

test('bomb taking flag wins even though both are removed', () => {
  const state = stateOf([[6, 'human', 'bomb'], [1, 'ai', 'flag'], [56, 'human', 'flag'], [9, 'ai', 'company']]);
  const next = applyMove(state, 6, 1);
  assert.equal(next.board[6], null);
  assert.equal(next.board[1], null);
  assert.equal(next.history[0].result, 'both');
  assert.deepEqual(next.result, { winner: 'human', reason: 'flag' });
  assert.throws(() => applyMove(next, 9, 14), /结束/);
});

test('a side with only blocked or immobile pieces loses on its turn', () => {
  const state = stateOf([[40, 'human', 'company'], [1, 'ai', 'flag'], [3, 'ai', 'general'], [56, 'human', 'flag']]);
  const next = applyMove(state, 40, 41);
  assert.deepEqual(next.result, { winner: 'human', reason: 'no-moves' });
});

test('observation excludes all enemy identities, private initial board and repetition hashes', () => {
  const state = createGame(randomLayout('human'), randomLayout('ai'));
  for (const side of ['human', 'ai']) {
    const observation = makeObservation(state, side);
    assert.ok(!('initial' in observation));
    assert.ok(!('repetitions' in observation));
    assert.equal(observation.ownRoster.length, 25);
    assert.equal(observation.enemyRoster.length, 25);
    assert.ok(observation.enemyRoster.every(p => !('type' in p)));
    assert.ok(observation.board.filter(p => p && p.side !== side).every(p => p.type === null));
    assert.ok(observation.board.filter(p => p?.side === side).every(p => TYPES[p.type]));
  }
});

test('battle observations retain dead own roster but expose no dead enemy rank', () => {
  const state = stateOf([[30, 'human', 'division'], [25, 'ai', 'regiment'], [56, 'human', 'flag'], [1, 'ai', 'flag'], [9, 'ai', 'company']]);
  const next = applyMove(state, 30, 25);
  const humanView = makeObservation(next, 'human'), aiView = makeObservation(next, 'ai');
  assert.equal(humanView.enemyRoster.length, 3);
  assert.ok(!JSON.stringify(humanView).includes('"type":"regiment"'));
  assert.ok(aiView.ownRoster.some(p => p.type === 'regiment'));
  assert.ok(!('attackerType' in humanView.history[0]));
  assert.ok(!('defenderType' in humanView.history[0]));
  humanView.history[0].flagRevealed.push({ side: 'human', index: 56 });
  assert.equal(next.history[0].flagRevealed.length, 0);
});

test('rail-turn evidence only identifies engineers when public geometry proves it', () => {
  const entries = [[25, 'human', 'engineer'], [56, 'human', 'flag'], [1, 'ai', 'flag'], [9, 'ai', 'company']];
  assert.equal(applyMove(stateOf(entries), 25, 54).history[0].engineerTurn, true);
  assert.equal(applyMove(stateOf(entries), 25, 30).history[0].engineerTurn, false);
});

test('100 quiet half-moves and three repetitions terminate as documented house draws', () => {
  const entries = [[40, 'human', 'company'], [19, 'ai', 'company'], [56, 'human', 'flag'], [1, 'ai', 'flag']];
  const quietState = stateOf(entries);
  quietState.quiet = 99;
  assert.deepEqual(applyMove(quietState, 40, 41).result, { winner: null, reason: 'quiet' });
  let repeated = stateOf(entries);
  const cycle = [[40, 41], [19, 18], [41, 40], [18, 19]];
  for (let n = 0; n < 9; n++) repeated = applyMove(repeated, ...cycle[n % 4]);
  assert.deepEqual(repeated.result, { winner: null, reason: 'repetition' });
});

test('illegal selection and impossible moves never mutate referee state', () => {
  const state = createGame(randomLayout('human'), randomLayout('ai'));
  const before = JSON.stringify(state);
  assert.throws(() => applyMove(state, -1, 10));
  const enemyIndex = state.board.findIndex(p => p?.side === 'ai');
  assert.throws(() => applyMove(state, enemyIndex, enemyIndex + 1));
  const flagIndex = state.board.findIndex(p => p?.side === 'human' && p.type === 'flag');
  assert.throws(() => applyMove(state, flagIndex, flagIndex - 5));
  assert.equal(JSON.stringify(state), before);
});

test('mountain variant is explicit, adds only two empty positions and cannot change deployment', () => {
  const human = randomLayout('human'), ai = randomLayout('ai');
  const standard = createGame(human, ai), regional = createGame(human, ai, { engineerMountains: true });
  assert.equal(standard.board.length, 60);
  assert.equal(standard.initial.length, 60);
  assert.deepEqual(standard.rules, { engineerMountains: false });
  assert.equal(regional.board.length, 62);
  assert.equal(regional.initial.length, 62);
  assert.deepEqual(regional.board.slice(60), [null, null]);
  assert.deepEqual(regional.board.slice(0, 60), standard.board);
  assert.deepEqual(makeObservation(regional, 'ai').rules, { engineerMountains: true });
  assert.equal(canPlace('engineer', 'human', 60), false);
  assert.equal(canPlace('engineer', 'ai', 61), false);
  assert.ok(isMountain(60) && isMountain(61));
  assert.ok(!isMountain(59) && !isMountain(62));
  assert.ok(validateLayout(regional.initial, 'human').length > 0);
});

test('only engineers directly beside each mountain can enter an empty mountain', () => {
  for (const mountain of [60, 61]) {
    for (const from of mountainNeighbors[mountain]) {
      for (const type of Object.keys(TYPES)) {
        const board = boardOf([[from, 'human', type]], 62);
        assert.equal(legalMoves(board, from).includes(mountain), type === 'engineer');
      }
    }
  }
  const center = boardOf([[27, 'human', 'engineer']], 62);
  assert.ok(legalMoves(center, 27).includes(60));
  assert.ok(legalMoves(center, 27).includes(61));
  assert.ok(!legalMoves(boardOf([[25, 'human', 'engineer']]), 25).includes(60));
});

test('occupied mountains protect engineers from every attacker including engineers and bombs', () => {
  for (const side of ['human', 'ai']) {
    for (const type of Object.keys(TYPES)) {
      const board = boardOf([[25, 'human', type], [60, side, 'engineer']], 62);
      assert.ok(!legalMoves(board, 25).includes(60));
    }
  }
  const state = stateOf([[25, 'human', 'engineer'], [60, 'ai', 'engineer'], [56, 'human', 'flag'], [1, 'ai', 'flag']], 'human', true);
  assert.throws(() => applyMove(state, 25, 60), /走法/);
});

test('leaving a mountain spends one move and permits only its neighboring empty stations', () => {
  for (const mountain of [60, 61]) {
    const board = boardOf([[mountain, 'human', 'engineer']], 62);
    assert.deepEqual(legalMoves(board, mountain), mountainNeighbors[mountain]);
    const [friendly, enemy] = mountainNeighbors[mountain];
    board[friendly] = { id: 'ally', side: 'human', type: 'company' };
    board[enemy] = { id: 'enemy', side: 'ai', type: 'platoon' };
    assert.deepEqual(legalMoves(board, mountain), mountainNeighbors[mountain].filter(i => i !== friendly && i !== enemy));
    assert.ok(!legalMoves(board, mountain).includes(mountain === 60 ? 61 : 60));
    assert.ok(!legalMoves(board, mountain).includes(5));
  }
});

test('rail travel cannot be combined with entering a mountain or crossing between mountains', () => {
  const board = boardOf([[5, 'human', 'engineer']], 62);
  const moves = legalMoves(board, 5);
  assert.ok(moves.includes(25) && moves.includes(34));
  assert.ok(!moves.includes(60) && !moves.includes(61));
  const state = stateOf([[60, 'human', 'engineer'], [9, 'ai', 'company'], [56, 'human', 'flag'], [1, 'ai', 'flag']], 'human', true);
  assert.throws(() => applyMove(state, 60, 61), /走法/);
  assert.throws(() => applyMove(state, 60, 5), /走法/);
  assert.throws(() => applyMove(state, 60, 62), /棋盘/);
});

test('mountain moves are immutable public engineer evidence without leaking other enemy identities', () => {
  const state = stateOf([[25, 'human', 'engineer'], [9, 'ai', 'company'], [56, 'human', 'flag'], [1, 'ai', 'flag']], 'human', true);
  const before = JSON.stringify(state);
  const entered = applyMove(state, 25, 60);
  assert.equal(JSON.stringify(state), before);
  assert.equal(entered.board[60].type, 'engineer');
  assert.equal(entered.board[25], null);
  assert.equal(entered.history[0].mountainMove, true);
  assert.equal(entered.history[0].engineerTurn, true);
  assert.equal(entered.history[0].result, 'move');
  assert.equal(entered.quiet, 1);
  const observation = makeObservation(entered, 'ai');
  assert.equal(observation.board.length, 62);
  assert.equal(observation.board[60].type, 'engineer');
  assert.equal(observation.board[60].origin, 25);
  assert.equal(observation.board[60].moved, true);
  assert.ok(observation.board.filter(p => p?.side === 'human' && p.id!==entered.board[60].id).every(p => p.type === null));
  assert.ok(!('initial' in observation) && !('repetitions' in observation));
  observation.rules.engineerMountains = false;
  assert.equal(entered.rules.engineerMountains, true);
  const enemyMoved = applyMove(entered, 9, 14);
  const exited = applyMove(enemyMoved, 60, 26);
  assert.equal(exited.board[60], null);
  assert.equal(exited.board[26].type, 'engineer');
  assert.equal(exited.history.at(-1).mountainMove, true);
  assert.equal(exited.history.at(-1).engineerTurn, true);
});

test('mountain engineers count toward legal-turn availability, and lose if every exit is occupied', () => {
  const available = stateOf([[40, 'human', 'company'], [60, 'ai', 'engineer'], [56, 'human', 'flag'], [1, 'ai', 'flag']], 'human', true);
  assert.equal(applyMove(available, 40, 41).result, null);
  const blockedEntries = [[40, 'human', 'company'], [60, 'ai', 'engineer'], [56, 'human', 'flag'], [1, 'ai', 'flag'], ...mountainNeighbors[60].map(i => [i, 'human', 'company'])];
  const blocked = stateOf(blockedEntries, 'human', true);
  assert.deepEqual(applyMove(blocked, 40, 41).result, { winner: 'human', reason: 'no-moves' });
});


test('rail-turn engineer stays face-up after ordinary movement and save reload, for either side', () => {
  for(const side of ['human','ai']) {
    const observer=side==='human'?'ai':'human';
    let state=stateOf([[25,side,'engineer'],[40,observer,'company'],[56,'human','flag'],[1,'ai','flag']],side,true);
    const id=state.board[25].id;
    assert.equal(makeObservation(state,observer).board[25].type,null);
    state=applyMove(state,25,54);
    assert.equal(state.history.at(-1).engineerTurn,true);
    assert.equal(makeObservation(state,observer).board[54].type,'engineer');
    state=applyMove(state,40,41);
    state=applyMove(state,54,49);
    assert.equal(state.history.at(-1).engineerTurn,false);
    state=JSON.parse(JSON.stringify(state));
    assert.equal(makeObservation(state,observer).board[49].type,'engineer');
    assert.deepEqual([...revealedEngineerIds(state)],[id]);
  }
});

test('straight railway travel and camp diagonal steps do not reveal engineers', () => {
  for(const [from,to] of [[25,30],[15,11]]) {
    const state=stateOf([[from,'human','engineer'],[9,'ai','company'],[56,'human','flag'],[1,'ai','flag']],'human',true);
    const next=applyMove(state,from,to);
    assert.equal(next.history.at(-1).engineerTurn,false);
    assert.equal(makeObservation(next,'ai').board[to].type,null);
    assert.equal(revealedEngineerIds(next).size,0);
  }
});

test('entering either mountain and then leaving keeps only that engineer public', () => {
  for(const [entry,mountain,exit] of [[25,60,26],[29,61,28]]) {
    let state=stateOf([[entry,'human','engineer'],[50,'human','engineer'],[9,'ai','company'],[56,'human','flag'],[1,'ai','flag']],'human',true);
    state=applyMove(state,entry,mountain);
    assert.equal(makeObservation(state,'ai').board[mountain].type,'engineer');
    state=applyMove(state,9,14);
    state=applyMove(state,mountain,exit);
    const view=makeObservation(JSON.parse(JSON.stringify(state)),'ai');
    assert.equal(view.board[exit].type,'engineer');
    assert.equal(view.board[50].type,null);
    assert.equal(view.board[56].type,null);
  }
});


test('turning railway attack reveals an engineer even when the battle removes a token', () => {
  for(const defender of ['mine','commander']) {
    const state=stateOf([[54,'human','engineer'],[5,'ai',defender],[9,'ai','company'],[56,'human','flag'],[1,'ai','flag']],'human',true);
    const id=state.board[54].id, next=applyMove(state,54,5);
    assert.equal(next.history.at(-1).engineerTurn,true);
    assert.equal(revealedEngineerIds(next).has(id),true);
    if(defender==='mine')assert.equal(makeObservation(next,'ai').board[5].type,'engineer');
    else assert.ok(!makeObservation(next,'ai').board.some(p=>p?.id===id));
  }
});
