/** Two-player Chinese army chess. This module owns the private referee state. */
export const ROWS = 12;
export const COLS = 5;
export const TYPES = Object.freeze({
  flag: Object.freeze({ name: '军旗', count: 1, rank: 0 }),
  mine: Object.freeze({ name: '地雷', count: 3, rank: null }),
  bomb: Object.freeze({ name: '炸弹', count: 2, rank: null }),
  commander: Object.freeze({ name: '司令', count: 1, rank: 9 }),
  general: Object.freeze({ name: '军长', count: 1, rank: 8 }),
  division: Object.freeze({ name: '师长', count: 2, rank: 7 }),
  brigade: Object.freeze({ name: '旅长', count: 2, rank: 6 }),
  regiment: Object.freeze({ name: '团长', count: 2, rank: 5 }),
  battalion: Object.freeze({ name: '营长', count: 2, rank: 4 }),
  company: Object.freeze({ name: '连长', count: 3, rank: 3 }),
  platoon: Object.freeze({ name: '排长', count: 3, rank: 2 }),
  engineer: Object.freeze({ name: '工兵', count: 3, rank: 1 }),
});

const camps = new Set([11, 13, 17, 21, 23, 36, 38, 42, 46, 48]);
const headquarters = new Set([1, 3, 56, 58]);
export const isCamp = i => camps.has(i);
export const isHQ = i => headquarters.has(i);
export const isMountain = i => i === 60 || i === 61;
export const mountainNeighbors = Object.freeze({
  60: Object.freeze([25, 26, 27, 30, 31, 32]),
  61: Object.freeze([27, 28, 29, 32, 33, 34]),
});
const inside = i => Number.isInteger(i) && i >= 0 && i < ROWS * COLS;
const playable = (board, i) => inside(i) || (board.length === 62 && isMountain(i));
const row = i => Math.floor(i / COLS);
const col = i => i % COLS;
const other = side => side === 'human' ? 'ai' : 'human';
const edgeKey = (a, b) => a < b ? `${a}:${b}` : `${b}:${a}`;

function buildRoads() {
  const edges = new Map();
  const add = (a, b) => edges.set(edgeKey(a, b), [Math.min(a, b), Math.max(a, b)]);
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const i = r * COLS + c;
      if (c < COLS - 1) add(i, i + 1);
      if (r < ROWS - 1 && (r !== 5 || c % 2 === 0)) add(i, i + COLS);
      if (isCamp(i)) {
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (!dr && !dc) continue;
            const nr = r + dr, nc = c + dc;
            if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS) add(i, nr * COLS + nc);
          }
        }
      }
    }
  }
  return [...edges.values()];
}

function buildRails() {
  const edges = [];
  for (const r of [1, 5, 6, 10]) {
    for (let c = 0; c < 4; c++) edges.push([r * COLS + c, r * COLS + c + 1]);
  }
  for (const c of [0, 4]) {
    for (let r = 1; r < 10; r++) edges.push([r * COLS + c, (r + 1) * COLS + c]);
  }
  edges.push([27, 32]);
  return edges;
}

export const roadEdges = Object.freeze(buildRoads().map(Object.freeze));
export const railEdges = Object.freeze(buildRails().map(Object.freeze));
function adjacency(edges) {
  const list = Array.from({ length: ROWS * COLS }, () => []);
  for (const [a, b] of edges) { list[a].push(b); list[b].push(a); }
  return list;
}
const roads = adjacency(roadEdges);
const rails = adjacency(railEdges);
const railSet = new Set(railEdges.map(([a, b]) => edgeKey(a, b)));

export function canPlace(type, side, i) {
  if (!TYPES[type] || !inside(i) || !['human', 'ai'].includes(side) || isCamp(i)) return false;
  const r = row(i);
  if (side === 'human' ? r < 6 : r > 5) return false;
  if (type === 'flag') return isHQ(i);
  if (type === 'mine') return side === 'human' ? r >= 10 : r <= 1;
  if (type === 'bomb') return side === 'human' ? r !== 6 : r !== 5;
  return true;
}

