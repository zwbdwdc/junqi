/* Fair hidden-information AI. This module accepts only a sanitized observation.
 * No referee state, browser storage, network, or UI access exists here. */
import { legalMoves, combat, isCamp, isHQ, isMountain, roadEdges, TYPES, mountainNeighbors } from './engine.js';
import { inferDomains, inferBeliefs } from './beliefs.js';
import { publicRouteRisk } from './route-defense.js';
import { rateFlagOffense } from './offense.js';
import { quietFlagMate, createFlagDrawGuard, fastFlagExposed } from './quiet-flag.js';
export { publicRouteRisk } from './route-defense.js';
export { inferDomains, inferBeliefs, sampleHiddenLayouts } from './beliefs.js';

export const DIFFICULTIES = Object.freeze({
  professional: { label: '职业', samples: 160, noise: 0.45, risk: 0.80, searchWorlds: 40, candidates: 26, depth: 4, beam: 4, timeLimitMs: 900, finalists: 6, routeDepth: 4 },
  hell: { label: '地狱', samples: 256, noise: 0.08, risk: 0.94, searchWorlds: 48, candidates: 28, depth: 8, beam: 5, timeLimitMs: 5000, finalists: 8, routeDepth: 4 },
});
const COUNTS = Object.freeze({ commander: 1, general: 1, division: 2, brigade: 2, regiment: 2,
  battalion: 2, company: 3, platoon: 3, engineer: 3, bomb: 2, mine: 3, flag: 1 });
const TYPE_NAMES = Object.keys(COUNTS);
const VALUE = Object.freeze({ commander: 280, general: 215, division: 155, brigade: 110, regiment: 80,
  battalion: 57, company: 37, platoon: 28, engineer: 64, bomb: 120, mine: 35, flag: 50000 });
const opponent = side => side === 'ai' ? 'human' : 'ai';
// The optional protected mountain nodes sit BETWEEN the two armies.
const row = i => isMountain(i) ? 5.5 : Math.floor(i / 5);
const col = i => isMountain(i) ? (i === 60 ? 1 : 3) : i % 5;
const distance = (a, b) => Math.abs(row(a) - row(b)) + Math.abs(col(a) - col(b));
const roadNeighbors = Array.from({ length: 62 }, () => []);
for (const [a, b] of roadEdges) { roadNeighbors[a].push(b); roadNeighbors[b].push(a); }

function pieceValue(type, board, side) {
  if (type !== 'engineer') return VALUE[type] || 35;
  const engineers = board.filter(p => p?.side === side && p.type === 'engineer').length;
  return VALUE.engineer + (engineers <= 1 ? 38 : engineers === 2 ? 12 : 0);
}

function materialBattle(attacker, defender, board) {
  const result = combat(attacker.type, defender.type);
  const ours = pieceValue(attacker.type, board, attacker.side), theirs = pieceValue(defender.type, board, defender.side);
  if (defender.type === 'flag') return { result, score: VALUE.flag };
  return { result, score: result === 'win' ? theirs : result === 'lose' ? -ours : theirs - ours };
}

function projectMove(board, from, to, defenderType = null) {
  const after = board.slice(), attacker = { ...board[from], moved: true }, target = board[to];
  after[from] = null;
  const result = target ? combat(attacker.type, defenderType || target.type) : 'move';
  after[to] = result === 'lose' ? target : result === 'both' ? null : attacker;
  return { board: after, result };
}

function allMoves(board, side) {
  const moves = [];
  for (let from = 0; from < board.length; from++) if (board[from]?.side === side)
    for (const to of legalMoves(board, from)) moves.push({ from, to });
  return moves;
}

export function hasLegalMove(board, side) {
  // Every railway edge is also a road edge: any legal rail trip therefore
  // already has a legal first adjacent destination. Only existence is needed.
  for (let from = 0; from < board.length; from++) {
    const piece = board[from];
    if (!piece || piece.side !== side || !TYPES[piece.type] || piece.type === 'flag' || piece.type === 'mine' || isHQ(from)) continue;
    if (isMountain(from)) {
      if (board.length === 62 && piece.type === 'engineer' && mountainNeighbors[from].some(to => !board[to])) return true;
      continue;
    }
    if (from >= 60) continue;
    if (roadNeighbors[from].some(to => (!board[to] || board[to].side !== side) && !(board[to] && isCamp(to)))) return true;
    if (board.length === 62 && piece.type === 'engineer' && [60,61].some(to => !board[to] && mountainNeighbors[to].includes(from))) return true;
  }
  return false;
}

/** A proof uses every publicly possible reply, never a sampled hidden army.
 * It intentionally stops after our next move. Failure to prove means unknown,
 * not a loss. In particular a moving dark token is not assigned a convenient
 * rank when deciding whether our next flag capture exists. */
export function provePublicWins(observation, domains = inferDomains(observation), options = {}) {
  const side = observation.side || 'ai', enemy = opponent(side), board = observation.board;
  const check = typeof options.check === 'function' ? options.check : () => {};
  const proofs = new Map(), repetitions = publicRepetitions(observation, domains);
  if (Object.values(domains).some(domain => !domain.length)) return proofs;
  const types = p => p.side === side ? [p.type] : domains[p.id] || TYPE_NAMES;
  const knownFlag = p => p?.side === enemy && types(p).length === 1 && types(p)[0] === 'flag';
  const enemyCanMove = position => position.some((p, at) => p?.side === enemy && types(p).some(type => {
    check();
    if (type === 'flag' || type === 'mine') return false;
    const test = position.slice(); test[at] = { ...p, type };
    return legalMoves(test, at).length > 0;
  }));
  const canTakeFlag = position => allMoves(position, side).some(move => knownFlag(position[move.to]));
  const rootBranches = move => {
    const target = board[move.to], outcomes = new Map();
    for (const type of target ? types(target) : [null]) {
      check();
      const projected = projectMove(board, move.from, move.to, type), won = type === 'flag';
      outcomes.set(`${projected.result}:${won}`, { board: projected.board, won });
    }
    return [...outcomes.values()];
  };
  for (const move of allMoves(board, side)) {
    if (options.move && (move.from !== options.move.from || move.to !== options.move.to)) continue;
    check();
    const branches = rootBranches(move);
    if (branches.length && branches.every(branch => branch.won || !enemyCanMove(branch.board))) {
      proofs.set(`${move.from}:${move.to}`, 1); continue;
    }
    const quiet = board[move.to] ? 0 : (observation.quiet || 0) + 1;
    if (quiet >= 100 || branches.some(branch => !branch.won &&
        (!canTakeFlag(branch.board) || repetitions.possibleCount(branch.board, enemy) >= 2))) continue;
    let forced = branches.length > 0;
    for (const branch of branches) {
      if (branch.won || !enemyCanMove(branch.board)) continue;
      const seen = new Set();
      outer: for (let from = 0; from < board.length; from++) {
        const p = branch.board[from];
        if (!p || p.side !== enemy) continue;
        for (const type of types(p)) {
          check();
          if (type === 'mine' || type === 'flag') continue;
          const hypothesis = branch.board.slice(); hypothesis[from] = { ...p, type };
          for (const to of legalMoves(hypothesis, from)) {
            check();
            const target = hypothesis[to], next = projectMove(hypothesis, from, to);
            const key = `${from}:${to}:${next.result}`;
            if (seen.has(key)) continue;
            seen.add(key);
            // Capture/no-moves wins precede draw rules in the referee.
            if (target?.type === 'flag' || !allMoves(next.board, side).length ||
                (!target && quiet + 1 >= 100) || repetitions.possibleCount(next.board, side) >= 2 || !canTakeFlag(next.board)) {
              forced = false; break outer;
            }
          }
        }
      }
      if (!forced) break;
    }
    if (forced) proofs.set(`${move.from}:${move.to}`, 2);
  }
  return proofs;
}

/** A conditional certificate for one observable combat branch, not a win.
 * The failed/cancelled capture branches remain in every score comparison. */
export function conditionalCaptureRace(observation, domains, move, check = () => {}) {
  check();
  const side = observation.side || 'ai', board = observation.board;
  const attacker = board[move.from], defender = board[move.to];
  if (!attacker || attacker.side !== side || !defender || defender.side === side ||
      !domains[defender.id]?.length || !legalMoves(board, move.from).includes(move.to)) return false;
  const surviving = domains[defender.id].filter(type => combat(attacker.type, type) === 'win');
  if (!surviving.length || surviving.length === domains[defender.id].length) return false;
  const after = projectMove(board, move.from, move.to, surviving[0]).board;
  if (!allMoves(after, side).some(reply => {
    const target = after[reply.to];
    return target?.side !== side && domains[target?.id]?.length === 1 && domains[target.id][0] === 'flag';
  })) return false;
  const conditional = { ...domains, [defender.id]: surviving };
  return provePublicWins(observation, conditional, { move, check }).get(`${move.from}:${move.to}`) === 2;
}

function enemyFlagGoals(observation, beliefs) {
  const enemy = opponent(observation.side || 'ai'), goals = [];
  for (let i = 0; i < observation.board.length; i++) {
    const p = observation.board[i], probability = p?.side === enemy ? beliefs.probabilities[p.id]?.flag || 0 : 0;
    if (probability) goals.push({ index: i, probability });
  }
  if (!goals.length) for (const index of enemy === 'human' ? [56, 58] : [1, 3]) goals.push({ index, probability: 0.5 });
  return goals;
}

function riskSupport(piece, beliefs) {
  if (piece.type === 'flag' || piece.type === 'engineer') return [piece.type];
  return beliefs.domains[piece.id]?.length ? beliefs.domains[piece.id] : TYPE_NAMES;
}

function publicAttacks(board, beliefs, side) {
  const attacks = [], enemy = opponent(side);
  for (let from = 0; from < board.length; from++) {
    const piece = board[from], upperBound = beliefs.consistent === false;
    // An inconsistent record has no valid posterior. These ones indicate
    // possible adverse types, not probabilities or a fabricated hidden army.
    const distribution = piece && upperBound ? Object.fromEntries(riskSupport(piece, beliefs).map(type => [type, 1])) :
      piece && beliefs.probabilities[piece.id];
    if (piece?.side !== enemy || !distribution || isHQ(from)) continue;
    const regularBoard = board.slice();
    regularBoard[from] = { ...piece, type: 'company' };
    const regular = new Set(legalMoves(regularBoard, from));
    let engineer = regular;
    if (distribution.engineer > 0) {
      regularBoard[from] = { ...piece, type: 'engineer' };
      engineer = new Set(legalMoves(regularBoard, from));
    }
    attacks.push({ from, piece, distribution, regular, engineer, upperBound });
  }
  return attacks;
}

