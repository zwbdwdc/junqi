// Versioned engineering evidence. Directed positions and historical matches
// never stand in for a new, independently verified playing-strength batch.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, renameSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseUnitTotals, verifyPackageBinding, verifyPortableProof, verifiedBatch } from './finalize-self-play.mjs';
import { preserveReportChain, inheritHistoricalAcceptance, assertReportUnchanged, collectReportEvidence } from './release-chain.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const absolute=name=>path.resolve(root,name);
const read=name=>JSON.parse(readFileSync(absolute(name),'utf8').replace(/^\uFEFF/,''));
const hash=name=>createHash('sha256').update(readFileSync(absolute(name))).digest('hex');
const evidence=name=>({file:path.relative(root,absolute(name)).replaceAll('\\','/'),sha256:hash(name)});
const metadata=()=>Object.fromEntries(['name','version','main'].map(key=>[key,read('package.json')[key]]));
const backend=['main.cjs','preload.cjs','storage.cjs','archive-store.cjs','diagnostics-store.cjs'];
function directoryHashes(directory,prefix='',extension=null){
  const result={};
  for(const entry of readdirSync(absolute(directory),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
    const filename=path.join(directory,entry.name),name=prefix+entry.name;
    if(entry.isDirectory())Object.assign(result,directoryHashes(filename,name+'/',extension));
    else {assert.ok(entry.isFile(),`unsupported evidence source: ${filename}`);if(!extension||entry.name.endsWith(extension))result[name]=hash(filename);}
  }
  return result;
}
function packageFiles(){
  return {...directoryHashes('dist','dist/'),...Object.fromEntries(backend.map(name=>[name,hash(name)]))};
}
function testsSnapshot(){return {packageFiles:packageFiles(),packageMetadata:metadata(),
  testFiles:directoryHashes('tests','tests/'),runnerSha256:hash('finalize-update.mjs'),
  runnerFiles:Object.fromEntries(['finalize-update.mjs','release-chain.mjs','finalize-self-play.mjs'].map(name=>[name,hash(name)]))};}

export function lastJsonResult(text){
  const lines=text.replace(/^\uFEFF/,'').split(/\r?\n/).map(line=>line.trim()).filter(line=>line.startsWith('{'));
  assert.ok(lines.length,'QA completion JSON is missing');
  return JSON.parse(lines.at(-1));
}

export function verifyUnitBinding(manifest,current,logSha256,totals){
  assert.equal(manifest?.schema,1);assert.equal(manifest.completed,true);
  assert.equal(manifest.exitCode,0,'full regression process did not succeed');
  assert.deepEqual(manifest.before,current,'tests started on different source or test files');
  assert.deepEqual(manifest.after,current,'source or tests changed during/after the run');
  assert.equal(manifest.logSha256,logSha256,'regression log changed');
  assert.deepEqual(manifest.totals,totals);
  assert.ok(totals.passed&&totals.tests>=210,'all current tests must pass, with no skips');
  return true;
}

export function verifyBridgeReport(name,report,log,expected){
  const required={archive:18,experience:8,consolidation:17}[name];assert.ok(required);
  assert.equal(report.ok,true);assert.equal(log.ok,true);
  assert.equal(report.checks,required);assert.equal(log.checks,required);
  assert.equal(path.resolve(log.reportPath),absolute(`research/${name}-qa-result.json`),'QA log points at a different report');
  verifyPackageBinding(report.packageBinding,expected);verifyPackageBinding(log.packageBinding,expected);
  assert.deepEqual(report.packageBinding,log.packageBinding);
  assert.ok(Array.isArray(report.results));
  if(name==='experience'){
    assert.equal(report.results.length,required);assert.ok(report.results.every(check=>check.ok===true));
  }else{
    assert.deepEqual(report.results.map(phase=>phase.phase),['write','read']);
    for(const phase of report.results){
      assert.equal(phase.ok,true);verifyPackageBinding(phase.packageBinding,expected);
      assert.ok(Array.isArray(phase.checks)&&phase.checks.length>0&&phase.checks.every(check=>check.ok===true));
    }
    assert.equal(report.results.reduce((sum,phase)=>sum+phase.checks.length,0),required);
  }
  return true;
}

export function sourceMatches(sourceHashes,current){
  if(!sourceHashes||typeof sourceHashes!=='object')return false;
  const names=Object.keys(sourceHashes).filter(name=>name!=='harness').sort();
  return JSON.stringify(names)===JSON.stringify(Object.keys(current).sort())&&
    names.every(name=>sourceHashes[name]===current[name]);
}

export function classifyStrength(batch,current){
  if(!batch)return {strengthAccepted:false,reason:'no-new-independent-acceptance'};
  const matchesCurrentCandidate=sourceMatches(batch.sourceHashes,current), s=batch.summary||{};
  const desktopEntry=batch.protocol?.decisionEntry==='desktop-worker-v1';
  const terminalCounts=Number.isSafeInteger(s.ruleTerminals)&&s.ruleTerminals>=0&&
    Number.isSafeInteger(s.resignations)&&s.resignations>=0&&s.ruleTerminals+s.resignations===20;
  const passed=matchesCurrentCandidate&&desktopEntry&&terminalCounts&&batch.allReplaysVerified===true&&batch.protocol?.mode==='acceptance'&&
    batch.protocol?.opponent==='professional'&&
    batch.protocol?.games===20&&batch.protocol?.paired===true&&s.planned===20&&s.complete===true&&
    s.coverageValid===true&&s.eligible===true&&s.passed===true&&s.wins>=19&&
    s.terminal===20&&s.capped===0&&s.errors===0&&s.pending===0;
  return {strengthAccepted:passed,matchesCurrentCandidate,
    reason:passed?'new-current-source-acceptance-passed':!matchesCurrentCandidate?'acceptance-source-not-current':
      !desktopEntry?'acceptance-decision-entry-not-current':'acceptance-threshold-not-met'};
}

export function verifyFreshAcceptance(batch,historical){
  if(batch)assert.ok(historical.every(item=>item.sha256!==batch.sha256),'historical acceptance cannot be relabeled as a new run');
  return true;
}

export function preservePreviousReport(reportFile,backupFile,nextVersion){
  return preserveReportChain({root,reportFile,backupFile,nextVersion});
}

export function verifyFeatureReport(report,expected){
  assert.equal(report.passed,true);verifyPackageBinding(report.packageBinding,expected);
  assert.ok(Array.isArray(report.checks)&&report.checks.length>0,'feature QA checks missing');
  assert.ok(report.checks.every(check=>check&&typeof check.name==='string'&&check.name.length>0&&check.ok===true),'feature QA contains incomplete or failed checks');
  assert.equal(report.featureProof?.annotation,true,'annotation package QA missing');
  assert.equal(report.featureProof?.resignation,true,'resignation package QA missing');
  return true;
}

export function verifySessionSaveReport(report,expected){
  assert.equal(report.passed,true);verifyPackageBinding(report.packageBinding,expected);
  assert.ok(Array.isArray(report.checks)&&report.checks.length>0,'session storage QA checks missing');
  assert.ok(report.checks.every(check=>check&&typeof check.name==='string'&&check.name.length>0&&check.ok===true),'session storage QA contains incomplete or failed checks');
  for(const name of ['persistentWarning','manualRetry','recoveryPersists','layoutReadFailure','invalidLayoutRejected','normalUiClean'])
    assert.equal(report.storageProof?.[name],true,`session storage proof missing: ${name}`);
  return true;
}

export function verifyExtendedPackageQa(report,expected,kind){
  assert.equal(report.passed,true);verifyPackageBinding(report.packageBinding,expected);
  assert.ok(report.checks?.length>0&&report.checks.every(check=>check.ok===true&&typeof check.name==='string'));
  const fields=kind==='early-resign'?['earlierThanImmediate','bothDifficulties','publicWorkerOnly','unchangedHistory','archiveAndLearning','replayAndReload']:
    kind==='desktop-ui'?['viewportFits','recordScroll','actualVersion','hiddenPieces']:null;
  assert.ok(fields,'unknown extended QA');
  const proof=kind==='early-resign'?report.earlyResignProof:report.uiProof;
  for(const field of fields)assert.equal(proof?.[field],true,`${kind} missing ${field}`);
  if(kind==='early-resign'){
    for(const workers of [report.workers,report.additionalWorkers]){
      assert.deepEqual(workers?.map(w=>w.difficulty).sort(),['hell','professional']);
      for(const worker of workers){
        assert.equal(worker.response.move,null);assert.equal(worker.response.resignation.resign,true);
        assert.ok([4,6].includes(worker.response.resignation.proof.maxPlies));
      }
    }
  }else{
    assert.ok(report.layouts?.length>=5&&report.layouts.every(layout=>layout.scroll[1]<=layout.viewport[1]+1&&layout.board.bottom<layout.viewport[1]));
  }
  return true;
}

const geometryCases=['920x730-z100','1240x930-z100','1440x900-z100','1440x730-z100','1920x730-z100','2560x1080-z100','1240x930-z90','1240x930-z110','1240x930-z125','920x730-z125'];
const geometryPhases=['setup','mountain-target','mountain-occupied','marked','replay'];
const geometryChecks=['board proportion','no mountain/piece collision','no piece/piece collision','piece hit centres','front rank edge hits','piece corner hits','frontline labels do not overlap pieces','marks do not cover another piece','mark container fits cell and visible text fits own piece','labels fit pieces','normal token proportion','board visible'];
const geometryActions=['start reachable after setup scroll','empty mountain legal target','both mountains occupied','occupied mountain selectable','mark menu visible','marked dark piece','replay controls and revealed board'];

export function verifyBoardGeometryReport(report,summary,expected){
  assert.equal(report?.schema,1);assert.equal(report.passed,true);assert.equal(report.baseline,false);assert.equal(report.failure,null);
  assert.equal(report.actualVersion,expected.packageMetadata.version,'geometry tested a different version');
  verifyPackageBinding(report.packageBinding,expected);verifyPackageBinding(summary?.packageBinding,expected);
  assert.deepEqual(summary.packageBinding,report.packageBinding);
  assert.equal(summary.passed,true);assert.equal(summary.checks,730);assert.equal(summary.layouts,50);assert.deepEqual(summary.failed,[]);
  assert.equal(typeof summary.reportPath,'string');assert.ok(summary.reportPath.endsWith('.json'));
  const names=geometryCases.flatMap(c=>[
    ...geometryPhases.flatMap(p=>geometryChecks.map(k=>`${c} ${p} ${k}`)),
    ...['rules','settings','history','rules','settings','history'].map(k=>`${c} ${k} dialog in viewport`),
    ...geometryActions.map(k=>`${c} ${k}`),
  ]);
  assert.ok(Array.isArray(report.checks)&&report.checks.every(c=>c?.ok===true&&typeof c.name==='string'));
  assert.deepEqual(report.checks.map(c=>c.name).sort(),names.sort(),'geometry must complete every required check');
  assert.equal(report.layouts?.length,50);assert.equal(report.dialogLayouts?.length,60);
  assert.deepEqual(report.layouts.map(g=>g.caseName+'/'+g.phase).sort(),geometryCases.flatMap(c=>geometryPhases.map(p=>c+'/'+p)).sort(),'missing or duplicate geometry scenario');
  const box=r=>{
    assert.ok(r&&['left','right','top','bottom'].every(k=>Number.isFinite(r[k])),'invalid geometry rectangle');
    assert.ok(r.right>r.left&&r.bottom>r.top,'empty geometry rectangle');
    for(const [size,a,b] of [['width','left','right'],['height','top','bottom']])if(size in r)assert.ok(Number.isFinite(r[size])&&Math.abs(r[size]-(r[b]-r[a]))<0.01);
    return r;
  };
  const intersects=(a,b,t)=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>t&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>t;
  const inside=(a,b,t=0.5)=>a.left>=b.left-t&&a.right<=b.right+t&&a.top>=b.top-t&&a.bottom<=b.bottom+t;
  const viewport=g=>{
    assert.ok(Array.isArray(g.viewport)&&g.viewport.length===2&&g.viewport.every(n=>Number.isFinite(n)&&n>0));
    const [,w,h,z]=g.caseName.match(/^(\d+)x(\d+)-z(\d+)$/)||[];assert.ok(w&&h&&z);
    assert.ok(Math.abs(g.viewport[0]-w*100/z)<3&&Math.abs(g.viewport[1]-h*100/z)<3,'scenario viewport does not match its zoom');
    return {left:0,top:0,right:g.viewport[0],bottom:g.viewport[1]};
  };
  for(const g of report.layouts){
    const screen=viewport(g),board=box(g.board);assert.ok(inside(board,screen,1));
    assert.ok(Math.abs(board.width/board.height-500/665)<0.015,'stretched board');
    assert.equal(g.pieces?.length,50);assert.equal(new Set(g.pieces.map(p=>p.index)).size,50);
    for(const p of g.pieces){
      assert.ok(Number.isInteger(p.index)&&p.index>=0&&p.index<62);box(p.box);box(p.text);
      assert.ok(inside(p.box,board)&&inside(p.text,p.box),'piece or label escaped its bounds');assert.equal(p.hit,p.index,'wrong piece hit target');
      assert.deepEqual(p.edgeHits,[26,28,31,33].includes(p.index)?[p.index,p.index]:[],'wrong front-rank edge hit');
      assert.deepEqual(p.cornerHits,[p.index,p.index,p.index,p.index],'wrong piece corner hit');
      assert.equal(p.mountain,p.index>=60);if(!p.mountain)assert.ok(p.box.width/p.box.height>=1.65&&p.box.width/p.box.height<=2.5);
    }
    assert.deepEqual(g.pieceOverlaps,[],'reported piece collision');
    for(let a=0;a<g.pieces.length;a++)for(let b=a+1;b<g.pieces.length;b++)assert.ok(!intersects(g.pieces[a].box,g.pieces[b].box,0.1),'unreported piece collision');
    assert.deepEqual(g.mountains?.map(m=>m.index).sort(),[60,61]);
    const occupied=['mountain-occupied','marked','replay'].includes(g.phase);
    for(const m of g.mountains){
      box(m.cell);assert.equal(m.occupied,occupied);assert.equal(g.pieces.some(p=>p.index===m.index),occupied);assert.deepEqual(m.overlaps,[]);
      if(occupied)assert.equal(m.paint,null,'occupied mountain decoration must be hidden');
      else{box(m.paint);for(const p of g.pieces)assert.ok(!intersects(m.paint,p.box,0.5),'unreported mountain collision');}
    }
    if(['mountain-occupied','marked'].includes(g.phase))assert.equal(g.pieces.find(p=>p.index===60)?.selected,true);
    assert.ok(Array.isArray(g.decorations));assert.equal(g.decorations.filter(d=>d.kind==='frontline').length,3);
    assert.equal(g.decorations.filter(d=>d.kind==='mark').length,g.phase==='marked'?1:0);
    for(const d of g.decorations){
      assert.ok(['frontline','mark'].includes(d.kind));assert.equal(d.owner,d.kind==='mark'?26:-1);box(d.paint);assert.deepEqual(d.overlaps,[]);
      for(const p of g.pieces)if(p.index!==d.owner)assert.ok(!intersects(d.paint,p.box,0.5),'unreported mark/frontline collision');
      if(d.kind==='mark'){
        const owner=g.pieces.find(p=>p.index===d.owner);assert.ok(owner);assert.deepEqual(d.ownPiece,owner.box);
        box(d.text);box(d.ownCell);assert.equal(d.visible,true);
        assert.ok(inside(d.ownCell,board)&&inside(owner.box,d.ownCell)&&inside(d.paint,d.ownCell)&&inside(d.text,owner.box),'mark escaped its owner cell or text escaped its piece');
        assert.deepEqual(d.hitOwners,[d.owner,d.owner,d.owner,d.owner,d.owner],'mark is occluded or targets another piece');
      }
    }
  }
  for(const c of geometryCases)assert.deepEqual(report.dialogLayouts.filter(d=>d.caseName===c).map(d=>d.id).sort(),['history','history','rules','rules','settings','settings']);
  for(const d of report.dialogLayouts){
    const screen=viewport(d);assert.ok(inside(box(d.rect),screen,1));assert.ok(d.buttons?.length>0);
    for(const button of d.buttons)assert.ok(inside(box(button),screen,1),'dialog close control escaped viewport');
  }
  return true;
}

export function runUpdateTests({tag=metadata().version}={}){
  assert.match(tag,/^\d+\.\d+(?:\.\d+)?$/);
  const logFile=`full-tests-${tag}.out`,bindingFile=`full-tests-${tag}.binding.json`,before=testsSnapshot();
  const startedAt=new Date().toISOString();
  const testFiles=readdirSync(absolute('tests')).filter(name=>name.endsWith('.test.mjs')).sort().map(name=>`tests/${name}`);
  assert.ok(testFiles.length);
  const result=spawnSync(process.execPath,['--test',...testFiles],{cwd:root,encoding:'utf8',maxBuffer:64*1024*1024,windowsHide:true});
  const output=(result.stdout||'')+(result.stderr||'')+(result.error?`\n${String(result.error)}\n`:'');
  writeFileSync(absolute(logFile),output);
  let totals=null;try{totals=parseUnitTotals(output);}catch{}
  const manifest={schema:1,startedAt,finishedAt:new Date().toISOString(),completed:result.status!==null,
    exitCode:result.status,signal:result.signal,command:[process.execPath,'--test',...testFiles],
    before,after:testsSnapshot(),logFile,logSha256:hash(logFile),totals};
  writeFileSync(absolute(bindingFile),JSON.stringify(manifest,null,2)+'\n');
  assert.ok(totals,'complete test footer missing');
  verifyUnitBinding(manifest,testsSnapshot(),hash(logFile),totals);
  console.log(JSON.stringify({logFile,bindingFile,...totals}));
  return manifest;
}

function verifyDirectedEndgame(filename,current){
  if(!filename)return null;
  const report=read(filename),protocol=report.protocol;
  assert.equal(report.schema,1);assert.equal(report.kind,'directed-endgame-pressure');
  assert.equal(report.complete,true,'directed run is incomplete');
  assert.equal(protocol?.notAcceptance,true);assert.equal(protocol.aiBudgetsUnmodified,true);
  assert.ok(sourceMatches(protocol.sourceHashes,current),'directed report did not test the current candidate');
  assert.ok(Array.isArray(report.rows)&&report.rows.length>0);
  for(const row of report.rows){
    assert.equal(row.complete,true);assert.equal(row.verified,true,'directed record replay failed');
    assert.equal(hash(row.recordPath),row.recordSha256,'directed raw record changed');
    assert.ok(row.terminal===true||row.capped===true,'every directed case must finish or be explicitly capped');
    assert.ok(!(row.terminal&&row.capped));
    if(row.terminal)assert.ok(row.result&&['ai','human',null].includes(row.result.winner));
  }
  const summary={games:report.rows.length,terminal:report.rows.filter(row=>row.terminal).length,
    aiWins:report.rows.filter(row=>row.result?.winner==='ai').length,
    humanWins:report.rows.filter(row=>row.result?.winner==='human').length,
    draws:report.rows.filter(row=>row.terminal&&row.result?.winner===null).length,
    capped:report.rows.filter(row=>row.capped).length,failed:0};
  assert.deepEqual(report.summary,summary,'directed summary differs from its case records');
  return {...evidence(filename),matchesCurrentCandidate:true,countsTowardAcceptance:false,
    role:'directed development cases; not unseen complete-game strength acceptance',
    recordHashesVerified:true,independentReplayClaim:report.rows.every(row=>row.verified),report};
}

export async function finalizeUpdate({version=metadata().version,tag=version,endgame=null,acceptance=null,executable='release/军棋暗战-便携版.exe',development='research/development-evidence.json'}={}){
  assert.match(version,/^\d+\.\d+\.\d+$/);assert.match(tag,/^\d+\.\d+(?:\.\d+)?$/);
  const packageMetadata=metadata();assert.equal(packageMetadata.version,version,'unexpected current app version');
  const files=packageFiles(),sources=directoryHashes('dist','','.js');
  const unitLog=`full-tests-${tag}.out`,unitManifest=`full-tests-${tag}.binding.json`;
  const units=parseUnitTotals(readFileSync(absolute(unitLog),'utf8'));
  verifyUnitBinding(read(unitManifest),testsSnapshot(),hash(unitLog),units);
  const asarPath=absolute('release/win-unpacked/resources/app.asar'),asarSha256=hash(asarPath);
  const expected={asarPath,asarSha256,packageFiles:files,packageMetadata};
  const qaLogs=Object.fromEntries(['smoke','reveal','archive','experience','consolidation','features','session-save','early-resign','desktop-ui','board-geometry'].map(name=>[name,`qa-${name}-${tag}.out`]));
  const qa=Object.fromEntries(Object.entries(qaLogs).map(([name,file])=>[name,lastJsonResult(readFileSync(absolute(file),'utf8'))]));
  for(const name of ['smoke','reveal']){
    assert.equal(qa[name].passed,true);assert.equal(qa[name].packaged,true);verifyPackageBinding(qa[name].packageBinding,expected);
  }
  assert.deepEqual(qa.smoke.sourceHashes,sources);assert.equal(qa.smoke.aiSha256,sources['ai.js']);
  for(const key of ['manualPlacement','invalidMineRejected','resume','playingStylePersists','decisionDiagnostics','diagnosticTimingPersists','searchCancellation',
    'enemyHidden','worker','twoDifficulties','completedReplay','replayNavigation','learningPersists','noDuplicateLearning','combatEffects','effectClippedToCell'])assert.equal(qa.smoke[key],true,key);
  assert.equal(qa.smoke.effectDurationMs,500);
  assert.ok(qa.smoke.searchDecisions.length>0&&qa.smoke.searchDecisions.every(d=>d.timeLimitMs===5000&&d.elapsedMs>0&&d.elapsedMs<6500&&d.completedDepth<=d.attemptedDepth));
  assert.ok(qa.smoke.searchDecisions.every(d=>Number.isFinite(d.resignationCheckMs)&&d.resignationCheckMs>=0&&Number.isFinite(d.searchTimeLimitMs)&&d.searchTimeLimitMs>=0&&Math.abs(d.resignationCheckMs+d.searchTimeLimitMs-d.timeLimitMs)<0.02),'current Worker phase timings must survive session and replay persistence');
  assert.ok(qa.smoke.searchDecisions.some(d=>d.completedDepth>=4&&d.searchedNodes>0));
  for(const key of ['legacySaveRestored','explicitEngineerReveal','otherIdentitiesHidden','reloadPersists','battleLog'])assert.equal(qa.reveal[key],true,key);
  assert.equal(qa.reveal.cases.length,8);
  verifyFeatureReport(qa.features,expected);
  verifySessionSaveReport(qa['session-save'],expected);
  for(const kind of ['early-resign','desktop-ui'])verifyExtendedPackageQa(qa[kind],expected,kind);
  const geometrySummary=qa['board-geometry'];
  assert.equal(typeof geometrySummary.reportPath,'string');
  const geometryFile=absolute(geometrySummary.reportPath),geometryReport=read(geometryFile);
  verifyBoardGeometryReport(geometryReport,geometrySummary,expected);
  const bridges={};
  for(const name of ['archive','experience','consolidation']){
    bridges[name]=read(`research/${name}-qa-result.json`);verifyBridgeReport(name,bridges[name],qa[name],expected);
  }
  const executableSha256=hash(executable),portableProof=read('research/portable-proof.json');
  const portableExpected={root,executable:absolute(executable),executableSha256,asarSha256};verifyPortableProof(portableProof,portableExpected);
  // ZIP portable archives are verified through the real hidden launcher. Bind
  // the helper and its output as well as the payload itself to this release.
  for(const name of ['verify-portable-runtime.mjs','portable-runtime-probe.cjs'])
    assert.equal(portableProof.helperFiles?.[name],hash(name),'portable runtime helper changed');
  assert.equal(hash(portableProof.probeReport.file),portableProof.probeReport.sha256,'portable runtime report changed');
  const directed=verifyDirectedEndgame(endgame,sources);
  let formal=null;
  if(acceptance){
    formal=await verifiedBatch(acceptance,'acceptance',20);
  }
  const strength=classifyStrength(formal,sources);
  const backup=`analysis/releases/before-${version}/validation-result.json`;
  const chain=preservePreviousReport(absolute('research/validation-result.json'),absolute(backup),version);
  const history=inheritHistoricalAcceptance(chain.previousReport,{root,previousReleaseReport:chain.previousReleaseReport,currentSourceHashes:sources});
  verifyFreshAcceptance(formal,history.historicalAcceptances);
  const evidenceFiles=[unitLog,unitManifest,...Object.values(qaLogs),...['archive','experience','consolidation'].map(name=>`research/${name}-qa-result.json`),
    'research/portable-proof.json','verify-portable.mjs','verify-portable-runtime.mjs','portable-runtime-probe.cjs',portableProof.probeReport.file,
    'finalize-update.mjs','finalize-self-play.mjs','release-chain.mjs','qa-package-binding.cjs','qa-features.cjs','qa-session-save.cjs','qa-early-resign.cjs','qa-desktop-ui.cjs','qa-board-geometry.cjs',geometryFile,backup];
  if(endgame)evidenceFiles.push(endgame);if(acceptance)evidenceFiles.push(acceptance);
  const report={schema:4,date:new Date().toISOString(),appVersion:version,
    technicalChecksPassed:true,strengthAccepted:strength.strengthAccepted,releaseThresholdMet:strength.strengthAccepted,
    strengthAssessment:strength,sourceHashes:sources,packageMetadata,packageFiles:files,asarSha256,
    executable:evidence(executable),executableSha256,portableProof,unitTests:{...units,sourceBindingVerified:true,manifest:evidence(unitManifest)},
    packagedSmoke:qa.smoke,engineerReveal:qa.reveal,persistenceChecks:{archive:18,experience:8,consolidation:17},
    packageQa:{allFiveExecutedAgainstCurrentAsar:true,requiredQa:Object.keys(qaLogs),allRequiredExecutedAgainstCurrentAsar:true,bridges,features:qa.features,sessionSave:qa['session-save'],earlyResign:qa['early-resign'],desktopUi:qa['desktop-ui'],boardGeometry:{...geometrySummary,report:evidence(geometryFile)}},directedEndgame:directed,
    acceptance:formal?{...formal,...strength,countsTowardAcceptance:strength.matchesCurrentCandidate}:null,
    historicalAcceptances:history.historicalAcceptances,
    previousReleaseReport:chain.previousReleaseReport,developmentEvidence:development?evidence(development):null,evidence:evidenceFiles.map(evidence),limits:[
      'Software checks and directed endgame pressure cases do not establish a 19-of-20 complete-game win rate.',
      'Only a newly verified paired 20-game independent acceptance batch using every current AI module can qualify playing strength; all 20 games must reach genuine terminals and at least 19 must be wins.',
      'Ply caps remain unresolved cases. They are never converted into wins or rule draws.',
      'Directed positions are development evidence and must be excluded from later unseen acceptance selection.',
      'Sampled hidden-information search and static route estimates are approximate; no general guarantee of winning every favourable position is claimed.'
    ]};
  assert.equal(hash(asarPath),asarSha256,'ASAR changed during evidence assembly');verifyPortableProof(portableProof,portableExpected);
  assert.deepEqual(packageFiles(),files,'source changed during evidence assembly');assert.deepEqual(metadata(),packageMetadata);
  verifyUnitBinding(read(unitManifest),testsSnapshot(),hash(unitLog),units);
  report.archiveEvidence=collectReportEvidence(report,root);
  for(const item of report.evidence)assert.equal(hash(item.file),item.sha256,'evidence changed during assembly');
  assertReportUnchanged(absolute('research/validation-result.json'),chain.currentSha256);
  const destination=absolute('research/validation-result.json'),temporary=destination+'.'+randomUUID()+'.tmp';
  writeFileSync(temporary,JSON.stringify(report,null,2)+'\n',{flag:'wx'});renameSync(temporary,destination);
  console.log(JSON.stringify({appVersion:version,tests:units.tests,technicalChecksPassed:true,strengthAccepted:strength.strengthAccepted,
    directedEndgame:directed?.report.summary||null,historicalAcceptances:history.historicalAcceptances.map(item=>({originalRelease:item.originalRelease,summary:item.summary})),sourceHash:sources['ai.js'],executableSha256}));
  return report;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const options={};let runTests=false;
  try{
    for(let i=2;i<process.argv.length;i++){
      const arg=process.argv[i];if(arg==='--run-tests'){runTests=true;continue;}
      assert.ok(['--version','--tag','--endgame','--acceptance','--executable','--development'].includes(arg),`unknown option ${arg}`);
      const value=process.argv[++i];assert.ok(value&&!value.startsWith('--'),`missing value for ${arg}`);options[arg.slice(2)]=value;
    }
    if(runTests)runUpdateTests(options);else await finalizeUpdate(options);
  }catch(error){console.error(error);process.exitCode=1;}
}
