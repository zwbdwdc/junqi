import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chooseMove,provePublicWins,inferDomains,publicRepetitions} from '../dist/ai.js';
import {randomLayout,createGame,makeObservation,legalMoves,applyMove,combat} from '../dist/engine.js';
function seeded(seed){return()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
const context=seed=>({style:['balanced','pressure','maneuver'][seed%3],wing:seed%2?-1:1,seed});
const experience=JSON.parse(readFileSync(new URL('./fixtures/finishing-experience.json',import.meta.url)));
function fixture(){
 const rng=seeded(810),g=createGame(randomLayout('human',rng),randomLayout('ai',rng),{engineerMountains:true});
 const own=type=>structuredClone(g.initial.find(p=>p?.side==='ai'&&p.type===type));
 const enemy=type=>structuredClone(g.initial.find(p=>p?.side==='human'&&p.type===type));
 g.board.fill(null);g.board[1]=own('flag');g.board[58]=enemy('flag');g.turn='ai';g.revealedFlags.human=true;
 return {g,own,enemy,observation:()=>makeObservation(g,'ai')};
}

test('a direct flag win takes priority over our own exposed flag and every playing style',()=>{
 const {g,own,enemy,observation}=fixture();g.board[53]=own('engineer');g.board[5]=own('bomb');g.board[6]=enemy('engineer');
 for(const level of['professional','hell'])for(const profile of[null,experience])for(let seed=1;seed<=3;seed++){
  const move=chooseMove(observation(),level,seeded(seed),profile,context(seed));
  assert.deepEqual({from:move.from,to:move.to},{from:53,to:58});assert.equal(move.info.diagnostics.provenWin,true);
  assert.equal(move.info.diagnostics.selectionPool,1);assert.equal(applyMove(g,move.from,move.to).result?.winner,'ai');
 }
});

test('a two-move flag finish is certified against every legal enemy reply and is not replaced by random variety',()=>{
 const {g,own,enemy,observation}=fixture();g.board[49]=own('engineer');g.board[22]=enemy('engineer');
 g.history=[{side:'human',from:27,to:22,attackerId:g.board[22].id,defenderId:null,result:'move',engineerTurn:true,flagRevealed:[]}];
 const obs=observation();assert.equal(provePublicWins(obs).get('49:53'),2);
 for(const level of['professional','hell'])for(const profile of[null,experience]){
  const move=chooseMove(obs,level,seeded(41),profile,context(17));assert.equal(move.info.diagnostics.winInOwnMoves,2);
  const after=applyMove(g,move.from,move.to);
  for(const[from,p]of after.board.entries())if(p?.side==='human')for(const to of legalMoves(after.board,from)){
   const replied=applyMove(after,from,to);assert.equal(replied.result,null);
   const finish=chooseMove(makeObservation(replied,'ai'),level,seeded(11),null,context(4));
   assert.equal(applyMove(replied,finish.from,finish.to).result?.winner,'ai');
  }
 }
});

test('a possible hidden interceptor or an intervening draw prevents a false short-win certificate',()=>{
 const {g,own,enemy,observation}=fixture();g.board[49]=own('engineer');g.board[54]={...enemy('company'),moved:true};
 assert.equal(provePublicWins(observation()).has('49:53'),false,'a possible superior can remove the staging engineer');
 g.board[22]=g.board[54];g.board[54]=null;g.quiet=98;
 assert.equal(provePublicWins(observation()).has('49:53'),false,'enemy quiet reply reaches the draw limit first');
});

test('short-win certification treats unknown equal-rank token swaps as possible repetitions',()=>{
 const board=Array(62).fill(null),piece=(id,side,type,origin)=>({id,side,type,origin,moved:false});
 for(const[at,p]of[[1,piece('a','ai','flag',1)],[6,piece('b','ai','company',6)],
  [58,piece('c','human','flag',58)],[40,piece('d','human','company',40)],[41,piece('e','human','company',41)]])board[at]=p;
 const key=`human|${board.map(p=>p?`${p.side[0]}:${p.type}`:'-').join(',')}`;
 let g={board,initial:structuredClone(board),turn:'human',ply:0,quiet:0,result:null,history:[],
  revealedFlags:{ai:false,human:true},rules:{engineerMountains:true},repetitions:{[key]:1}};
 const cycle=[[40,46],[6,7],[41,40],[7,8],[46,41],[8,6]];
 for(const[from,to]of cycle)g=applyMove(g,from,to);
 assert.equal(g.result,null);
 // This sparse referee fixture omits dead identities; supply its unresolved
 // public domains explicitly instead of applying full-25 counting to five tokens.
 const obs=makeObservation(g,'ai'),repetitions=publicRepetitions(obs,{c:['flag'],d:['company','platoon'],e:['company','platoon']}),probe=structuredClone(obs.board);
 [probe[40],probe[41]]=[probe[41],probe[40]];
 assert.equal(repetitions.count(probe,'human'),1,'public identities alone miss the equal-rank swap');
 assert.equal(repetitions.possibleCount(probe,'human'),2,'a proof must allow the hidden equal-rank interpretation');
 for(const[from,to]of cycle)g=applyMove(g,from,to);
 assert.equal(g.result?.reason,'repetition','the actual referee confirms the type-based repetition');
});

const fixedExchangeSearch={clock:()=>0,nodeLimit:1000000,maxDepth:4};
test('a known equal-command exchange protects an officer without a second-wave threat or an immobilization win',()=>{
 const {g,own,enemy,observation}=fixture();g.board[1]=null;g.board[3]=own('flag');g.revealedFlags.human=false;
 g.board[39]={...own('commander'),moved:true};g.board[24]={...enemy('commander'),moved:true};
 g.board[19]={...own('brigade'),moved:true};g.board[61]={...enemy('engineer'),moved:true};
 g.history=[{ply:1,side:'human',from:29,to:24,attackerId:g.board[24].id,defenderId:own('general').id,
  result:'win',flagRevealed:[],engineerTurn:false,mountainMove:false},
  {ply:2,side:'human',from:34,to:61,attackerId:g.board[61].id,defenderId:null,
   result:'move',flagRevealed:[],engineerTurn:true,mountainMove:true}];g.ply=2;
 const obs=observation();assert.deepEqual(inferDomains(obs)[g.board[24].id],['commander']);
 assert.equal(combat(g.board[24].type,g.board[19].type),'win');
 assert.ok(legalMoves(g.board,24).includes(19),'the public commander threatens a valuable officer');
 const exchanged=applyMove(g,39,24);
 assert.equal(exchanged.history.at(-1).result,'both');assert.equal(exchanged.result,null);
 for(const side of['ai','human'])assert.ok(exchanged.board.some((p,at)=>p?.side===side&&legalMoves(exchanged.board,at).length),
  'both armies retain a mobile piece after the exchange');
 for(const level of['professional','hell'])for(const profile of[null,experience])for(const seed of[17,99]){
  const move=chooseMove(obs,level,seeded(seed),profile,context(seed),fixedExchangeSearch);
  assert.equal(move.info.searchDepth,4);assert.equal(move.info.diagnostics.searchAborted,false);
  assert.deepEqual({from:move.from,to:move.to},{from:39,to:24});
 }
});

test('recorded equal-command positions retain a legal answer to every public commander reply',()=>{
 const cases=JSON.parse(readFileSync(new URL('./fixtures/public-equal-exchanges.json',import.meta.url)));
 for(const {observation,expected}of cases)for(const level of['professional','hell'])for(const profile of[null,experience])for(const seed of[17,99]){
  const target=observation.board[expected.to],domains=inferDomains(observation);
  assert.deepEqual(domains[target.id],['commander']);
  const move=chooseMove(observation,level,seeded(seed),profile,context(seed),fixedExchangeSearch);
  assert.equal(move.info.searchDepth,4);assert.equal(move.info.diagnostics.searchAborted,false);
  assert.ok(legalMoves(observation.board,move.from).includes(move.to));
  const landing=observation.board[move.to],support=landing?domains[landing.id]:[null];
  // Each publicly possible result of our selected move must pass. Unknown
  // target ranks cannot be replaced by the convenient sample for this check.
  for(const type of support){
   const board=observation.board.slice();if(landing)board[move.to]={...landing,type};
   const apply=(before,from,to)=>{
    assert.ok(legalMoves(before,from).includes(to));const next=before.slice(),p=before[from],q=before[to];
    const outcome=q?combat(p.type,q.type):'move';next[from]=null;
    next[to]=outcome==='lose'?q:outcome==='both'?null:{...p,moved:true};return next;
   };
   const after=apply(board,move.from,move.to),flag=after.findIndex(p=>p?.side==='ai'&&p.type==='flag');
   assert.ok(flag>=0);
   for(const[from,p]of after.entries())if(p?.side==='human')for(const rank of domains[p.id]){
    const hypothesis=after.slice();hypothesis[from]={...p,type:rank};
    assert.equal(legalMoves(hypothesis,from).includes(flag),false,'the preparation must not offer immediate flag capture');
   }
   const at=after.findIndex(p=>p?.id===target.id);
   if(at<0){assert.equal(landing?.id,target.id,'removing the commander must be an actual battle');continue;}
   after[at]={...after[at],type:'commander'};
   const replies=legalMoves(after,at);assert.ok(replies.length);
   for(const to of replies){
    const replied=apply(after,at,to);
    if(replied[to]?.id!==target.id)continue; // The commander voluntarily exchanged.
    assert.ok(replied.some((p,from)=>p?.side==='ai'&&legalMoves(replied,from).includes(to)&&
     ['win','both'].includes(combat(p.type,'commander'))),`${level}: ${move.from}->${move.to} must answer commander ${at}->${to}`);
   }
  }
 }
});

test('ordinary play offers multiple moves only inside the searched quality and safety envelope',()=>{
 let varied=0;
 for(let setup=113;setup<=116;setup++){
  const rng=seeded(setup),g=createGame(randomLayout('human',rng),randomLayout('ai',rng));
  const obs=makeObservation(g,'ai'),choices=new Set();
  for(let seed=1;seed<=8;seed++){
   const move=chooseMove(obs,'professional',seeded(44),null,context(seed));
   assert.ok(legalMoves(obs.board,move.from).includes(move.to));assert.ok(move.info.diagnostics.selectionGap<=5);
   assert.equal(move.info.diagnostics.provenWin,false);choices.add(`${move.from}:${move.to}`);
  }
  if(choices.size>1)varied++;
 }
 assert.ok(varied>=2,'different styles/seeds can vary near-equal openings without forcing every opening to vary');
});

test('style does not override the unique emergency flag defense',()=>{
 const {g,own,enemy,observation}=fixture();g.board[5]=own('bomb');g.board[29]=own('platoon');g.board[6]=enemy('engineer');g.board[54]=enemy('company');
 g.history=[{side:'human',from:34,to:6,attackerId:g.board[6].id,defenderId:null,result:'move',engineerTurn:true,flagRevealed:[]}];
 for(const level of['professional','hell'])for(let seed=1;seed<=4;seed++){
  const move=chooseMove(observation(),level,seeded(seed),null,context(seed));
  assert.deepEqual({from:move.from,to:move.to},{from:5,to:6});assert.equal(move.info.diagnostics.selectionPool,1);
 }
});