function canIntercept(board, side, target, type) {
  return board.some((friend, at) => friend?.side === side &&
    ['win', 'both'].includes(combat(friend.type, type)) && legalMoves(board, at).includes(target));
}

function forcedFlagApproach(board, from, type, flagAt, side) {
  const reachable = new Set(legalMoves(board, from));
  if (reachable.has(flagAt)) return true;
  for (const gate of roadNeighbors[flagAt]) {
    if (!reachable.has(gate) || board[gate]?.side === board[from].side) continue;
    if (board[gate] && combat(type, board[gate].type) !== 'win') continue;
    const after = projectMove(board, from, gate).board;
    if (!canIntercept(after, side, gate, type)) return true;
  }
  return false;
}

function railwayInvasion(board, attack, type, flagAt, side) {
  const reachable = type === 'engineer' ? attack.engineer : attack.regular;
  for (const staging of reachable) {
    // These squares include the back railway junctions. From a junction an
    // invader can turn toward the flag on the next move without being engineer.
    if (distance(staging, flagAt) > 3 || roadNeighbors[flagAt].includes(staging) || isHQ(staging)) continue;
    if (board[staging] && (board[staging].side !== side || combat(type, board[staging].type) !== 'win')) continue;
    const future = board.slice(); future[attack.from] = { ...attack.piece, type };
    const staged = projectMove(future, attack.from, staging).board;
    if (!forcedFlagApproach(staged, staging, type, flagAt, side)) continue;
    if (canIntercept(staged, side, staging, type)) continue;
    // We get a real preparation move after the railway incursion. If any
    // repositioning covers every remaining flag approach, this is not forced.
    let canPrepare = false;
    for (const response of allMoves(staged, side)) {
      if (staged[response.to] && response.to !== staging) continue;
      const prepared = projectMove(staged, response.from, response.to).board;
      if (prepared[staging]?.side === side || !prepared[staging] ||
          !forcedFlagApproach(prepared, staging, type, flagAt, side)) { canPrepare = true; break; }
    }
    if (!canPrepare) return true;
  }
  return false;
}

/** Evaluate ALL hanging friendly pieces, not only the piece just moved.
 * Hence an unrelated quiet move cannot cash in another piece's escape bonus. */
export function publicDanger(board, beliefs, side) {
  const threats = new Map(), flagAt = board.findIndex(p => p?.side === side && p.type === 'flag');
  const mobile = board.flatMap((piece, at) => piece?.side === side &&
    !['flag', 'mine'].includes(piece.type) && !isHQ(at) && legalMoves(board, at).length ? [at] : []);
  // Exchanging the last mobile unit loses even while our flag is protected.
  // This public check also remains available when the search runs out of time.
  let lastUnitRisk = mobile.length === 0 ? 1 : 0;
  let flagRisk = 0, pressure = 0, approachRisk = 0, invasionRisk = 0;
  const attacks = publicAttacks(board, beliefs, side);
  for (const attack of attacks) {
    let flagChance = 0, lastUnitChance = 0;
    for (const [type, probability] of Object.entries(attack.distribution)) {
      if (!probability || type === 'mine' || type === 'flag') continue;
      const reachable = type === 'engineer' ? attack.engineer : attack.regular;
      if (flagAt >= 0 && reachable.has(flagAt)) flagChance += probability;
      if (mobile.length === 1 && reachable.has(mobile[0]) && combat(type, board[mobile[0]].type) !== 'lose') {
        const hypothesis = board.slice(); hypothesis[attack.from] = { ...attack.piece, type };
        // Removing this unit may also open a rail for a previously blocked
        // friend. Check the resulting board rather than merely counting ranks.
        if (!hasLegalMove(projectMove(hypothesis, attack.from, mobile[0]).board, side)) lastUnitChance += probability;
      }
    }
    flagRisk = Math.max(flagRisk, Math.min(1, flagChance));
    lastUnitRisk = Math.max(lastUnitRisk, Math.min(1, lastUnitChance));
    if (flagAt >= 0) {
      const closeness = Math.max(0, 5 - distance(attack.from, flagAt));
      const mobile = attack.upperBound ? Number(Object.keys(attack.distribution).some(type => type !== 'mine' && type !== 'flag')) :
        1 - (attack.distribution.mine || 0) - (attack.distribution.flag || 0);
      pressure += closeness * (isCamp(attack.from) ? 2.2 : 1) * mobile;
      // A camp next to the flag is a staging post, not merely a piece that is
      // presently unable to capture it. Test the enemy's approach AND whether
      // we could intercept on the following move. Types here are hypotheses.
      let incoming = 0;
      for (const [type, probability] of Object.entries(attack.distribution)) {
        if (!probability || type === 'mine' || type === 'flag') continue;
        const reachable = type === 'engineer' ? attack.engineer : attack.regular;
        let unanswerable = false;
        for (const gate of roadNeighbors[flagAt]) {
          if (!reachable.has(gate) || board[gate]?.side === attack.piece.side) continue;
          const defender = board[gate];
          if (defender && combat(type, defender.type) !== 'win') continue;
          const projected = board.slice();
          projected[attack.from] = null;
          projected[gate] = { ...attack.piece, type, moved: true };
          const answer = canIntercept(projected, side, gate, type);
          if (!answer) { unanswerable = true; break; }
        }
        if (unanswerable) incoming += probability;
      }
      approachRisk = Math.max(approachRisk, Math.min(1, incoming));
      let invasion = 0;
      for (const [type, probability] of Object.entries(attack.distribution)) {
        if (!probability || type === 'mine' || type === 'flag') continue;
        if (railwayInvasion(board, attack, type, flagAt, side)) invasion += probability;
      }
      invasionRisk = Math.max(invasionRisk, Math.min(1, invasion));
    }
    for (const to of new Set([...attack.regular, ...attack.engineer])) {
      const target = board[to];
      if (!target || target.side !== side || target.type === 'flag') continue;
      let danger = 0;
      for (const [type, probability] of Object.entries(attack.distribution)) {
        if (!probability || type === 'mine' || type === 'flag' || !(type === 'engineer' ? attack.engineer : attack.regular).has(to)) continue;
        const result = combat(type, target.type), value = pieceValue(target.type, board, side);
        const loss = result === 'win' ? value : result === 'both' ? Math.max(0, value - VALUE[type] * 0.7) : 0;
        danger = attack.upperBound ? Math.max(danger, loss) : danger + probability * loss;
      }
      threats.set(to, Math.max(threats.get(to) || 0, danger));
    }
  }
  const sorted = [...threats.values()].sort((a, b) => b - a);
  const risk = (sorted[0] || 0) + (sorted[1] || 0) * 0.22 + sorted.slice(2).reduce((a, b) => a + b, 0) * 0.035;
  return { risk, flagRisk, lastUnitRisk, approachRisk, invasionRisk, pressure, threats, attacks };
}

// Preparation is a bounded public route assessment, not a forced-loss proof.
// Count a quiet move by ANY friendly piece: vacating a railway for a reserve
// and moving that reserve are different, complementary parts of defence.
function prepareThenIntercept(board, side, from, target, type, cache, extraBlock = 1) {
  const key = `${searchKey(board, side, 0, 0)}:${from}:${target}:${type}:${extraBlock}`;
  if (cache.has(key)) return cache.get(key);
  let covered = canIntercept(board, side, from, type);
  if (!covered) for (const move of allMoves(board, side)) {
    if (board[move.to]) continue;
    const prepared = projectMove(board, move.from, move.to).board;
    // The enemy still occupies its staging square during our preparation.
    // In particular an occupied camp cannot be used as an escape shortcut.
    if (!legalMoves(prepared, from).includes(target)) {
      // A weak piece on the railway buys a tempo; it is not a permanent wall.
      // Give the reserve only the corresponding real reply after that guard
      // is captured, then require an immediate interception at the entry.
      if (!legalMoves(prepared, from).includes(move.to)) { covered = true; break; }
      const blocked = projectMove(prepared, from, move.to);
      if (blocked.result !== 'win' || canIntercept(blocked.board, side, move.to, type) ||
          (extraBlock > 0 && prepareThenIntercept(blocked.board, side, move.to, target, type, cache, extraBlock - 1))) {
        covered = true; break;
      }
      continue;
    }
    const advanced = projectMove(prepared, from, target).board;
    if (advanced[target]?.side === side || !advanced[target] || canIntercept(advanced, side, target, type)) {
      covered = true; break;
    }
  }
  cache.set(key, covered);
  return covered;
}

