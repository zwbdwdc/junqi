import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {lastJsonResult,verifyUnitBinding,verifyBridgeReport,verifyFeatureReport,verifySessionSaveReport,verifyExtendedPackageQa,verifyBoardGeometryReport,sourceMatches,classifyStrength,verifyFreshAcceptance,preservePreviousReport} from '../finalize-update.mjs';

const sources={'ai.js':'a','engine.js':'e','offense.js':'o'};
const acceptance=()=>({sourceHashes:{...sources,harness:'h'},allReplaysVerified:true,
  protocol:{mode:'acceptance',opponent:'professional',games:20,paired:true,decisionEntry:'desktop-worker-v1'},
  summary:{planned:20,wins:19,losses:1,draws:0,capped:0,errors:0,terminal:20,pending:0,
    ruleTerminals:18,resignations:2,complete:true,coverageValid:true,eligible:true,passed:true}});

test('release strength cannot accept legacy core-only results or ambiguous terminal counts',()=>{
  for(const mutate of [
    r=>delete r.protocol.decisionEntry,
    r=>r.protocol.decisionEntry='chooseMove',
    r=>r.protocol.decisionEntry='test-policy',
    r=>r.protocol.opponent='hell',
    r=>delete r.summary.ruleTerminals,
    r=>r.summary.resignations=3,
    r=>{r.summary.ruleTerminals=21;r.summary.resignations=-1;},
  ]){const data=acceptance();mutate(data);assert.equal(classifyStrength(data,sources).strengthAccepted,false);}
});

test('update evidence never promotes absent or different-source acceptance to current playing strength',()=>{
  assert.equal(classifyStrength(null,sources).strengthAccepted,false);
  const old=acceptance();old.sourceHashes['ai.js']='previous';
  assert.equal(classifyStrength(old,sources).strengthAccepted,false);
  assert.equal(classifyStrength(old,sources).matchesCurrentCandidate,false);
  const omitted=acceptance();delete omitted.sourceHashes['offense.js'];
  assert.equal(classifyStrength(omitted,sources).strengthAccepted,false);
  assert.equal(sourceMatches({...sources,'unpackaged.js':'u'},sources),false);
});

test('only complete verified paired twenty-game acceptance with nineteen wins can pass',()=>{
  assert.equal(classifyStrength(acceptance(),sources).strengthAccepted,true);
  for(const mutate of [
    r=>r.protocol.mode='training',r=>r.protocol.games=19,r=>r.protocol.paired=false,
    r=>r.allReplaysVerified=false,r=>r.summary.wins=18,r=>r.summary.terminal=19,
    r=>r.summary.capped=1,r=>r.summary.pending=1,r=>r.summary.errors=1,
    r=>r.summary.coverageValid=false,r=>r.summary.eligible=false,r=>r.summary.passed=false,
  ]){const data=acceptance();mutate(data);assert.equal(classifyStrength(data,sources).strengthAccepted,false);}
});
test('renaming or copying historical acceptance never creates a new acceptance run',()=>{
  assert.equal(verifyFreshAcceptance(null,[{sha256:'old'}]),true);
  assert.equal(verifyFreshAcceptance({sha256:'new'},[{sha256:'old'}]),true);
  assert.throws(()=>verifyFreshAcceptance({sha256:'old',file:'renamed.json'},[{sha256:'old',file:'previous.json'}]),/historical acceptance/);
});

const totals={tests:210,pass:210,fail:0,cancelled:0,skipped:0,todo:0,passed:true};
const current={packageFiles:{'dist/ai.js':'a','main.cjs':'b'},packageMetadata:{version:'2.4.1'},testFiles:{'tests/fixture.json':'f'},runnerSha256:'runner'};
const unitBinding=()=>({schema:1,completed:true,exitCode:0,before:structuredClone(current),after:structuredClone(current),logSha256:'log',totals:{...totals}});
test('full regression log requires matching before-and-after source, fixtures, version and bytes',()=>{
  assert.equal(verifyUnitBinding(unitBinding(),current,'log',totals),true);
  for(const mutate of [
    r=>r.completed=false,r=>r.exitCode=1,r=>r.logSha256='old',
    r=>r.before.packageFiles['dist/ai.js']='old',r=>r.after.packageFiles['main.cjs']='changed',
    r=>r.after.testFiles['tests/fixture.json']='changed',r=>r.after.packageMetadata.version='2.4.0',
    r=>r.totals.pass=209,
  ]){const binding=unitBinding();mutate(binding);assert.throws(()=>verifyUnitBinding(binding,current,'log',totals));}
});

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const expected={asarPath:path.join(root,'release','test.asar'),asarSha256:'sha',
  packageFiles:{'dist/ai.js':'a','main.cjs':'b'},packageMetadata:{version:'2.4.1'}};
