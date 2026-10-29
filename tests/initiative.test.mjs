import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chooseMove,publicDanger,inferDomains} from '../dist/ai.js';
import {legalMoves,randomLayout,createGame,makeObservation,applyMove,combat} from '../dist/engine.js';
const fixtures=JSON.parse(readFileSync(new URL('./fixtures/public-initiative-regressions.json',import.meta.url)));
function seeded(seed) {return()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
function quietPreparationAndShuffle(next,move){
  const p=next.board[move.from];next.board[move.from]=null;next.board[move.to]={...p,moved:true};
  next.history.push({side:'ai',from:move.from,to:move.to,attackerId:p.id,defenderId:null,result:'move',ply:++next.ply});next.quiet++;
  const from=next.board[39]?.side==='human'?39:44,to=from===39?44:39,q=next.board[from];
  assert.ok(q&&!next.board[to]);next.board[from]=null;next.board[to]={...q,moved:true};
  next.history.push({side:'human',from,to,attackerId:q.id,defenderId:null,result:'move',ply:++next.ply});next.quiet++;
}

test('recorded stagnation: fixed two-ply decisions use an affordable probe against a passive opponent',()=>{
  for(const {beforePly,observation} of fixtures.filter(x=>x.beforePly<100))for(const level of ['professional','hell']){
    const next=structuredClone(observation);let contact=false;
    for(let turn=0;turn<3;turn++){
      // A wall-clock limit used to pass on busy machines at depth2 and fail on
      // faster runs that completed depth4. Test the intended depth explicitly.
      const move=chooseMove(next,level,seeded(99+turn),undefined,undefined,{clock:()=>0,nodeLimit:1000000,maxDepth:2});
      assert.equal(move.info.searchDepth,2);
      assert.ok(legalMoves(next.board,move.from).includes(move.to));
      if(next.board[move.to]){
        if(turn===0) assert.ok(['company','platoon','battalion','regiment'].includes(next.board[move.from].type),'uncertain immediate reconnaissance uses an affordable officer');
        contact=true;break;
      }
      // Allow preparation while the opponent repeats its recorded E5/E4 shuffle.
      quietPreparationAndShuffle(next,move);
    }
    assert.ok(contact,`${level} before ${beforePly}: preparation must lead to contact within three turns`);
  }
});

test('recorded four-ply preparation clears a camp, gains a real bomb recapture, and then makes contact',()=>{
  const next=structuredClone(fixtures.find(x=>x.beforePly===52).observation);
  const domains=inferDomains(next);
  assert.ok(domains[next.board[30].id].includes('general'));
  const bombCoversFront=board=>{
    // A stronger public-compatible enemy can take our battalion at25. The
    // preparation is useful only if a bomb can then immediately recapture it.
    assert.equal(board[25]?.type,'battalion');
    const future=board.slice();future[30]={...board[30],type:'general'};
    assert.ok(legalMoves(future,30).includes(25));
    assert.equal(combat('general',board[25].type),'win');
    future[25]=future[30];future[30]=null;
    return future.some((piece,at)=>piece?.side==='ai'&&piece.type==='bomb'&&legalMoves(future,at).includes(25));
  };
  assert.equal(bombCoversFront(next.board),false);
  let clearedCamp=false,prepared=false,contact=false;
  for(let turn=0;turn<4;turn++){
    const move=chooseMove(next,'hell',seeded(99+turn),undefined,undefined,{clock:()=>0,nodeLimit:5000000,maxDepth:4});
    assert.equal(move.info.searchDepth,4);
    assert.ok(legalMoves(next.board,move.from).includes(move.to));
    if(next.board[move.to]){
      assert.ok(prepared,'the extra preparation must produce actual frontline support before contact');
      assert.ok(['company','platoon','battalion','regiment'].includes(next.board[move.from].type));
      contact=true;break;
    }
    quietPreparationAndShuffle(next,move);
    if(!next.board[21])clearedCamp=true;
    if(next.board[21]?.type==='bomb'&&bombCoversFront(next.board)){
      assert.ok(clearedCamp,'the occupied camp must be cleared before the bomb uses it');
      prepared=true;
    }
  }
  // Both the original CFE snapshot and current source complete this concrete
  // three-move preparation then probe on move4. This is not an arbitrary
  // extension of the old contact deadline; the new defensive capability above
  // is checked independently of sampled search scores.
  assert.ok(prepared);assert.ok(contact,'supported preparation must lead to contact within four own turns');
});

test('recorded railway intrusion: both levels respond at the flag side instead of taking the far engineer into a camp',()=>{
  const {observation}=fixtures.find(x=>x.beforePly===104);
  for(const level of ['professional','hell']){
    const move=chooseMove(observation,level,seeded(99));
    assert.equal(move.info.actionClass,'defend');
    assert.notEqual(move.from,32,'far-side engineer shelter was unrelated to the exposed flag route');
  }
});

test('bomb railway approaches are flag threats even though a bomb cannot survive capturing an ordinary guard',()=>{
  const board=Array(62).fill(null);
  board[1]={id:'flag',side:'ai',type:'flag'};
  board[29]={id:'commander',side:'ai',type:'commander'};
  board[20]={id:'bomb',side:'human',type:null,moved:true};
  const beliefs={probabilities:{bomb:{bomb:1}}};
  const risk=publicDanger(board,beliefs,'ai');
  assert.equal(risk.flagRisk,0);assert.equal(risk.approachRisk,0);assert.equal(risk.invasionRisk,1);
  const guarded=board.slice();guarded[9]=guarded[29];guarded[29]=null;
  assert.equal(publicDanger(guarded,beliefs,'ai').invasionRisk,0);
});

test('a low-contact endgame continues toward an exposed flag while the opponent only shuffles a rear piece',()=>{
  for(const level of ['professional','hell']){
    const rng=seeded(381), original=createGame(randomLayout('human',rng),randomLayout('ai',rng));
    let game=structuredClone(original);game.board.fill(null);game.turn='ai';game.quiet=34;
    game.board[1]=original.initial.find(p=>p?.side==='ai'&&p.type==='flag');
    game.board[20]=original.initial.find(p=>p?.side==='ai'&&p.type==='regiment');
    game.board[56]=original.initial.find(p=>p?.side==='human'&&p.type==='flag');game.revealedFlags.human=true;
    game.board[59]={...original.initial.find(p=>p?.side==='human'&&p.type==='platoon'),moved:true};
    let entered=false;
    for(let n=0;n<8&&!game.result;n++){
      const move=chooseMove(makeObservation(game,'ai'),level,seeded(500+n));game=applyMove(game,move.from,move.to);
      if(move.to>=30&&move.to<60)entered=true;
      if(game.result)break;
      const from=game.board[59]?.side==='human'?59:54,to=from===59?54:59;
      game=applyMove(game,from,to);
    }
    assert.ok(entered,'must cross the front without waiting for the opponent');
    assert.equal(game.result?.winner,'ai','should carry the advance through to the flag');
  }
});
