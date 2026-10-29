// Final evidence assembly. A valid report may say strengthAccepted=false;
// engineering checks and the user's playing-strength threshold are separate.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyPart,scoreBatch,validatePlan} from './benchmarks/self-play-batch.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const read=name=>JSON.parse(readFileSync(path.resolve(root,name),'utf8').replace(/^\uFEFF/,''));
const hash=name=>createHash('sha256').update(readFileSync(path.resolve(root,name))).digest('hex');
const result=name=>JSON.parse(readFileSync(path.resolve(root,name),'utf8').replace(/^\uFEFF/,'').trim().split(/\r?\n/).filter(line=>line.startsWith('{')).at(-1));
const evidence=name=>({file:name,sha256:hash(name)});
function distribution(values){
  const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);
  return sorted.length?{count:sorted.length,min:sorted[0],median:sorted[Math.floor(sorted.length*.5)],
    p95:sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))],max:sorted.at(-1),
    mean:sorted.reduce((sum,value)=>sum+value,0)/sorted.length}:null;
}
function searchSummary(records){
  const rows=records.flatMap(record=>record.decisions),result={};
  for(const policy of ['challenger','opponent']){
    const decisions=rows.filter(row=>row.policy===policy);
    result[policy]={moves:decisions.length,elapsedMs:distribution(decisions.map(row=>row.elapsedMs)),
      completedDepth:distribution(decisions.map(row=>row.info.diagnostics?.completedDepth)),
      searchedNodes:distribution(decisions.map(row=>row.info.searchedNodes)),
      depthCounts:decisions.reduce((counts,row)=>{const depth=row.info.diagnostics?.completedDepth??'unreported';counts[depth]=(counts[depth]||0)+1;return counts;},{})};
  }
  return result;
}

export function parseUnitTotals(text){
  const counts={};
  for(const name of ['tests','pass','fail','cancelled','skipped','todo']){
    const rows=[...text.matchAll(new RegExp('^\\s*(?:ℹ|#)?\\s*'+name+'\\s+(\\d+)\\s*$','gm'))];
    assert.equal(rows.length,1,`one completed test total required: ${name}`);counts[name]=Number(rows[0][1]);
  }
  assert.equal(counts.tests,counts.pass+counts.fail+counts.cancelled+counts.skipped+counts.todo);
  return {...counts,passed:counts.tests>0&&counts.tests===counts.pass};
}

function moduleHashes(directory,prefix=''){
  const values={};
  for(const entry of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
    if(entry.isDirectory())Object.assign(values,moduleHashes(path.join(directory,entry.name),prefix+entry.name+'/'));
    else if(entry.isFile()&&entry.name.endsWith('.js'))values[prefix+entry.name]=hash(path.join(directory,entry.name));
  }
  return values;
}

function packageSourceFiles(directory,prefix='dist/'){
  const values={};
  for(const entry of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
    const name=prefix+entry.name,filename=path.join(directory,entry.name);
    if(entry.isDirectory())Object.assign(values,packageSourceFiles(filename,name+'/'));
    else {assert.ok(entry.isFile(),`unexpected source entry: ${name}`);values[name]=hash(filename);}
  }
  if(prefix==='dist/')for(const name of ['main.cjs','preload.cjs','storage.cjs','archive-store.cjs','diagnostics-store.cjs'])values[name]=hash(name);
  return values;
}

export function verifyPackageBinding(binding,expected){
  assert.ok(binding&&typeof binding==='object','package execution binding is required');
  assert.equal(binding.packaged,true,'source-only QA cannot qualify the desktop package');
  assert.equal(binding.sourceMatched,true);assert.equal(binding.unchanged,true);
  assert.equal(typeof binding.asarPath,'string');
  assert.equal(path.resolve(binding.asarPath),path.resolve(expected.asarPath),'QA must execute the package being reported');
  assert.equal(binding.asarSha256Before,expected.asarSha256,'QA began on a different package');
  assert.equal(binding.asarSha256After,expected.asarSha256,'QA ended on a different package');
  assert.deepEqual(binding.packageFiles,expected.packageFiles,'every renderer asset and privileged module must match current source');
  assert.deepEqual(binding.packageMetadata,expected.packageMetadata,'package identity must match current source');
  return true;
}

export function verifyPortableProof(proof,expected){
  assert.equal(proof?.schema,1);assert.equal(proof.verified,true,'portable payload must be independently extracted and verified');
  assert.equal(typeof proof.executable,'string');assert.equal(typeof proof.extractedAsar,'string');
  assert.equal(path.resolve(expected.root,proof.executable),path.resolve(expected.executable));
  assert.equal(proof.executableSha256,expected.executableSha256,'portable proof is for a different executable');
  assert.equal(proof.asarSha256,expected.asarSha256,'portable payload differs from the executed QA package');
  assert.equal(hash(path.resolve(expected.root,proof.executable)),proof.executableSha256);
  assert.equal(hash(path.resolve(expected.root,proof.extractedAsar)),proof.asarSha256,'extracted payload bytes changed');
  return true;
}