const binding=()=>({packaged:true,sourceMatched:true,unchanged:true,asarPath:expected.asarPath,
  asarSha256Before:'sha',asarSha256After:'sha',packageFiles:{...expected.packageFiles},packageMetadata:{...expected.packageMetadata}});
function bridge(name){
  const checks={archive:18,experience:8,consolidation:17}[name];
  const phases=name==='experience'?Array.from({length:checks},()=>({ok:true})):
    ['write','read'].map((phase,i)=>({phase,ok:true,packageBinding:binding(),checks:Array.from({length:i===0?8:checks-8},()=>({ok:true}))}));
  return {report:{ok:true,checks,packageBinding:binding(),results:phases},
    log:{ok:true,checks,reportPath:path.join(root,'research',`${name}-qa-result.json`),packageBinding:binding()}};
}
test('five package QA evidence cannot reuse stale bridge summaries or phase packages',()=>{
  for(const name of ['archive','experience','consolidation']){
    const {report,log}=bridge(name);assert.equal(verifyBridgeReport(name,report,log,expected),true);
    assert.throws(()=>verifyBridgeReport(name,report,{...log,checks:1},expected));
    assert.throws(()=>verifyBridgeReport(name,report,{...log,reportPath:'unrelated.json'},expected));
    const bad=structuredClone(report);
    if(name==='experience')bad.results[0].ok=false;
    else bad.results[1].packageBinding.asarSha256After='stale';
    assert.throws(()=>verifyBridgeReport(name,bad,log,expected));
  }
});

function temporary(t){
  const base=mkdtempSync(path.join(os.tmpdir(),'junqi-update-evidence-'));
  t.after(()=>{const relative=path.relative(os.tmpdir(),base);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));rmSync(base,{recursive:true,force:true});});
  return base;
}
test('previous release report is preserved byte-for-byte and never overwritten on retries',t=>{
  const base=temporary(t),source=path.join(base,'report.json'),backup=path.join(base,'backup','previous.json');
  const original='{ "appVersion": "2.4.1", "strengthAccepted": false }\n';
  writeFileSync(source,original);const chain=preservePreviousReport(source,backup,'2.5.0');assert.equal(readFileSync(backup,'utf8'),original);
  writeFileSync(source,JSON.stringify({appVersion:'2.5.0',previousReleaseReport:chain.previousReleaseReport}));
  preservePreviousReport(source,backup,'2.5.0');assert.equal(readFileSync(backup,'utf8'),original);
});
test('missing old evidence backup cannot be silently replaced with a new-version report',t=>{
  const base=temporary(t),source=path.join(base,'report.json'),backup=path.join(base,'previous.json');
  writeFileSync(source,'{"appVersion":"2.5.0"}');assert.throws(()=>preservePreviousReport(source,backup,'2.5.0'),/original predecessor backup/);
});
test('new feature release requires both feature proofs against the actual package',()=>{
  const report={passed:true,checks:[{name:'annotation',ok:true},{name:'resignation',ok:true}],featureProof:{annotation:true,resignation:true},packageBinding:binding()};
  assert.equal(verifyFeatureReport(report,expected),true);
  for(const mutate of [r=>r.featureProof.annotation=false,r=>r.featureProof.resignation=false,r=>r.checks=[],r=>r.checks[0].ok=false,r=>r.packageBinding.asarSha256After='old']){
    const bad=structuredClone(report);mutate(bad);assert.throws(()=>verifyFeatureReport(bad,expected));
  }
});
test('package completion parser accepts final JSON and rejects missing or truncated completion',()=>{
  assert.deepEqual(lastJsonResult('progress\n{"passed":false}\n{"passed":true}\n'),{passed:true});
  assert.throws(()=>lastJsonResult('progress only'),/completion JSON/);
  assert.throws(()=>lastJsonResult('{"passed":true}\n{"passed":'),SyntaxError);
});

test('storage patch release rejects stale package proof, failed checks and unverified recovery',()=>{
  const storageProof=Object.fromEntries(['persistentWarning','manualRetry','recoveryPersists','layoutReadFailure','invalidLayoutRejected','normalUiClean'].map(name=>[name,true]));
  const report={passed:true,checks:[{name:'storage recovery',ok:true}],storageProof,packageBinding:binding()};
  assert.equal(verifySessionSaveReport(report,expected),true);
  for(const mutate of [r=>r.passed=false,r=>r.checks=[],r=>r.checks[0].ok=false,r=>r.packageBinding.asarSha256After='old',
    ...Object.keys(storageProof).map(name=>r=>delete r.storageProof[name])]){
    const bad=structuredClone(report);mutate(bad);assert.throws(()=>verifySessionSaveReport(bad,expected));
  }
});