export function flagPreparation(board, beliefs, side, cache = new Map(), routeDepth = 4) {
  const flagAt = board.findIndex(p => p?.side === side && p.type === 'flag');
  if (flagAt < 0) return { reserve: 0, breach: 0, route: 0 };
  const attacks = publicAttacks(board, beliefs, side);
  const entry = (side === 'ai' ? 5 : 50) + (col(flagAt) > 2 ? 4 : 0);
  let reserve = 0, breach = 0;
  for (const attack of attacks) {
    let delayed = 0;
    for (const [type, probability] of Object.entries(attack.distribution)) {
      if (!probability || type === 'mine' || type === 'flag') continue;
      const hypothesis = board.slice(); hypothesis[attack.from] = { ...attack.piece, type };
      const reachable = type === 'engineer' ? attack.engineer : attack.regular;
      let exposedRoute = false;
      for (const first of reachable) {
        if (board[first] && combat(type, board[first].type) !== 'win') continue;
        const staged = projectMove(hypothesis, attack.from, first).board;
        if (first !== entry) {
          if (!legalMoves(staged, first).includes(entry)) continue;
          if (staged[entry] && combat(type, staged[entry].type) !== 'win') continue;
        }
        const arrived = first === entry ? staged : projectMove(staged, first, entry).board;
        // A major beside three intact protective mines is not an opened flag
        // route. Only types that can actually enter a flag gate need a reserve.
        const nextMoves = legalMoves(arrived, entry);
        if (!roadNeighbors[flagAt].some(gate => nextMoves.includes(gate) &&
            (!arrived[gate] || combat(type, arrived[gate].type) === 'win'))) continue;
        const prepared = first === entry ? canIntercept(staged, side, entry, type) || allMoves(staged, side).some(move =>
          !staged[move.to] && !forcedFlagApproach(projectMove(staged, move.from, move.to).board, entry, type, flagAt, side)) :
          prepareThenIntercept(staged, side, first, entry, type, cache);
        if (!prepared) { exposedRoute = true; break; }
      }
      if (exposedRoute) delayed += probability;
    }
    reserve = Math.max(reserve, Math.min(1, delayed));

    const engineerMass = attack.distribution.engineer || 0;
    if (!engineerMass) continue;
    for (const gate of roadNeighbors[flagAt]) {
      if (board[gate]?.side !== side || board[gate].type !== 'mine' || !attack.engineer.has(gate)) continue;
      const hypothesis = board.slice(); hypothesis[attack.from] = { ...attack.piece, type: 'engineer' };
      const opened = projectMove(hypothesis, attack.from, gate).board;
      const interceptions = allMoves(opened, side).filter(move => move.to === gate && combat(opened[move.from].type, 'engineer') === 'win');
      let bestReplyRisk = 1;
      for (const intercept of interceptions) {
        const replied = projectMove(opened, intercept.from, gate).board;
        let followerRisk = 0;
        for (const follower of attacks) {
          if (follower.from === attack.from) continue;
          let takeover = 0;
          for (const [type, probability] of Object.entries(follower.distribution)) {
            if (!probability || type === 'mine' || type === 'flag' || combat(type, replied[gate].type) !== 'win') continue;
            const next = replied.slice(); next[follower.from] = { ...follower.piece, type };
            const nextMoves = legalMoves(next, follower.from);
            let unsafe = nextMoves.includes(gate) && !canIntercept(projectMove(next, follower.from, gate).board, side, gate, type);
            if (unsafe) { takeover += probability; continue; }
            for (const staging of nextMoves) {
              if (!roadNeighbors[gate].includes(staging) || isHQ(staging) ||
                  (next[staging] && combat(type, next[staging].type) !== 'win')) continue;
              const staged = projectMove(next, follower.from, staging).board;
              if (!legalMoves(staged, staging).includes(gate)) continue;
              // We can exchange the follower at its staging square before it
              // takes the gate, or prepare a counter after its next capture.
              if (canIntercept(staged, side, staging, type)) continue;
              if (!prepareThenIntercept(staged, side, staging, gate, type, cache)) { unsafe = true; break; }
            }
            if (unsafe) takeover += probability;
          }
          followerRisk = Math.max(followerRisk, Math.min(1, takeover));
        }
        bestReplyRisk = Math.min(bestReplyRisk, followerRisk);
      }
      breach = Math.max(breach, engineerMass * bestReplyRisk);
    }
  }
  // Keep evaluating a cleared gate after the engineer has been recaptured.
  // Otherwise the preparation reward disappears precisely when the reserve
  // must use the cleared square to complete its defensive relay.
  for (const gate of roadNeighbors[flagAt]) {
    if (board[gate]?.side !== side || ['mine', 'flag'].includes(board[gate].type)) continue;
    for (const follower of attacks) {
      let takeover = 0;
      for (const [type, probability] of Object.entries(follower.distribution)) {
        if (!probability || ['mine', 'flag'].includes(type) || combat(type, board[gate].type) !== 'win') continue;
        const hypothesis = board.slice(); hypothesis[follower.from] = { ...follower.piece, type };
        const nextMoves = legalMoves(hypothesis, follower.from);
        let unsafe = nextMoves.includes(gate) && !canIntercept(projectMove(hypothesis, follower.from, gate).board, side, gate, type);
        if (unsafe) { takeover += probability; continue; }
        for (const staging of nextMoves) {
          if (!roadNeighbors[gate].includes(staging) || isHQ(staging) ||
              (hypothesis[staging] && combat(type, hypothesis[staging].type) !== 'win')) continue;
          const staged = projectMove(hypothesis, follower.from, staging).board;
          if (!legalMoves(staged, staging).includes(gate) || canIntercept(staged, side, staging, type)) continue;
          if (!prepareThenIntercept(staged, side, staging, gate, type, cache)) { unsafe = true; break; }
        }
        if (unsafe) takeover += probability;
      }
      breach = Math.max(breach, Math.min(1, takeover));
    }
  }
  // A long route warning is not the same event as an already opened mine
  // gate. Keep them separate so adding a longer horizon cannot price an
  // ordinary four-move possibility as a near-term forced flag collapse.
  return { reserve, breach, route: publicRouteRisk(board, beliefs, side, cache, routeDepth) };
}

function initiativeContext(observation) {
  const side = observation.side || 'ai', history = observation.history || [];
  const recent = history.slice(-20), quiet = Math.min(40, observation.quiet || 0);
  const ownMoves = recent.filter(e => e.side === side);
  const advances = ownMoves.filter(e => !e.defenderId && (side === 'ai' ? row(e.to) > row(e.from) : row(e.to) < row(e.from))).length;
  const contacts = recent.filter(e => e.defenderId).length;
  // The extra urge saturates: a slow opponent must not make a general charge
  // a suspected bomb. It buys preparation and affordable reconnaissance.
  return { urgency: 1 + Math.min(1.1, quiet / 30) + (ownMoves.length >= 5 && advances <= 1 && !contacts ? 0.45 : 0), recent };
}

export function publicRepetitions(observation, domains = inferDomains(observation)) {
  const side = observation.side || 'ai', identities = new Map(), metadata = new Map();
  for (const piece of observation.ownRoster || []) {
    identities.set(piece.id, `${side}:${piece.type}`);
    metadata.set(piece.id, { side, domain: [piece.type] });
  }
  for (const piece of observation.enemyRoster || []) {
    identities.set(piece.id, `${opponent(side)}:${domains[piece.id]?.length === 1 ? domains[piece.id][0] : piece.id}`);
    metadata.set(piece.id, { side: opponent(side), domain: domains[piece.id] || TYPE_NAMES });
  }
  const key = (board, turn) => `${turn}|${board.map(p => p ? identities.get(p.id) || p.id : '-').join(',')}`;
  const board = Array(observation.board.length).fill(null), counts = new Map(), positions = [];
  for (const piece of [...(observation.ownRoster || []), ...(observation.enemyRoster || [])])
    if (Number.isInteger(piece.origin)) board[piece.origin] = piece;
  const remember = turn => {
    const k = key(board, turn); counts.set(k, (counts.get(k) || 0) + 1);
    positions.push({ turn, board: board.slice() });
  };
  remember('human');
  for (const event of observation.history || []) {
    const attacker = board[event.from] || { id: event.attackerId };
    board[event.from] = null;
    if (event.result === 'move' || event.result === 'win') board[event.to] = attacker;
    else if (event.result === 'both') board[event.to] = null;
    remember(opponent(event.side));
  }
  // Unknown identities are keyed by public token ID. Equal keys guarantee a
  // real repetition; swapping indistinguishable unknown enemies may be missed
  // but can never invent a draw by reading their hidden types.
  return {
    count: (after, turn) => counts.get(key(after, turn)) || 0,
    // Certification needs the opposite bound: two unidentified, equal-rank
    // tokens might have swapped. Domain overlap deliberately overestimates
    // repetition possibilities rather than falsely certify a win before a draw.
    possibleCount: (after, turn) => positions.filter(previous => previous.turn === turn && previous.board.every((piece, at) => {
      const next = after[at];
      if (!piece || !next) return !piece && !next;
      if (piece.id === next.id) return true;
      const a = metadata.get(piece.id), b = metadata.get(next.id);
      return a && b && a.side === b.side && a.domain.some(type => b.domain.includes(type));
    })).length,
  };
}

function engineerRoute(board, from, target) {
  if (from === target) return 0;
  const engineer = board[from], base = board.slice(); base[from] = null;
  const queue = [[from, 0]], seen = new Set([from]);
  for (let head = 0; head < queue.length; head++) {
    const [at, depth] = queue[head];
    if (depth >= 6) continue;
    const position = base.slice(); position[at] = engineer;
    for (const to of legalMoves(position, at)) {
      if (to === target) return depth + 1;
      if (position[to] || seen.has(to) || isHQ(to)) continue;
      seen.add(to); queue.push([to, depth + 1]);
    }
  }
  return Infinity;
}

export function mineObjectives(observation, beliefs, goals) {
  return observation.board.flatMap((piece, index) => {
    if (!piece || piece.side === (observation.side || 'ai') || isHQ(index)) return [];
    const probability = beliefs.probabilities[piece.id]?.mine || 0;
    if (probability < 0.15) return [];
    const nearFlag = goals.reduce((sum, goal) => sum + Math.max(0, 4 - distance(index, goal.index)) * goal.probability, 0);
    // Coarse probabilities avoid switching jobs just because the next Monte
    // Carlo batch changes a rear piece's mine estimate by a few percent.
    const confidence = Math.round(probability * 5) / 5;
    return [{ id: piece.id, index, value: confidence * (45 + nearFlag * 16) }];
  });
}

function mineMissionPotential(board, tasks, side) {
  if (!tasks.length) return 0;
  const engineers = board.flatMap((piece, index) => piece?.side === side && piece.type === 'engineer' ? [index] : []);
  const values = tasks.map(task => {
    if (board[task.index]?.id !== task.id) return task.value;
    const route = Math.min(...engineers.map(from => engineerRoute(board, from, task.index)));
    return Number.isFinite(route) ? task.value / (route + 1) : 0;
  }).sort((a, b) => b - a);
  // Focus on an achievable job, instead of being pulled toward the average
  // location of every hypothetical mine on the board.
  return (values[0] || 0) + (values[1] || 0) * 0.20;
}

function offensivePotential(board, from, goals, side) {
  const piece = board[from];
  if (!piece || ['mine', 'flag'].includes(piece.type) || isHQ(from)) return 0;
  const progress = side === 'ai' ? row(from) : 11 - row(from);
  const goalDistance = goals.reduce((sum, goal) => sum + distance(from, goal.index) * goal.probability, 0);
  const destinations = legalMoves(board, from);
  const forwardReach = destinations.reduce((best, to) => {
    if (board[to] || isHQ(to) || isMountain(to)) return best;
    return Math.max(best, side === 'ai' ? row(to) : 11 - row(to));
  }, progress);
  // A camp shelters a threatened unit (scored separately). It is not an
  // offensive objective: rewarding occupancy here makes the final departure
  // toward a revealed flag look worse than shuffling another unit into camp.
  return progress * 2.1 - goalDistance * 0.9 + Math.min(4, forwardReach - progress) * 1.2;
}

