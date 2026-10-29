import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, randomLayout, makeObservation } from '../dist/engine.js';
import { inferDomains, inferBeliefs, sampleHiddenLayouts, publicLikelihoods, ARMY_COUNTS } from '../dist/beliefs.js';

function seeded(seed) { return () => ((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32); }
function initial(seed=12) {
  const rng=seeded(seed),game=createGame(randomLayout('human',rng),randomLayout('ai',rng),{engineerMountains:true});
  return {game,observation:makeObservation(game,'ai')};
}
function event(side,from,to,attackerId,defenderId=null,result='move',extra={}) {
  return {side,from,to,attackerId,defenderId,result,flagRevealed:[],engineerTurn:false,mountainMove:false,...extra};
}
function pursuit(cycles=1) {
  const {game,observation}=initial(115);
  const ours=game.initial.find(p=>p?.side==='ai'&&p.type==='commander');
  const dead=game.initial.find(p=>p?.side==='human'&&p.type==='general');
  const suspect=game.initial.find(p=>p?.side==='human'&&p.type==='bomb');
  observation.board.fill(null);
  observation.board[20]={...ours,moved:true};observation.board[25]={...suspect,type:null,moved:true};
  observation.history=[event('ai',19,20,ours.id,dead.id,'win'),
    event('human',suspect.origin,35,suspect.id),event('human',35,30,suspect.id),event('human',30,25,suspect.id)];
  for(let i=0;i<cycles;i++)observation.history.push(event('human',25,30,suspect.id),event('human',30,25,suspect.id));
  return {observation,ours,dead,suspect};
}

test('one random sample still preserves every globally feasible identity with complete witness armies',()=>{
  const {observation}=initial();
  const beliefs=inferBeliefs(observation,{samples:1,rng:seeded(41)});
  assert.equal(beliefs.consistent,true);assert.equal(beliefs.diagnostics.supportComplete,true);
  assert.ok(beliefs.diagnostics.supportAdded>0);
  assert.equal(sampleHiddenLayouts(observation,1,seeded(41)).length,1,'raw sampler API retains the requested size');
  for(const [id,domain] of Object.entries(beliefs.domains)) {
    assert.ok(Math.abs(Object.values(beliefs.probabilities[id]).reduce((a,b)=>a+b,0)-1)<1e-8);
    for(const type of domain)assert.ok(beliefs.probabilities[id][type]>0,`${id}/${type} needs a whole-army witness`);
    if(domain.length>1)assert.ok(Math.max(...Object.values(beliefs.probabilities[id]))<0.95,
      'a single sampled layout cannot turn an uncertain rank into near-certainty');
  }
  for(const world of beliefs.worlds)for(const [type,count] of Object.entries(ARMY_COUNTS))
    assert.equal(Object.values(world).filter(rank=>rank===type).length,count);
  for(const [type,count] of Object.entries(ARMY_COUNTS))assert.ok(Math.abs(Object.values(beliefs.probabilities)
    .reduce((sum,p)=>sum+p[type],0)-count)<1e-8,'marginals must sum to real initial army counts');
});

test('repeating a bluff chase cannot accumulate evidence without limit or turn a hard domain into a singleton',()=>{
  const once=pursuit(1),repeated=pursuit(50);
  // UUID identities differ between independently constructed fixtures; compare
  // the same public observation with only more repetitions added instead.
  const longer=structuredClone(once.observation),suspect=once.suspect;
  for(let i=0;i<49;i++)longer.history.push(event('human',25,30,suspect.id),event('human',30,25,suspect.id));
  const before=inferDomains(once.observation),after=inferDomains(longer);
  assert.deepEqual(after,before);
  assert.ok(after[suspect.id].length>1);
  assert.deepEqual(publicLikelihoods(once.observation,before),publicLikelihoods(longer,after));
  const a=inferBeliefs(once.observation,{samples:80,rng:seeded(3)}),b=inferBeliefs(longer,{samples:80,rng:seeded(3)});
  assert.deepEqual(a.probabilities,b.probabilities);
  assert.ok(a.probabilities[suspect.id].bomb>0&&a.probabilities[suspect.id].bomb<1);
  assert.ok(repeated.observation.history.length>once.observation.history.length);
});

test('behavioral mixture responds to pursuit but preserves neutral and bluff alternatives',()=>{
  const {observation,suspect}=pursuit(1),quiet=structuredClone(observation);
  quiet.history=quiet.history.slice(0,1);
  const neutral=inferBeliefs(quiet,{samples:256,rng:seeded(32)}),chased=inferBeliefs(observation,{samples:256,rng:seeded(32)});
  assert.ok(chased.probabilities[suspect.id].bomb>neutral.probabilities[suspect.id].bomb);
  assert.ok(chased.probabilities[suspect.id].bomb<0.5,'an approach alone cannot identify a bomb');
  assert.equal(chased.diagnostics.neutralShare,0.45);assert.equal(chased.diagnostics.bluffShare,0.15);
  assert.ok(chased.diagnostics.effectiveSamples>=chased.diagnostics.sampledWorlds*0.5);
  for(const types of Object.values(chased.likelihoods))for(const weight of Object.values(types))assert.ok(weight>=0.7&&weight<=3);
});

test('public engineer revelation defeats all bomb-like behavioral priors',()=>{
  const {observation,suspect}=pursuit(20);
  observation.history.push(event('human',30,25,suspect.id,null,'move',{engineerTurn:true}));
  const beliefs=inferBeliefs(observation,{samples:16,rng:seeded(6)});
  assert.deepEqual(beliefs.domains[suspect.id],['engineer']);
  assert.equal(beliefs.probabilities[suspect.id].bomb,0);
  assert.ok(Math.abs(beliefs.probabilities[suspect.id].engineer-1)<1e-8);
});

test('knowing our real commander does not mean the opponent identified it after eating a known engineer',()=>{
  const {observation,ours,dead,suspect}=pursuit(1);
  const domains=inferDomains(observation);
  domains[dead.id]=['engineer'];
  const baseline=publicLikelihoods(observation,domains);
  const alternative=structuredClone(observation);
  alternative.board[20].type='company';
  alternative.ownRoster.find(piece=>piece.id===ours.id).type='company';
  assert.deepEqual(publicLikelihoods(alternative,domains),baseline,'opponent-knowledge estimate must not consult our private rank');
  const quiet=structuredClone(observation);quiet.history=quiet.history.slice(0,1);
  assert.equal(baseline[suspect.id].bomb,publicLikelihoods(quiet,domains)[suspect.id].bomb,
    'beating an engineer reveals no strong-rank minimum to provoke a bomb chase inference');
});

test('beliefs use no referee fields, are deterministic from public facts, and leave the observation unchanged',()=>{
  const {observation}=initial(81),before=JSON.stringify(observation),protectedView=structuredClone(observation);
  for(const name of ['initial','setup','trueBoard','replay','referee'])Object.defineProperty(protectedView,name,
    {get(){throw new Error(`forbidden private field ${name}`);}});
  const a=inferBeliefs(observation,{samples:32,rng:seeded(7)}),b=inferBeliefs(protectedView,{samples:32,rng:seeded(7)});
  assert.deepEqual(a,b);assert.equal(JSON.stringify(observation),before);
});

test('inconsistent public evidence is reported rather than assigned invented independent ranks',()=>{
  const {observation}=initial(1);
  for(const piece of observation.board)if(piece?.side==='human')piece.type='flag';
  const result=inferBeliefs(observation,{samples:16,rng:seeded(5)});
  assert.equal(result.consistent,false);assert.equal(result.worlds.length,0);
  assert.equal(result.diagnostics.supportComplete,false);
  assert.equal(Object.values(result.probabilities).flatMap(Object.values).every(value=>value===0),true);
});
