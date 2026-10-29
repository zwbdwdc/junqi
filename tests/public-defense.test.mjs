import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { legalMoves, combat, applyMove, makeObservation, createGame, randomLayout } from '../dist/engine.js';
import { inferDomains, sampleHiddenLayouts } from '../dist/beliefs.js';
import { chooseMove } from '../dist/ai.js';
import { createAIContext } from '../dist/ai-context.js';

// Anonymous observations only. All opponent ranks below are explicitly forced
// public-consistent hypotheses, never ranks imported from a finished replay.
const examples=JSON.parse(fs.readFileSync(new URL('./fixtures/public-flag-preparation.json',import.meta.url)));
const seeded=s=>()=>((s=(Math.imul(s,1664525)+1013904223)>>>0)/2**32);
function hypotheticalBoard(observation,assignments) {
  const domains=inferDomains(observation);
  for(const [at,type] of Object.entries(assignments)) {
    const id=observation.board[Number(at)].id;
    assert.ok(domains[id].includes(type),`hypothesis ${at}/${type} must be publicly possible`);
    domains[id]=[type];
  }
  const [world]=sampleHiddenLayouts(observation,1,seeded(812933),domains);
  assert.ok(world,'the joint hypothesis requires a complete count-consistent army');
  return observation.board.map(p=>p?{...p,type:p.type||world[p.id]}:null);
}
function move(board,from,to) {
  assert.ok(legalMoves(board,from).includes(to),`illegal continuation ${from}->${to}`);
  const piece=board[from],target=board[to],result=target?combat(piece.type,target.type):'move';
  board[from]=null;
  if(result==='move'||result==='win')board[to]={...piece,moved:true};
  else if(result==='both')board[to]=null;
  return result;
}
function lateralRush(first,second,type) {
  const {observation}=examples.find(x=>x.name==='prepare-lateral-flag-defence');
  const board=hypotheticalBoard(observation,{40:type}),invader=board[40].id;
  move(board,...first);
  move(board,40,25);
  if(board[25]?.id!==invader)return {board,stopped:true};
  move(board,...second);
  move(board,25,5);
  if(board[5]?.id!==invader)return {board,stopped:true};
  const canIntercept=legalMoves(board,9).includes(5)&&board[9]?.type==='commander';
  if(canIntercept)move(board,9,5);
  return {board,stopped:board[5]?.id!==invader,canIntercept};
}

test('public fixture exports contain no referee layouts, real IDs or nonpublic enemy ranks',()=>{
  for(const {observation} of examples) {
    assert.equal(observation.initial,undefined);
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(JSON.stringify(observation)));
    assert.ok(observation.enemyRoster.every(p=>Object.keys(p).sort().join(',')==='id,origin'));
    assert.ok(observation.board.every(p=>!p||p.side===observation.side||p.type===null||['flag','engineer'].includes(p.type)));
  }
});

test('clearing the complete back railway lets the reserve intercept every public rank on the demonstrated rush',()=>{
  const {observation}=examples.find(x=>x.name==='prepare-lateral-flag-defence');
  const types=inferDomains(observation)[observation.board[40].id];
  assert.ok(!types.includes('engineer'),'engineering turns would require a different defence audit');
  for(const type of types)for(const [first,second] of [
    [[6,5],[4,9]],[[6,11],[4,9]],[[4,9],[6,5]],[[4,9],[6,11]],
  ]) {
    const result=lateralRush(first,second,type);
    assert.equal(result.stopped,true,`${type}, ${first} / ${second}`);
    assert.equal(result.board[1]?.type,'flag');
  }
});

test('moving the blocker along the same railway or onto the reserve exit is not credited as clearing it',()=>{
  const {observation}=examples.find(x=>x.name==='prepare-lateral-flag-defence');
  for(const to of [7,8]) {
    const result=lateralRush([6,to],[4,9],'general');
    assert.equal(result.canIntercept,false,`6->${to} still blocks 9->5`);
    assert.equal(result.stopped,false);
  }
  const board=hypotheticalBoard(observation,{40:'general'});
  move(board,6,9);move(board,40,25);
  assert.ok(!legalMoves(board,4).includes(9),'6->9 occupies the reserve only exit');
});

test('covering either right-rail choke blocks a public engineer hypothesis from opening the flag mine',()=>{
  const {observation}=examples.find(x=>x.name==='cover-engineer-rail-ingress');
  for(const first of [[18,19],[23,19],[23,29]]) {
    const board=hypotheticalBoard(observation,{44:'engineer'});
    assert.ok(legalMoves(board,44).includes(8),'the exposed mine is reachable before preparation');
    move(board,...first);
    assert.ok(!legalMoves(board,44).includes(8),`${first} must actually block the rail route`);
    assert.equal(board[8]?.type,'mine');
  }
});

