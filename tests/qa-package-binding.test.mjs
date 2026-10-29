import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
const {beginPackageBinding}=createRequire(import.meta.url)('../qa-package-binding.cjs');
const critical=['main.cjs','preload.cjs','storage.cjs','archive-store.cjs','diagnostics-store.cjs'];
function fixture(t){
  const root=mkdtempSync(path.join(os.tmpdir(),'junqi-package-binding-'));
  t.after(()=>{
    const relative=path.relative(os.tmpdir(),root);
    assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));
    rmSync(root,{recursive:true,force:true});
  });
  mkdirSync(path.join(root,'dist','assets'),{recursive:true});
  for(const name of critical)writeFileSync(path.join(root,name),name);
  for(const [name,data] of [['app.js','js'],['index.html','html'],['style.css','css'],['assets/icon.svg','svg']])
    writeFileSync(path.join(root,'dist',name),data);
  writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'test-game',version:'2.4.0',main:'main.cjs',devDependencies:{example:'1'}}));
  return root;
}
test('QA binding inventories all renderer assets and privileged files without claiming a source run was packaged',t=>{
  const root=fixture(t),binding=beginPackageBinding(root).finish();
  assert.equal(binding.packaged,false);assert.equal(binding.asarPath,null);assert.equal(binding.asarSha256Before,null);
  assert.equal(binding.asarSha256After,null);assert.equal(binding.sourceMatched,true);assert.equal(binding.unchanged,true);
  assert.deepEqual(binding.packageMetadata,{name:'test-game',version:'2.4.0',main:'main.cjs'});
  assert.deepEqual(Object.keys(binding.packageFiles).sort(),[...critical,'dist/app.js','dist/index.html','dist/style.css','dist/assets/icon.svg'].sort());
  assert.equal(binding.packageFiles['dist/style.css'],createHash('sha256').update('css').digest('hex'));
});
test('QA binding rejects package or critical source changes during execution',t=>{
  for(const name of ['dist/style.css','preload.cjs','diagnostics-store.cjs','dist/assets/icon.svg']){
    const root=fixture(t),audit=beginPackageBinding(root);
    writeFileSync(path.join(root,name),'changed while QA was running');
    assert.throws(()=>audit.finish(),/unchanged throughout QA/,name);
  }
  const root=fixture(t),audit=beginPackageBinding(root);
  writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'test-game',version:'2.5.0',main:'main.cjs'}));
  assert.throws(()=>audit.finish(),/unchanged throughout QA/);
});
test('QA binding rejects missing required package identity',t=>{
  const root=fixture(t);
  writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'test-game',main:'main.cjs'}));
  assert.throws(()=>beginPackageBinding(root),/missing package metadata: version/);
});
