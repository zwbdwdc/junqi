/* Public-information inference. Hard constraints never use a referee board.
 * Behavioral worlds are bounded hypotheses, not rank revelations. */
import { combat, canPlace, isMountain } from './engine.js';

export const ARMY_COUNTS = Object.freeze({ commander:1, general:1, division:2, brigade:2, regiment:2,
  battalion:2, company:3, platoon:3, engineer:3, bomb:2, mine:3, flag:1 });
const COUNTS=ARMY_COUNTS, TYPE_NAMES=Object.keys(COUNTS);
const opponent=side=>side==='ai'?'human':'ai';
const row=i=>isMountain(i)?5.5:Math.floor(i/5);
const col=i=>isMountain(i)?(i===60?1:3):i%5;
const distance=(a,b)=>Math.abs(row(a)-row(b))+Math.abs(col(a)-col(b));
const clamp=(n,lo,hi)=>Math.max(lo,Math.min(hi,n));
function shuffled(values,rng){
  const result=[...values];
  for(let i=result.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[result[i],result[j]]=[result[j],result[i]];}
  return result;
}

function restrict(domains, id, predicate) {
  if (!domains[id]) return;
  domains[id] = domains[id].filter(predicate);
}

/** Exact logical domains from observable facts, including anonymous dead pieces.
 * Identity counts describe the INITIAL army, never the hidden live army. */
export function inferDomains(observation) {
  const side = observation.side || 'ai';
  const enemy = opponent(side);
  const own = Object.fromEntries((observation.ownRoster || []).map(p => [p.id, p.type]));
  for (const p of observation.board) if (p?.side === side) own[p.id] = p.type;
  const roster = (observation.enemyRoster || observation.board.filter(p => p?.side === enemy))
    .map(p => ({ id: p.id, origin: p.origin }));
  const domains = Object.fromEntries(roster.map(p => [p.id,
    TYPE_NAMES.filter(type => !Number.isInteger(p.origin) || canPlace(type, enemy, p.origin))]));
  for (const [index, p] of observation.board.entries()) {
    if (!p || p.side !== enemy) continue;
    if (!domains[p.id]) domains[p.id] = [...TYPE_NAMES];
    if (p.moved) restrict(domains, p.id, type => type !== 'mine' && type !== 'flag');
    if (isMountain(index)) restrict(domains, p.id, type => type === 'engineer');
    // Flags and engineers are the only enemy identities explicitly made public.
    if (p.type === 'flag' || p.type === 'engineer') restrict(domains, p.id, type => type === p.type);
  }
  const commanderAlreadyRevealed = new Set();
  for (const event of observation.history || []) {
    const enemyMoved = event.side === enemy;
    if (enemyMoved) {
      restrict(domains, event.attackerId, type => type !== 'mine' && type !== 'flag');
      if (event.engineerTurn || event.mountainMove ||
          (row(event.from) !== row(event.to) && col(event.from) !== col(event.to) &&
           distance(event.from, event.to) > 2)) {
        restrict(domains, event.attackerId, type => type === 'engineer');
      }
    }
    if (event.defenderId && event.result !== 'move') {
      const enemyId = enemyMoved ? event.attackerId : event.defenderId;
      const ownType = own[enemyMoved ? event.defenderId : event.attackerId];
      if (ownType) restrict(domains, enemyId, type =>
        combat(enemyMoved ? type : ownType, enemyMoved ? ownType : type) === event.result);
      const enemyDied = enemyMoved ? ['lose', 'both'].includes(event.result) : ['win', 'both'].includes(event.result);
      const revealedNow = (event.flagRevealed || []).some(reveal => reveal.side === enemy);
      if (enemyDied && !revealedNow && !commanderAlreadyRevealed.has(enemy))
        restrict(domains, enemyId, type => type !== 'commander');
      if (enemyDied && event.capturedFlagSide !== enemy)
        restrict(domains, enemyId, type => type !== 'flag');
      if (event.capturedFlagSide === enemy) restrict(domains, enemyId, type => type === 'flag');
      for (const reveal of event.flagRevealed || []) {
        commanderAlreadyRevealed.add(reveal.side);
        if (reveal.side === enemy) {
          // The newly public commander death identifies this battle's enemy piece.
          restrict(domains, enemyId, type => type === 'commander');
          if (reveal.id) restrict(domains, reveal.id, type => type === 'flag');
        }
      }
    }
  }
  // Counting propagation is valid even for dead identities: all 25 are retained.
  let changed = true;
  while (changed) {
    changed = false;
    for (const type of TYPE_NAMES) {
      const allowed = Object.keys(domains).filter(id => domains[id].includes(type));
      const fixed = allowed.filter(id => domains[id].length === 1);
      if (fixed.length === COUNTS[type]) {
        for (const id of allowed) if (domains[id].length > 1) {
          domains[id] = domains[id].filter(t => t !== type); changed = true;
        }
      } else if (allowed.length === COUNTS[type]) {
        for (const id of allowed) if (domains[id].length > 1) {
          domains[id] = [type]; changed = true;
        }
      }
    }
  }
  return domains;
}

