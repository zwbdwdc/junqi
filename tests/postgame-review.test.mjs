import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewCompletedPlans, reviewPlanFrames } from '../dist/postgame-review.js';
import { applyMove, createGame, randomLayout, makeObservation } from '../dist/engine.js';
import { createLearningProfile, learnFromGame, serializeProfile } from '../dist/learning.js';

// These are synthetic board positions. No user game or private user layout is
// part of this regression suite or the deliverable source archive.
function sparse(entries, moves) {
  const board=Array(62).fill(null);
  entries.forEach(([at,side,type],n)=>board[at]={id:`synthetic-${n}`,side,type,origin:at,moved:false});
  let game={board,initial:structuredClone(board),turn:'ai',ply:0,quiet:0,result:null,
    history:[],revealedFlags:{human:false,ai:false},repetitions:{},rules:{engineerMountains:true}};
  const frames=[{board:structuredClone(board),ply:0,event:null}];
  for(const [from,to] of moves){
    game=applyMove(game,from,to);
    frames.push({board:structuredClone(game.board),ply:game.ply,event:game.history.at(-1)});
  }
  return {game,frames,notes:reviewPlanFrames(frames,game.history)};
}
const flags=[[3,'ai','flag'],[58,'human','flag']];

test('entering camp is an escape only when the piece was actually in danger',()=>{
  const danger=sparse([...flags,[25,'ai','company'],[30,'human','commander']],[[25,21]]);
  const safe=sparse([...flags,[25,'ai','commander'],[30,'human','company']],[[25,21]]);
  assert.equal(danger.notes.get(1).escape,true);
  assert.equal(safe.notes.get(1).escape,false);
  assert.equal(safe.notes.get(1).productive,false);
});

test('idle return along a recent route is a shuttle, while genuine flight is not',()=>{
  const idle=sparse([...flags,[25,'ai','commander'],[44,'human','company']],[[25,21],[44,49],[21,25]]);
  assert.equal(idle.notes.get(3).shuttle,true);
  const retreat=sparse([...flags,[25,'ai','company'],[35,'human','commander']],[[25,21],[35,30],[21,22]]);
  assert.equal(retreat.notes.get(3).shuttle,false);
});

test('review distinguishes avoidable flag neglect from an already lost flag defence',()=>{
  const missed=sparse([...flags,[8,'human','brigade'],[13,'ai','general'],[25,'ai','company']],[[25,26],[8,3]]);
  assert.equal(missed.notes.get(1).avoidableFlagLoss,true,'the general could capture the flag attacker');
  const lost=sparse([...flags,[8,'human','commander'],[13,'ai','regiment'],[25,'ai','company']],[[13,8],[8,3]]);
  assert.equal(lost.notes.get(1).avoidableFlagLoss,false,'a weaker last defender had no move that saves the flag');
});

test('capturing a flag attacker counts as defence',()=>{
  const game=sparse([...flags,[8,'human','brigade'],[13,'ai','general']],[[13,8]]);
  assert.equal(game.notes.get(1).defended,true);
  assert.equal(game.notes.get(1).avoidableFlagLoss,false);
});

test('returning to block a railway approach is useful defence, not idle shuttling',()=>{
  const game=sparse([...flags,[9,'ai','general'],[29,'human','company']],[[9,5],[29,24],[5,9]]);
  assert.equal(game.notes.get(3).shuttle,false,'the guard blocks the newly approaching enemy railway route');
  assert.equal(game.notes.get(3).defended,true,'review should recognize prevention before an adjacent flag check');
});

test('escaping to a remote camp does not excuse a missed chance to block a short flag route',()=>{
  const game=sparse([...flags,[4,'ai','mine'],[13,'ai','platoon'],[25,'ai','engineer'],
    [24,'human','brigade'],[30,'human','company']],[[25,21]]);
  const note=game.notes.get(1);
  assert.equal(note.escape,true,'the engineer really does escape a possible capture');
  assert.equal(note.defended,false,'the remote camp does not close the railway to the flag');
  assert.equal(note.missedFlagCover,true,'13→14 would force the railway invader to stop before reaching the rear');
});

test('an advance followed six half-moves later by losing a commander to a bomb is not productive',()=>{
  const game=sparse([...flags,[25,'ai','commander'],[11,'ai','platoon'],[36,'human','bomb'],[45,'human','company']],
    [[25,30],[45,40],[11,16],[40,45],[16,17],[36,31],[30,31]]);
  assert.equal(game.game.history.at(-1).result,'both');
  assert.equal(game.notes.get(1).productive,false,'future contact alone cannot turn a losing exchange into good development');
});

test('an advance leading to a favorable capture can receive productive credit',()=>{
  const game=sparse([...flags,[25,'ai','battalion'],[36,'human','company']],[[25,30],[36,31],[30,31]]);
  assert.equal(game.notes.get(1).productive,true);
});

