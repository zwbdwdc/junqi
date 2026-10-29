/* Resignation is a proof, never a low sampled score. Only the sanitized
 * observation enters this module; all still-possible combat outcomes count. */
import { legalMoves, combat, TYPES } from './engine.js';
import { inferDomains } from './beliefs.js';
import { createFlagDrawGuard } from './quiet-flag.js';

const other = side => side === 'ai' ? 'human' : 'ai';
const exhausted = Symbol('resignation-budget');

/** Prove that EVERY move loses on the opponent's very next turn. A missing
 * proof is deliberately not evidence of a loss. Camps, mountains, uncertain
 * ranks, counterwins and possible draws all remain valid ways to continue. */
function assessImmediateResignation(observation, options = {}) {
  const clock = typeof options.clock === 'function' ? options.clock : () => performance.now();
  const started = clock(), timeLimit = Math.max(0, options.timeLimitMs ?? 60);
  const nodeLimit = Math.max(0, options.nodeLimit ?? 12000);
  let nodes = 0, ownMoves = 0, branches = 0;
  const finish = (resign, reason) => ({ resign, reason, proof: {
    ownMoves, branches, nodes, maxPlies: resign ? 2 : null,
    elapsedMs: Math.max(0, clock() - started),
  } });
  const check = () => {
    if (++nodes > nodeLimit || clock() - started >= timeLimit) throw exhausted;
  };
  const side = observation?.side, enemy = other(side), board = observation?.board;
  if (!['ai', 'human'].includes(side) || observation.turn !== side || observation.result ||
      !Array.isArray(board) || ![60, 62].includes(board.length) ||
      observation.enemyRoster?.length !== 25 || observation.ownRoster?.length !== 25 ||
      !board.some(piece => piece?.side === side && piece.type === 'flag') ||
      board.some(piece => piece?.side === side && !TYPES[piece.type])) return finish(false, 'unavailable');
  try {
    check();
    const domains = inferDomains(observation);
    if (Object.values(domains).some(domain => !domain.length) ||
        board.some(piece => piece?.side === enemy && !domains[piece.id]?.length)) return finish(false, 'inconsistent');
    const drawGuard = createFlagDrawGuard(observation);
    const canMove = position => position.some((piece, from) => piece?.side === side && legalMoves(position, from).length > 0);
    const project = (position, from, to, attackerType, defenderType) => {
      const next = position.slice(), attacker = position[from], target = position[to];
      const result = target ? combat(attackerType, defenderType) : 'move';
      next[from] = null;
      next[to] = result === 'lose' ? target : result === 'both' ? null : { ...attacker, moved: true };
      return { board: next, result };
    };
    // The opponent must have a single legal, winning reply across ALL its
    // supported ranks. This is stronger (and safer) than choosing a different
    // convenient reply in each guessed army.
    const hasCertainWinningReply = (position, possible) => {
      for (let from = 0; from < position.length; from++) {
        const attacker = position[from];
        if (attacker?.side !== enemy) continue;
        const types = possible[attacker.id];
        let common = null;
        for (const type of types) {
          check();
          const hypothesis = position.slice(); hypothesis[from] = { ...attacker, type };
          const destinations = new Set(legalMoves(hypothesis, from));
          common = common === null ? destinations : new Set([...common].filter(to => destinations.has(to)));
          if (!common.size) break;
        }
        for (const to of common || []) {
          check();
          const target = position[to];
          // Capturing a flag wins even when a bomb also destroys the attacker.
          if (target?.type === 'flag') return true;
          let certain = true;
          for (const type of types) {
            check();
            const next = project(position, from, to, type, target?.type).board;
            // The referee awards no-moves before either draw rule, including
            // mutual destruction of the two sides' final movable pieces.
            if (canMove(next)) { certain = false; break; }
          }
          if (certain) return true;
        }
      }
      return false;
    };
    for (let from = 0; from < board.length; from++) {
      const attacker = board[from];
      if (attacker?.side !== side) continue;
      for (const to of legalMoves(board, from)) {
        check(); ownMoves++;
        const target = board[to], supported = target ? domains[target.id] : [null];
        if (supported.includes('flag')) return finish(false, 'counterwin-possible');
        const outcomes = new Map();
        for (const type of supported) {
          check();
          const next = project(board, from, to, attacker.type, type);
          const branch = outcomes.get(next.result) || { ...next, types: [] };
          branch.types.push(type); outcomes.set(next.result, branch);
        }
        for (const branch of outcomes.values()) {
          check(); branches++;
          const quiet = target ? 0 : (observation.quiet || 0) + 1;
          // A possible draw is sufficient to refuse resignation. A root
          // no-moves win is also retained because it has no legal enemy reply.
          if (quiet >= 100 || drawGuard.wouldDraw(branch.board, enemy)) return finish(false, 'draw-possible');
          const possible = target && branch.result === 'lose'
            ? { ...domains, [target.id]: branch.types } : domains;
          if (!hasCertainWinningReply(branch.board, possible)) return finish(false, 'escape-possible');
        }
      }
    }
    // Already having no move is the referee's job; do not invent a resignation.
    return finish(ownMoves > 0, ownMoves > 0 ? 'forced-loss' : 'no-moves');
  } catch (error) {
    if (error !== exhausted) throw error;
    return finish(false, 'budget');
  }
}