export async function verifiedBatch(filename,expectedMode,expectedGames){
  const batch=read(filename),plan=read(batch.plan);validatePlan(plan);
  assert.equal(plan.config.mode,expectedMode);assert.equal(plan.config.opponent,'professional');
  assert.equal(plan.config.games,expectedGames);assert.equal(plan.config.paired,true);
  assert.equal(batch.verified,true,'batch must have completed its independent verification');
  assert.equal(batch.summary.complete,true,'all paired games must finish or reach their recorded cap');
  assert.deepEqual(batch.failures,[]);
  assert.equal(hash('benchmarks/self-play-batch.mjs'),plan.aggregatorSha256);
  for(const item of plan.exclusions)assert.equal(hash(item.file),item.sha256,'exclusion snapshot changed');
  const reports=[],records=[];
  for(const part of plan.parts){
    const verified=await verifyPart(plan,part,read(part.output));reports.push(verified);
    const partRecords=[];
    for(const game of verified.games){
      const recordFile=path.join(part.output.replace(/\.json$/i,'.games'),game.id+'.json');
      const bytes=readFileSync(recordFile);
      assert.equal(createHash('sha256').update(bytes).digest('hex'),game.recordSha256);
      const record=JSON.parse(bytes);partRecords.push(record);records.push(record);
      assert.equal(game.reason,record.game.result?.reason||(record.winner==='capped'?'evaluation-ply-cap':null));
    }
    assert.deepEqual(verified.search,searchSummary(partRecords),'search summaries must match verified raw decisions');
  }
  const score=scoreBatch(plan,reports);assert.deepEqual(batch.summary,score);
  assert.deepEqual(batch.sourceHashes,plan.sourceHashes);
  return {file:filename,sha256:hash(filename),sourceHashes:batch.sourceHashes,
    protocol:{mode:plan.config.mode,opponent:plan.config.opponent,games:plan.config.games,paired:plan.config.paired,
      maxPlies:plan.config.maxPlies,seeds:plan.config.seeds,budgets:{hell:5000,professional:900}},
    summary:score,allReplaysVerified:true,
    games:records.map(record=>({seed:record.descriptor.seed,hellSide:record.descriptor.challengerSide,
      outcome:record.winner,plies:record.game.ply,reason:record.game.result?.reason||(record.winner==='capped'?'evaluation-ply-cap':null),terminal:record.terminal})),
    timing:searchSummary(records)};
}

