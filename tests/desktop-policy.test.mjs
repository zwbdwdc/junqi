import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createDesktopPolicy } from '../benchmarks/desktop-policy.mjs';
import { runSelfPlay, parseArgs, sourceHashes, seeded, verifyResignation, validateRecord, harnessFiles, DESKTOP_ENTRY } from '../benchmarks/self-play-v2.mjs';
import { assessResignation } from '../dist/resignation.js';
import { createGame, makeObservation, applyMove, legalMoves, randomLayout } from '../dist/engine.js';
import { createAIContext } from '../dist/ai-context.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const hash=value=>createHash('sha256').update(value).digest('hex');
const seedFor=(...parts)=>createHash('sha256').update(parts.join(':')).digest().readUInt32LE(0);
function fixture(t) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'junqi-desktop-policy-'));
  t.after(()=>{const relative=path.relative(os.tmpdir(),directory);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));fs.rmSync(directory,{recursive:true,force:true});});
  fs.writeFileSync(path.join(directory,'package.json'),'{"type":"module"}');
  const source=path.join(directory,'dist');fs.cpSync(path.join(root,'dist'),source,{recursive:true});
  fs.writeFileSync(path.join(source,'ai.js'),`import {legalMoves} from './engine.js';
export const DIFFICULTIES={hell:{timeLimitMs:5000},professional:{timeLimitMs:900}};
let seenRoster=null;
export function chooseMove(o,d,r,profile,context,options){
 if(arguments.length!==6||profile!==null||!Object.isFrozen(o)||!Object.isFrozen(o.board))throw Error('Worker boundary bypassed');
 for(const key of ['initial','repetitions','gameId','aiDecisions','runtime','referee','trueBoard','rngSeed'])if(key in o)throw Error('Private observation field');
 if(o.enemyRoster.some(p=>'type' in p)||o.board.some(p=>p&&p.side!==o.side&&![null,'engineer','flag'].includes(p.type)))throw Error('Hidden identity leaked');
 const roster=o.ownRoster.map(p=>p.id).join(',');if(seenRoster!==null&&seenRoster!==roster)throw Error('Worker reused across sides or games');seenRoster=roster;
 const moves=o.board.flatMap((p,from)=>p?.side===o.side?legalMoves(o.board,from).map(to=>({from,to})):[]),draw=r();
 const move=moves[Math.floor(draw*moves.length)];
 return {...move,info:{searchDepth:0,searchedNodes:0,draw,context,diagnostics:{completedDepth:0,attemptedDepth:0,timeLimitMs:options.timeLimitMs,elapsedMs:0}}};
}`);
  return {directory,source};
}

test('desktop bridge supplies only public input, fixed RNG and the real Worker budget split',async t=>{
  const {source}=fixture(t),client=createDesktopPolicy(source);t.after(()=>client.close());
  const game=createGame(randomLayout('human',seeded(1)),randomLayout('ai',seeded(2)),{engineerMountains:true});
  const observation=makeObservation(game,'human'),context=createAIContext(7),request={observation,difficulty:'hell',context,rngSeed:921};
  const a=await client.decide(request),b=await client.decide(request);
  assert.equal(a.error,undefined);assert.equal(a.move.info.draw,seeded(921)());
  assert.equal(b.move.info.draw,a.move.info.draw);assert.equal(b.move.from,a.move.from);assert.equal(b.move.to,a.move.to);
  for(const response of [a,b]){
    const d=response.info.diagnostics;
    assert.equal(d.timeLimitMs,5000);assert.ok(d.resignationCheckMs>=0&&d.searchTimeLimitMs<=5000);
    assert.ok(Math.abs(d.resignationCheckMs+d.searchTimeLimitMs-5000)<0.02);
    assert.deepEqual(response.move.info.context,context);
  }
  assert.deepEqual(observation,makeObservation(game,'human'));
});

test('self-play uses separate desktop Workers for each viewpoint and recreates them across paired games',async t=>{
  const {source,directory}=fixture(t);
  const config=parseArgs(['--source-root',source,'--games','2','--seeds','90111','--max-plies','4','--output',path.join(directory,'run.json')]);
  const report=await runSelfPlay(config,{signals:false});
  assert.equal(report.schema,2);assert.equal(report.protocol.testOnly,false);assert.equal(report.protocol.decisionEntry,DESKTOP_ENTRY);
  assert.deepEqual(report.protocol.harnessFiles,harnessFiles());
  assert.equal(report.sourceHashes.harness,hash(JSON.stringify(harnessFiles())));
  assert.equal(report.summary.capped,2);assert.equal(report.summary.ruleTerminals,0);assert.equal(report.summary.resignations,0);
  for(const item of report.games){
    const record=read(path.resolve(directory,item.file));
    assert.equal(record.resignationDecision,null);assert.equal(record.terminalKind,null);
    assert.equal(record.decisions.length,4);
    for(const d of record.decisions){assert.ok(Number.isFinite(d.info.diagnostics.resignationCheckMs));assert.ok(Number.isFinite(d.info.diagnostics.searchTimeLimitMs));}
  }
});

