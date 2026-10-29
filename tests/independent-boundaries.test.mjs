import test from 'node:test';
import assert from 'node:assert/strict';
import {createGame,randomLayout,makeObservation,legalMoves} from '../dist/engine.js';
import {chooseMove} from '../dist/ai.js';
import {inferDomains,inferBeliefs,ARMY_COUNTS} from '../dist/beliefs.js';
import {createAIContext} from '../dist/ai-context.js';
const seeded=s=>()=>((s=(Math.imul(s,1664525)+1013904223)>>>0)/2**32);
function fixture(seed=930711) {
 const rng=seeded(seed),game=createGame(randomLayout('human',rng),randomLayout('ai',rng),{engineerMountains:true});
 const observation=makeObservation(game,'ai');observation.turn='ai';observation.board.fill(null);
 const own=type=>({...game.initial.find(p=>p?.side==='ai'&&p.type===type)});
 const enemy=type=>({...game.initial.find(p=>p?.side==='human'&&p.type===type),type:null,moved:true});
 observation.board[1]=own('flag');observation.board[56]={...enemy('flag'),type:'flag',moved:false};
 return {observation,own,enemy};
}
const event=(from,to,id,extra={})=>({side:'human',from,to,attackerId:id,defenderId:null,result:'move',flagRevealed:[],engineerTurn:false,mountainMove:false,...extra});

test('aggressive or retreating bluff movement preserves possible small ranks and exact whole-army counts',()=>{
 const {observation,own,enemy}=fixture(),suspect=enemy('bomb');
 observation.board[20]=own('commander');observation.board[25]=suspect;
 observation.history=[event(suspect.origin,35,suspect.id),event(35,30,suspect.id),event(30,25,suspect.id)];
 const quiet=structuredClone(observation),hard=inferDomains(observation);
 for(let i=0;i<80;i++)observation.history.push(event(25,30,suspect.id),event(30,25,suspect.id));
 assert.deepEqual(inferDomains(observation),hard,'no capture or engineer turn means no new exact rank information');
 for(const history of [quiet,observation]){
  const belief=inferBeliefs(history,{samples:1,rng:seeded(771)});
  assert.ok(belief.probabilities[suspect.id].platoon>0,'fake aggression cannot rule out a small officer');
  assert.ok(belief.probabilities[suspect.id].bomb>0&&belief.probabilities[suspect.id].bomb<1,'fake bomb behavior is uncertain');
  assert.ok(belief.domains[suspect.id].length>1);
  for(const world of belief.worlds)for(const [type,count] of Object.entries(ARMY_COUNTS))
   assert.equal(Object.values(world).filter(t=>t===type).length,count);
 }
});

test('zero search time cannot interrupt a publicly certain immediate flag capture across styles',()=>{
 const {observation,own,enemy}=fixture();
 observation.board[51]=own('company');observation.board[42]=enemy('company');
 const before=JSON.stringify(observation);
 for(const difficulty of ['professional','hell'])for(const seed of [7,923,12817]) {
  const move=chooseMove(observation,difficulty,seeded(seed),null,createAIContext(seed),{timeLimitMs:0,nodeLimit:0});
  assert.deepEqual({from:move.from,to:move.to},{from:51,to:56});
  assert.equal(move.info.diagnostics.provenWin,true);assert.equal(move.info.diagnostics.winInOwnMoves,1);
  assert.equal(move.info.searchDepth,0,'exact public proof is not mislabeled as searched depth');
 }
 assert.equal(JSON.stringify(observation),before);
});

test('zero search time preserves the sole immediate flag defence under aggressive style and learning weights',()=>{
 const {observation,own,enemy}=fixture();
 observation.board[5]=own('bomb');observation.board[25]=own('commander');
 const attacker=enemy('engineer');observation.board[6]={...attacker,type:'engineer'};
 observation.board[42]=enemy('company');
 observation.history=[event(54,6,attacker.id,{engineerTurn:true})];
 const profile={weights:{attack:1e8,scout:1e8,defend:-1000,risk:-1000}};
 for(const difficulty of ['professional','hell'])for(const seed of [19,9281]){
  const move=chooseMove(observation,difficulty,seeded(seed),profile,createAIContext(seed),{timeLimitMs:0,nodeLimit:0});
  assert.ok(legalMoves(observation.board,move.from).includes(move.to));
  assert.deepEqual({from:move.from,to:move.to},{from:5,to:6});
 }
});
