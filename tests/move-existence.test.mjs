import test from 'node:test';
import assert from 'node:assert/strict';
import {hasLegalMove} from '../dist/ai.js';
import {TYPES,legalMoves,roadEdges,railEdges,mountainNeighbors,randomLayout,createGame,applyMove} from '../dist/engine.js';
const seeded=value=>()=>((value=(Math.imul(value,1664525)+1013904223)>>>0)/2**32);
const exact=(board,side)=>board.some((piece,from)=>piece?.side===side&&legalMoves(board,from).length>0);
const piece=(side,type,id)=>({id,side,type});

test('fast move existence relies on every railway first edge also being a road',()=>{
  const key=(a,b)=>[a,b].sort((a,b)=>a-b).join(':');
  const roads=new Set(roadEdges.map(([a,b])=>key(a,b)));
  for(const [a,b] of railEdges)assert.ok(roads.has(key(a,b)),`railway ${a}-${b} must have a legal adjacent first step`);
});

test('move existence preserves HQ, invalid ranks and protected mountain entry and exit',()=>{
  for(const length of [60,62])for(const type of [...Object.keys(TYPES),'unknown',null])for(let from=0;from<length;from++){
    const board=Array(length).fill(null);board[from]=piece('ai',type,'solo');
    assert.equal(hasLegalMove(board,'ai'),exact(board,'ai'),`${length}:${type}:${from}`);
    assert.equal(hasLegalMove(board,'human'),false);
  }
  for(const mountain of [60,61]){
    const board=Array(62).fill(null);board[mountain]=piece('ai','engineer','engineer');
    for(const to of mountainNeighbors[mountain])board[to]=piece('human','platoon',String(to));
    assert.equal(hasLegalMove(board,'ai'),false,'mountain exit cannot attack occupied neighbor');
    board[mountainNeighbors[mountain][0]]=null;
    assert.equal(hasLegalMove(board,'ai'),true,'mountain exit can use one empty neighbor');
  }
  const onlyMountain=Array.from({length:62},(_,at)=>piece('ai','mine',String(at)));
  onlyMountain[25]=piece('ai','engineer','engineer');onlyMountain[60]=null;
  assert.equal(hasLegalMove(onlyMountain,'ai'),true,'empty protected mountain is an independent one-step move');
  onlyMountain[60]=piece('human','engineer','occupant');
  assert.equal(hasLegalMove(onlyMountain,'ai'),false,'occupied mountain cannot be attacked');
});

test('move existence agrees with actual legalMoves on fixed dense and sparse boards, including each sole mobile unit',()=>{
  const rng=seeded(7217),types=Object.keys(TYPES);
  for(const length of [60,62])for(let sample=0;sample<1500;sample++){
    const occupancy=sample%3===0?.15:sample%3===1?.5:.9;
    const board=Array.from({length},(_,at)=>rng()<occupancy?piece(rng()<.5?'ai':'human',types[Math.floor(rng()*types.length)],String(at)):null);
    for(const side of ['ai','human'])assert.equal(hasLegalMove(board,side),exact(board,side));
    for(let from=0;from<length;from++)if(board[from]){
      const side=board[from].side;
      const single=board.map((item,at)=>item?.side===side&&at!==from?{...item,type:'mine'}:item);
      assert.equal(hasLegalMove(single,side),exact(single,side));
    }
  }
});

test('move existence agrees throughout legal games with and without protected mountains',()=>{
  const rng=seeded(189731);
  for(let sample=0;sample<100;sample++){
    let game=createGame(randomLayout('human',rng),randomLayout('ai',rng),{engineerMountains:sample%2===0});
    for(let ply=0;ply<12&&!game.result;ply++){
      for(const side of ['ai','human'])assert.equal(hasLegalMove(game.board,side),exact(game.board,side));
      const choices=game.board.flatMap((item,from)=>item?.side===game.turn?legalMoves(game.board,from).map(to=>[from,to]):[]);
      const [from,to]=choices[Math.floor(rng()*choices.length)];game=applyMove(game,from,to);
    }
  }
});
