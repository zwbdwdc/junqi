// Test-only evidence binding. Never included in the shipped application.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const rawFs = process.versions.electron ? require('original-fs') : fs;
const critical = ['main.cjs','preload.cjs','storage.cjs','archive-store.cjs','diagnostics-store.cjs'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function files(root) {
  const hashes = {};
  const visit = (directory,prefix) => {
    for(const entry of fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
      const name=prefix+entry.name,filename=path.join(directory,entry.name);
      if(entry.isDirectory())visit(filename,name+'/');
      else {assert.ok(entry.isFile(),`unexpected package entry: ${name}`);hashes[name]=sha(fs.readFileSync(filename));}
    }
  };
  visit(path.join(root,'dist'),'dist/');
  for(const name of critical)hashes[name]=sha(fs.readFileSync(path.join(root,name)));
  return hashes;
}
function metadata(root) {
  const value=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  return Object.fromEntries(['name','version','main'].map(key=>{
    assert.equal(typeof value[key],'string',`missing package metadata: ${key}`);return [key,value[key]];
  }));
}
function beginPackageBinding(sourceRoot=__dirname) {
  const asarPath=process.env.JUNQI_QA_ASAR?path.resolve(process.env.JUNQI_QA_ASAR):null;
  const appRoot=asarPath||sourceRoot;
  const capture=()=>({packageFiles:files(appRoot),packageMetadata:metadata(appRoot),
    asarSha256:asarPath?sha(rawFs.readFileSync(asarPath)):null});
  const verifySource=snapshot=>{
    assert.deepEqual(snapshot.packageFiles,files(sourceRoot),'executed package files must match current source files');
    assert.deepEqual(snapshot.packageMetadata,metadata(sourceRoot),'executed package metadata must match source metadata');
  };
  const before=capture();verifySource(before);
  if(process.env.JUNQI_QA_EXPECTED_ASAR_SHA256)
    assert.equal(before.asarSha256,process.env.JUNQI_QA_EXPECTED_ASAR_SHA256,'child must execute the parent package');
  return {
    childEnv:{...process.env,...(asarPath?{JUNQI_QA_ASAR:asarPath,JUNQI_QA_EXPECTED_ASAR_SHA256:before.asarSha256}:{})},
    finish(){
      const after=capture();verifySource(after);
      assert.deepEqual(after,before,'executed package must remain unchanged throughout QA');
      return {packaged:!!asarPath,asarPath,asarSha256Before:before.asarSha256,asarSha256After:after.asarSha256,
        packageFiles:after.packageFiles,packageMetadata:after.packageMetadata,sourceMatched:true,unchanged:true};
    },
  };
}
module.exports={beginPackageBinding};
