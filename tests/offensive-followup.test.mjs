import test from 'node:test';
import assert from 'node:assert/strict';
import {rateFlagOffense} from '../dist/offense.js';

import {legalMoves} from '../dist/engine.js';
const deterministic={clock:()=>0,timeLimitMs:90,nodeLimit:12000};
function fixture(types) {
 const board=Array(62).fill(null), put=(at,type,side)=>board[at]={id:`${side}-${at}`,type,side,origin:at,moved:true};
 put(52,'engineer','ai');put(51,'regiment','ai');put(3,'flag','ai');
 put(53,'mine','human');put(59,'mine','human');put(58,'flag','human');put(57,null,'human');
 const observation={side:'ai',board};
 const domains=Object.fromEntries(board.filter(p=>p?.side==='human').map(p=>[p.id,p.type?[p.type]:types]));
 const probabilities=Object.fromEntries(Object.entries(domains).map(([id,ts])=>[id,Object.fromEntries(ts.map(t=>[t,1/ts.length]))]));
 return {observation,beliefs:{consistent:true,domains,probabilities},move:{from:52,to:57}};
}
test('engineer loss publicly excludes mine and permits a regiment to follow against small officers',()=>{
 const {observation,beliefs,move}=fixture(['mine','company','platoon']);
 const before=structuredClone({observation,beliefs});
 const r=rateFlagOffense(observation,beliefs,[move],deterministic);
 assert.ok(r.enabled);const evaluated=r.scores.get('52:57'), loss=evaluated.continuations.find(x=>x.outcome==='lose');
 assert.deepEqual(loss.defenderDomain,['company','platoon']);assert.equal(loss.mass,2/3);
 assert.equal(loss.plan.type,'regiment');assert.deepEqual(loss.plan.path,[52,57,58]);
 assert.ok(evaluated.value>0,'public battle evidence enables a contingent following route');
 assert.deepEqual({observation,beliefs},before,'no rank disclosure or mutation of the live observation');
});
test('strong officer still supported by a failed probe cannot be invented into a small defender',()=>{
 const {observation,beliefs,move}=fixture(['mine','company','division','bomb']);
 const r=rateFlagOffense(observation,beliefs,[move],deterministic);assert.ok(r.enabled);
 const loss=r.scores.get('52:57').continuations.find(x=>x.outcome==='lose');
 assert.deepEqual(loss.defenderDomain,['company','division']);assert.equal(loss.plan,null);
 const both=r.scores.get('52:57').continuations.find(x=>x.outcome==='both');
 assert.equal(both.mass,.25);assert.equal(both.plan.type,'regiment','an observed explosion really clears the gate');
});
test('rank-conditioned branches conserve probability and retain rare strong alternatives',()=>{
 const {observation,beliefs,move}=fixture(['mine','company','division']);
 beliefs.probabilities['human-57']={mine:.5,company:.499,division:.001};
 const r=rateFlagOffense(observation,beliefs,[move],deterministic), rows=r.scores.get('52:57').continuations;
 assert.equal(rows.reduce((n,b)=>n+b.mass,0),1);assert.deepEqual(rows.find(b=>b.outcome==='lose').defenderDomain,['company','division']);
 assert.equal(rows.find(b=>b.outcome==='lose').plan,null,'low probability does not remove a hard supported rank');
});
test('conditioned evidence does not leak into a later unrelated root or its cache',()=>{
 const {observation,beliefs,move}=fixture(['mine','company','platoon']);
 const quiet={from:52,to:47};assert.ok(legalMoves(observation.board,52).includes(47));
 const forward=rateFlagOffense(observation,beliefs,[move,quiet],deterministic),reverse=rateFlagOffense(observation,beliefs,[quiet,move],deterministic);
 assert.deepEqual(forward.scores.get('52:47'),reverse.scores.get('52:47'));
 assert.deepEqual(forward.scores.get('52:57'),reverse.scores.get('52:57'));
});
test('node exhaustion remains an atomic rollback for all conditioned root values',()=>{
 const {observation,beliefs,move}=fixture(['mine','company','platoon']);
 const r=rateFlagOffense(observation,beliefs,[move],{...deterministic,nodeLimit:1});
 assert.equal(r.enabled,false);assert.equal(r.scores.size,0);assert.equal(r.budgetReason,'nodes');
});