test('early resignation release needs actual deeper proofs in both workers and a matching package',()=>{
  const workers=['professional','hell'].map(difficulty=>({difficulty,response:{move:null,resignation:{resign:true,proof:{maxPlies:4}}}}));
  const report={passed:true,checks:[{name:'worker',ok:true}],packageBinding:binding(),workers,additionalWorkers:structuredClone(workers),
    earlyResignProof:Object.fromEntries(['earlierThanImmediate','bothDifficulties','publicWorkerOnly','unchangedHistory','archiveAndLearning','replayAndReload'].map(k=>[k,true]))};
  assert.equal(verifyExtendedPackageQa(report,expected,'early-resign'),true);
  for(const mutate of [r=>r.workers.pop(),r=>r.workers[0].response.resignation.proof.maxPlies=2,
    r=>r.earlyResignProof.replayAndReload=false,r=>r.additionalWorkers[1].response.move={from:1,to:2},r=>r.packageBinding.asarSha256After='old']){
    const bad=structuredClone(report);mutate(bad);assert.throws(()=>verifyExtendedPackageQa(bad,expected,'early-resign'));
  }
});

function boardGeometryFixture(){
  const cases=['920x730-z100','1240x930-z100','1440x900-z100','1440x730-z100','1920x730-z100','2560x1080-z100','1240x930-z90','1240x930-z110','1240x930-z125','920x730-z125'];
  const phases=['setup','mountain-target','mountain-occupied','marked','replay'];
  const checks=['board proportion','no mountain/piece collision','no piece/piece collision','piece hit centres','front rank edge hits','piece corner hits','frontline labels do not overlap pieces','marks do not cover another piece','mark container fits cell and visible text fits own piece','labels fit pieces','normal token proportion','board visible'];
  const actions=['start reachable after setup scroll','empty mountain legal target','both mountains occupied','occupied mountain selectable','mark menu visible','marked dark piece','replay controls and revealed board'];
  const rect=(left,top,width,height)=>({left,top,width,height,right:left+width,bottom:top+height});
  const pos=i=>i>=60?[i===60?90:210,199.2]:[30+(i%5)*60,(38+Math.floor(i/5)*50+(i>=30?38:0))*.6];
  const camps=new Set([11,13,17,21,23,36,38,42,46,48]);
  const report={schema:1,passed:true,baseline:false,actualVersion:expected.packageMetadata.version,failure:null,packageBinding:binding(),checks:[],layouts:[],dialogLayouts:[]};
  for(const caseName of cases){
    const [,w,h,z]=caseName.match(/^(\d+)x(\d+)-z(\d+)$/),viewport=[w*100/z,h*100/z];
    for(const phase of phases){
      const occupied=['mountain-occupied','marked','replay'].includes(phase);
      const indexes=Array.from({length:60},(_,i)=>i).filter(i=>!camps.has(i)&&(!occupied||![27,30].includes(i)));
      if(occupied)indexes.push(60,61);
      const pieces=indexes.map(index=>{const [x,y]=pos(index);return {index,box:rect(x-23,y-11.7,46,23.4),text:rect(x-10,y-5,20,10),hit:index,edgeHits:[26,28,31,33].includes(index)?[index,index]:[],cornerHits:[index,index,index,index],mountain:index>=60,selected:index===60};});
      const mountains=[60,61].map(index=>{const [x,y]=pos(index);return {index,occupied,cell:rect(x-25,y-11.7,50,23.4),paint:occupied?null:rect(x-7,y-7,14,14),overlaps:[]};});
      const decorations=[30,150,270].map(x=>({kind:'frontline',owner:-1,paint:rect(x-4,191.5,8,15),overlaps:[]}));
      if(phase==='marked'){const p=pieces.find(p=>p.index===26);decorations.push({kind:'mark',owner:26,paint:rect(p.box.left+2,p.box.bottom-8,30,7),text:rect(p.box.left+3,p.box.bottom-7,28,5),visible:true,ownPiece:{...p.box},ownCell:rect(p.box.left-2,p.box.top,50,p.box.height),hitOwners:[26,26,26,26,26],overlaps:[]});}
      report.layouts.push({caseName,phase,viewport,board:rect(0,0,300,399),pieces,mountains,decorations,pieceOverlaps:[]});
      report.checks.push(...checks.map(k=>({name:`${caseName} ${phase} ${k}`,ok:true})));
    }
    for(const id of ['rules','settings','history','rules','settings','history']){
      report.dialogLayouts.push({caseName,id,viewport,rect:rect(10,10,200,200),buttons:[rect(170,20,30,30)]});
      report.checks.push({name:`${caseName} ${id} dialog in viewport`,ok:true});
    }
    report.checks.push(...actions.map(k=>({name:`${caseName} ${k}`,ok:true})));
  }
  const summary={passed:true,checks:730,failed:[],layouts:50,reportPath:path.join(root,'research','board-geometry-fixture.json'),packageBinding:binding()};
  return {report,summary};
}

