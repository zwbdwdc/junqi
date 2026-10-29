import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chooseMove,inferBeliefs,flagPreparation} from '../dist/ai.js';
import {legalMoves,combat} from '../dist/engine.js';
const observation=JSON.parse(readFileSync(new URL('./fixtures/generated-acceptance-last-engineer-draw.json',import.meta.url))).observation;
function seeded(seed){return()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}

test('a possible long flag route is distinct from an already breached mine screen',()=>{
  const beliefs=inferBeliefs(observation,{samples:256,rng:seeded(151152458)});
  const board=observation.board.slice();board[11]=board[10];board[10]=null;
  const warning=flagPreparation(board,beliefs,observation.side,new Map(),4);
  assert.ok(warning.route>.4);assert.ok(warning.reserve>.4);
  assert.equal(warning.breach,0,'no mine gate has been opened for a following attack');
});

test('a distant flag warning does not buy one tempo with a certainly lost final engineer',()=>{
  const beliefs=inferBeliefs(observation,{samples:256,rng:seeded(151152458)});
  const types=beliefs.domains[observation.board[19].id];
  assert.ok(types.length);assert.ok(types.every(type=>combat(type,'engineer')==='win'));
  for(const level of ['professional','hell']){
    const selected=chooseMove(observation,level,seeded(151152458),null,null,{clock:()=>0,maxDepth:4,nodeLimit:3000000});
    assert.equal(selected.info.searchDepth,4);
    const board=observation.board.slice(),unit=board[selected.from];
    assert.equal(board[selected.to],null,'this fixture permits a safe quiet continuation');
    board[selected.from]=null;board[selected.to]=unit;
    const engineer=board.findIndex(piece=>piece?.side===observation.side&&piece.type==='engineer');
    assert.ok(engineer>=0);
    for(const type of types){
      const hypothesis=board.slice();hypothesis[19]={...hypothesis[19],type};
      assert.equal(legalMoves(hypothesis,19).includes(engineer),false,'the public superior cannot immediately take the last engineer');
    }
    assert.equal(selected.info.diagnostics.flagBreachRisk,0);
  }
});
