import { legalMoves, combat, isHQ, isCamp, isMountain } from './engine.js';

const mobile = p => p && !['flag', 'mine'].includes(p.type);
const signature = board => board.map(p => p ? `${p.side}:${p.id}:${p.type || '?'}` : '-').join('|');
const stop = Symbol('offensive-budget');
const clamp = x => Math.max(0, Math.min(1, x));
const relaxedCache = new Map();
function relaxedDistance(type, goal, size) {
  const movement = type === 'engineer' ? type : 'company', key = `${movement}:${goal}:${size}`;
  if (relaxedCache.has(key)) return relaxedCache.get(key);
  const incoming = Array.from({length:size},()=>[]);
  for(let from=0;from<size;from++) {
    const empty=Array(size).fill(null);empty[from]={type:movement,side:'ai'};
    for(const to of legalMoves(empty,from))incoming[to].push(from);
  }
  const distance=Array(size).fill(Infinity),queue=[goal];distance[goal]=0;
  for(let i=0;i<queue.length;i++)for(const from of incoming[queue[i]])if(distance[from]===Infinity){distance[from]=distance[queue[i]]+1;queue.push(from);}
  relaxedCache.set(key,distance);return distance;
}

/** Public, bounded strategic route estimate, NOT a forced-win certificate.
 * Enemy pieces keep their public types. A dark blocker is traversable only
 * when every logically supported identity loses and the attacker survives.
 * Actual roads, railways, camps, HQ and occupied squares come from the referee
 * movement function; no Manhattan or friendly-piece teleport is used.
 *
 * Returned progress is an ARMY potential difference: moving an unrelated
 * second unit cannot repeatedly collect forward/camp development credit.
 * It belongs beside ordinary strategy and NEVER overrides terminal safety.
 */
