/** Offline deployment planner. Its inputs deliberately contain no human board or game state. */
import { TYPES, isCamp, isHQ, canPlace, randomLayout, legalMoves } from './engine.js';

const SITES = Array.from({ length: 30 }, (_, i) => i).filter(i => !isCamp(i));
const LEVELS = new Set(['professional', 'hell']);
const STRONG_HQ = new Set(['mine', 'platoon', 'company']);
const row = i => Math.floor(i / 5);
const col = i => i % 5;
const distance = (a, b) => Math.abs(row(a) - row(b)) + Math.abs(col(a) - col(b));
const rank = type => TYPES[type].rank ?? 0;

function exchange(board, a, b) { [board[a], board[b]] = [board[b], board[a]]; }
function canExchange(board, a, b) {
  return a !== b && board[a] && board[b]
    && canPlace(board[a].type, 'ai', b) && canPlace(board[b].type, 'ai', a);
}
function pick(values, rng) { return values[Math.floor(rng() * values.length)]; }

// Remove all friends that can eventually move. A unit still unable to leave is
// sealed by our own permanent mines/HQs, not merely waiting for an opening.
// This uses our deployment alone; no opponent layout is available here.
export function permanentlyTrappedUnits(board) {
  const fixed = board.map((piece, at) => piece && (isHQ(at) || ['mine', 'flag'].includes(piece.type)) ? piece : null);
  return board.flatMap((piece, at) => {
    if (!piece || isHQ(at) || ['mine', 'flag'].includes(piece.type)) return [];
    const opened = fixed.slice(); opened[at] = piece;
    return legalMoves(opened, at).length ? [] : [at];
  });
}
const needsExit = piece => piece && (rank(piece.type) >= 4 || ['engineer', 'bomb'].includes(piece.type));

function profileFor(level, rng) {
  // These are private, mixed preferences, not named templates or observable rank placements.
  const style = level === 'hell' ? pick(['flanks', 'probe', 'ambush', 'engineers'], rng) : 'balanced';
  const guardRoll = rng();
  return {
    level, style, wing: rng() < 0.5 ? 0 : 4,
    guardTarget: level === 'hell'
      ? (guardRoll < 0.06 ? 0 : guardRoll < 0.32 ? 1 : guardRoll < 0.83 ? 2 : 3)
      : (guardRoll < 0.22 ? 1 : guardRoll < 0.87 ? 2 : 3),
    frontTarget: style === 'ambush' ? 1 : style === 'flanks' ? 2 : 1 + Math.floor(rng() * 2),
    advance: 0.65 + rng() * 0.6,
    defend: 0.75 + rng() * 0.55,
    // Independently vary every type's positional preference each game. No fixed tell survives.
    jitter: Object.fromEntries(Object.keys(TYPES).map(type => [type,
      Array.from({ length: 30 }, () => (rng() - 0.5) * (level === 'hell' ? 2.6 : 3.4))])),
  };
}

function structuralRules(board, level) {
  const allowed = STRONG_HQ;
  for (const i of [1, 3]) if (board[i].type !== 'flag' && !allowed.has(board[i].type)) return false;
  if (permanentlyTrappedUnits(board).some(at => needsExit(board[at]))) return false;
  const engineers = SITES.filter(i => board[i].type === 'engineer');
  // Retain a mobile reserve; do not put every engineer on the exposed first line.
  if (!engineers.some(i => row(i) >= 1 && row(i) <= 3)) return false;
  return level !== 'hell' || new Set(engineers.map(col)).size >= 2;
}