/** A bounded public AND-OR proof. Every friendly move and supported combat
 * outcome must lose. An enemy reply must be the SAME legal action for all
 * remaining ranks; its every outcome must preserve the forced win. Keeping
 * independent rank domains (rather than guessed armies) over-approximates
 * uncertainty and can only reject a proof, never erase a possible escape. */
export function assessResignation(observation, options = {}) {
  const clock = typeof options.clock === 'function' ? options.clock : () => performance.now();
  const started = clock(), timeLimit = Math.max(0, options.timeLimitMs ?? 180);
  const nodeLimit = Math.max(0, options.nodeLimit ?? 500000);
  const requested = Number.isFinite(options.maxPlies) ? options.maxPlies : 6;
  const maxPlies = Math.max(2, Math.min(6, Math.floor(requested / 2) * 2));
  const immediate = assessImmediateResignation(observation, { ...options, clock,
    timeLimitMs: Math.min(timeLimit, 60), nodeLimit });
  immediate.proof.elapsedMs = Math.max(0, clock() - started);
  if (immediate.resign || maxPlies === 2 ||
      ['unavailable', 'inconsistent', 'no-moves', 'budget', 'counterwin-possible', 'draw-possible'].includes(immediate.reason)) return immediate;
  const side = observation.side, enemy = other(side), initial = observation.board;
  const domains = inferDomains(observation);
  // Deep proofs are reserved for sparse positions or a nearby flag invader.
  // A crowded army must not hide a short forced mate at its own headquarters.
  const active = initial.filter(p => p && (p.side === side
    ? !['mine', 'flag'].includes(p.type) : domains[p.id].some(type => !['mine', 'flag'].includes(type)))).length;
  const flagAt = initial.findIndex(p => p?.side === side && p.type === 'flag');
  const nearbyInvader = initial.some((p, at) => p?.side === enemy &&
    Math.abs(Math.floor(at / 5) - Math.floor(flagAt / 5)) + Math.abs(at % 5 - flagAt % 5) <= 3 &&
    domains[p.id].every(type => !['mine', 'flag'].includes(type)));
  if (active > (options.maxActivePieces ?? 12) && !nearbyInvader) return immediate;
  const guard = createFlagDrawGuard(observation);
  let nodes = immediate.proof.nodes, ownMoves = immediate.proof.ownMoves, branches = immediate.proof.branches;
  let completedPlies = 2, attemptedPlies = 2;
  const check = () => { if (++nodes > nodeLimit || clock() - started >= timeLimit) throw exhausted; };
  const finish = (resign, reason, depth = null) => ({ resign, reason, proof: {
    ownMoves, branches, nodes, maxPlies: depth, completedPlies, attemptedPlies,
    elapsedMs: Math.max(0, clock() - started),
  } });
  const ourHasMove = board => {
    for (let from = 0; from < board.length; from++) if (board[from]?.side === side) {
      check(); if (legalMoves(board, from).length) return true;
    }
    return false;
  };
  const certainFlagCapture = (board, possible) => {
    const flag = board.findIndex(p => p?.side === side && p.type === 'flag');
    for (let from = 0; from < board.length; from++) {
      const attacker = board[from]; if (attacker?.side !== enemy) continue;
      let certain = true;
      for (const type of possible[attacker.id]) {
        check(); const hypothesis = board.slice(); hypothesis[from] = { ...attacker, type };
        if (!legalMoves(hypothesis, from).includes(flag)) { certain = false; break; }
      }
      if (certain) return true;
    }
    return false;
  };
  const ourMoves = board => {
    const moves = [];
    for (let from = 0; from < board.length; from++) if (board[from]?.side === side) {
      check();
      for (const to of legalMoves(board, from)) moves.push({ from, to });
    }
    // Try counterplay first: finding a single escape is enough to keep playing.
    return moves.sort((a, b) => Number(!!board[b.to]) - Number(!!board[a.to]));
  };
  const enemyMoves = (board, possible) => {
    const moves = [];
    for (let from = 0; from < board.length; from++) {
      const piece = board[from]; if (piece?.side !== enemy) continue;
      let common = null;
      for (const type of possible[piece.id]) {
        check();
        const hypothesis = board.slice(); hypothesis[from] = { ...piece, type };
        const destinations = new Set(legalMoves(hypothesis, from));
        common = common === null ? destinations : new Set([...common].filter(to => destinations.has(to)));
        if (!common.size) break;
      }
      for (const to of common || []) moves.push({ from, to });
    }
    const flag = board.findIndex(p => p?.side === side && p.type === 'flag');
    const distance = at => Math.abs(Math.floor(at / 5) - Math.floor(flag / 5)) + Math.abs(at % 5 - flag % 5);
    return moves.sort((a, b) =>
      Number(board[b.to]?.type === 'flag') - Number(board[a.to]?.type === 'flag') ||
      distance(a.to) - distance(b.to) || Number(!!board[b.to]) - Number(!!board[a.to]));
  };
  const project = (board, move, possible, turn) => {
    const attacker = board[move.from], target = board[move.to];
    const unknown = turn === side ? target : attacker;
    const types = unknown ? possible[unknown.id] : [null], outcomes = new Map();
    for (const type of types) {
      check();
      const result = !target ? 'move' : combat(turn === side ? attacker.type : type, turn === side ? type : target.type);
      if (!outcomes.has(result)) {
        const boardAfter = board.slice(); boardAfter[move.from] = null;
        boardAfter[move.to] = result === 'lose' ? target : result === 'both' ? null : { ...attacker, moved: true };
        outcomes.set(result, { board: boardAfter, types: [] });
      }
      outcomes.get(result).types.push(type);
    }
    return [...outcomes.values()].map(branch => ({ board: branch.board,
      // Observed battle outcomes narrow only the participating enemy token.
      // Unmodelled flag/commander revelations leave a larger, safer domain.
      possible: unknown ? { ...possible, [unknown.id]: branch.types } : possible }));
  };
  const solve = (board, possible, turn, quiet, depth) => {
    check(); if (depth <= 0) return false;
    if (turn === enemy && certainFlagCapture(board, possible)) return true;
    const moves = turn === side ? ourMoves(board) : enemyMoves(board, possible);
    if (!moves.length) return turn === side;
    for (const move of moves) {
      check();
      const target = board[move.to], nextTurn = other(turn);
      if (turn === side) {
        ownMoves++;
        // Even an unconfirmed enemy flag is a possible immediate counterwin.
        if (target && possible[target.id].includes('flag')) return false;
      } else if (target?.type === 'flag') return true;
      let allOutcomesLose = true;
      for (const branch of project(board, move, possible, turn)) {
        check(); branches++;
        const nextQuiet = target ? 0 : quiet + 1;
        // The referee checks no-moves before either draw rule. After our move,
        // enemyMoves in solve must find a common reply or refuse the proof.
        let lost;
        if (nextTurn === side && !ourHasMove(branch.board)) lost = true;
        else if (nextQuiet >= 100 || guard.wouldDraw(branch.board, nextTurn)) lost = false;
        else lost = guard.withPosition(branch.board, nextTurn,
          () => solve(branch.board, branch.possible, nextTurn, nextQuiet, depth - 1));
        if (!lost) { allOutcomesLose = false; break; }
      }
      if (turn === side && !allOutcomesLose) return false;
      if (turn === enemy && allOutcomesLose) return true;
    }
    return turn === side;
  };
  try {
    for (let depth = 4; depth <= maxPlies; depth += 2) {
      attemptedPlies = depth;
      const lost = solve(initial, domains, side, observation.quiet || 0, depth);
      completedPlies = depth;
      if (lost) return finish(true, 'forced-loss', depth);
    }
    return finish(false, 'escape-possible');
  } catch (error) {
    if (error !== exhausted) throw error;
    return finish(false, 'budget');
  }
}