function opportunity(board, from, beliefs, side) {
  const piece = board[from];
  if (!piece) return 0;
  const chances = [];
  for (const to of legalMoves(board, from)) {
    const target = board[to];
    if (!target || target.side === side) continue;
    let gain = 0;
    for (const [type, probability] of Object.entries(beliefs.probabilities[target.id] || {}))
      if (probability) gain += probability * materialBattle(piece, { ...target, type }, board).score;
    chances.push(clamp(gain, 0, 150));
  }
  chances.sort((a, b) => b - a);
  // A second profitable target matters because one opponent move cannot always
  // save both; this rewards a fork without assuming the enemy sees our rank.
  return (chances[0] || 0) * 0.16 + (chances[1] || 0) * 0.28;
}

function interceptDistance(board, from, target, beliefs) {
  const piece = board[from], base = board.slice(); base[from] = null;
  const queue = [[from, 0]], seen = new Set([from]);
  for (let n = 0; n < queue.length; n++) {
    const [at, depth] = queue[n];
    if (depth >= 5) continue;
    const future = base.slice(); future[at] = piece;
    for (const to of legalMoves(future, at)) {
      if (to === target) return depth + 1;
      if (seen.has(to) || isHQ(to)) continue;
      if (future[to]) {
        // Intermediate hostile pieces are a possible path only if the public
        // estimate strongly favors clearing them; a mine/bomb wall is not air.
        const distribution = beliefs.probabilities[future[to].id] || {};
        const survive = Object.entries(distribution).reduce((sum, [type, p]) => sum + (combat(piece.type, type) === 'win' ? p : 0), 0);
        if (survive < 0.8 || (distribution.bomb || 0) > 0.08) continue;
      }
      seen.add(to); queue.push([to, depth + 1]);
    }
  }
  return 6;
}

function reserveMobilization(board, projected, from, to, beliefs, side) {
  const piece = board[from];
  if (!['commander', 'general', 'division', 'brigade', 'regiment', 'bomb'].includes(piece.type)) return 0;
  let best = 0;
  for (let at = 0; at < board.length; at++) {
    const invader = board[at];
    if (!invader || invader.side === side || !invader.moved || isMountain(at) || isHQ(at) || (side === 'ai' ? row(at) > 6 : row(at) < 5)) continue;
    const distribution = beliefs.probabilities[invader.id] || {};
    const mobile = 1 - (distribution.mine || 0) - (distribution.flag || 0);
    const canStop = Object.entries(distribution).reduce((sum, [type, p]) => sum + (['win', 'both'].includes(combat(piece.type, type)) ? p : 0), 0);
    if (mobile < 0.85 || canStop < 0.65) continue;
    const before = interceptDistance(board, from, at, beliefs);
    const after = projected[to]?.side === side ? interceptDistance(projected, to, at, beliefs) : before;
    const urgency = 5 + (side === 'ai' ? 5 - row(at) : row(at) - 6) * 2;
    const flag = board.findIndex(p => p?.side === side && p.type === 'flag');
    const guardPost = flag < 0 ? -1 : side === 'ai' ? (col(flag) === 1 ? 11 : 13) : (col(flag) === 1 ? 46 : 48);
    let prepare = 0;
    if (guardPost >= 0 && (!board[guardPost] || guardPost === from)) {
      const beforePost = from === guardPost ? 0 : interceptDistance(board, from, guardPost, beliefs);
      const afterPost = to === guardPost ? 0 : interceptDistance(projected, to, guardPost, beliefs);
      prepare = (beforePost - afterPost) * urgency * 2 * canStop;
    }
    // A reserve should get ahead of a railway invasion, rather than chase the
    // square the invader is about to leave on the opposite side of the board.
    best = Math.max(best, (before - after) * urgency * canStop * 3 + prepare);
  }
  return best;
}

function clamp(value, min = 0, max = 1) { return Math.min(max, Math.max(min, value)); }
function learnedWeights(profile) {
  const weights = Object.fromEntries(['attack', 'scout', 'shelter', 'defend', 'develop', 'risk', 'bombCaution']
    .map(key => [key, Number.isFinite(profile?.weights?.[key]) ? clamp(profile.weights[key], 0.8, 1.25) : 1]));
  if (profile?.opponent?.moves >= 12 && Number.isFinite(profile.opponent.attackRate))
    weights.defend = clamp(weights.defend * (1 + (clamp(profile.opponent.attackRate) - 0.3) * 0.15), 0.8, 1.25);
  return weights;
}

function expectedCapture(observation, move, beliefs, weights) {
  const board = observation.board, attacker = board[move.from], defender = board[move.to];
  if (!defender) return { gain: 0, survive: 1, penalty: 0, bombChance: 0, uncertainty: 0, flagChance: 0 };
  const upperBound = beliefs.consistent === false;
  const distribution = upperBound ? Object.fromEntries(riskSupport(defender, beliefs).map(type => [type, 1])) :
    beliefs.probabilities[defender.id] || { [defender.type || 'company']: 1 };
  const value = pieceValue(attacker.type, board, attacker.side);
  let gain = 0, survive = 0, casualty = 0, uncertainty = 0, downside = 0;
  if (upperBound) { gain = Infinity; survive = 1; }
  for (const [type, probability] of Object.entries(distribution)) {
    if (!probability) continue;
    const battle = materialBattle(attacker, { ...defender, type }, board);
    gain = upperBound ? Math.min(gain, battle.score) : gain + probability * battle.score;
    downside = upperBound ? Math.max(downside, -battle.score) : downside + probability * Math.max(0, -battle.score);
    if (upperBound) { survive = Math.min(survive, Number(battle.result === 'win')); casualty = 1 - survive; }
    else if (battle.result === 'win') survive += probability; else casualty += probability;
    uncertainty -= probability * Math.log2(probability);
  }
  const major = attacker.type === 'commander' ? 1.6 : attacker.type === 'general' ? 1.25 : attacker.type === 'division' ? 0.55 : 0.10;
  const bombChance = distribution.bomb || 0, mineChance = distribution.mine || 0;
  // Losing the commanding reserve is more costly than an average-value trade.
  // This is a risk premium, NOT a claim to identify a hidden bomb.
  // A known equal-rank exchange removes their commander as well as ours.
  // Charge this premium on net material lost, not merely on our piece dying.
  let penalty = downside * (0.12 + major * 0.20) * weights.risk;
  if (attacker.type !== 'bomb') penalty += bombChance * value * major * 1.9 * weights.bombCaution;
  if (attacker.type !== 'engineer' && attacker.type !== 'bomb') penalty += mineChance * value * 0.8;
  return { gain, survive, casualty, penalty, bombChance, mineChance, uncertainty,
    flagChance: upperBound ? Number(riskSupport(defender, beliefs).length === 1 && distribution.flag === 1) : distribution.flag || 0 };
}

function strategicFeatures(observation, move, beliefs, goals, baseDanger, danger, battle, initiative) {
  const board = observation.board, side = observation.side || 'ai', piece = board[move.from], target = board[move.to];
  const ownFlag = board.findIndex(p => p?.side === side && p.type === 'flag');
  const value = pieceValue(piece.type, board, side);
  const goalDistance = at => goals.reduce((sum, goal) => sum + distance(at, goal.index) * goal.probability, 0);
  const advancement = goalDistance(move.from) - goalDistance(move.to);
  const nearestEnemy = at => board.reduce((best, p, i) => p && p.side !== side ? Math.min(best, distance(at, i)) : best, 20);
  const nearestSupport = at => board.reduce((best, p, i) => p?.side === side && i !== move.from && !['flag', 'mine'].includes(p.type)
    ? Math.min(best, distance(at, i)) : best, 20);
  const hasSupport = nearestSupport(move.to) <= 2;
  const isMinor = ['company', 'platoon', 'battalion'].includes(piece.type);
  const projected = projectMove(board, move.from, move.to, target ? 'platoon' : null).board;
  // Quiet moves are exact. Captures retain their separately evaluated outcomes.
  let develop = target ? advancement * 0.7 : (offensivePotential(projected, move.to, goals, side) -
    offensivePotential(board, move.from, goals, side)) * initiative.urgency;
  let shelter = 0, defend = 0, scout = 0, plan = 0;
  if (!target || battle.survive >= 0.8)
    defend += reserveMobilization(board, projected, move.from, move.to, beliefs, side) * battle.survive;
  if (isCamp(move.to) || isMountain(move.to)) {
    shelter += Math.min(28, (baseDanger.threats.get(move.from) || 0) * 0.30);
    develop += isCamp(move.to) ? 0.8 : 0.5;
    if (isMinor && nearestEnemy(move.to) > 3) develop -= 2;
  }
  if (isCamp(move.from)) develop -= 0.8;
  if (!target) plan += opportunity(projected, move.to, beliefs, side) - opportunity(board, move.from, beliefs, side) * 0.5;
  if (isMountain(move.from)) {
    const arrival = (observation.history || []).filter(e => e.attackerId === piece.id && e.to === move.from).at(-1);
    develop += Math.min(7, Math.max(0, (observation.ply || 0) - (arrival?.ply ?? observation.ply ?? 0)) * 0.22);
  }
  // Quiet forward motion by a small piece has to uncover information or support
  // a teammate. Merely being closer to the enemy does not justify being lost.
  if (isMinor && advancement > 0 && !hasSupport && nearestEnemy(move.to) <= 2) plan -= 8;
  if (piece.type === 'engineer') {
    if (battle.mineChance && target) develop += battle.mineChance * 8;
    if (target && battle.casualty) {
      const remaining = board.filter(friend => friend?.side === side && friend.type === 'engineer').length;
      const mineNeed = board.reduce((sum, enemy) => sum + (enemy?.side !== side ? beliefs.probabilities[enemy?.id]?.mine || 0 : 0), 0);
      plan -= battle.casualty * mineNeed * 22 / Math.pow(Math.max(1, remaining), 1.5);
    }
  }
  if (piece.type === 'bomb' && !target) {
    let supportBefore = 0, supportAfter = 0;
    board.forEach((friend, at) => {
      if (friend?.side !== side || !['commander', 'general', 'division'].includes(friend.type)) return;
      supportBefore += Math.max(0, 3 - distance(move.from, at));
      supportAfter += Math.max(0, 3 - distance(move.to, at));
    });
    plan += (supportAfter - supportBefore) * 2;
    if (nearestEnemy(move.to) <= 1 && !hasSupport) plan -= 7;
  }
  if (ownFlag >= 0 && baseDanger.pressure > 0) {
    const before = Math.max(0, 5 - distance(move.from, ownFlag)), after = Math.max(0, 5 - distance(move.to, ownFlag));
    defend += (after - before) * Math.min(4, baseDanger.pressure * 0.8);
    if (isCamp(move.to) && distance(move.to, ownFlag) <= 3) defend += Math.min(12, baseDanger.pressure * 2);
    if (isCamp(move.from) && distance(move.from, ownFlag) <= 3) defend -= Math.min(18, baseDanger.pressure * 2);
    defend += (baseDanger.pressure - danger.pressure) * 1.2;
  }
  if (target && isMinor && battle.uncertainty > 0.5 && hasSupport && battle.gain >= -value * 0.55)
    scout = Math.min(12, battle.uncertainty * 3.2) * initiative.urgency * (battle.bombChance > 0.15 ? 1.25 : 1);
  // Entrants are frozen forever in headquarters; only an actual flag win
  // justifies assigning a valuable mobile unit to an ordinary HQ square.
  if (isHQ(move.to) && battle.flagChance < 0.8) plan -= 20 + value * 0.65;
  const previous = (observation.history || []).filter(e => e.side === side && e.attackerId === piece.id).slice(-8);
  previous.forEach((event, i) => {
    const recent = (i + 1) / previous.length;
    if (event.to === move.to) plan -= 7 * recent;
    if (event.from === move.to && event.to === move.from) plan -= 10 * recent;
  });
  if (!target) {
    const recentPiece = initiative.recent.filter(e => e.attackerId === piece.id && !e.defenderId);
    const revisits = recentPiece.filter(e => e.to === move.to || e.from === move.to).length;
    plan -= revisits * 5 * initiative.urgency;
    // Moving a second idle piece does not reset the whole army's need to act.
    if (initiative.urgency > 1.5 && advancement <= 0 && baseDanger.risk < 15 && baseDanger.pressure === 0 && shelter < 3)
      plan -= 6 * initiative.urgency;
  }
  return { develop, shelter, defend, scout, plan };
}

