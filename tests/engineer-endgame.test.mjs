import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync}from'node:fs';
import{chooseMove,inferDomains,publicRepetitions}from'../dist/ai.js';
import{randomLayout,createGame,makeObservation,legalMoves,applyMove}from'../dist/engine.js';
const fixtures=JSON.parse(readFileSync(new URL('./fixtures/engineer-endgames.json',import.meta.url)));
const experience=JSON.parse(readFileSync(new URL('./fixtures/engineer-experience.json',import.meta.url)));
function seeded(seed){return()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}

test('recorded engineer losses are avoided with both fresh and recovered learned preferences',()=>{
  for(const {case:id,observation}of fixtures.filter(x=>x.beforePly!==156))for(const profile of[null,experience])for(const seed of[17,99]){
    const move=chooseMove(observation,'hell',seeded(seed),profile);
    assert.ok(legalMoves(observation.board,move.from).includes(move.to));
    assert.notEqual(move.from,id==='engineer-mountain'?60:24,`${id}: preserve engineer instead of placing it in the proven superior's path`);
  }
});

test('engineer chooses an actual railway approach to a publicly proven mine, then clears it',()=>{
  const rng=seeded(510),g=createGame(randomLayout('human',rng),randomLayout('ai',rng));
  const obs=makeObservation(g,'ai'),own=type=>structuredClone(g.initial.find(p=>p?.side==='ai'&&p.type===type));
  const enemy=type=>structuredClone(g.initial.find(p=>p?.side==='human'&&p.type===type));
  const mine=enemy('mine'),flag=enemy('flag');obs.board.fill(null);obs.board[1]=own('flag');obs.board[18]=own('engineer');obs.board[17]=own('platoon');
  obs.board[24]=own('company');obs.board[43]={...enemy('company'),type:null,moved:true};
  obs.board[53]={...mine,type:null,moved:false};obs.board[58]={...flag,type:null};
  obs.history=[{ply:35,side:'ai',from:52,to:53,attackerId:own('commander').id,defenderId:mine.id,result:'lose',flagRevealed:[{side:'ai',index:1,id:obs.board[1].id}]}];
  obs.ply=35;obs.quiet=0;
  assert.deepEqual(inferDomains(obs)[mine.id],['mine']);
  for(const level of['professional','hell']){
    const next=structuredClone(obs),move=chooseMove(next,level,seeded(26));
    assert.equal(move.from,18);assert.equal(next.board[move.to],null);
    next.board[move.to]={...next.board[18],moved:true};next.board[18]=null;
    assert.ok(legalMoves(next.board,move.to).includes(53),'prepare a real next-turn mine capture, not a geometrically nearer dead end');
    next.history.push({side:'ai',ply:36,from:18,to:move.to,attackerId:next.board[move.to].id,defenderId:null,result:'move'});next.ply=37;
    const clear=chooseMove(next,level,seeded(27));assert.deepEqual({from:clear.from,to:clear.to},{from:move.to,to:53});
  }
});

test('public repetition recognizes a terminal draw before an otherwise direct flag capture, while a safe non-draw move exists',()=>{
  const piece=(id,side,type,origin)=>({id,side,type,origin,moved:false});const board=Array(62).fill(null);
  for(const[i,p]of [[1,piece('af','ai','flag',1)],[5,piece('ab','ai','bomb',5)],[22,piece('ap','ai','platoon',22)],
    [56,piece('hf','human','flag',56)],[54,piece('he','human','engineer',54)],[40,piece('hc','human','commander',40)],
    [37,piece('hg','human','general',37)],[47,piece('hd','human','division',47)]])board[i]=p;
  let g={board,initial:structuredClone(board),turn:'human',ply:0,quiet:0,result:null,history:[],revealedFlags:{ai:false,human:false},rules:{engineerMountains:true},repetitions:{}};
  for(const[from,to]of[[54,6],[22,27],[40,45],[27,28],[45,40],[28,27],[40,45],[27,28],[45,40]])g=applyMove(g,from,to);
  const obs=makeObservation(g,'ai');const after=structuredClone(obs.board);after[27]=after[28];after[28]=null;
  assert.equal(publicRepetitions(obs).count(after,'human'),2);
  assert.ok(legalMoves(obs.board,5).includes(6),'a non-draw emergency capture exists');
  for(const level of['professional','hell']){
    const move=chooseMove(obs,level,seeded(14));assert.deepEqual({from:move.from,to:move.to},{from:28,to:27});
    assert.equal(move.info.diagnostics.repetitionDraw,true);
    assert.equal(applyMove(g,move.from,move.to).result?.reason,'repetition');
  }
});

test('actual late lone-general position is allowed to save a draw rather than being forced to abandon its flag',()=>{
  const {observation}=fixtures.find(x=>x.beforePly===156);
  const move=chooseMove(observation,'hell',seeded(17));assert.equal(move.info.diagnostics.repetitionDraw,true);
});
