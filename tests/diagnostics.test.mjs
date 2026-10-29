import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const { createDiagnosticsStore } = createRequire(import.meta.url)('../diagnostics-store.cjs');

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'junqi-diagnostics-'));
  t.after(() => fs.rm(directory,{recursive:true,force:true}));
  return { directory, store:createDiagnosticsStore({directory,...options}) };
}
test('diagnostics retain bounded versions and learning status across store restarts without private game fields',async t=>{
  const {directory,store}=await fixture(t,{maxEntries:4});
  const launch={launchId:'synthetic-launch',appVersion:'2.3.0',electronVersion:'44.5.1'};
  await store.append({...launch,event:'startup',executable:'C:\\test\\game.exe',portableExecutable:'C:\\test\\portable.exe',
    board:[{type:'bomb'}],gameId:'private-game-identifier',stack:'private-stack'});
  await Promise.all(Array.from({length:6},(_,index)=>store.append({...launch,event:'experience-review',
    before:index,after:index+1,learned:1,ok:true,profile:{weights:{attack:1}},history:['private-history']})));
  await store.waitForIdle();
  const first=JSON.parse(await fs.readFile(store.file,'utf8'));
  assert.equal(first.schema,1);assert.equal(first.entries.length,4);
  assert.deepEqual(first.entries.map(e=>e.after),[3,4,5,6]);
  const restarted=createDiagnosticsStore({directory,maxEntries:4});
  await restarted.append({...launch,event:'experience-review',ok:false,error:'synthetic-write-failure'});
  const second=JSON.parse(await fs.readFile(store.file,'utf8'));
  assert.equal(second.entries.length,4);assert.equal(second.entries.at(-1).error,'synthetic-write-failure');
  assert.equal(second.entries.at(-1).appVersion,'2.3.0');
  const text=JSON.stringify(second);
  for(const secret of ['board','history','weights','private-game-identifier','stack'])assert.equal(text.includes(secret),false);
});
test('damaged or oversized diagnostics are replaceable and logging failures do not throw',async t=>{
  const {directory,store}=await fixture(t,{maxBytes:2048});
  await fs.writeFile(store.file,'broken-json');
  assert.equal((await store.append({event:'startup',appVersion:'2.3.0'})).ok,true);
  await fs.writeFile(store.file,'x'.repeat(3000));
  assert.equal((await store.append({event:'experience-review',ok:false,error:'x'.repeat(5000)})).ok,true);
  const saved=JSON.parse(await fs.readFile(store.file,'utf8'));
  assert.equal(saved.entries.length,1);assert.equal(saved.entries[0].error.length,600);
  const blocker=path.join(directory,'file-not-directory');await fs.writeFile(blocker,'x');
  const blocked=createDiagnosticsStore({directory:blocker});
  assert.equal((await blocked.append({event:'startup'})).ok,false);
  assert.equal((await store.append({event:'unknown',board:[]})).ok,false);
});