test('review penalizes declining a flag capture only when the flag was already publicly revealed',()=>{
  const missed=sparse([...flags,[53,'ai','general'],[25,'ai','company'],[44,'human','company']],[[25,26]]);
  missed.frames[0].revealedFlags={human:true,ai:false};
  assert.equal(reviewPlanFrames(missed.frames,missed.game.history).get(1).missedKnownWin,true);
  missed.frames[0].revealedFlags.human=false;
  assert.equal(reviewPlanFrames(missed.frames,missed.game.history).get(1).missedKnownWin,false,
    'postgame full identities must not manufacture knowledge that was absent during play');
  const taken=sparse([...flags,[53,'ai','general'],[44,'human','company']],[[53,58]]);
  taken.frames[0].revealedFlags={human:true,ai:false};
  assert.equal(reviewPlanFrames(taken.frames,taken.game.history).get(1).missedKnownWin,false);
});

test('taking another immediate win is not blamed for declining the revealed flag',()=>{
  const alternative=sparse([...flags,[53,'ai','general'],[39,'ai','commander'],[44,'human','company']],[[39,44]]);
  alternative.frames[0].revealedFlags={human:true,ai:false};
  assert.equal(alternative.game.result.reason,'no-moves');
  assert.equal(reviewPlanFrames(alternative.frames,alternative.game.history).get(1).missedKnownWin,false);
});

test('unfinished or malformed replay never reads hidden identities',()=>{
  const live={result:null};
  Object.defineProperty(live,'initial',{get(){throw new Error('active initial board read');}});
  assert.equal(reviewCompletedPlans(live).size,0);
  assert.equal(reviewCompletedPlans({result:{winner:'ai',reason:'resign'},history:[]}).size,0);
});

function seeded(seed){return()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);}

test('completed learning records a missed public flag win and does not reward the unrelated camp move',()=>{
  // Independently generated, fully legal synthetic game; this sequence kills
  // the human commander, reveals its flag, and brings an AI attacker beside it.
  const rng=seeded(17);
  let game=createGame(randomLayout('human',rng),randomLayout('ai',rng),{engineerMountains:true});
  for(const [from,to] of [[34,29],[28,61],[30,25],[20,35],[35,15],[12,11],[32,27],[29,39],
    [44,39],[11,17],[49,39],[39,54],[40,15],[17,12],[45,10],[61,32],[37,32],[54,53],[10,5]])
    game=applyMove(game,from,to);
  assert.equal(game.revealedFlags.human,true);
  const finished=applyMove(game,7,11);
  finished.result={winner:'human',reason:'resign'};
  const input={gameId:'synthetic-missed-public-win',completedGame:finished,observation:makeObservation(finished,'ai'),
    decisions:[{ply:20,from:7,to:11,info:{actionClass:'shelter',learningFeatures:{shelter:1}}}]};
  const learned=learnFromGame(createLearningProfile(),input);
  assert.equal(learned.lastSummary.fullReview,true);
  assert.equal(learned.lastSummary.missedKnownWins,1);
  assert.ok(learned.weights.shelter<1,'safe camp occupancy cannot excuse declining an already available win');
  assert.ok(learned.weights.attack>1,'the missed objective receives bounded positive priority');
  assert.deepEqual(learnFromGame(learned,input),learned,'a repaired learner cannot relearn this finished game twice');
});

function place(layout,at,type){
  const from=layout.findIndex(piece=>piece?.type===type);
  [layout[from],layout[at]]=[layout[at],layout[from]];
  if(layout[from])layout[from].origin=from;
  layout[at].origin=at;
}
function campEpisode({danger=false,shuttle=false}={}){
  const human=randomLayout('human',seeded(111)),ai=randomLayout('ai',seeded(112));
  place(ai,25,'commander');place(human,30,danger?'commander':'company');
  let game=createGame(human,ai,{engineerMountains:true});
  const moves=[[34,38],[25,21],[39,34],...(shuttle?[[21,25],[44,39]]:[])];
  for(const [from,to] of moves)game=applyMove(game,from,to);
  game={...game,result:{winner:null,reason:'quiet'}};
  return {gameId:`synthetic-camp-${danger}-${shuttle}`,completedGame:game,observation:makeObservation(game,'ai'),
    decisions:game.history.filter(event=>event.side==='ai').map(event=>({ply:event.ply,from:event.from,to:event.to,
      info:{actionClass:'shelter',learningFeatures:{shelter:1}}}))};
}

test('learning rewards a real escape but gives no bonus for merely occupying camp',()=>{
  const base=createLearningProfile();
  const safe=learnFromGame(base,campEpisode());
  const escape=learnFromGame(base,campEpisode({danger:true}));
  assert.equal(safe.weights.shelter,1,'camp occupancy alone is not evidence of good shelter');
  assert.ok(escape.weights.shelter>1,'escaping a genuine equal-rank capture threat earns shelter credit');
});

test('learning discourages unproductive camp shuttles and stores no replay identities',()=>{
  const input=campEpisode({shuttle:true}),before=JSON.stringify(input.completedGame);
  const learned=learnFromGame(createLearningProfile(),input);
  assert.ok(learned.weights.shelter<1,'idle return must not strengthen hiding');
  assert.ok(learned.weights.develop>1,'idle return should favor productive development');
  const saved=serializeProfile(learned);
  for(const piece of input.completedGame.initial.filter(Boolean))assert.equal(saved.includes(piece.id),false);
  assert.equal(Object.hasOwn(learned,'board'),false);
  assert.equal(Object.hasOwn(learned,'history'),false);
  assert.equal(JSON.stringify(input.completedGame),before,'review must not mutate its source game');
});
