import test from 'node:test';
import assert from 'node:assert/strict';
import { tacticalSearch } from '../dist/ai.js';
import { applyMove, legalMoves, isCamp, isHQ, combat } from '../dist/engine.js';
const V = { commander:280,general:215,division:155,brigade:110,regiment:80,battalion:57,
  company:37,platoon:28,engineer:64,bomb:120,mine:35,flag:50000 };
const opposite = side => side === 'ai' ? 'human' : 'ai';
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const dist = (a,b) => Math.abs(Math.floor(a/5)-Math.floor(b/5))+Math.abs(a%5-b%5);
const piece = (id, side, type) => ({ id, side, type, moved:true });
function position(quiet, entries = [[1,'ai','flag'],[13,'ai','regiment'],[42,'human','company'],[56,'human','flag']]) {
  const board = Array(62).fill(null);
  for (const [at,side,type] of entries) board[at] = piece(`${side}-${at}`,side,type);
  return {board,initial:board,turn:'ai',ply:0,quiet,result:null,history:[],
    revealedFlags:{ai:false,human:false},rules:{engineerMountains:true},repetitions:{}};
}
const drawValue = (board,side) => -clamp(board.reduce((s,p)=>!p||p.type==='flag'?s:
  s+(p.side===side?1:-1)*V[p.type],0)*0.85,-350,350);
// An independent full-width reference obtains terminality, quiet reset and
// priority from REAL applyMove, then uses the unchanged incremental search
// scoring for these fixtures (no immediate flag-exposure or quiescent branch).
function reference(state, depth, visits = {draws:0,captures:0}) {
  const side=state.turn,choices=[];
  for(const [from,p] of state.board.entries()) if(p?.side===side)
    for(const to of legalMoves(state.board,from)) choices.push({from,to});
  if(!choices.length) return -50000;
  if(state.quiet>=100) return drawValue(state.board,side);
  return Math.max(...choices.map(move=>{
    const p=state.board[move.from],target=state.board[move.to],after=applyMove(state,move.from,move.to);
    if(after.result){
      if(after.result.winner) return after.result.winner===side?50000:-50000;
      assert.equal(after.result.reason,'quiet'); visits.draws++; return drawValue(after.board,side);
    }
    let score=0;
    if(target){
      visits.captures++;
      const result=combat(p.type,target.type);
      score=result==='win'?V[target.type]:result==='lose'?-V[p.type]:V[target.type]-V[p.type];
    }
    const ours=state.board.findIndex(q=>q?.side===side&&q.type==='flag');
    const theirs=state.board.findIndex(q=>q?.side!==side&&q?.type==='flag');
    if(isHQ(move.to))score-=V[p.type]*0.45+12;
    if(isCamp(move.to))score+=2;
    if(isCamp(move.from))score-=1;
    if(theirs>=0)score+=clamp(dist(move.from,theirs)-dist(move.to,theirs),-6,6)*0.30;
    if(theirs>=0&&dist(move.to,theirs)<=2&&!isHQ(move.to))score+=2.5;
    if(ours>=0&&dist(move.from,ours)<=3&&dist(move.to,ours)>3)score-=2;
    if(depth>1)score-=0.97*reference(after,depth-1,visits);
    return score;
  }));
}
const stats = table => ({replies:0,nodes:0,table:table||new Map()});
const evaluate = (state,depth,statistics=stats()) => tacticalSearch(state.board,state.turn,depth,
  {beam:Infinity},statistics,-Infinity,Infinity,state.quiet);

for(const quiet of [96,97,98,99]) test(`quiet ${quiet} reaches the real 100-ply draw at the correct depth`,()=>{
  const state=position(quiet),depth=100-quiet,visits={draws:0,captures:0},statistics=stats();
  const expected=reference(state,depth,visits),actual=evaluate(state,depth,statistics);
  assert.ok(visits.draws>0);assert.ok(statistics.quietDraws>0);
  assert.ok(Math.abs(actual-expected)<1e-8,`actual ${actual}, engine reference ${expected}`);
});
test('a capture at quiet 99 resets the clock and remains searchable',()=>{
  const state=position(99,[[1,'ai','flag'],[25,'ai','regiment'],[26,'human','platoon'],[42,'human','company'],[56,'human','flag']]);
  const after=applyMove(state,25,26);assert.equal(after.quiet,0);assert.equal(after.result,null);
  const visits={draws:0,captures:0};
  const expected=reference(state,2,visits),actual=evaluate(state,2);
  assert.ok(visits.captures>0);assert.ok(actual>drawValue(state.board,state.turn));
  assert.ok(Math.abs(actual-expected)<1e-8);
});
test('the transposition table distinguishes the same board with different quiet clocks',()=>{
  const shared=new Map(),a=position(98),b=position(99);
  const first=evaluate(a,2,stats(shared)),second=evaluate(b,2,stats(shared));
  assert.notEqual(first,second);
  assert.equal(second,evaluate(b,2));
  assert.ok([...shared.keys()].some(key=>key.endsWith('|quiet:98')));
  assert.ok([...shared.keys()].some(key=>key.endsWith('|quiet:99')));
});
test('flag and no-moves wins precede quiet draws, including entry on a terminal clock',()=>{
  const flag=position(99,[[1,'ai','flag'],[51,'ai','company'],[42,'human','company'],[56,'human','flag']]);
  assert.deepEqual(applyMove(flag,51,56).result,{winner:'ai',reason:'flag'});
  assert.equal(evaluate(flag,1),50000);
  const trapped=position(99,[[1,'ai','flag'],[13,'ai','company'],[58,'human','company'],[56,'human','flag']]);
  const after=applyMove(trapped,13,12);assert.equal(after.quiet,100);
  assert.deepEqual(after.result,{winner:'ai',reason:'no-moves'});
  assert.equal(evaluate(trapped,1),50000);
  assert.equal(tacticalSearch(after.board,'human',2,{beam:5},stats(),-Infinity,Infinity,100),-50000);
});
test('quiet draw utility is bounded, side-symmetric, and adds no future moves',()=>{
  const state=position(100),a=stats(),b=stats();
  const ours=tacticalSearch(state.board,'ai',8,{beam:5},a,-Infinity,Infinity,100);
  const theirs=tacticalSearch(state.board,'human',8,{beam:5},b,-Infinity,Infinity,100);
  assert.equal(ours,-theirs);assert.ok(Math.abs(ours)<=350);assert.equal(a.nodes,0);assert.equal(b.nodes,0);
  assert.equal(ours,-(80-37)*0.85);
});