function instantiate(observation, world) {
  const side = observation.side || 'ai';
  return observation.board.map(p => !p ? null : { ...p, type: p.side === side ? p.type : world[p.id] });
}

function sampledBoards(observation, beliefs, count, rng) {
  const boards = [], cumulative = [];
  beliefs.weights.reduce((sum, weight, i) => { cumulative[i] = sum + weight; return cumulative[i]; }, 0);
  // Stratification reduces the chance that a rare but important bomb disappears
  // from every searched world, while all worlds still satisfy army counts.
  const offset = rng();
  for (let n = 0; n < count; n++) {
    const point = (n + offset) / count;
    let index = cumulative.findIndex(value => value >= point);
    if (index < 0) index = beliefs.worlds.length - 1;
    boards.push(instantiate(observation, beliefs.worlds[index]));
  }
  return boards;
}

function flagExposed(board, side) {
  return fastFlagExposed(board, side);
}

const SEARCH_INTERRUPTED = Symbol('search interrupted');
const TYPE_CODE = Object.fromEntries(TYPE_NAMES.map((type, index) => [type, index]));
function searchKey(board, side, depth, qDepth) {
  return `${side}:${depth}:${qDepth}|` + board.map(piece => !piece ? '.' :
    String.fromCharCode(65 + TYPE_CODE[piece.type] + (piece.side === 'ai' ? 0 : 12))).join('');
}
function checkSearchBudget(statistics) {
  const control = statistics.control;
  if (!control) return;
  if (statistics.nodes >= control.nodeLimit) { control.reason = 'nodes'; throw SEARCH_INTERRUPTED; }
  if (control.now() >= control.deadline) { control.reason = 'time'; throw SEARCH_INTERRUPTED; }
}

// Search values describe future material changes, not total board material.
// A draw therefore uses the same bounded opportunity cost as root draws:
// leading armies dislike abandoning their advantage; trailing armies welcome
// it. This is a heuristic (+/-350), never a win certificate. Do not add total
// material again to ordinary leaves. Repetition is NOT simulated here.
function simulationDrawValue(board, side) {
  const lead = board.reduce((sum, piece) => !piece || piece.type === 'flag' ? sum :
    sum + (piece.side === side ? 1 : -1) * (VALUE[piece.type] || 0), 0);
  return -clamp(lead * 0.85, -350, 350);
}

function simulationMoves(board, side, statistics, limit, escapes = false, quiet = 0) {
  const ownFlag = board.findIndex(p => p?.side === side && p.type === 'flag');
  const enemyFlag = board.findIndex(p => p && p.side !== side && p.type === 'flag');
  // HQ is off the railway and the flag cannot move. A friendly move cannot
  // create a new enemy one-step flag attack, so only existing checks require
  // testing each continuation. This avoids a costly redundant scan at leaves.
  const emergency = flagExposed(board, side);
  // Only move ordering uses this inexpensive pre-move attack map. Subsequent
  // replies still use the resulting board, including newly opened railways.
  const enemyMoves = escapes ? allMoves(board, opponent(side)) : [];
  const approachers = !emergency && ownFlag >= 0 ? [...new Set(enemyMoves.filter(move =>
    roadNeighbors[ownFlag].includes(move.to)).map(move => move.from))].filter(from =>
    forcedFlagApproach(board, from, board[from].type, ownFlag, side)) : [];
  const exposure = (piece, at) => enemyMoves.reduce((worst, move) => {
    if (move.to !== at || isCamp(at) || isMountain(at)) return worst;
    const result = combat(board[move.from].type, piece.type);
    return Math.max(worst, result === 'win' ? pieceValue(piece.type, board, side) :
      result === 'both' ? Math.max(0, pieceValue(piece.type, board, side) - VALUE[board[move.from].type]) : 0);
  }, 0);
  const options = allMoves(board, side).map(move => {
    statistics.replies++;
    const attacker = board[move.from], target = board[move.to];
    const battle = target ? materialBattle(attacker, target, board) : { score: 0, result: 'move' };
    const projected = projectMove(board, move.from, move.to);
    const won = target?.type === 'flag' || !hasLegalMove(projected.board, opponent(side));
    const draw = !won && !target && quiet >= 99;
    const drawValue = draw ? simulationDrawValue(projected.board, side) : null;
    let position = 0;
    if (!won && !draw) {
      if (isHQ(move.to)) position -= pieceValue(attacker.type, board, side) * 0.45 + 12;
      if (isCamp(move.to)) position += 2.0;
      if (isCamp(move.from)) position -= 1.0;
      if (enemyFlag >= 0) position += clamp(distance(move.from, enemyFlag) - distance(move.to, enemyFlag), -6, 6) * 0.30;
      if (enemyFlag >= 0 && distance(move.to, enemyFlag) <= 2 && !isHQ(move.to)) position += 2.5;
      if (ownFlag >= 0 && distance(move.from, ownFlag) <= 3 && distance(move.to, ownFlag) > 3) position -= 2;
    }
    const unsafe = emergency && !won && !draw && flagExposed(projected.board, side);
    const leavesApproach = !won && !draw && approachers.some(from => projected.board[from]?.side === opponent(side) &&
      forcedFlagApproach(projected.board, from, projected.board[from].type, ownFlag, side));
    const escape = !target && escapes ? Math.max(0, exposure(attacker, move.from) - exposure(attacker, move.to)) * 0.8 : 0;
    return { ...move, board: projected.board, won, draw, drawValue, capture: !!target, gain: battle.score, position,
      essential: won || (emergency && !unsafe) || (approachers.length > 0 && !leavesApproach), unsafe,
      order: draw ? drawValue : (won ? VALUE.flag : battle.score) + position + escape - (unsafe ? VALUE.flag * 0.9 : 0) - (leavesApproach ? VALUE.flag * 0.7 : 0) };
  });
  options.sort((a, b) => b.order - a.order || a.from - b.from || a.to - b.to);
  // At a leaf all replies are considered; elsewhere the beam also includes
  // quiet camp and blocking moves, ordered above moves leaving a flag en prise.
  const selected = options.slice(0, limit);
  for (const option of options) if (option.essential && !selected.includes(option)) selected.push(option);
  // A terminal draw must remain an available reply even when captures have a
  // higher provisional ordering score. All quiet draws preserve the same army.
  const drawing = options.find(option => option.draw);
  if (drawing && !selected.includes(drawing)) selected.push(drawing);
  return selected;
}

// Resolve short exchanges at the leaf rather than treating the last capture
// as free material. This is an extension, not additional fully searched depth.
function exchangeReply(board, side, target, remaining, statistics) {
  checkSearchBudget(statistics);
  let best = 0;
  for (const move of allMoves(board, side)) {
    const defender = board[move.to];
    if (!defender || (move.to !== target && defender.type !== 'flag')) continue;
    statistics.nodes++; statistics.extensions = (statistics.extensions || 0) + 1;
    checkSearchBudget(statistics);
    const battle = materialBattle(board[move.from], defender, board);
    if (defender.type === 'flag') return VALUE.flag;
    const projected = projectMove(board, move.from, move.to).board;
    if (!hasLegalMove(projected, opponent(side))) return VALUE.flag;
    let value = battle.score;
    if (remaining > 1 && battle.result === 'win')
      value -= 0.97 * exchangeReply(projected, opponent(side), move.to, remaining - 1, statistics);
    best = Math.max(best, value);
  }
  return best;
}

/** Determinization is ONLY of sampled hypotheses. No true hidden rank enters
 * the search. The first action is common to every world; later hypothetical
 * branches model tactical continuations, not a promise of solved hidden play. */