function shuffle(items, rng) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.max(0, Math.floor(rng() * (i + 1))));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function tokenId() {
  // IDs carry neither rank nor allocation sequence, including under a seeded layout RNG.
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `p${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

export function randomLayout(side, rng = Math.random) {
  if (!['human', 'ai'].includes(side)) throw new Error('无效阵营');
  const board = Array(ROWS * COLS).fill(null);
  for (const [type, spec] of Object.entries(TYPES)) {
    for (let n = 0; n < spec.count; n++) {
      const candidates = board.map((p, i) => !p && canPlace(type, side, i) ? i : -1).filter(i => i >= 0);
      const i = shuffle(candidates, rng)[0];
      if (i === undefined) throw new Error('无法生成合法布局');
      board[i] = { id: tokenId(), side, type, origin: i, moved: false };
    }
  }
  return board;
}

export function validateLayout(board, side) {
  if (!Array.isArray(board) || board.length !== ROWS * COLS) return ['棋盘必须包含 60 个位置'];
  if (!['human', 'ai'].includes(side)) return ['无效阵营'];
  const errors = [], counts = Object.fromEntries(Object.keys(TYPES).map(t => [t, 0])), ids = new Set();
  board.forEach((p, i) => {
    if (!p || p.side !== side) return;
    if (!TYPES[p.type]) { errors.push(`位置 ${i + 1} 的棋子种类无效`); return; }
    counts[p.type]++;
    if (!canPlace(p.type, side, i)) errors.push(`${TYPES[p.type].name}不能放在第 ${row(i) + 1} 行第 ${col(i) + 1} 列`);
    if (typeof p.id !== 'string' || !p.id || ids.has(p.id)) errors.push('棋子编号缺失或重复');
    ids.add(p.id);
  });
  for (const [t, spec] of Object.entries(TYPES)) {
    if (counts[t] !== spec.count) errors.push(`${spec.name}需要 ${spec.count} 枚，当前 ${counts[t]} 枚`);
  }
  return errors;
}

/** Works with an observation board: enemy ranks are unnecessary for movement. */
export function legalMoves(board, from) {
  if (!Array.isArray(board) || !playable(board, from)) return [];
  const piece = board[from];
  if (!piece || !TYPES[piece.type] || piece.type === 'flag' || piece.type === 'mine' || isHQ(from)) return [];
  if (isMountain(from)) {
    // This optional regional rule spends one whole move leaving the refuge.
    // Only an empty neighboring station is allowed; no attack or onward rail travel.
    return piece.type === 'engineer' ? mountainNeighbors[from].filter(to => !board[to]) : [];
  }
  const moves = new Set();
  const mayLand = to => (!board[to] || board[to].side !== piece.side) && !(board[to] && isCamp(to));
  for (const to of roads[from]) if (mayLand(to)) moves.add(to);
  if (piece.type === 'engineer') {
    const seen = new Set([from]), queue = [from];
    for (let n = 0; n < queue.length; n++) {
      for (const to of rails[queue[n]]) {
        if (seen.has(to)) continue;
        seen.add(to);
        if (mayLand(to)) moves.add(to);
        if (!board[to]) queue.push(to);
      }
    }
    if (board.length === 62) {
      for (const mountain of [60, 61]) {
        // Reaching an entrance by rail does not also enter the mountain this turn.
        if (!board[mountain] && mountainNeighbors[mountain].includes(from)) moves.add(mountain);
      }
    }
  } else {
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      let current = from;
      for (;;) {
        const r = row(current) + dr, c = col(current) + dc;
        if (r < 0 || r >= ROWS || c < 0 || c >= COLS) break;
        const to = r * COLS + c;
        if (!railSet.has(edgeKey(current, to))) break;
        if (mayLand(to)) moves.add(to);
        if (board[to]) break;
        current = to;
      }
    }
  }
  return [...moves].sort((a, b) => a - b);
}

export function combat(attType, defType) {
  if (!TYPES[attType] || !TYPES[defType]) throw new Error('裁判收到无效棋子种类');
  if (attType === 'bomb' || defType === 'bomb') return 'both';
  if (defType === 'flag') return 'win';
  if (defType === 'mine') return attType === 'engineer' ? 'win' : 'lose';
  if (TYPES[attType].rank === TYPES[defType].rank) return 'both';
  return TYPES[attType].rank > TYPES[defType].rank ? 'win' : 'lose';
}

function positionKey(board, turn) {
  return `${turn}|${board.map(p => p ? `${p.side[0]}:${p.type}` : '-').join(',')}`;
}

export function createGame(humanBoard, aiBoard, options = {}) {
  const errors = [...validateLayout(humanBoard, 'human'), ...validateLayout(aiBoard, 'ai')];
  if (errors.length) throw new Error(errors.join('；'));
  const firstTurn = options.firstTurn === undefined ? 'human' : options.firstTurn;
  if (firstTurn !== 'human' && firstTurn !== 'ai') throw new Error('先手阵营无效');
  const rules = { engineerMountains: options.engineerMountains === true };
  const board = Array(rules.engineerMountains ? 62 : ROWS * COLS).fill(null), ids = new Set();
  for (const [layout, side] of [[humanBoard, 'human'], [aiBoard, 'ai']]) {
    layout.forEach((p, i) => {
      if (!p || p.side !== side) return;
      if (board[i] || ids.has(p.id)) throw new Error('布局位置或棋子编号冲突');
      ids.add(p.id);
      board[i] = { id: p.id, side, type: p.type, origin: i, moved: false };
    });
  }
  return {
    board, firstTurn, turn: firstTurn, ply: 0, quiet: 0, result: null, history: [], rules,
    revealedFlags: { human: false, ai: false },
    initial: board.map(p => p ? { ...p } : null),
    repetitions: { [positionKey(board, firstTurn)]: 1 },
  };
}

function hasMoves(board, side) {
  return board.some((p, i) => p?.side === side && legalMoves(board, i).length > 0);
}

export function applyMove(state, from, to) {
  if (state.result) throw new Error('本局已经结束');
  if (!playable(state.board, from) || !playable(state.board, to)) throw new Error('位置超出棋盘');
  const attacker = state.board[from], defender = state.board[to];
  if (!attacker || attacker.side !== state.turn) throw new Error('请移动当前行动方的棋子');
  if (!legalMoves(state.board, from).includes(to)) throw new Error('这一步不符合军棋走法');
  const board = state.board.map(p => p ? { ...p } : null);
  const result = defender ? combat(attacker.type, defender.type) : 'move';
  const next = {
    ...state, board, turn: other(state.turn), ply: state.ply + 1,
    quiet: defender ? 0 : state.quiet + 1,
    revealedFlags: { ...state.revealedFlags },
    history: [...state.history], repetitions: { ...state.repetitions },
  };
  const event = {
    ply: next.ply, side: attacker.side, from, to, attackerId: attacker.id,
    defenderId: defender?.id ?? null, result, flagRevealed: [], engineerTurn: false,
    mountainMove: isMountain(from) || isMountain(to),
  };
  if (attacker.type === 'engineer') {
    const ordinary = state.board.slice();
    ordinary[from] = { ...attacker, type: 'platoon' };
    event.engineerTurn = !legalMoves(ordinary, from).includes(to);
  }
  board[from] = null;
  if (result === 'move' || result === 'win') board[to] = { ...attacker, moved: true };
  else if (result === 'both') board[to] = null;
  const dead = [];
  if (result === 'lose' || result === 'both') dead.push(attacker);
  if (defender && (result === 'win' || result === 'both')) dead.push(defender);
  for (const piece of dead) {
    if (piece.type === 'commander' && !next.revealedFlags[piece.side]) {
      next.revealedFlags[piece.side] = true;
      const index = board.findIndex(p => p?.side === piece.side && p.type === 'flag');
      if (index >= 0) event.flagRevealed.push({ side: piece.side, index, id: board[index].id });
    }
    if (piece.type === 'flag') {
      event.capturedFlagSide = piece.side;
      next.result = { winner: other(piece.side), reason: 'flag' };
    }
  }
  next.history.push(event);
  const key = positionKey(board, next.turn);
  next.repetitions[key] = (next.repetitions[key] ?? 0) + 1;
  if (!next.result && !hasMoves(board, next.turn)) next.result = { winner: state.turn, reason: 'no-moves' };
  // These two draw limits are explicit house rules, exposed in the game's rule panel.
  if (!next.result && next.quiet >= 100) next.result = { winner: null, reason: 'quiet' };
  if (!next.result && next.repetitions[key] >= 3) next.result = { winner: null, reason: 'repetition' };
  return next;
}

/** Public identity follows the token for the rest of the game. Deriving it
 * from history also supports saved games created before explicit revelation. */
export function revealedEngineerIds(state) {
  return new Set((state.history || []).filter(event => event.engineerTurn || event.mountainMove)
    .map(event => event.attackerId));
}

/** The ONLY object sent to an AI. No private board, casualty type, or position hash. */
export function makeObservation(state, side) {
  if (!['human', 'ai'].includes(side)) throw new Error('无效观察阵营');
  const initial = state.initial ?? state.board;
  const engineers = revealedEngineerIds(state);
  return {
    side,
    board: state.board.map(p => p ? {
      id: p.id, side: p.side,
      type: p.side === side || (p.type === 'flag' && state.revealedFlags[p.side]) ||
        (p.type === 'engineer' && engineers.has(p.id)) ? p.type : null,
      origin: p.origin, moved: p.moved,
    } : null),
    firstTurn: state.firstTurn === undefined ? 'human' : state.firstTurn,
    turn: state.turn, ply: state.ply, quiet: state.quiet,
    result: state.result ? { ...state.result } : null,
    revealedFlags: { ...state.revealedFlags },
    rules: { engineerMountains: state.rules?.engineerMountains === true },
    history: state.history.map(e => ({ ...e, flagRevealed: e.flagRevealed.map(f => ({ ...f })) })),
    ownRoster: initial.filter(p => p?.side === side).map(p => ({ id: p.id, type: p.type, origin: p.origin })),
    enemyRoster: initial.filter(p => p && p.side !== side).map(p => ({ id: p.id, origin: p.origin })),
    enemyCounts: Object.fromEntries(Object.entries(TYPES).map(([t, spec]) => [t, spec.count])),
  };
}
