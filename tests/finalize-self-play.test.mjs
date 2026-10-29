import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {parseUnitTotals,verifyPackageBinding,verifyPortableProof} from '../finalize-self-play.mjs';

const names=['tests','pass','fail','cancelled','skipped','todo'];
const totals=(overrides={},prefix='ℹ')=>{
  const counts={tests:197,pass:197,fail:0,cancelled:0,skipped:0,todo:0,...overrides};
  return names.map(name=>`${prefix} ${name} ${counts[name]}`).join('\n')+'\n';
};

test('final evidence parser accepts exactly one complete Node or TAP totals section',()=>{
  for(const prefix of ['ℹ','#','']){
    const parsed=parseUnitTotals('Test output\n'+totals({},prefix)+'duration_ms 400\n');
    assert.equal(parsed.tests,197);assert.equal(parsed.pass,197);assert.equal(parsed.passed,true);
  }
});

test('truncated or concatenated unit output cannot masquerade as completed evidence',()=>{
  const valid=totals();
  for(const name of names){
    const row=valid.split('\n').find(line=>line.startsWith(`ℹ ${name} `));
    assert.throws(()=>parseUnitTotals(valid.replace(row+'\n','')),/one completed test total/);
    assert.throws(()=>parseUnitTotals(valid+row+'\n'),/one completed test total/);
  }
  assert.throws(()=>parseUnitTotals(valid+valid),/one completed test total/);
  assert.throws(()=>parseUnitTotals(''),/one completed test total/);
});

test('failed, cancelled, skipped, pending and empty suites never pass finalization totals',()=>{
  for(const category of ['fail','cancelled','skipped','todo']){
    const parsed=parseUnitTotals(totals({pass:196,[category]:1}));
    assert.equal(parsed.passed,false,category);
    assert.equal(parsed[category],1);
  }
  assert.equal(parseUnitTotals(totals({tests:0,pass:0})).passed,false);
  assert.throws(()=>parseUnitTotals(totals({pass:196})),/197 !== 196/);
});

const expectedPackage={asarPath:path.resolve('release/example.asar'),asarSha256:'1'.repeat(64),
  packageFiles:{'main.cjs':'2'.repeat(64),'dist/app.js':'3'.repeat(64),'dist/style.css':'4'.repeat(64)},
  packageMetadata:{name:'test-game',version:'2.4.0',main:'main.cjs'}};
const packageBinding=()=>({packaged:true,sourceMatched:true,unchanged:true,asarPath:expectedPackage.asarPath,
  asarSha256Before:expectedPackage.asarSha256,asarSha256After:expectedPackage.asarSha256,
  packageFiles:structuredClone(expectedPackage.packageFiles),packageMetadata:structuredClone(expectedPackage.packageMetadata)});

test('final evidence accepts only the exact package executed throughout QA',()=>{
  assert.equal(verifyPackageBinding(packageBinding(),expectedPackage),true);
  assert.throws(()=>verifyPackageBinding(undefined,expectedPackage),/binding is required/);
  for(const [field,value] of [['packaged',false],['sourceMatched',false],['unchanged',false],
    ['asarPath',path.resolve('different.asar')],['asarSha256Before','0'.repeat(64)],['asarSha256After','0'.repeat(64)]]){
    const binding=packageBinding();binding[field]=value;
    assert.throws(()=>verifyPackageBinding(binding,expectedPackage),field);
  }
});

test('final package binding rejects stale, omitted or additional assets and mismatched identity',()=>{
  for(const mutate of [
    value=>value.packageFiles['dist/style.css']='old-css',
    value=>delete value.packageFiles['main.cjs'],
    value=>value.packageFiles['dist/untracked.js']='extra',
    value=>value.packageMetadata.version='2.3.0',
    value=>value.packageMetadata.main='old-main.cjs',
    value=>delete value.packageMetadata.name,
  ]){
    const binding=packageBinding();mutate(binding);
    assert.throws(()=>verifyPackageBinding(binding,expectedPackage));
  }
});

test('portable proof must bind current executable and unchanged extracted payload to the QA archive',t=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'junqi-finalizer-proof-'));
  t.after(()=>{
    const relative=path.relative(os.tmpdir(),root);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));
    rmSync(root,{recursive:true,force:true});
  });
  const sha=text=>createHash('sha256').update(text).digest('hex');
  writeFileSync(path.join(root,'game.exe'),'portable');writeFileSync(path.join(root,'payload.asar'),'payload');
  const expected={root,executable:path.join(root,'game.exe'),executableSha256:sha('portable'),asarSha256:sha('payload')};
  const proof={schema:1,verified:true,executable:'game.exe',executableSha256:expected.executableSha256,
    asarSha256:expected.asarSha256,extractedAsar:'payload.asar'};
  assert.equal(verifyPortableProof(proof,expected),true);
  for(const [field,value] of [['verified',false],['executable','other.exe'],['executableSha256','0'.repeat(64)],['asarSha256','0'.repeat(64)]])
    assert.throws(()=>verifyPortableProof({...proof,[field]:value},expected));
  writeFileSync(path.join(root,'payload.asar'),'swapped payload');
  assert.throws(()=>verifyPortableProof(proof,expected),/extracted payload bytes changed/);
  writeFileSync(path.join(root,'payload.asar'),'payload');writeFileSync(path.join(root,'game.exe'),'swapped executable');
  assert.throws(()=>verifyPortableProof(proof,expected));
});