/** Complete bipartite matching, optionally forcing one identity/type pair.
 * A witness proves support under army counts; absence in random samples does
 * not prove a rank impossible. Anonymous dead identities still consume slots. */
function matchWorld(domains, rng, forced = null) {
  const ids = Object.keys(domains), slots = TYPE_NAMES.flatMap(type => Array(COUNTS[type]).fill(type));
  if (ids.length > slots.length || ids.some(id => !domains[id].length)) return null;
  const occupied = Array(slots.length).fill(null);
  const fixedSlot = forced ? slots.indexOf(forced.type) : -1;
  if (forced && (!domains[forced.id]?.includes(forced.type) || fixedSlot < 0)) return null;
  if (forced) occupied[fixedSlot] = forced.id;
  const order = shuffled(ids.filter(id => id !== forced?.id), rng).sort((a,b) => domains[a].length - domains[b].length);
  const options = Object.fromEntries(order.map(id => [id, shuffled(slots.flatMap((type,i) =>
    i !== fixedSlot && domains[id].includes(type) ? [i] : []), rng)]));
  const match = (id, seen) => {
    for (const slot of options[id]) {
      if (seen.has(slot)) continue;
      seen.add(slot);
      if (occupied[slot] === null || match(occupied[slot], seen)) { occupied[slot] = id; return true; }
    }
    return false;
  };
  return order.every(id => match(id, new Set())) ? Object.fromEntries(occupied.flatMap((id,i) =>
    id === null ? [] : [[id,slots[i]]])) : null;
}

export function sampleHiddenLayouts(observation, count = 48, rng = Math.random, domains = inferDomains(observation)) {
  const worlds = [];
  for (let i=0;i<count;i++) {
    const world = matchWorld(domains,rng);
    if (!world) break;
    worlds.push(world);
  }
  return worlds;
}

const STRONG = new Set(['commander','general','division','brigade','regiment','battalion']);
const strengthShare = domain => {
  const total = (domain || []).reduce((sum,type) => sum + COUNTS[type],0);
  return total ? domain.reduce((sum,type) => sum + (STRONG.has(type) ? COUNTS[type] : 0),0) / total : 0;
};

/** What the opponent may have learned about OUR tokens from public combat.
 * Our private rank is deliberately not used here: beating a known engineer
 * does not announce a commander. Uncertain defeated ranks supply only weak,
 * bounded exposure evidence; nobody is declared to know an unshown rank. */
function behaviorEvidence(observation, domains) {
  const side=observation.side||'ai',enemy=opponent(side);
  const positions=Object.fromEntries([...(observation.ownRoster||[]),...(observation.enemyRoster||[])]
    .map(piece=>[piece.id,piece.origin]));
  const exposure={},pursuits={},retreats={},publicEngineers=new Set();
  for(const event of observation.history||[]) {
    if(event.side===enemy) {
      for(const [target,confidence] of Object.entries(exposure)) {
        const at=positions[target];
        if(!Number.isInteger(at)||confidence<=0)continue;
        const before=distance(event.from,at),after=distance(event.to,at);
        if(after<=3&&after<before) {
          pursuits[event.attackerId]||={};
          pursuits[event.attackerId][target]=Math.max(pursuits[event.attackerId][target]||0,
            confidence*(after<=1?1.6:0.8));
        } else if(before<=3&&after>before) {
          retreats[event.attackerId]||={};
          retreats[event.attackerId][target]=Math.max(retreats[event.attackerId][target]||0,confidence);
        }
      }
    } else if(event.engineerTurn||event.mountainMove) {
      publicEngineers.add(event.attackerId);exposure[event.attackerId]=0;
    }
    const ownId=event.side===side?event.attackerId:event.defenderId;
    const enemyId=event.side===side?event.defenderId:event.attackerId;
    const survived=event.side===side?event.result==='win':event.result==='lose';
    if(event.defenderId&&survived&&!publicEngineers.has(ownId))
      exposure[ownId]=Math.max(exposure[ownId]||0,Math.min(0.8,strengthShare(domains[enemyId])*0.8));
    delete positions[event.attackerId];
    if(event.result==='move'||event.result==='win')positions[event.attackerId]=event.to;
    if(event.defenderId&&['win','both'].includes(event.result))delete positions[event.defenderId];
  }
  return {pursuits,retreats,exposure};
}

/** Soft role suggestions, all bounded. Repeatedly approaching the same target
 * takes a maximum, not a sum, so a bluff shuttle cannot manufacture certainty. */