test('actual desktop resignation is a public proof and rejects forged, altered or unproven responses',async t=>{
  const client=createDesktopPolicy(path.join(root,'dist'));t.after(()=>client.close());
  const {observation}=read(path.join(root,'tests/fixtures/ai-early-resignation.json')).fixtures[0];
  const response=await client.decide({observation,difficulty:'hell',context:createAIContext(4),rngSeed:7});
  assert.equal(response.move,null);assert.equal(response.info,null);assert.equal(response.resignation.resign,true);
  assert.equal(verifyResignation(observation,response,{assessResignation}).resign,true);
  const falsified=structuredClone(response);falsified.resignation.proof.nodes++;
  assert.throws(()=>verifyResignation(observation,falsified,{assessResignation}),/proof facts/);
  const incomplete=structuredClone(response);incomplete.resignation.reason='budget';
  assert.throws(()=>verifyResignation(observation,incomplete,{assessResignation}),/Malformed/);
  const game=createGame(randomLayout('human',seeded(6)),randomLayout('ai',seeded(7)),{engineerMountains:true});
  assert.throws(()=>verifyResignation(makeObservation(game,'human'),response,{assessResignation}),/no complete public/);
});

test('a resignation checkpoint does not invent a move and rejects winner, observation and proof tampering',async t=>{
  const {source,directory}=fixture(t),g=read(path.join(root,'tests/fixtures/ai-resignation-game.json')).game;
  // Fixed legal formations replay the existing genuine public-loss fixture.
  // This is a test-only record; no injected policy is eligible for acceptance.
  const layouts={hell:g.initial.slice(0,60).map((_,i)=>g.initial[59-i]?.side==='human'?{...g.initial[59-i],side:'ai'}:null),
    professional:g.initial.slice(0,60).map(p=>p?.side==='ai'?p:null)};
  fs.writeFileSync(path.join(source,'formations.js'),`const layouts=${JSON.stringify(layouts)};export const createAILayout=d=>structuredClone(layouts[d]);`);
  const config=parseArgs(['--source-root',source,'--games','1','--paired','false','--seeds','91214','--max-plies','500','--output',path.join(directory,'resume.json')]);
  const paused=await runSelfPlay(config,{signals:false,stopAfterPlies:0,policy:()=>{throw Error('not called');}});
  const modules=await Promise.all(['engine.js','formations.js','ai-context.js','resignation.js'].map(file=>import(pathToFileURL(path.join(source,file)).href)));
  const api=Object.assign({},...modules),descriptor={seed:91214,pair:0,challengerSide:'human',index:0,id:'00001'};
  const sides={human:'challenger',ai:'opponent'};
  const contexts=Object.fromEntries(Object.entries(sides).map(([side,policy])=>[side,api.createAIContext(seedFor(descriptor.seed,policy,'context'))]));
  const boardFor=side=>Array.from({length:60},(_,at)=>{const p=layouts[side==='human'?'hell':'professional'][side==='human'?59-at:at];return p?{...p,id:`self-00001-${side}-${at}`,side,origin:at,moved:false}:null;});
  let game=api.createGame(boardFor('human'),boardFor('ai'),{engineerMountains:true});game.gameId='self-play-training-91214-human';
  const decisions=[];
  for(const event of g.history){
    const observation=api.makeObservation(game,game.turn),policy=sides[game.turn];
    decisions.push({ply:game.ply+1,side:game.turn,policy,difficulty:policy==='challenger'?'hell':'professional',
      rngSeed:seedFor(descriptor.seed,policy,game.ply,'move'),observationSha256:hash(JSON.stringify(observation)),from:event.from,to:event.to,elapsedMs:1,info:{}});
    game=api.applyMove(game,event.from,event.to);
  }
  const observation=api.makeObservation(game,game.turn),proof=api.assessResignation(observation,{clock:()=>0,nodeLimit:500000,maxPlies:6});
  assert.equal(proof.resign,true);const side=game.turn,policy=sides[side];
  const resignationDecision={afterPly:game.ply,side,policy,difficulty:policy==='challenger'?'hell':'professional',rngSeed:seedFor(descriptor.seed,policy,game.ply,'move'),observationSha256:hash(JSON.stringify(observation)),elapsedMs:1,response:{requestId:1,move:null,info:null,resignation:proof}};
  game={...game,result:{winner:side==='ai'?'human':'ai',reason:'resign'}};
  const record={schema:2,descriptor,sides,contexts,game,decisions,resignationDecision,failures:[],status:'finished',terminal:true,terminalKind:'resignation',winner:sides[game.result.winner]};
  assert.equal(validateRecord(record,descriptor,paused.protocol,api),record);
  assert.equal(record.game.history.length,record.decisions.length);assert.equal(record.resignationDecision.afterPly,record.game.ply);
  for(const mutate of [r=>r.game.result.winner=side,r=>r.resignationDecision.observationSha256='0'.repeat(64),r=>r.resignationDecision.response.resignation.proof.nodes++,r=>r.terminalKind='rule',r=>r.resignationDecision=null]){
    const bad=structuredClone(record);mutate(bad);assert.throws(()=>validateRecord(bad,descriptor,paused.protocol,api));
  }
  const oldProtocol={...paused.protocol};delete oldProtocol.decisionEntry;
  assert.throws(()=>validateRecord(record,descriptor,oldProtocol,api),/different decision entry/);
});