function prepare(board, level, rng) {
  const allowed = STRONG_HQ;
  const hq = board[1].type === 'flag' ? 3 : 1;
  if (!allowed.has(board[hq].type)) {
    const destinations = SITES.filter(i => allowed.has(board[i].type) && canExchange(board, hq, i));
    exchange(board, hq, pick(destinations, rng));
  }
  // Expendable rear sentries may remain as decoys; officers, bombs and engineers
  // must have an eventual exit without an opponent first removing our mines.
  for (const from of permanentlyTrappedUnits(board).filter(at => needsExit(board[at]))) {
    const destinations = SITES.filter(to => ['company', 'platoon'].includes(board[to].type) &&
      !isHQ(to) && canExchange(board, from, to) && !permanentlyTrappedUnits(board).includes(to));
    if (destinations.length) exchange(board, from, pick(destinations, rng));
  }
  let trapped = permanentlyTrappedUnits(board).filter(at => needsExit(board[at])).length;
  while (trapped) {
    // A trapped rear bomb cannot swap with a front-row small officer. Moving
    // its blocking mine instead is a legal repair and may open several exits.
    const repairs = [];
    for (const a of SITES) for (const b of SITES) {
      if (a >= b || board[a].type === 'flag' || board[b].type === 'flag' || !canExchange(board,a,b)) continue;
      exchange(board,a,b);
      const count = permanentlyTrappedUnits(board).filter(at => needsExit(board[at])).length;
      if (count < trapped && [1,3].every(at => board[at].type === 'flag' || allowed.has(board[at].type))) repairs.push([a,b,count]);
      exchange(board,a,b);
    }
    if (!repairs.length) break;
    const [a,b,count] = pick(repairs,rng); exchange(board,a,b); trapped=count;
  }
  if (!structuralRules(board, level)) {
    // Swapping an engineer with an ordinary officer cannot invalidate mine/bomb/flag placement.
    const pairs = [];
    for (const from of SITES.filter(i => board[i].type === 'engineer')) {
      for (const to of SITES.filter(i => !isHQ(i) && row(i) >= 1 && row(i) <= 3 && rank(board[i].type) >= 2)) {
        if (!canExchange(board, from, to)) continue;
        exchange(board, from, to);
        if (structuralRules(board, level)) pairs.push([from, to]);
        exchange(board, from, to);
      }
    }
    if (pairs.length) exchange(board, ...pick(pairs, rng));
  }
  return board;
}

function deploymentScore(board, profile) {
  let score = 0, frontlineOfficers = 0, frontlineSmall = 0, frontlineBig = 0;
  const flag = board[1].type === 'flag' ? 1 : 3;
  const flagGuard = [flag - 1, flag + 1, flag + 5];
  const flagMines = flagGuard.filter(i => board[i].type === 'mine').length;
  score -= Math.abs(flagMines - profile.guardTarget) * 5 * profile.defend;
  const engineers = [], bombs = [], big = [];

  for (const i of SITES) {
    const type = board[i].type, value = rank(type), r = row(i), c = col(i);
    score += profile.jitter[type][i];
    if (isHQ(i)) continue;
    const onRail = r === 1 || r === 5 || c === 0 || c === 4;
    if (type === 'engineer') {
      engineers.push(i);
      score += (onRail ? 1.3 : 0) + (r >= 2 && r <= 4 ? 1.8 : 0) - (r === 0 ? 3 : 0);
      if (profile.style === 'engineers') score += (onRail ? 2.5 : 0) + (r === 2 || r === 3 ? 1.5 : 0);
    } else if (type === 'bomb') {
      bombs.push(i);
      score += r >= 2 && r <= 4 ? 1.6 : -1.5;
      if (profile.style === 'ambush') score += r >= 2 && r <= 3 ? 2.3 : 0;
      if (profile.style === 'flanks') score += c === 0 || c === 4 ? 1.4 : 0;
    } else if (type === 'mine') {
      // Rear rail mines can protect a flag, but three fixed flag guards are not mandatory.
      if (r === 1 && (c === 0 || c === 4)) score -= 0.9;
    } else if (value > 0) {
      if (r === 5) {
        if (value >= 4) frontlineOfficers++;
        if (value <= 3) frontlineSmall++;
        if (value >= 7) frontlineBig++;
        score += value >= 4 ? 1.4 * profile.advance : 0.5;
        if (profile.style === 'probe' && c === 2 && value <= 4) score += 3;
        if (profile.style === 'ambush' && value <= 4) score += 1.6;
      }
      if (value >= 7) {
        big.push(i);
        score += r === 0 ? -8 : r >= 3 ? 1.3 : 0;
        if (profile.style === 'ambush' && r >= 2 && r <= 4) score += 2;
      }
      if (profile.style === 'flanks' && value >= 5 && r >= 3) score += (4 - Math.abs(c - profile.wing)) * 0.55;
      if (profile.style === 'probe' && value >= 6 && r >= 2 && r <= 4 && c >= 1 && c <= 3) score += 1.8;
    }
  }

  score -= Math.abs(frontlineBig - profile.frontTarget) * 2.8;
  score += Math.min(frontlineOfficers, 3) * 1.1;
  score += frontlineSmall > 0 ? 2.8 : -3.5;
  if (frontlineOfficers === 5) score -= 2;
  for (const bomb of bombs) {
    const nearestBig = Math.min(...big.map(i => distance(i, bomb)));
    score += nearestBig <= 2 ? 2.5 : -1;
    if (distance(bomb, flag) <= 4) score += profile.defend;
  }
  if (distance(bombs[0], bombs[1]) <= 1) score -= 3;
  for (let a = 0; a < big.length; a++) {
    for (let b = a + 1; b < big.length; b++) if (distance(big[a], big[b]) <= 1) score -= 1.7;
  }
  score += new Set(engineers.map(col)).size * 1.1;
  for (const engineer of engineers) {
    if (profile.style === 'engineers' && big.some(i => distance(i, engineer) <= 2)) score += 1.8;
    for (const other of engineers) if (other > engineer && distance(engineer, other) <= 1) score -= 1.8;
  }
  return score;
}