export function tacticalSearch(board, side, depth, config, statistics, alpha = -Infinity, beta = Infinity, quiet = 0) {
  if (!config.quietFlagExtension) return tacticalSearchBody(board, side, depth, config, statistics, alpha, beta, quiet);
  statistics.flagDrawGuard ||= createFlagDrawGuard();
  return statistics.flagDrawGuard.withPosition(board, side, () =>
    tacticalSearchBody(board, side, depth, config, statistics, alpha, beta, quiet));
}

function tacticalSearchBody(board, side, depth, config, statistics, alpha, beta, quiet) {
  checkSearchBudget(statistics);
  if (quiet >= 100) {
    // applyMove gives no-moves priority over the quiet limit. Flag captures are
    // handled by the caller's move.won before another search node is entered.
    if (!hasLegalMove(board, side)) return -VALUE.flag;
    statistics.quietDraws = (statistics.quietDraws || 0) + 1;
    return simulationDrawValue(board, side);
  }
  const originalAlpha = alpha, originalBeta = beta, qDepth = config.qDepth || 0;
  const width = config.rootDepth > 3 && depth < config.rootDepth ? Math.min(3, config.beam) : config.beam;
  const key = statistics.table ? `${searchKey(board, side, depth, qDepth)}|${width}:${config.escapeOrdering ? 1 : 0}|fq:${config.quietFlagExtension ? statistics.flagDrawGuard.context() : 0}|quiet:${quiet}` : null;
  const cached = key && statistics.table.get(key);
  if (cached) {
    statistics.cacheHits = (statistics.cacheHits || 0) + 1;
    if (cached.bound === 'exact') return cached.score;
    if (cached.bound === 'lower') alpha = Math.max(alpha, cached.score); else beta = Math.min(beta, cached.score);
    if (alpha >= beta) return cached.score;
  }
  const moves = simulationMoves(board, side, statistics, depth === 1 ? (qDepth ? Infinity : 1) : width, config.escapeOrdering === true && depth > 1, quiet);
  if (!moves.length) return -VALUE.flag;
  let best = -Infinity;
  for (const move of moves) {
    statistics.nodes++;
    checkSearchBudget(statistics);
    let score = move.gain + move.position;
    if (move.won) score = VALUE.flag;
    else if (move.draw) {
      statistics.quietDraws = (statistics.quietDraws || 0) + 1;
      score = move.drawValue;
    }
    else if (depth > 1) score -= 0.97 * tacticalSearch(move.board, opponent(side), depth - 1, config, statistics,
      (score - beta) / 0.97, (score - alpha) / 0.97, move.capture ? 0 : quiet + 1);
    // Complete every immediate defence before accepting a sampled quiet mate.
    // This is a result in one hypothetical army, not a public win certificate.
    else if (!move.capture && config.quietFlagExtension &&
      quietFlagMate(move.board, side, quiet + 1, statistics, checkSearchBudget, hasLegalMove)) score = VALUE.flag * 0.97 * 0.97;
    // A quiet last ply that opens a direct flag loss is not a sound endpoint.
    else if (move.unsafe) score -= VALUE.flag * 0.9;
    else if (qDepth && move.capture) score -= 0.97 * exchangeReply(move.board, opponent(side), move.to, qDepth, statistics);
    best = Math.max(best, score);
    alpha = Math.max(alpha, best);
    if (alpha >= beta) break;
  }
  if (key && statistics.table.size < 50000) statistics.table.set(key, { score: best,
    bound: best <= originalAlpha ? 'upper' : best >= originalBeta ? 'lower' : 'exact' });
  return best;
}

export function conservativeContinuation(immediate, deep) {
  return deep > immediate ? immediate + Math.min(15, (deep - immediate) * 0.20) : deep;
}

function describeDecision(candidate, observation, baseDanger) {
  if (candidate.winInOwnMoves === 2) return { actionClass: 'attack', explanation: '公开局面已形成连续夺旗机会，按可验证的路线收官。' };
  if (candidate.knownFlag) return { actionClass: 'attack', explanation: '军旗已公开，优先夺旗。' };
  if (candidate.flagProgress > 15) return { actionClass: 'attack', explanation: '推进通向军旗的路线，并检查沿途阻挡和反击。' };
  if (baseDanger.flagRisk > 0.001) return { actionClass: 'defend', explanation: '对手已威胁军旗，先封住夺旗路线或消灭来子。' };
  if (candidate.features.shelter > 3) return { actionClass: 'shelter', explanation: '利用行营或山界避开反击，保留有价值的棋子。' };
  if (candidate.features.defend > 3 || baseDanger.approachRisk > candidate.danger.approachRisk + 0.05 || baseDanger.invasionRisk > candidate.danger.invasionRisk + 0.05) return { actionClass: 'defend', explanation: '对方已进入旗侧，回防并控制军旗附近通路。' };
  if (candidate.features.scout > 0) return { actionClass: 'scout', explanation: '由有后续支援的小子试探，保留大子避免疑炸。' };
  if (observation.board[candidate.to]) return { actionClass: 'attack', explanation: '根据公开碰撞和移动线索估计对手身份，并检查后续反击。' };
  return { actionClass: 'develop', explanation: '改善通路、行营和子力支援，同时避免留下可被反吃的棋子。' };
}