test('board geometry release requires complete current-package details, not a passing stdout summary',()=>{
  const {report,summary}=boardGeometryFixture();assert.equal(verifyBoardGeometryReport(report,summary,expected),true);
  const transparentContainer=structuredClone(report),mark=transparentContainer.layouts.find(g=>g.phase==='marked').decorations.at(-1);
  mark.paint.left=mark.ownCell.left;mark.paint.width=mark.paint.right-mark.paint.left;
  assert.equal(verifyBoardGeometryReport(transparentContainer,summary,expected),true,'transparent box may use its own cell while visible text stays in the piece');
  assert.throws(()=>verifyBoardGeometryReport(summary,summary,expected));
  for(const mutate of [
    r=>r.baseline=true,r=>r.actualVersion='old',r=>r.packageBinding.packaged=false,r=>r.packageBinding.asarSha256After='old',
    r=>r.failure='interrupted',r=>r.checks[0].ok=false,r=>r.checks.pop(),r=>r.checks[0].name='unrelated check',
    r=>r.layouts.pop(),r=>r.layouts[49]=structuredClone(r.layouts[0]),r=>r.dialogLayouts.pop(),
    r=>r.layouts.at(-1).viewport=[920,730],r=>r.layouts[0].pieces.pop(),
  ]){const bad=structuredClone(report);mutate(bad);assert.throws(()=>verifyBoardGeometryReport(bad,summary,expected));}
  for(const mutate of [s=>s.passed=false,s=>s.checks=480,s=>s.layouts=49,s=>s.failed=['bad'],s=>s.packageBinding.asarSha256After='old']){
    const bad=structuredClone(summary);mutate(bad);assert.throws(()=>verifyBoardGeometryReport(report,bad,expected));
  }
});

test('board geometry release recomputes internal collisions even when all checks and overlap claims pass',()=>{
  const {report,summary}=boardGeometryFixture();
  for(const mutate of [
    r=>r.layouts[0].pieces[1].box={...r.layouts[0].pieces[0].box},
    r=>{const g=r.layouts.find(g=>g.phase==='marked');g.decorations.find(d=>d.kind==='mark').paint={...g.pieces.find(p=>p.index===60).box};},
    r=>{const g=r.layouts[0];g.mountains[0].paint={...g.pieces.find(p=>p.index===26).box};},
    r=>{const g=r.layouts[0];g.decorations[0].paint={...g.pieces[0].box};},
    r=>r.layouts[0].pieces[0].hit=60,r=>r.layouts[0].pieces.find(p=>p.index===26).edgeHits=[60,26],
    r=>r.layouts[0].pieces[0].cornerHits=[60,0,0,0],
    r=>r.layouts[0].pieces[0].text.right+=100,r=>r.layouts[0].board.width=500,
    r=>r.layouts[0].pieces[0].box.left=NaN,r=>delete r.layouts[0].pieceOverlaps,
    r=>r.layouts[0].decorations=[],r=>r.layouts.find(g=>g.phase==='marked').decorations.pop(),
    r=>r.layouts.find(g=>g.phase==='mountain-occupied').mountains[0].paint={left:0,right:1,top:0,bottom:1},
    r=>r.layouts.find(g=>g.phase==='marked').decorations.at(-1).visible=false,
    r=>r.layouts.find(g=>g.phase==='marked').decorations.at(-1).hitOwners=[26,26,60,26,26],
    r=>{const d=r.layouts.find(g=>g.phase==='marked').decorations.at(-1);d.text.left=d.ownPiece.left-1.5;d.text.right=d.text.left+d.text.width;},
    r=>r.layouts.find(g=>g.phase==='marked').decorations.at(-1).ownPiece.right+=100,
    r=>delete r.layouts.find(g=>g.phase==='marked').decorations.at(-1).ownCell,
    r=>r.dialogLayouts[0].buttons[0].bottom=10000,
  ]){const bad=structuredClone(report);mutate(bad);assert.throws(()=>verifyBoardGeometryReport(bad,summary,expected));}
});