export function publicLikelihoods(observation, domains = inferDomains(observation)) {
  const side=observation.side||'ai',enemy=opponent(side),evidence=behaviorEvidence(observation,domains),likelihoods={};
  const sumTwo=values=>Object.values(values||{}).sort((a,b)=>b-a).slice(0,2).reduce((a,b)=>a+b,0);
  for(let at=0;at<observation.board.length;at++) {
    const piece=observation.board[at];if(!piece||piece.side!==enemy)continue;
    const likelihood=Object.fromEntries(TYPE_NAMES.map(type=>[type,1]));
    const pursue=Math.min(1.5,sumTwo(evidence.pursuits[piece.id]));
    const retreat=Math.min(1,sumTwo(evidence.retreats[piece.id]));
    if(domains[piece.id]?.includes('bomb')) {
      if(enemy==='human'?piece.origin>=40:piece.origin<20)likelihood.bomb*=1.12;
      likelihood.bomb*=Math.exp(pursue*0.95);
      const coversMajor=observation.board.some((other,index)=>other?.side===enemy&&other.id!==piece.id&&
        domains[other.id]?.length&&domains[other.id].every(type=>['commander','general','division'].includes(type))&&distance(at,index)<=2);
      if(coversMajor)likelihood.bomb*=1.25;
    }
    if(!piece.moved&&(observation.history?.length||0)>=12&&domains[piece.id]?.includes('mine'))likelihood.mine=1.15;
    // Retreat also fits a trap. Its role signal is intentionally very small;
    // the separate bluff component retains the opposite explanation.
    for(const type of ['company','platoon','engineer'])likelihood[type]*=1+retreat*0.15;
    likelihoods[piece.id]=Object.fromEntries(Object.entries(likelihood).map(([type,weight])=>[type,clamp(weight,0.7,3)]));
  }
  return likelihoods;
}

function normalize(values) {
  const total=values.reduce((sum,value)=>sum+value,0);
  return values.map(value=>value/(total||1));
}
const effectiveSamples=weights=>1/(weights.reduce((sum,weight)=>sum+weight*weight,0)||1);
function weightedHypothesis(base,scores,temperature) {
  const max=Math.max(0,...scores.map(score=>score*temperature));
  return normalize(base.map((weight,index)=>weight*Math.exp(scores[index]*temperature-max)));
}

export function inferBeliefs(observation,{samples=80,rng=Math.random}={}) {
  const domains=inferDomains(observation),requestedSamples=Math.max(1,Math.floor(samples));
  const worlds=sampleHiddenLayouts(observation,requestedSamples,rng,domains),sampleCount=worlds.length;
  const likelihoods=publicLikelihoods(observation,domains);
  let infeasiblePairs=0;
  if(worlds.length) {
    const covered=Object.fromEntries(Object.keys(domains).map(id=>[id,new Set(worlds.map(world=>world[id]))]));
    // Usually only a few rare pairs need a witness. In the worst case this
    // checks at most 25*12 edges, each by a bounded 25-slot matching.
    for(const [id,domain] of Object.entries(domains))for(const type of [...domain]) {
      if(covered[id].has(type))continue;
      const witness=matchWorld(domains,rng,{id,type});
      if(witness) {
        worlds.push(witness);
        for(const [piece,rank] of Object.entries(witness))covered[piece].add(rank);
      } else {domains[id]=domains[id].filter(rank=>rank!==type);infeasiblePairs++;}
    }
  }
  const supportAdded=worlds.length-sampleCount;
  // Witness worlds have a small fixed share: they preserve support without
  // pretending targeted coverage was an unbiased random draw.
  const supportShare=supportAdded?Math.max(0.04,1-sampleCount/32):0;
  const base=worlds.map((world,index)=>index<sampleCount?(1-supportShare)/sampleCount:supportShare/supportAdded);
  const scores=worlds.map(world=>clamp(Object.entries(likelihoods).reduce((sum,[id,types])=>
    sum+Math.log(types[world[id]]||1),0),-3,3));
  let temperature=1,weights=base.slice();
  const mix=()=>{
    const behavior=weightedHypothesis(base,scores,temperature),bluff=weightedHypothesis(base,scores,-temperature*0.5);
    return normalize(base.map((weight,index)=>0.45*weight+0.40*behavior[index]+0.15*bluff[index]));
  };
  if(worlds.length) {
    weights=mix();
    for(let attempt=0;attempt<5&&effectiveSamples(weights)<effectiveSamples(base)*0.70;attempt++) {
      temperature*=0.65;weights=mix();
    }
  }
  const probabilities=Object.fromEntries(Object.keys(domains).map(id=>[id,Object.fromEntries(TYPE_NAMES.map(type=>[type,0]))]));
  worlds.forEach((world,index)=>{for(const [id,type] of Object.entries(world))probabilities[id][type]+=weights[index];});
  // Impossible evidence must not produce an invented, count-inconsistent army.
  // Callers can see consistent=false and retain logical-domain safety checks.
  return {domains,probabilities,worlds,weights,likelihoods,consistent:worlds.length>0,
    diagnostics:{requestedSamples,sampledWorlds:sampleCount,actualWorlds:worlds.length,supportAdded,infeasiblePairs,
      supportComplete:worlds.length>0,effectiveSamples:worlds.length?effectiveSamples(weights):0,
      neutralShare:0.45,behaviorShare:0.40,bluffShare:0.15,temperature}};
}

