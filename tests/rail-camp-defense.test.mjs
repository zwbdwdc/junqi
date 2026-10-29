import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as engine from '../dist/engine.js';
import {publicRouteRisk} from '../dist/route-defense.js';
const source=fs.readFileSync(new URL('../dist/route-defense.js',import.meta.url),'utf8');
const {routeCovered}=Function('legalMoves','combat','isHQ','isMountain','isCamp',
 source.replace(/^import[^\n]+\n/,'').replace(/export function/g,'function')+'\nreturn {routeCovered};')(
 engine.legalMoves,engine.combat,engine.isHQ,engine.isMountain,engine.isCamp);
const own=(type,id=type)=>({id,side:'human',type,moved:true});
const enemy=(type,id='invader')=>({id,side:'ai',type,moved:true});
const belief={consistent:true,domains:{invader:['division']},probabilities:{invader:{division:1}}};
const empty=()=>Array(62).fill(null);
function quiet(board,from,to){
 assert.ok(engine.legalMoves(board,from).includes(to),`${from} -> ${to} legal`);
 assert.equal(board[to],null);const next=board.slice();next[to]=board[from];next[from]=null;return next;
}

test('a distant railway approach cannot be excluded by Manhattan distance',()=>{
 const board=empty();board[58]=own('flag');board[54]=own('mine');board[29]=enemy(null);
 let line=board.slice();line[29]={...line[29],type:'division'};
 for(const [from,to] of [[29,49],[49,48],[48,53]])line=quiet(line,from,to);
 assert.ok(engine.legalMoves(line,53).includes(58));
 assert.equal(publicRouteRisk(board,belief,'human',new Map(),4),1);
 assert.equal(publicRouteRisk(board,belief,'human',new Map(),2),0);
});

test('a weaker guard can occupy the next camp before the invader reaches it',()=>{
 const board=empty();board[58]=own('flag');board[54]=own('mine');board[29]=enemy('division');board[43]=own('platoon');
 const after=quiet(quiet(board,29,49),43,48);
 assert.equal(engine.legalMoves(after,49).includes(48),false);
 assert.equal(routeCovered(board,29,[49,48,53,58],'human',new Map()),true);
});

test('a camp already reached by the invader cannot be reclaimed as a preparation',()=>{
 const board=empty();board[58]=own('flag');board[49]=enemy('division');board[43]=own('platoon');
 const after=quiet(board,49,48);
 assert.equal(engine.legalMoves(after,43).includes(48),false);
 assert.equal(routeCovered(board,49,[48,53,58],'human',new Map()),false);
});

test('a weak ordinary-square blocker is not credited as a permanent wall',()=>{
 const board=empty();board[58]=own('flag');board[49]=enemy('division');board[52]=own('platoon');
 let line=quiet(quiet(board,49,48),52,53);
 assert.ok(engine.legalMoves(line,48).includes(53));
 assert.equal(engine.combat('division','platoon'),'win');
 assert.equal(routeCovered(board,49,[48,53,58],'human',new Map()),false);
});

test('a sufficiently strong ordinary guard still stops the same real route',()=>{
 const board=empty();board[58]=own('flag');board[49]=enemy('division');board[52]=own('commander');
 assert.equal(routeCovered(board,49,[48,53,58],'human',new Map()),true);
});

test('the generated public case gains a right-camp reply without proving the whole flag safe',()=>{
 const frames=JSON.parse(fs.readFileSync(new URL('./fixtures/generated-terminal-route-risk.json',import.meta.url)));
 const observation=frames.find(row=>row.beforePly===143).observation;
 const board=observation.board.slice();board[29]={...board[29],type:'division'};
 assert.equal(board[43].type,'platoon');assert.equal(board[58].type,'flag');
 assert.equal(routeCovered(board,29,[49,48,53,58],observation.side,new Map()),true);
 // The distinct left-hand invader still has a legal route. Camp 48 is not a universal defence.
 let alternate=quiet(board,43,48);alternate[46]={...alternate[46],type:'division'};
 for(const [from,to] of [[46,52],[52,53]])alternate=quiet(alternate,from,to);
 assert.ok(engine.legalMoves(alternate,53).includes(58));
});