export function rateFlagOffense(observation, beliefs, moves, options = {}) {
  const side = observation.side || 'ai', enemy = side === 'ai' ? 'human' : 'ai';
  const now = options.clock || (() => performance.now()), started = now();
  const limit = options.timeLimitMs ?? 90, maxDepth = options.maxDepth ?? 7;
  const nodeLimit = options.nodeLimit ?? options.maxNodes ?? 12000;
  const cache = new Map(), attacksCache = new Map(), results = new Map();
  let nodes = 0, budgetReason = null, conditional = null, evidenceKey = '';
  const check = () => {
    if(nodes>=nodeLimit){budgetReason='nodes';throw stop;}
    if(now()-started>=limit){budgetReason='time';throw stop;}
  };
  const support = p => conditional?.id === p.id ? conditional.types : p.type ? [p.type] : beliefs.domains?.[p.id] || [];
  const knownFlag = p => p?.side === enemy && support(p).length === 1 && support(p)[0] === 'flag';
  const flag = observation.board.findIndex(knownFlag);
  if (flag < 0) return { enabled: false, reason: 'flag-unconfirmed', scores: results, elapsedMs: now() - started, nodes };
  if (beliefs.consistent === false) return { enabled: false, reason: 'inconsistent-beliefs', scores: results, elapsedMs: now() - started, nodes };
  if(observation.board.some(p=>p?.side===enemy&&!support(p).length))
    return {enabled:false,reason:'missing-public-domain',scores:results,elapsedMs:now()-started,nodes};
  const probability = (p, accepts) => {
    const types = support(p);
    if (!types.length) return 1;
    if (beliefs.consistent === false) return Number(types.some(accepts));
    const raw = beliefs.probabilities?.[p.id], total = types.reduce((n, t) => n + Math.max(0, raw?.[t] || 0), 0);
    if (total <= 0) return types.filter(accepts).length / types.length;
    return clamp(types.reduce((n, t) => n + (accepts(t) ? Math.max(0, raw[t] || 0) : 0), 0) / total);
  };
  const threat = (board, at, piece) => {
    if (isCamp(at) || isMountain(at)) return 0;
    const k = `${signature(board)}:${evidenceKey}:${at}:${piece.type}`;
    if (attacksCache.has(k)) return attacksCache.get(k);
    let risk = 0;
    for (let from = 0; from < board.length; from++) {
      const p = board[from]; if (p?.side !== enemy || isHQ(from)) continue;
      const types = support(p), regular = types.some(t => !['engineer', 'mine', 'flag'].includes(t));
      let normalReach = false, engineerReach = false;
      if (regular) { const b = board.slice(); b[from] = { ...p, type: 'company' }; normalReach = legalMoves(b, from).includes(at); }
      if (types.includes('engineer')) { const b = board.slice(); b[from] = { ...p, type: 'engineer' }; engineerReach = legalMoves(b, from).includes(at); }
      risk = Math.max(risk, probability(p, t => !['mine', 'flag'].includes(t) &&
        (t === 'engineer' ? engineerReach : normalReach) && combat(t, piece.type) !== 'lose'));
    }
    attacksCache.set(k, risk); return risk;
  };
  // Dijkstra over actual occupied-board continuations. A small capture mask
  // keeps a confirmed cleared mine from magically reappearing behind us.
  const route = (board, from, goal, depthLimit = maxDepth, incumbent = Infinity) => {
    const piece = board[from]; if (!mobile(piece) || isHQ(from)) return null;
    const lower = relaxedDistance(piece.type, goal, board.length);
    if(lower[from]>depthLimit||lower[from]>=incumbent)return null;
    const base = board.slice(); base[from] = null;
    const isLastEngineer = piece.type === 'engineer' && board.filter(p => p?.side === side && p.type === 'engineer').length === 1;
    const initialRisk=threat(board,from,piece), hazardScale=isLastEngineer?2.4:1.5;
    const queue = [{ at: from, path: [], cleared: [], cost: initialRisk*hazardScale, exposure: initialRisk }], seen = new Map();
    for (let steps = 0; queue.length && steps < 180; steps++) {
      check(); queue.sort((a,b) => a.cost+lower[a.at]-b.cost-lower[b.at] || a.path.length - b.path.length || a.at - b.at);
      const current = queue.shift(); nodes++;
      if(current.cost+lower[current.at]>=incumbent)continue;
      if (current.at === goal) return { ...current, from, id: piece.id, type: piece.type, turns: current.path.length };
      if (current.path.length >= depthLimit) continue;
      const position = base.slice(); for (const x of current.cleared) position[x] = null;
      position[current.at] = piece;
      for (const to of legalMoves(position, current.at)) {
        if ((isHQ(to) && to !== goal) || to === from || current.path.includes(to)) continue;
        if(current.path.length+1+lower[to]>depthLimit||current.cost+1+lower[to]>=incumbent)continue;
        const defender = position[to];
        if (defender) {
          if (defender.side === side) continue;
          const domain = support(defender);
          if (!(to === flag && knownFlag(defender)) && (!domain.length || !domain.every(t => combat(piece.type, t) === 'win'))) continue;
        }
        const after = position.slice(); after[current.at] = null; after[to] = { ...piece, moved: true };
        const exposure = to === goal ? 0 : threat(after, to, piece);
        const cost = current.cost + 1 + exposure * hazardScale;
        const cleared = defender ? [...current.cleared, to].sort((a,b)=>a-b) : current.cleared;
        const k = `${to}:${cleared.join('.')}`, depth=current.path.length+1;
        const frontier=seen.get(k)||[];
        // A cheaper but longer route cannot discard a shorter route that is
        // the only one capable of finishing within the remaining depth.
        if(frontier.some(x=>x.depth<=depth&&x.cost<=cost))continue;
        seen.set(k,[...frontier.filter(x=>!(depth<=x.depth&&cost<=x.cost)),{depth,cost}]);
        queue.push({ at: to, path: [...current.path, to], cleared, cost, exposure: Math.max(current.exposure, exposure) });
      }
    }
    if(queue.length){budgetReason='route-states';throw stop;}
    return null;
  };
  const potential = board => {
    const k = `${signature(board)}:${evidenceKey}`; if (cache.has(k)) return cache.get(k);
    check(); let best = null;
    const army=board.flatMap((piece,from)=>piece?.side===side&&mobile(piece)?[{from,lower:relaxedDistance(piece.type,flag,board.length)[from]}]:[]).sort((a,b)=>a.lower-b.lower||a.from-b.from);
    for (const {from} of army) {
      const plan = route(board, from, flag,maxDepth,best?.cost??Infinity);
      if (plan && (!best || plan.cost < best.cost || plan.cost === best.cost && plan.from < best.from)) best = plan;
    }
    // A finite band, measured in route tempos. Terminal proofs remain handled
    // by the caller; the heuristic never gets a flag-sized winning score.
    const result = { value: best ? Math.max(0, maxDepth + 1 - best.cost) * 32 : 0, plan: best };
    cache.set(k, result); return result;
  };
  try {
    const baseline = potential(observation.board);
    for (const move of moves) {
      conditional = null; evidenceKey = '';
      check(); const piece = observation.board[move.from], defender = observation.board[move.to];
      if (!piece || piece.side !== side || !legalMoves(observation.board, move.from).includes(move.to)) throw Error('Illegal offensive root candidate');
      const branches = new Map(), branchTypes = new Map();
      if (!defender) branches.set('move', 1);
      else for (const t of support(defender)) {
        const outcome = combat(piece.type, t), mass = probability(defender, type => type === t);
        branches.set(outcome, (branches.get(outcome) || 0) + mass);
        branchTypes.set(outcome,[...(branchTypes.get(outcome)||[]),t]);
      }
      let value = 0, mostLikely = null, topMass = -1;
      const continuations = [];
      for (const [outcome, mass] of branches) {
        if(mass<=0)continue;
        // An observed failed attack tells us the defender belongs to exactly
        // this combat-equivalent subset. It does not expose a particular rank.
        // Keep board.type dark, and retain ALL surviving identities, including
        // a stronger officer that may defeat the intended following regiment.
        conditional = outcome === 'lose' ? { id:defender.id,types:branchTypes.get(outcome) } : null;
        evidenceKey = conditional ? `${conditional.id}=${conditional.types.join(',')}` : '';
        const after = observation.board.slice(); after[move.from] = null;
        after[move.to] = outcome === 'lose' ? defender : outcome === 'both' ? null : { ...piece, moved: true };
        // A root flag capture is already covered by the exact win detector.
        const evaluated = knownFlag(defender) ? { value: baseline.value, plan: null } : potential(after);
        value += mass * evaluated.value;
        continuations.push({outcome,mass,defenderDomain:conditional?.types||null,value:evaluated.value,plan:evaluated.plan});
        if (mass > topMass) { mostLikely = evaluated.plan; topMass = mass; }
      }
      results.set(`${move.from}:${move.to}`, { progress: value - baseline.value, value, plan: mostLikely, continuations });
    }
    return { enabled: true, baseline, scores: results, elapsedMs: now() - started, nodes, cachedPositions: cache.size };
  } catch (error) {
    if (error !== stop) throw error;
    // Atomic result: no move receives credit merely because it was visited
    // before the budget expired. The caller keeps its existing evaluation.
    return { enabled: false, reason: 'budget', budgetReason, scores: new Map(), elapsedMs: now() - started, nodes };
  }
}