function variedChoice(candidates, observation, difficulty, context, baseDanger, rng) {
  const best = candidates[0], stats = { selectionGap: 0, selectionPool: 1, mode: 'best' };
  // Variety never overrules a certified finish or an urgent flag response.
  if (!best || !context || best.winInOwnMoves || best.draw || best.score < -800 ||
      baseDanger.flagRisk > 0.001 || baseDanger.approachRisk > 0.05 || baseDanger.invasionRisk > 0.10)
    return { chosen: best, ...stats };
  const tolerance = difficulty === 'hell' ? 3.5 : 5;
  const pool = candidates.filter(candidate => !candidate.draw && !candidate.winInOwnMoves &&
    candidate.score >= best.score - tolerance && candidate.danger.flagRisk <= best.danger.flagRisk + 0.001 &&
    candidate.danger.approachRisk <= best.danger.approachRisk + 0.015 &&
    candidate.danger.invasionRisk <= best.danger.invasionRisk + 0.02 &&
    candidate.reserveRisk <= best.reserveRisk + 0.005 && candidate.breachRisk <= best.breachRisk + 0.005 &&
    candidate.routeRisk <= best.routeRisk + 0.005 &&
    candidate.danger.risk <= best.danger.risk + 2 && (candidate.lossMass || 0) <= (best.lossMass || 0) + 0.01 &&
    (candidate.casualty || 0) <= (best.casualty || 0) + 0.04 && candidate.bombChance <= best.bombChance + 0.025);
  if (pool.length < 2) return { chosen: best, ...stats };
  const style = ['pressure', 'maneuver'].includes(context.style) ? context.style : 'balanced';
  const wing = context.wing === -1 || context.wing === 1 ? context.wing : 0;
  const seed = Number.isFinite(context.seed) ? context.seed >>> 0 : 0;
  const weights = pool.map(candidate => {
    const progress = (observation.side === 'human' ? -1 : 1) * (row(candidate.to) - row(candidate.from));
    const plan = style === 'pressure' ? clamp(progress, -2, 2) * 0.28 + (observation.board[candidate.to] ? 0.3 : 0) :
      style === 'maneuver' ? (isCamp(candidate.to) ? 0.55 : 0) + (col(candidate.to) !== col(candidate.from) ? 0.2 : 0) : 0;
    // Fixed per-game wing/style gently guide equally good choices; they do not
    // alter search scores or expand the permitted quality/risk envelope.
    return Math.exp((candidate.score - best.score) / 2 + plan + wing * (col(candidate.to) - 2) * 0.16);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let hash = Math.imul(seed ^ ((observation.ply || 0) + 1), 0x45d9f3b) >>> 0;
  hash = Math.imul(hash ^ hash >>> 16, 0x45d9f3b) >>> 0;
  // The game seed keeps a restored turn reproducible when a caller supplies a
  // reproducible search RNG; runtime RNG still provides independent sampling.
  let draw = ((rng() + (hash >>> 0) / 4294967296) % 1) * total, chosen = pool.at(-1);
  for (let i = 0; i < pool.length; i++) { draw -= weights[i]; if (draw <= 0) { chosen = pool[i]; break; } }
  return { chosen, selectionGap: Math.round((best.score - chosen.score) * 100) / 100,
    selectionPool: pool.length, mode: style };
}

// A common empty destination is legal for every remaining public identity of
// this token. We do not turn a sampled movable rank into a certain draw offer.
function enemyHasQuietReply(board, beliefs, side) {
  return board.some((piece, from) => {
    if (!piece || piece.side === side || isHQ(from)) return false;
    const support = riskSupport(piece, beliefs);
    if (!support.length || support.some(type => type === 'mine' || type === 'flag')) return false;
    let common = null;
    for (const type of support) {
      const hypothesis = board.slice(); hypothesis[from] = { ...piece, type };
      const quiet = new Set(legalMoves(hypothesis, from).filter(to => !board[to]));
      common = common === null ? quiet : new Set([...common].filter(to => quiet.has(to)));
      if (!common.size) return false;
    }
    return common.size > 0;
  });
}

export function chooseMove(observation, difficulty = 'professional', rng = Math.random, learningProfile = null, context = null, options = {}) {
  const now = typeof options.clock === 'function' ? options.clock : () => performance.now(), startedAt = now();
  difficulty = difficulty === 'hell' ? 'hell' : 'professional';
  const config = DIFFICULTIES[difficulty], side = observation.side || 'ai';
  const timeLimitMs = Number.isFinite(options.timeLimitMs) ? Math.max(0, options.timeLimitMs) : config.timeLimitMs;
  const nodeLimit = Number.isFinite(options.nodeLimit) ? Math.max(0, options.nodeLimit) : Infinity;
  const maxDepth = Number.isFinite(options.maxDepth) ? Math.max(2, Math.min(config.depth, Math.floor(options.maxDepth / 2) * 2)) : config.depth;
  const control = { now, deadline: startedAt + timeLimitMs, nodeLimit, reason: null };
  const moves = allMoves(observation.board, side);
  if (!moves.length) return null;
  const beliefs = inferBeliefs(observation, { samples: config.samples, rng });
  const wins = provePublicWins(observation, beliefs.domains);
  let offense = { enabled: false, reason: 'certified-win', scores: new Map(), nodes: 0, elapsedMs: 0 };
  const weights = learnedWeights(learningProfile), goals = enemyFlagGoals(observation, beliefs);
  const initiative = initiativeContext(observation);
  const repetitions = publicRepetitions(observation, beliefs.domains), mineTasks = mineObjectives(observation, beliefs, goals);
  const initialMission = mineMissionPotential(observation.board, mineTasks, side);
  const materialLead = observation.board.reduce((sum, piece) => {
    if (!piece || piece.type === 'flag') return sum;
    if (piece.side === side) return sum + (VALUE[piece.type] || 0);
    return sum - Object.entries(beliefs.probabilities[piece.id] || {}).reduce((value, [type, probability]) =>
      value + (type === 'flag' ? 0 : VALUE[type]) * probability, 0);
  }, 0);
  const drawValue = -clamp(materialLead * 0.85, -350, 350);
  const baseDanger = publicDanger(observation.board, beliefs, side);
  const preparationCache = new Map();
  const basePreparation = flagPreparation(observation.board, beliefs, side, preparationCache, config.routeDepth);
  const statistics = { replies: 0, nodes: 0, worlds: beliefs.worlds.length, searchWorlds: 0, extensions: 0, cacheHits: 0,
    table: new Map(), control, completedDepth: 0, attemptedDepth: 0, aborted: false };
  statistics.flagDrawGuard = createFlagDrawGuard(observation);
  const rated = moves.map(move => {
    const attacker = observation.board[move.from], target = observation.board[move.to];
    const battle = expectedCapture(observation, move, beliefs, weights);
    const knownFlag = !!target && beliefs.domains[target.id]?.length === 1 && beliefs.domains[target.id][0] === 'flag';
    // Evaluate survival/death branches by their actual posterior mass. Removing
    // a hidden defender unconditionally would create imaginary open railways.
    const branches = new Map();
    const upperBound = beliefs.consistent === false;
    const branchTypes = target && upperBound ? Object.fromEntries(riskSupport(target, beliefs).map(type => [type, 1])) :
      target && beliefs.probabilities[target.id] || {};
    if (target) for (const [type, probability] of Object.entries(branchTypes)) {
      if (!probability) continue;
      const result = combat(attacker.type, type);
      if (!branches.has(result)) branches.set(result, { probability: 0, board: projectMove(observation.board, move.from, move.to, type).board });
      branches.get(result).probability = upperBound ? 1 : branches.get(result).probability + probability;
    }
    else branches.set('move', { probability: 1, board: projectMove(observation.board, move.from, move.to).board });
    let risk = 0, flagRisk = 0, lastUnitRisk = 0, approachRisk = 0, invasionRisk = 0, pressure = 0, exposure = 0, landingLoss = 0, mission = 0, draw = false;
    let reserveRisk = 0, breachRisk = 0, routeRisk = 0, repetitionDraw = false, allowOpponentDraw = false;
    const quietDraw = !target && (observation.quiet || 0) >= 99;
    const aggregate = (current, value, mass) => upperBound ? Math.max(current, value) : current + mass * value;
    for (const branch of branches.values()) {
      const danger = publicDanger(branch.board, beliefs, side);
      const preparation = flagPreparation(branch.board, beliefs, side, preparationCache, config.routeDepth);
      reserveRisk = aggregate(reserveRisk, preparation.reserve, branch.probability);
      breachRisk = aggregate(breachRisk, preparation.breach, branch.probability);
      routeRisk = aggregate(routeRisk, preparation.route, branch.probability);
      risk = aggregate(risk, danger.risk, branch.probability);
      flagRisk = aggregate(flagRisk, danger.flagRisk, branch.probability);
      lastUnitRisk = aggregate(lastUnitRisk, danger.lastUnitRisk, branch.probability);
      approachRisk = aggregate(approachRisk, danger.approachRisk, branch.probability);
      invasionRisk = aggregate(invasionRisk, danger.invasionRisk, branch.probability);
      pressure = aggregate(pressure, danger.pressure, branch.probability);
      if (branch.board[move.to]?.id === attacker.id) {
        landingLoss = aggregate(landingLoss, danger.threats.get(move.to) || 0, branch.probability);
        exposure = aggregate(exposure, Math.max(0, (danger.threats.get(move.to) || 0) - (baseDanger.threats.get(move.from) || 0)), branch.probability);
      }
      if (!upperBound) mission += branch.probability * mineMissionPotential(branch.board, mineTasks, side);
      if (!target) {
        repetitionDraw ||= repetitions.count(branch.board, opponent(side)) >= 2;
        draw ||= repetitionDraw || quietDraw;
        if (!draw && (observation.quiet || 0) === 98) allowOpponentDraw ||= enemyHasQuietReply(branch.board, beliefs, side);
      }
    }
    const danger = { risk, flagRisk, lastUnitRisk, approachRisk, invasionRisk, pressure };
    const features = strategicFeatures(observation, move, beliefs, goals, baseDanger, danger, battle, initiative);
    // The reserve and long-route detectors can describe the same incursion.
    // Count that warning once. Its speculative benefit is bounded by a major
    // piece, so buying a single tempo with a doomed engineer is not treated as
    // averting a proved loss. Immediate flag/approach and actual breach scores
    // retain their much stronger protection below.
    features.plan -= Math.max(reserveRisk * 270, routeRisk * VALUE.commander) + breachRisk * 800;
    features.defend += Math.max(0, Math.max(basePreparation.reserve,basePreparation.route) - Math.max(reserveRisk,routeRisk)) * 12 + Math.max(0, basePreparation.breach - breachRisk) * 30;
    features.develop += mission - initialMission;
    // An already threatened general elsewhere does not make throwing an
    // additional engineer out of a protected mountain nearly free.
    features.plan -= exposure * 0.70;
    if (attacker.type === 'engineer') {
      const count = observation.board.filter(p => p?.side === side && p.type === 'engineer').length;
      const mineNeed = observation.board.reduce((sum, p) => sum + (p?.side !== side ? beliefs.probabilities[p?.id]?.mine || 0 : 0), 0);
      features.plan -= landingLoss * (0.50 + mineNeed * 22 / Math.pow(Math.max(1, count), 1.5) /
        pieceValue('engineer', observation.board, side));
    }
    const strategic = features.plan + features.develop * weights.develop + features.defend * weights.defend +
      features.shelter * weights.shelter + features.scout * weights.scout;
    const attackBonus = battle.gain > 0 && battle.gain < VALUE.flag * 0.5 ? battle.gain * (weights.attack - 1) : 0;
    let score = battle.gain + attackBonus - battle.penalty + strategic - danger.risk * config.risk * weights.risk -
      Math.max(danger.flagRisk, danger.lastUnitRisk) * VALUE.flag * 1.3 - danger.approachRisk * 1250 - danger.invasionRisk * 700 + (rng() - 0.5) * config.noise;
    const winInOwnMoves = wins.get(`${move.from}:${move.to}`) || 0;
    if (draw && !knownFlag) score = drawValue;
    else if (allowOpponentDraw) score = Math.min(score, drawValue);
    if (winInOwnMoves) score = VALUE.flag - winInOwnMoves * 100 + (knownFlag ? 1 : 0);
    return { ...move, score, strategic, attackBonus, features, ...battle, danger, reserveRisk, breachRisk, routeRisk, flagProgress: 0, flagPlan: null,
      draw: draw && !winInOwnMoves, quietDraw: quietDraw && !winInOwnMoves, repetitionDraw: repetitionDraw && !winInOwnMoves,
      allowOpponentDraw: allowOpponentDraw && !winInOwnMoves, winInOwnMoves, knownFlag };
  }).sort((a, b) => b.score - a.score || a.from - b.from || a.to - b.to);

  // A route which wins immediately after a successful probe must reach the
  // search even if the non-tempo-aware approach heuristic calls it unsafe.
  // Its certificate is bounded inside the same turn clock, not added to it.
  let raceProofNodes = 0;
  const raceDeadline = Math.min(control.deadline, now() + (difficulty === 'hell' ? 80 : 40));
  const RACE_INTERRUPTED = Symbol('race proof interrupted');
  const raceCheck = () => {
    raceProofNodes++;
    checkSearchBudget(statistics);
    if (raceProofNodes > 12000 || now() >= raceDeadline) throw RACE_INTERRUPTED;
  };
  if (!rated.some(candidate => candidate.winInOwnMoves)) {
    try {
      for (const candidate of rated)
        candidate.conditionalFlagRace = conditionalCaptureRace(observation, beliefs.domains, candidate, raceCheck);
    } catch (error) {
      if (error !== RACE_INTERRUPTED && error !== SEARCH_INTERRUPTED) throw error;
    }
  }

  // The same game can be lost by losing our last mover or by allowing an
  // unanswerable flag approach. Do not delete the only possible flag guard
  // merely because fighting with it carries some last-unit risk, while a
  // retreat postpones a certain flag loss by one turn.
  const survivalRisk = candidate => Math.max(candidate.danger.flagRisk, candidate.danger.lastUnitRisk, candidate.danger.approachRisk);
  const minimumTerminalRisk = Math.min(...rated.map(survivalRisk));
  const certified = rated.filter(candidate => candidate.winInOwnMoves);
  const fastestWin = Math.min(...certified.map(candidate => candidate.winInOwnMoves));
  // Estimated risks below certainty remain for scoring and multi-ply search.
  // Small probability differences must not delete the only useful guard or
  // attack before that search can compare it with a superficially safer move.
  // Existing score penalties still charge for those probabilistic dangers.
  // Only exclude a certain terminal danger when an alternative avoids it;
  // if every move has that danger, keep them all for the best fighting chance.
  // A proof outranks ALL numerical estimates, including a sampled flag chance
  // that happens to be 100% while its logical domain still permits other ranks.
  let safe = certified.length ? certified.filter(candidate => candidate.winInOwnMoves === fastestWin) :
    rated.filter(candidate => candidate.draw || candidate.knownFlag || candidate.conditionalFlagRace ||
      minimumTerminalRisk >= 1 - 1e-9 || survivalRisk(candidate) < 1 - 1e-9);
  // Spend the route budget only on moves which can enter the comparison.
  // Evaluating dozens of already rejected moves used to time out this entire
  // feature in the very endgames for which it was intended. This budget is
  // part of (never added to) the existing total turn budget.
  if (!certified.length) {
    offense = rateFlagOffense(observation, beliefs, safe.filter(candidate => !candidate.draw),
      { clock: now, timeLimitMs: Math.min(difficulty === 'hell' ? 350 : 180, Math.max(0, startedAt + timeLimitMs - now())) });
    for (const candidate of safe) {
      const plan = offense.scores.get(`${candidate.from}:${candidate.to}`);
      candidate.flagProgress = plan?.progress || 0;
      candidate.flagPlan = plan?.plan || null;
      candidate.features.plan += candidate.flagProgress;
      candidate.strategic += candidate.flagProgress;
      if (!candidate.draw) candidate.score = Math.min(candidate.allowOpponentDraw ? drawValue : Infinity, candidate.score + candidate.flagProgress);
    }
    safe.sort((a, b) => b.score - a.score || a.from - b.from || a.to - b.to);
  }
  let candidates = safe.slice(0, config.candidates);
  // Keep one concrete flag-route improvement in the deeper comparison. A
  // shallow material search cannot see a three-move finish and must not prune
  // every attacking continuation before the deeper iteration gets to it.
  // This adds a candidate, never a win certificate or a safety exemption.
  const flagAdvance = safe.filter(candidate => !candidate.draw && candidate.flagProgress > 1 && candidate.flagPlan?.turns <= 4)
    .sort((a, b) => b.flagProgress - a.flagProgress || a.flagPlan.turns - b.flagPlan.turns || b.score - a.score)[0];
  if (flagAdvance && !candidates.includes(flagAdvance)) candidates.push(flagAdvance);
  for (const race of safe.filter(candidate => candidate.conditionalFlagRace))
    if (!candidates.includes(race)) candidates.push(race);
  for (const special of [safe.find(candidate => candidate.draw), safe.find(candidate => !candidate.draw)])
    if (special && !candidates.includes(special)) candidates.push(special);
  if (beliefs.worlds.length && candidates.some(candidate => !candidate.draw && !candidate.winInOwnMoves)) {
    const worlds = sampledBoards(observation, beliefs, config.searchWorlds, rng);
    statistics.searchWorlds = worlds.length;
    const rows = new Map(candidates.filter(candidate => !candidate.draw && !candidate.winInOwnMoves).map(candidate => [candidate,
      worlds.map(board => {
        const attacker = board[candidate.from], defender = board[candidate.to];
        const battle = defender ? materialBattle(attacker, defender, board) : { score: 0, result: 'move' };
        return { board: projectMove(board, candidate.from, candidate.to).board, gain: battle.score, won: defender?.type === 'flag',
          conditionalFlagSurvived: !!candidate.conditionalFlagRace && battle.result === 'win',
          quiet: defender ? 0 : (observation.quiet || 0) + 1, immediate: null };
      })]));
    const scoreCandidate = (candidate, searched, lossMass) => Math.min(candidate.allowOpponentDraw ? drawValue : Infinity, candidate.gain + candidate.attackBonus - candidate.penalty + candidate.strategic +
      (searched - candidate.gain) * 0.68 - candidate.danger.risk * 0.38 * weights.risk - Math.max(candidate.danger.flagRisk, candidate.danger.lastUnitRisk) * VALUE.flag * 1.3 -
      candidate.danger.approachRisk * 1250 - candidate.danger.invasionRisk * 700 - lossMass * VALUE.flag * 0.4);
    let pool = candidates;
    for (let depth = 2; depth <= maxDepth; depth += 2) {
      if (depth > 2 && now() - startedAt >= timeLimitMs * 0.96) { control.reason = 'time'; break; }
      statistics.attemptedDepth = depth;
      const searchConfig = { ...config, quietFlagExtension: true, rootDepth: depth - 1, qDepth: depth > 2 ? 2 : 0, escapeOrdering: depth > 2 };
      const completed = [];
      try {
        for (const candidate of pool) {
          if (candidate.draw || candidate.winInOwnMoves) continue;
          let total = 0, lossMass = 0;
          for (const row of rows.get(candidate)) {
            checkSearchBudget(statistics);
            let score = row.gain;
            if (!row.won) score -= 0.94 * tacticalSearch(row.board, opponent(side), depth - 1, searchConfig, statistics,
              -Infinity, Infinity, row.quiet);
            // A terminal result inside one guessed army is not a public win.
            // Rare sampled immobilization wins must not outweigh sacrificing
            // a real unit in nearly every other world whose eventual loss is
            // still beyond the horizon. Keep the real referee/search terminal
            // value and proven root wins unchanged; bound this optimistic
            // root utility only. A sampled direct flag capture keeps its
            // separate, immediate capture value (it is not called a proof).
            // Only this row's successful root capture satisfies the public
            // conditional proof. Mine/bomb/higher-rank failures receive no
            // exemption, nor do unrelated optimistic sampled terminals.
            const certifiedBranchWin = row.conditionalFlagSurvived && score > VALUE.flag * 0.6;
            if (!row.won && !certifiedBranchWin && score > VALUE.flag * 0.6) score = Math.max(row.gain, VALUE.commander);
            if (depth === 2) row.immediate = score;
            else if (!certifiedBranchWin) score = conservativeContinuation(row.immediate, score);
            total += score;
            if (score < -VALUE.flag * 0.6) lossMass++;
          }
          const mass = lossMass / worlds.length;
          completed.push({ candidate, score: scoreCandidate(candidate, total / worlds.length, mass), lossMass: mass });
        }
      } catch (error) {
        if (error !== SEARCH_INTERRUPTED) throw error;
        statistics.aborted = true; break;
      }
      // Commit atomically: an interrupted iteration cannot favour the first
      // candidate or whichever sampled worlds happened to be evaluated first.
      for (const result of completed) Object.assign(result.candidate, { score: result.score, lossMass: result.lossMass });
      statistics.completedDepth = depth; candidates = pool;
      candidates.sort((a, b) => b.score - a.score || a.from - b.from || a.to - b.to);
      if (depth === 4 && depth < maxDepth && baseDanger.flagRisk <= 0.001) {
        pool = candidates.slice(0, config.finalists);
        if (flagAdvance && candidates.includes(flagAdvance) && !pool.includes(flagAdvance)) pool.push(flagAdvance);
        for (const race of candidates.filter(candidate => candidate.conditionalFlagRace))
          if (!pool.includes(race)) pool.push(race);
        const draw = candidates.find(candidate => candidate.draw);
        if (draw && !pool.includes(draw)) pool.push(draw);
      }
    }
  }
  for (const candidate of candidates) if (candidate.draw && !candidate.knownFlag)
    candidate.score = drawValue;
  candidates.sort((a, b) => b.score - a.score || a.from - b.from || a.to - b.to);
  const selection = variedChoice(candidates.length ? candidates : rated, observation, difficulty, context, baseDanger, rng);
  const chosen = selection.chosen, description = describeDecision(chosen, observation, baseDanger);
  const learningFeatures = {
    attack: clamp(Math.max(0, chosen.gain) / 200 + Math.max(0, chosen.flagProgress) / 64), scout: clamp(chosen.features.scout / 8),
    shelter: clamp(chosen.features.shelter / 25), defend: clamp(Math.max(0, chosen.features.defend) / 15 + baseDanger.flagRisk +
      Math.max(0, baseDanger.approachRisk - chosen.danger.approachRisk) + Math.max(0, baseDanger.invasionRisk - chosen.danger.invasionRisk)),
    develop: clamp(Math.max(0, chosen.features.develop) / 10),
    risk: clamp((chosen.danger.risk + (chosen.casualty || 0) * pieceValue(observation.board[chosen.from].type, observation.board, side)) / 150),
    bombCaution: observation.board[chosen.from].type === 'bomb' ? 0 : clamp(chosen.bombChance * 3),
  };
  return { from: chosen.from, to: chosen.to, info: {
    difficulty, sampledWorlds: statistics.worlds, searchWorlds: statistics.searchWorlds,
    searchedReplies: statistics.replies, searchedNodes: statistics.nodes, searchDepth: statistics.completedDepth, legalMoves: moves.length,
    inferredPieces: Object.values(beliefs.domains).filter(domain => domain.length === 1).length,
    beliefConsistent: beliefs.consistent, expectedScore: Math.round(chosen.score * 10) / 10,
    method: `公开线索推断 · 主动展开 · 旗路预防 · ${statistics.completedDepth} 层采样搜索`,
    diagnostics: { initiative: Math.round(initiative.urgency * 100) / 100, flagApproachRisk: Math.round(chosen.danger.approachRisk * 1000) / 1000,
      flagInvasionRisk: Math.round(chosen.danger.invasionRisk * 1000) / 1000, repetitionDraw: chosen.repetitionDraw, quietDraw: chosen.quietDraw, allowOpponentDraw: chosen.allowOpponentDraw,
      lastUnitRisk: Math.round(chosen.danger.lastUnitRisk * 1000) / 1000,
      flagReserveRisk: Math.round(chosen.reserveRisk * 1000) / 1000, flagBreachRisk: Math.round(chosen.breachRisk * 1000) / 1000,
      flagRouteRisk: Math.round(chosen.routeRisk * 1000) / 1000,
      flagAttackProgress: Math.round(chosen.flagProgress * 1000) / 1000, flagAttackTurns: chosen.flagPlan?.turns ?? null,
      flagPlannerEnabled: offense.enabled, flagPlannerReason: offense.reason || null,
      flagPlannerNodes: offense.nodes, flagPlannerElapsedMs: Math.round(offense.elapsedMs),
      retainedFlagAdvance: flagAdvance ? { from: flagAdvance.from, to: flagAdvance.to } : null,
      conditionalFlagRace: !!chosen.conditionalFlagRace, conditionalFlagProofNodes: raceProofNodes,
      mineTargets: mineTasks.length, selectionGap: selection.selectionGap, selectionPool: selection.selectionPool,
      provenWin: chosen.winInOwnMoves > 0, winInOwnMoves: chosen.winInOwnMoves, mode: chosen.winInOwnMoves ? 'finish' : selection.mode,
      completedDepth: statistics.completedDepth, attemptedDepth: statistics.attemptedDepth, searchAborted: statistics.aborted,
      elapsedMs: Math.round(now() - startedAt), timeLimitMs, budgetReason: control.reason,
      finalistCount: candidates.length, quiescenceNodes: statistics.extensions, cacheHits: statistics.cacheHits,
      quietTerminals: statistics.quietDraws || 0 },
    ...description, learningFeatures,
  } };
}


