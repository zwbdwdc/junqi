import { legalMoves, combat, isHQ, isMountain, isCamp } from './engine.js';

const other = side => side === 'ai' ? 'human' : 'ai';
const key = board => board.map(p => p ? `${p.side[0]}${p.type || '?'}:${p.id}` : '-').join(',');
const canStop = (a, b) => ['win', 'both'].includes(combat(a, b));
const relaxedDistances = new Map();
function relaxed(type) {
  // Officers and bombs have identical movement geometry. Reuse the graph;
  // capture strength remains resolved on the occupied board below.
  if (!['engineer', 'mine', 'flag'].includes(type)) type = 'company';
  if (relaxedDistances.has(type)) return relaxedDistances.get(type);
  const edges = Array.from({ length: 62 }, (_, from) => {
    const empty = Array(62).fill(null); empty[from] = { side: 'ai', type };
    return legalMoves(empty, from);
  });
  const distances = edges.map((_, from) => {
    const d = Array(62).fill(Infinity), queue = [from]; d[from] = 0;
    for (let h = 0; h < queue.length; h++) for (const to of edges[queue[h]])
      if (d[to] === Infinity) { d[to] = d[queue[h]] + 1; queue.push(to); }
    return d;
  });
  relaxedDistances.set(type, distances); return distances;
}
function mightCatch(type, at, path) {
  // Empty-board distance is an optimistic lower bound; failure rules a reply
  // out, success still requires the real occupied-board sequence below.
  const d = relaxed(type)[at];
  return path.slice(0, -1).some((target, step) => !isCamp(target) && d[target] <= step + 1);
}
function mightBlockCamp(type, at, path) {
  const d = relaxed(type)[at];
  return path.slice(1, -1).some((target, step) => isCamp(target) && d[target] <= step + 1);
}
function move(board, from, to) {
  const result = board[to] ? combat(board[from].type, board[to].type) : 'move';
  const after = board.slice(); after[from] = null;
  after[to] = result === 'lose' ? board[to] : result === 'both' ? null : { ...board[from], moved: true };
  return after;
}

// This is a bounded route warning, not a mate proof. Enumerate actual short
// routes into the flag, including camps and the central gate which are missed
// by a railway-junction-only model. All intermediate captures must survive.
function attackRoutes(board, from, flag, maxDepth = 4) {
  const queue = [{ board, from, path: [] }], routes = [];
  const distances = relaxed(board[from].type);
  let shortest = 5;
  for (let head = 0; head < queue.length && head < 512; head++) {
    const state = queue[head];
    if (state.path.length >= Math.min(maxDepth, shortest)) continue;
    for (const to of legalMoves(state.board, state.from)) {
      if (to !== flag && (isHQ(to) || isMountain(to) ||
        distances[to][flag] > maxDepth - state.path.length - 1 || state.path.includes(to) || to === from)) continue;
      if (state.board[to] && combat(state.board[state.from].type, state.board[to].type) !== 'win') continue;
      const path = [...state.path, to];
      if (to === flag) {
        shortest = path.length; routes.push(path);
        if (routes.length >= 24) return routes;
      } else if (path.length < maxDepth) queue.push({ board: move(state.board, state.from, to), from: to, path });
    }
  }
  return routes;
}

// The attacker moves first. Only real one-move replies are available between
// route steps. In particular, a camp occupied by the attacker cannot be used
// for a preparation until it has actually been vacated. A weak temporary
// blocker is not credited as a permanent wall.
function routeCovered(board, from, path, side, cache) {
  const signature = `route:${key(board)}:${from}:${path.join('.')}`;
  if (cache.has(signature)) return cache.get(signature);
  const target = path[0], attacker = board[from];
  if (!attacker || attacker.side === side) return true;
  if (!legalMoves(board, from).includes(target)) return false;
  const after = move(board, from, target);
  if (!after[target] || after[target].side === side) return true;
  if (path.length === 1) return false;
  let covered = false;
  for (let at = 0; at < after.length && !covered; at++) {
    const defender = after[at];
    if (defender?.side !== side) continue;
    const strong = canStop(defender.type, attacker.type);
    if (!(strong && mightCatch(defender.type, at, path)) && !mightBlockCamp(defender.type, at, path)) continue;
    const moves = legalMoves(after, at);
    if (strong && moves.includes(target)) { covered = true; break; }
    for (const to of moves) {
      if (after[to] || isHQ(to)) continue;
      const prepared = move(after, at, to);
      // Moving a capable guard onto a subsequent square can stop this line,
      // but only if the invader can genuinely capture that guard or the guard
      // occupies a protected camp. Re-evaluate the actual attack below.
      if (path[1] === to && !legalMoves(prepared, target).includes(to)) { covered = true; break; }
      if (!(strong && mightCatch(defender.type, to, path.slice(1))) && !mightBlockCamp(defender.type, to, path.slice(1))) continue;
      if (routeCovered(prepared, target, path.slice(1), side, cache)) { covered = true; break; }
    }
  }
  cache.set(signature, covered);
  return covered;
}

export function publicRouteRisk(board, beliefs, side, cache = new Map(), maxDepth = 4) {
  const flag = board.findIndex(p => p?.side === side && p.type === 'flag');
  if (flag < 0) return 0;
  const positionKey = `route-risk:${side}:${maxDepth}:${key(board)}`;
  if (cache.has(positionKey)) return cache.get(positionKey);
  let risk = 0;
  for (let from = 0; from < board.length; from++) {
    const piece = board[from];
    if (piece?.side !== other(side) || isHQ(from) || isMountain(from)) continue;
    const support = piece.type ? [piece.type] : beliefs.domains[piece.id]?.length ? beliefs.domains[piece.id] :
      ['commander', 'general', 'division', 'brigade', 'regiment', 'battalion', 'company', 'platoon', 'engineer', 'bomb', 'mine', 'flag'];
    const distribution = beliefs.consistent === false ? Object.fromEntries(support.map(type => [type, 1])) : beliefs.probabilities[piece.id] || {};
    let mass = 0;
    for (const [type, probability] of Object.entries(distribution)) {
      if (!probability || ['flag', 'mine'].includes(type)) continue;
      if (relaxed(type)[from][flag] > maxDepth) continue;
      const hypothesis = board.slice(); hypothesis[from] = { ...piece, type };
      const routes = attackRoutes(hypothesis, from, flag, maxDepth);
      if (routes.some(path => path.length >= 3 && !routeCovered(hypothesis, from, path, side, cache))) mass += probability;
    }
    risk = Math.max(risk, Math.min(1, mass));
  }
  cache.set(positionKey, risk);
  return risk;
}