/** Generate a fresh, legal AI deployment using difficulty and randomness only. */
export function createAILayout(difficulty = 'professional', rng = Math.random) {
  const level = LEVELS.has(difficulty) ? difficulty : 'professional';
  if (typeof rng !== 'function') throw new TypeError('阵型随机源必须是函数');
  const random = () => {
    const value = Number(rng());
    return Number.isFinite(value) ? Math.max(0, Math.min(1 - Number.EPSILON, value)) : 0.5;
  };
  const profile = profileFor(level, random);
  const candidates = level === 'hell' ? 8 : 4, steps = level === 'hell' ? 150 : 95;
  let best = null, bestScore = -Infinity;
  for (let attempt = 0; attempt < candidates; attempt++) {
    const board = prepare(randomLayout('ai', random), level, random);
    // Never admit an unrepairable initial layout as the best candidate.
    if (!structuralRules(board,level)) continue;
    let score = deploymentScore(board, profile);
    if (score > bestScore) { best = board.slice(); bestScore = score; }
    for (let step = 0; step < steps; step++) {
      const a = pick(SITES, random), b = pick(SITES, random);
      // Keep the initial random flag side independent of subsequent positional preferences.
      if (board[a].type === 'flag' || board[b].type === 'flag' || !canExchange(board, a, b)) continue;
      exchange(board, a, b);
      if (!structuralRules(board, level)) { exchange(board, a, b); continue; }
      const candidateScore = deploymentScore(board, profile);
      const temperature = 0.15 + 1.8 * (1 - step / steps);
      if (candidateScore >= score || random() < Math.exp((candidateScore - score) / temperature)) score = candidateScore;
      else exchange(board, a, b);
      if (score > bestScore) { best = board.slice(); bestScore = score; }
    }
  }
  if (!best) throw new Error('无法生成满足机动要求的合法阵型');
  return finish(best);
}

function finish(board) {
  // IDs originate in engine.randomLayout's opaque UUIDs and never encode strategy or identity.
  return board.map((piece, i) => piece ? { ...piece, origin: i, moved: false } : null);
}
