import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {rateFlagOffense} from '../dist/offense.js';
import {legalMoves,isHQ,isCamp,combat} from '../dist/engine.js';
import {inferBeliefs} from '../dist/beliefs.js';
const seeded=initial=>{let n=initial;return()=>((n=(Math.imul(n,1664525)+1013904223)>>>0)/4294967296);};
const p=(type,at,side='ai')=>({id:`${side}:${at}`,side,type,origin:at,moved:true});
function toy(entries) {const board=Array(62).fill(null);for(const [at,type,side]of entries)board[at]=p(type,at,side);return{board,side:'ai'};}
function beliefsFor(obs,domains={}) {return {consistent:true,domains:Object.fromEntries(obs.board.filter(p=>p?.side==='human').map(p=>[p.id,domains[p.id]||[p.type]])),probabilities:Object.fromEntries(obs.board.filter(p=>p?.side==='human').map(p=>[p.id,Object.fromEntries((domains[p.id]||[p.type]).map(t=>[t,1/(domains[p.id]?.length||1)]))]))};}
const all=obs=>obs.board.flatMap((p,from)=>p?.side===obs.side?legalMoves(obs.board,from).map(to=>({from,to})):[]);
const deterministic={clock:()=>0,timeLimitMs:100,maxDepth:7};
function assertLegalPath(obs,plan,beliefs) {if(!plan)return;let board=structuredClone(obs.board),from=plan.from;for(const to of plan.path){assert.ok(legalMoves(board,from).includes(to),`illegal ${from}->${to}`);let actor=board[from],victim=board[to];if(victim){let domain=victim.type?[victim.type]:beliefs.domains[victim.id];assert.ok(domain.every(t=>t==='flag'||combat(actor.type,t)==='win'));}board[from]=null;board[to]=actor;from=to;}}

test('visible flag camp exit makes army progress; unrelated engineer camp change earns none',()=>{
 const obs=JSON.parse(fs.readFileSync(new URL('./fixtures/player-endgame-20261013.json',import.meta.url))).observation, b=inferBeliefs(obs,{samples:256,rng:seeded(13)});
 const result=rateFlagOffense(obs,b,all(obs),deterministic);
 assert.ok(result.enabled);assert.deepEqual(result.baseline.plan.path,[52,57,58]);
 assert.equal(result.scores.get('46:52').progress,32);assert.equal(result.scores.get('36:42').progress,0);
 assertLegalPath(obs,result.baseline.plan,b);
});

test('rotation uses same geometry and gives same army progress to the human side',()=>{
 const obs=toy([[46,'platoon'],[36,'engineer'],[58,'flag','human'],[3,'flag']]);const b=beliefsFor(obs);
 const rotated={...obs,side:'human',board:obs.board.map((_,at)=>{const src=at<60?59-at:at===60?61:60;const x=obs.board[src];return x?{...x,side:x.side==='ai'?'human':'ai'}:null;})};
 const rb={consistent:true,domains:b.domains,probabilities:b.probabilities};
 const a=rateFlagOffense(obs,b,[{from:46,to:52}],deterministic),r=rateFlagOffense(rotated,rb,[{from:13,to:7}],deterministic);
 assert.equal(a.scores.get('46:52').progress,r.scores.get('13:7').progress);assert.equal(a.baseline.value,r.baseline.value);
});

test('unknown flag does not receive a fabricated finishing mission',()=>{
 const obs=toy([[46,'platoon'],[58,null,'human']]),b=beliefsFor(obs,{[obs.board[58].id]:['flag','mine']});
 assert.equal(rateFlagOffense(obs,b,all(obs),deterministic).reason,'flag-unconfirmed');
});

test('engineer can clear certified mines while an officer cannot invent that route',()=>{
 const obs=toy([[52,'engineer'],[53,'mine','human'],[57,'mine','human'],[59,'mine','human'],[58,'flag','human'],[49,'regiment'],[3,'flag']]),b=beliefsFor(obs);
 const r=rateFlagOffense(obs,b,all(obs),deterministic);assert.ok(r.enabled);assert.equal(r.baseline.plan.type,'engineer');assertLegalPath(obs,r.baseline.plan,b);
 const noEngineer=structuredClone(obs);noEngineer.board[52]=null;const n=rateFlagOffense(noEngineer,b,all(noEngineer),deterministic);assert.equal(n.baseline.plan,null);
});

test('ambiguous bomb or stronger officer blocks the optimistic future capture route',()=>{
 const obs=toy([[52,'engineer'],[53,null,'human'],[57,null,'human'],[59,null,'human'],[58,'flag','human'],[3,'flag']]);
 const d=Object.fromEntries([53,57,59].map(at=>[obs.board[at].id,['mine','bomb','regiment']])),b=beliefsFor(obs,d);
 const r=rateFlagOffense(obs,b,[],deterministic);assert.equal(r.baseline.plan,null);
});

test('friendly road blocker must move before the teammate has a route',()=>{
 const obs=toy([[52,'platoon'],[57,'engineer'],[53,'mine','human'],[59,'mine','human'],[58,'flag','human'],[3,'flag']]),b=beliefsFor(obs);
 const r=rateFlagOffense(obs,b,[{from:57,to:56}],deterministic);
 // HQ trapping does not count as continuing the engineer's own route.
 assert.equal(r.scores.get('57:56').plan.type,'platoon');assertLegalPath(obs,r.baseline.plan,b);
});

test('budget cancellation discards all candidate credits atomically',()=>{
 const obs=toy([[46,'platoon'],[36,'engineer'],[58,'flag','human']]),b=beliefsFor(obs);let ticks=0;
 const r=rateFlagOffense(obs,b,all(obs),{clock:()=>ticks++,timeLimitMs:5});
 assert.equal(r.enabled,false);assert.equal(r.reason,'budget');assert.equal(r.scores.size,0);
});

test('fixed node budget also discards partially evaluated roots',()=>{
 const obs=toy([[46,'platoon'],[36,'engineer'],[58,'flag','human']]),b=beliefsFor(obs);
 const r=rateFlagOffense(obs,b,all(obs),{...deterministic,nodeLimit:3});
 assert.equal(r.enabled,false);assert.equal(r.reason,'budget');assert.equal(r.budgetReason,'nodes');assert.equal(r.scores.size,0);assert.equal(r.nodes,3);
});

test('inconsistent beliefs disable probabilities rather than multiply branch mass',()=>{
 const obs=toy([[46,'platoon'],[58,'flag','human']]),b={...beliefsFor(obs),consistent:false};
 assert.equal(rateFlagOffense(obs,b,all(obs),deterministic).reason,'inconsistent-beliefs');
});

test('a missing dark piece domain disables planning without guessed ranks',()=>{
 const obs=toy([[46,'platoon'],[58,'flag','human'],[50,null,'human']]),b=beliefsFor(obs);b.domains[obs.board[50].id]=[];
 assert.equal(rateFlagOffense(obs,b,all(obs),deterministic).reason,'missing-public-domain');
});