export async function finalize(){
  const units=parseUnitTotals(readFileSync(path.join(root,'full-tests-fast.out'),'utf8'));
  assert.ok(units.tests>=210&&units.passed,'complete current regression checks must pass');
  const finalEvidenceUnits=parseUnitTotals(readFileSync(path.join(root,'final-evidence-unit.out'),'utf8'));
  assert.ok(finalEvidenceUnits.tests===9&&finalEvidenceUnits.passed,'final evidence checks must all pass');
  const smoke=result('qa-smoke-fast.out'),reveal=result('qa-reveal-fast.out');
  assert.equal(smoke.passed,true);assert.equal(smoke.packaged,true);
  assert.equal(reveal.passed,true);assert.equal(reveal.packaged,true);
  const sources=moduleHashes(path.join(root,'dist'));
  assert.deepEqual(smoke.sourceHashes,sources,'the packaged smoke must match every current JS module');
  assert.equal(smoke.searchCancellation,true);assert.equal(smoke.decisionDiagnostics,true);
  assert.ok(smoke.searchDecisions.length&&smoke.searchDecisions.every(d=>d.timeLimitMs===5000&&d.elapsedMs>0&&d.elapsedMs<6500&&d.completedDepth<=d.attemptedDepth));
  assert.ok(smoke.searchDecisions.some(d=>d.completedDepth>=4&&d.searchedNodes>0));
  const bridges=['archive','experience','consolidation'].map(name=>read(`research/${name}-qa-result.json`));
  assert.ok(bridges.every(item=>item.ok));assert.deepEqual(bridges.map(item=>item.checks),[18,8,17]);
  const packageMetadata=Object.fromEntries(['name','version','main'].map(key=>[key,read('package.json')[key]]));
  const packageFiles=packageSourceFiles(path.join(root,'dist'));
  const asarPath=path.join(root,'release/win-unpacked/resources/app.asar'),asarSha256=hash(asarPath);
  const expectedPackage={asarPath,asarSha256,packageFiles,packageMetadata};
  for(const report of [smoke,reveal,...bridges])verifyPackageBinding(report.packageBinding,expectedPackage);
  for(const [index,bridge] of bridges.entries()){
    assert.ok(Array.isArray(bridge.results));
    if(index===1){
      assert.equal(bridge.results.length,bridge.checks);assert.ok(bridge.results.every(check=>check.ok===true));
    }else{
      assert.deepEqual(bridge.results.map(phase=>phase.phase),['write','read']);
      for(const phase of bridge.results){
        assert.equal(phase.ok,true);verifyPackageBinding(phase.packageBinding,expectedPackage);
        assert.ok(Array.isArray(phase.checks)&&phase.checks.every(check=>check.ok===true));
      }
      assert.equal(bridge.results.reduce((sum,phase)=>sum+phase.checks.length,0),bridge.checks);
    }
  }
  const executable=path.join(root,'release/军棋暗战-便携版.exe'),executableSha256=hash(executable);
  const portableProof=read('research/portable-proof.json');
  const expectedPortable={root,executable,executableSha256,asarSha256};
  verifyPortableProof(portableProof,expectedPortable);
  const formal=await verifiedBatch('benchmarks/self-play-acceptance-01.json','acceptance',20);
  const development=await verifiedBatch('benchmarks/self-play-mobility-305.json','training',4);
  const control=await verifiedBatch('benchmarks/self-play-mobility-306.json','training',4);
  const experiment=await verifiedBatch('benchmarks/self-play-recapture-306.json','training',4);
  assert.deepEqual(control.protocol,experiment.protocol,'the experimental comparison must use the same complete seed plan and budgets');
  for(const [name,value] of Object.entries(control.sourceHashes))
    if(name!=='ai.js')assert.equal(experiment.sourceHashes[name],value,'comparison rules, formations and inference must be identical');
  const interruptionRoot='analysis/2026-10-13/recapture306-interrupted-at178/';
  const interrupted=read(interruptionRoot+'00001.json');
  const resumed=read('benchmarks/self-play-recapture-306.parts/1-306001.games/00001.json');
  assert.equal(interrupted.game.ply,178);assert.deepEqual(interrupted.failures,[]);
  assert.deepEqual(resumed.descriptor,interrupted.descriptor);assert.deepEqual(resumed.contexts,interrupted.contexts);
  assert.deepEqual(resumed.game.initial,interrupted.game.initial);assert.deepEqual(resumed.game.rules,interrupted.game.rules);
  assert.deepEqual(resumed.decisions.slice(0,interrupted.decisions.length),interrupted.decisions,'resume must preserve every completed decision');
  assert.deepEqual(resumed.game.history.slice(0,interrupted.game.history.length),interrupted.game.history);
  const failedBatch=read(interruptionRoot+'self-play-recapture-306.json');
  assert.ok(failedBatch.failures.some(item=>item.seed===306001&&item.exitCode===1));
  assert.ok(readFileSync(path.join(root,interruptionRoot+'console.out'),'utf8').includes('Error: EPERM: operation not permitted, rename'));
  const matchesCurrent=batch=>Object.entries(sources).every(([name,value])=>batch.sourceHashes[name]===value)&&
    Object.keys(batch.sourceHashes).filter(name=>name!=='harness').length===Object.keys(sources).length;
  const auditRoot='analysis/2026-10-13/performance-audit/';
  const optimizationManifest=read(auditRoot+'manifest.json');
  for(const [name,value] of Object.entries(optimizationManifest))assert.equal(hash(auditRoot+name),value,'optimization evidence changed');
  assert.equal(sources['ai.js'],optimizationManifest['candidate/dist/ai.js']);
  assert.equal(development.sourceHashes['ai.js'],optimizationManifest['baseline/ai.js']);
  assert.deepEqual(development.sourceHashes,control.sourceHashes);
  for(const [name,value] of Object.entries(sources))
    if(name!=='ai.js')assert.equal(development.sourceHashes[name],value,'only the equivalent move-existence helper may differ from the tested development source');
  const equivalence=read(auditRoot+'exists-equivalence.json'),boundaries=read(auditRoot+'exists-boundaries.json');
  assert.equal(equivalence.allRailEdgesAreRoadEdges,true);assert.equal(boundaries.allRailEdgesAreRoadEdges,true);
  assert.ok(boundaries.comparisons>=329278&&boundaries.legalStates>=1200);
  assert.equal(equivalence.results.length,2);
  for(const sample of equivalence.results){
    assert.deepEqual(sample.baseline,sample.candidate,'fixed-depth optimization decisions must be completely identical');
    assert.ok(sample.baselineMs>0&&sample.candidateMs>0);
  }
  const strengthAccepted=matchesCurrent(formal)&&formal.summary.passed;
  const report={schema:2,date:new Date().toISOString(),appVersion:read('package.json').version,
    technicalChecksPassed:true,strengthAccepted,releaseThresholdMet:strengthAccepted,
    sourceHashes:sources,asarSha256,packageFiles,packageMetadata,
    executableSha256,portableProof,
    unitTests:units,finalEvidenceTests:finalEvidenceUnits,packagedSmoke:smoke,engineerReveal:reveal,
    persistenceChecks:{archive:18,experience:8,consolidation:17},
    acceptance:{...formal,matchesCurrentCandidate:matchesCurrent(formal)},
    development:{...development,matchesCurrentCandidate:matchesCurrent(development),countsTowardAcceptance:false},
    pairedExperiment:{control,experiment,countsTowardAcceptance:false,merged:false,
      recovery:{seed:306001,savedPly:178,reason:'EPERM while atomically replacing the progress summary; exact locking cause unknown',
        oldDecisionsPreserved:true,originalFailure:evidence(interruptionRoot+'self-play-recapture-306.json'),
        originalRecord:evidence(interruptionRoot+'00001.json'),originalLog:evidence(interruptionRoot+'console.out'),
        resumedLog:evidence('analysis/2026-10-13/self-play-recapture-306-resume.out')},
      reason:'The experimental recapture model underestimated an opponent choosing between correlated private piece identities. The frozen experiment is retained, regardless of its score. A conservative revision was tested separately but did not establish better real-game decisions.'},
    optimization:{comparisons:boundaries.comparisons,legalStates:boundaries.legalStates,
      baseAiSha256:development.sourceHashes['ai.js'],currentAiSha256:sources['ai.js'],
      timings:equivalence.results.map(sample=>({seed:sample.seed,ply:sample.ply,depth:4,
        identicalDecisionAndNodeCounts:true,baselineMs:sample.baselineMs,candidateMs:sample.candidateMs,
        reductionPercent:100*(1-sample.candidateMs/sample.baselineMs)})),
      currentTimedGameStrengthVerified:false,
      note:'The move-existence predicate is equivalent on valid boards. A wall-clock-limited search may now finish a deeper iteration and choose another move. Prior full-game results are not relabeled as current-version strength evidence.'},
    previousTestFindings:{originalRun:evidence('full-tests-acceptance01.out'),
      originalTotals:parseUnitTotals(readFileSync(path.join(root,'full-tests-acceptance01.out'),'utf8')),
      explanation:'Two older tests required a unique exchange or a three-turn probe in a complex board. Independent public replay found a valid second threat and a four-turn supported probe. Tests now check those tactical properties at fixed depth; the original failures remain in the evidence.'},
    evidence:['full-tests-fast.out','final-evidence-unit.out','qa-smoke-fast.out','qa-reveal-fast.out',
      'research/archive-qa-result.json','research/experience-qa-result.json','research/consolidation-qa-result.json',
      'research/portable-proof.json','verify-portable.mjs','finalize-self-play.mjs','qa-package-binding.cjs',
      auditRoot+'manifest.json',auditRoot+'exists-equivalence.json',auditRoot+'exists-boundaries.json',
      'analysis/2026-10-13/recapture-correlated-counterattack.json',
      'analysis/2026-10-13/recapture306-comparison-final.json',
      'analysis/2026-10-13/candidate-2.4-recapture-worst/review-summary.json'].map(evidence),
    limits:[
      'Passing software checks does not establish the requested playing strength. Only a complete untouched 20-game acceptance batch with at least 19 wins can pass it.',
      'Ply caps remain unresolved. They are neither wins nor rule draws, and all games are retained.',
      'Development positions and seeds are excluded from any subsequent acceptance batch; development wins never replace failed acceptance games.',
      'The AI uses sampled public-information hypotheses and bounded search. Strategic cooperation, avoiding repeated quiet play, and opponent modeling remain approximate.',
      'These self-play runs use isolated synthetic records and no user learning profile. Postgame learning in the app adjusts bounded aggregate preferences, not a trained general strategy model.'
    ]};
  assert.equal(hash(asarPath),asarSha256,'package changed during final verification');
  verifyPortableProof(portableProof,expectedPortable);
  assert.deepEqual(packageSourceFiles(path.join(root,'dist')),packageFiles,'source changed during final verification');
  assert.deepEqual(Object.fromEntries(['name','version','main'].map(key=>[key,read('package.json')[key]])),packageMetadata);
  writeFileSync(path.join(root,'research/validation-result.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({tests:units.tests,technicalChecksPassed:true,strengthAccepted,
    acceptance:formal.summary,development:development.summary,sourceHash:sources['ai.js']}));
  return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))finalize().catch(error=>{console.error(error);process.exitCode=1;});