test('recapturing the engineer does not restore the mine barrier against a separate publicly possible follower',()=>{
  const {observation}=examples.find(x=>x.name==='cover-engineer-rail-ingress');
  const board=hypotheticalBoard(observation,{44:'engineer',49:'general'});
  move(board,11,17); // An unrelated camp transfer leaves the ingress open.
  assert.equal(move(board,44,8),'win');
  assert.equal(move(board,7,8),'win'); // This recapture is correct, but the mine is gone.
  move(board,49,9);move(board,2,7);
  assert.equal(move(board,9,8),'win');
  assert.equal(move(board,7,8),'lose');
  assert.equal(move(board,8,3),'win');
  assert.equal(board[3].side,'human');
});

// The relay is a legitimate alternative to an immediate rail blockade. It is
// partial protection (a possible enemy commander still wins), and its next
// recapture must vacate camp 13 so the general can actually occupy it.
test('a general relay covers lower follower ranks only when the recapture clears its camp',()=>{
  const {observation}=examples.find(x=>x.name==='cover-engineer-rail-ingress');
  for(const type of ['commander','general','division','brigade']) {
    const board=hypotheticalBoard(observation,{44:'engineer',49:type});
    for(const step of [[16,17],[44,8],[13,8],[49,9],[17,13],[9,8]])move(board,...step);
    const result=move(board,13,8);
    assert.equal(result,type==='commander'?'lose':type==='general'?'both':'win');
    assert.equal(board[8]?.side==='human',type==='commander');
  }
  const blocked=hypotheticalBoard(observation,{44:'engineer',49:'general'});
  for(const step of [[16,17],[44,8],[7,8],[49,9]])move(blocked,...step);
  assert.equal(blocked[13].side,'ai');
  assert.ok(!legalMoves(blocked,17).includes(13),'recapturing with the company leaves the relay camp occupied');
});

function ownMoves(board) {
  return board.flatMap((p,from)=>p?.side==='ai'?legalMoves(board,from).map(to=>[from,to]):[]);
}
function stopsNamedGateRush(board) {
  // The attacker in this public-consistent counterexample has already staged
  // at 9. Check every friendly move before 9->8 and every reply before 8->3.
  // This is deliberately a narrow, falsifiable line check, not game minimax.
  const attacker=board[9].id,defences=[];
  for(const first of ownMoves(board)) {
    const prepared=structuredClone(board);
    const wins=prepared[first[1]]?.side==='human'&&prepared[first[1]].type==='flag';
    move(prepared,...first);
    if(wins||prepared[9]?.id!==attacker){defences.push({first,reply:null});continue;}
    assert.ok(legalMoves(prepared,9).includes(8));
    move(prepared,9,8);
    if(prepared[8]?.id!==attacker){defences.push({first,reply:null});continue;}
    for(const reply of ownMoves(prepared)) {
      const after=structuredClone(prepared);
      const won=after[reply[1]]?.side==='human'&&after[reply[1]].type==='flag';
      move(after,...reply);
      if(won||after[8]?.id!==attacker||!legalMoves(after,8).includes(3)){defences.push({first,reply});break;}
    }
  }
  return defences;
}

test('all legal local replies confirm that the wrong recapture loses the demonstrated relay tempo',()=>{
  const {observation}=examples.find(x=>x.name==='cover-engineer-rail-ingress');
  const results=[];
  for(const capture of [[13,8],[7,8]]){
    const board=hypotheticalBoard(observation,{44:'engineer',49:'general'});
    for(const step of [[16,17],[44,8],capture,[49,9]])move(board,...step);
    results.push(stopsNamedGateRush(board));
  }
  assert.ok(results[0].some(d=>d.first.join(':')==='17:13'&&d.reply?.join(':')==='13:8'));
  assert.equal(results[1].length,0,'company recapture leaves no response against this short, public-possible rush');
});

function relayObservation(followerType) {
  const {observation}=examples.find(x=>x.name==='cover-engineer-rail-ingress');
  const board=hypotheticalBoard(observation,{44:'engineer',49:followerType});
  const domains=inferDomains(observation);
  domains[observation.board[44].id]=['engineer'];domains[observation.board[49].id]=[followerType];
  const [world]=sampleHiddenLayouts(observation,1,seeded(812933),domains);
  const initial=Array(62).fill(null);
  for(const piece of observation.ownRoster)initial[piece.origin]={...piece,side:'ai',moved:false};
  for(const piece of observation.enemyRoster)initial[piece.origin]={...piece,side:'human',type:world[piece.id],moved:false};
  let game={...structuredClone(observation),board,initial,repetitions:{}};
  game=applyMove(game,16,17);game=applyMove(game,44,8);
  return makeObservation(game,'ai');
}

