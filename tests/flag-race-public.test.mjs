import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {conditionalCaptureRace,provePublicWins,chooseMove} from '../dist/ai.js';
import {inferDomains} from '../dist/beliefs.js';
const matched=JSON.parse(fs.readFileSync(new URL('./fixtures/conditional-flag-race-public.json',import.meta.url)));
const original=JSON.parse(fs.readFileSync(new URL('./fixtures/conditional-flag-race-original-public.json',import.meta.url)));
const move={from:50,to:55},domains=inferDomains(matched);
const rng=seed=>()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};

test('a conditional flag race preserves hidden root failures and never becomes an unconditional win',()=>{
 const before=JSON.stringify(matched);
 assert.equal(conditionalCaptureRace(matched,domains,move),true);
 assert.equal(provePublicWins(matched,domains).has('50:55'),false);
 for(const type of ['mine','bomb','general','division','brigade'])
  assert.equal(conditionalCaptureRace(matched,{...domains,[matched.board[55].id]:[type]},move),false,type);
 assert.equal(JSON.stringify(matched),before);
});

test('both recorded public positions now compare and select the conditional flag race',()=>{
 for(const observation of [matched,original]){
  const before=JSON.stringify(observation);
  const chosen=chooseMove(observation,'hell',rng(2026101901+101*131),null,null,{clock:()=>0,nodeLimit:1500000});
  assert.deepEqual([chosen.from,chosen.to],[50,55]);
  assert.equal(chosen.info.diagnostics.conditionalFlagRace,true);
  assert.equal(chosen.info.diagnostics.provenWin,false);
  assert.ok(chosen.info.expectedScore<0,'the many failed root captures still carry their losses');
  assert.equal(JSON.stringify(observation),before);
 }
});

test('an opponent who can capture our flag first refutes both conditional routes',()=>{
 for(const fixture of [matched,original]){
  const o=structuredClone(fixture),known=inferDomains(o),at=[9,13].find(i=>o.board[i]?.side==='human');
  assert.ok(at);o.board[8]=o.board[at];o.board[at]=null;
  assert.equal(conditionalCaptureRace(o,known,move),false);
 }
});

test('a protected camp or mountain cannot be attacked to manufacture a conditional finish',()=>{
 for(const to of [46,60]){
  const o=structuredClone(matched);o.board[to]=o.board[55];o.board[55]=null;
  assert.equal(conditionalCaptureRace(o,domains,{from:50,to}),false);
 }
});

test('a quiet draw is preferred to an uncertain flag race with losing root branches',()=>{
 const o=structuredClone(matched);o.quiet=99;
 const chosen=chooseMove(o,'hell',rng(2026101901+101*131),null,null,{clock:()=>0,maxDepth:4,nodeLimit:500000});
 assert.equal(chosen.info.diagnostics.quietDraw,true);
 assert.equal(chosen.info.diagnostics.conditionalFlagRace,false);
});

test('an immediate public capture wins ahead of the uncertain race',()=>{
 const o=structuredClone(matched);o.board[57]=o.board[17];o.board[17]=null;
 const chosen=chooseMove(o,'hell',rng(7),null,null,{clock:()=>0,nodeLimit:0});
 assert.deepEqual([chosen.from,chosen.to],[57,56]);
 assert.equal(chosen.info.diagnostics.provenWin,true);
 assert.equal(chosen.info.diagnostics.conditionalFlagRace,false);
});

test('conditional proof responds to interruption inside public reply enumeration',()=>{
 const stop=Symbol('stop');let checks=0;
 assert.throws(()=>conditionalCaptureRace(matched,domains,move,()=>{if(++checks===12)throw stop;}),error=>error===stop);
 assert.equal(checks,12);
 const chosen=chooseMove(matched,'hell',rng(7),null,null,{clock:()=>0,nodeLimit:0});
 assert.equal(chosen.info.diagnostics.conditionalFlagRace,false,'an interrupted conditional certificate is never committed');
 assert.equal(chosen.info.diagnostics.completedDepth,0);
});

test('a defendable flag chooses the guard capture over a still-available uncertain race',()=>{
 const o=JSON.parse(fs.readFileSync(new URL('./fixtures/conditional-flag-race-defendable.json',import.meta.url)));
 assert.equal(conditionalCaptureRace(o,inferDomains(o),move),true);
 const random=(()=>{let seed=827;return()=>((seed=Math.imul(seed,1664525)+1013904223>>>0)/4294967296)})();
 const chosen=chooseMove(o,'hell',random,null,null,{clock:()=>0,maxDepth:4,nodeLimit:500000});
 assert.deepEqual([chosen.from,chosen.to],[8,9],'the commander should remove the known invading engineer');
 assert.equal(chosen.info.diagnostics.conditionalFlagRace,false);
});