test('the relay continuation remains identical under different secret follower ranks and uses the clearing recapture',()=>{
  const observation=relayObservation('general');
  assert.deepEqual(observation,relayObservation('commander'),'constructing a counterfactual must not disclose the follower');
  assert.equal(observation.board[49].type,null);
  for(const difficulty of ['professional','hell']) {
    const chosen=chooseMove(observation,difficulty,seeded(628103),null,createAIContext(992713),
      {clock:()=>0,nodeLimit:3000000});
    assert.deepEqual({from:chosen.from,to:chosen.to},{from:13,to:8},'the regiment must vacate camp 13 for the reserve relay');
    assert.equal(chosen.info.searchDepth,difficulty==='hell'?8:4,'the completed deep choice must retain the same defence');
  }
});

test('both difficulties prepare the reserve or a verifiable mine-screen defence without requiring one fixed opening move',()=>{
  for(const {name,observation} of examples)for(const difficulty of ['professional','hell']) {
    const chosen=chooseMove(observation,difficulty,seeded(628103),null,createAIContext(992713),
      {clock:()=>0,nodeLimit:300000});
    if(name==='prepare-lateral-flag-defence') {
      assert.ok(['4:9','6:5','6:11'].includes(`${chosen.from}:${chosen.to}`),
        `the reserve needs its exit and complete railway clear; got ${chosen.from}->${chosen.to}`);
    } else {
      const board=hypotheticalBoard(observation,{44:'engineer',49:'general'});
      move(board,chosen.from,chosen.to);
      if(!legalMoves(board,44).includes(8))continue; // Any legal blockade of the demonstrated ingress qualifies.
      move(board,44,8);
      let covered=false;
      for(const capture of ownMoves(board).filter(m=>m[1]===8)) {
        const replied=structuredClone(board);move(replied,...capture);
        if(replied[8]?.side!=='ai')continue;
        if(!legalMoves(replied,49).includes(9)) {covered=true;break;}
        move(replied,49,9);
        if(stopsNamedGateRush(replied).length){covered=true;break;}
      }
      assert.equal(covered,true,`root ${chosen.from}->${chosen.to} needs a legal follow-up against the public-possible rush`);
    }
  }
});

// Independent counterexample to treating shelter as always better: preserving
// the division can let an equal-rank sacrifice open the opposite engineering
// route. These are synthesized pieces, not a replay or known user arrangement.
test('a publicly possible equal-rank sacrifice can make shelter lose the flag while a rail redeployment leaves a defence',()=>{
  const rng=seeded(93277),game=createGame(randomLayout('human',rng),randomLayout('ai',rng),{engineerMountains:true});
  const observation=makeObservation(game,'ai');observation.board.fill(null);
  const own=type=>({...game.initial.find(p=>p?.side==='ai'&&p.type===type)});
  const enemy=type=>({...game.initial.find(p=>p?.side==='human'&&p.type===type),type:null,moved:true});
  observation.board[3]=own('flag');observation.board[56]={...enemy('flag'),type:'flag',moved:false};
  for(const at of [2,4,8])observation.board[at]={...own('mine'),id:`synthetic-screen-${at}`};
  observation.board[20]=own('division');observation.board[29]=own('platoon');
  observation.board[25]=enemy('commander');observation.board[51]=enemy('engineer');observation.board[54]=enemy('company');
  observation.history=[{side:'human',from:30,to:25,attackerId:observation.board[25].id,defenderId:own('general').id,
    result:'win',engineerTurn:false,mountainMove:false,flagRevealed:[]}];
  const crisis=hypotheticalBoard(observation,{51:'engineer',54:'platoon'});
  move(crisis,20,21);assert.equal(move(crisis,54,29),'both');
  const replies=ownMoves(crisis);assert.equal(replies.length,8);
  for(const reply of replies) {
    const after=structuredClone(crisis);move(after,...reply);
    assert.ok(legalMoves(after,51).includes(8),'the engineer can turn around the cleared right railway');
    move(after,51,8);
    for(const response of ownMoves(after)) {
      const end=structuredClone(after),wins=end[response[1]]?.side==='human'&&end[response[1]].type==='flag';
      move(end,...response);
      assert.equal(wins,false);assert.equal(end[8]?.side,'human');assert.ok(legalMoves(end,8).includes(3));
    }
  }
  const relay=hypotheticalBoard(observation,{51:'engineer',54:'platoon'});
  for(const step of [[29,19],[54,19],[20,5],[51,8]])move(relay,...step);
  assert.equal(move(relay,5,8),'win');
  const barrier=hypotheticalBoard(observation,{51:'engineer',54:'platoon'});
  for(const step of [[29,19],[25,20],[19,9]])move(barrier,...step);
  assert.ok(!legalMoves(barrier,51).includes(8),'if the division is captured first, the pawn can still screen the other rail');
});
