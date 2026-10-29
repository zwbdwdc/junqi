import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions, preserveReportChain, inheritHistoricalAcceptance, assertReportUnchanged, collectReportEvidence, sha256 } from '../release-chain.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
function fixture(t) {
  const root = mkdtempSync(path.join(here, 'case-'));
  t.after(() => { const relative = path.relative(here, root); assert.ok(relative.startsWith('case-') && !path.isAbsolute(relative)); rmSync(root, { recursive: true, force: true }); });
  const reportFile = path.join(root, 'report.json'), backupFile = path.join(root, 'archive', 'before-2.4.2.json');
  const write = value => writeFileSync(reportFile, typeof value === 'string' ? value : JSON.stringify(value));
  return { root, reportFile, backupFile, write, prepare: nextVersion => preserveReportChain({ root, reportFile, backupFile, nextVersion }) };
}
function batch(root, name, source = 'old') {
  const value = { sourceHashes: { 'ai.js': source }, summary: { wins: 19, losses: 1, draws: 0, capped: 0 }, strengthAccepted: true, countsTowardAcceptance: true };
  const bytes = Buffer.from(JSON.stringify(value)); writeFileSync(path.join(root, name), bytes);
  return { ...value, file: name, sha256: sha256(bytes) };
}

test('canonical numeric versions allow patch/minor/major advances without lexical ordering or precision loss', () => {
  for (const [a, b] of [['2.4.1', '2.4.2'], ['2.4.9', '2.4.10'], ['2.4.1', '2.5.0'], ['2.9.9', '3.0.0'], ['2.0.9007199254740992', '2.0.9007199254740993']]) assert.equal(compareVersions(a, b), -1);
  for (const bad of ['2.4', '02.4.1', '2.4.1-beta', 'v2.4.1', '../2.4.2', '2.4.2\n', 241]) assert.throws(() => compareVersions(bad, '2.4.1'));
});
test('exact BOM/spacing/newline bytes are backed up once and remain unchanged across pre/post-write retries', t => {
  const f = fixture(t), original = '\uFEFF{ "appVersion": "2.4.1", "acceptance": null }\r\n'; f.write(original);
  const first = f.prepare('2.4.2'); assert.equal(first.retry, false); assert.equal(readFileSync(f.backupFile, 'utf8'), original);
  f.prepare('2.4.2');
  f.write({ appVersion: '2.4.2', previousReleaseReport: first.previousReleaseReport });
  assert.equal(f.prepare('2.4.2').retry, true); assert.equal(readFileSync(f.backupFile, 'utf8'), original);
});
test('same-version report without its original backup and release rollback are refused', t => {
  const f = fixture(t); f.write({ appVersion: '2.4.2' });
  assert.throws(() => f.prepare('2.4.2'), /original predecessor backup/); assert.equal(existsSync(f.backupFile), false);
  assert.throws(() => f.prepare('2.4.1'), /rollback/);
});
test('existing backup mismatch, same-version unlinked backup and tampering all fail without overwriting backup', t => {
  const f = fixture(t); f.write({ appVersion: '2.4.1' }); const first = f.prepare('2.4.2'), bytes = readFileSync(f.backupFile);
  f.write({ appVersion: '2.4.0' }); assert.throws(() => f.prepare('2.4.2'), /differs from actual predecessor/);
  f.write({ appVersion: '2.4.2' }); assert.throws(() => f.prepare('2.4.2'), /no predecessor link/);
  f.write({ appVersion: '2.4.2', previousReleaseReport: { ...first.previousReleaseReport, sha256: '0'.repeat(64) } });
  assert.throws(() => f.prepare('2.4.2'), /bytes do not match/);
  f.write({ appVersion: '2.4.2', previousReleaseReport: { ...first.previousReleaseReport, file: 'wrong.json' } });
  assert.throws(() => f.prepare('2.4.2'), /path does not match/); assert.deepEqual(readFileSync(f.backupFile), bytes);
});
test('version metadata mismatch, same source/backup and stale assembly snapshots are refused', t => {
  const f = fixture(t); f.write({ appVersion: '2.4.1', packageMetadata: { version: '2.4.0' } });
  assert.throws(() => f.prepare('2.4.2'), /version mismatch/);
  f.write({ appVersion: '2.4.1' });
  assert.throws(() => preserveReportChain({ ...f, backupFile: f.reportFile, nextVersion: '2.4.2' }), /must differ/);
  const first = f.prepare('2.4.2'); f.write({ appVersion: '2.4.1', changed: true });
  assert.throws(() => assertReportUnchanged(f.reportFile, first.currentSha256), /changed during assembly/);
});
test('null current acceptance carries older history, preserving result and original origin across further releases', t => {
  const f = fixture(t), old = batch(f.root, 'old.json');
  f.write({ appVersion: '2.4.1', acceptance: null, historicalAcceptance: { ...old, previousRelease: '2.4.0' } });
  const chain = f.prepare('2.4.2'), inherited = inheritHistoricalAcceptance(chain.previousReport,
    { root: f.root, previousReleaseReport: chain.previousReleaseReport, currentSourceHashes: { 'ai.js': 'new' } });
  assert.equal(inherited.acceptance, null); assert.equal(inherited.strengthAccepted, false);
  assert.equal(inherited.historicalAcceptances.length, 1); const carried = inherited.historicalAcceptances[0];
  assert.deepEqual(carried.summary, old.summary); assert.equal(carried.originalRelease, '2.4.0');
  assert.equal(carried.notCurrent, true); assert.equal(carried.countsTowardAcceptance, false); assert.equal(carried.matchesCurrentCandidate, false);
  f.write({ appVersion: '2.4.2', ...inherited, previousReleaseReport: chain.previousReleaseReport });
  const next = preserveReportChain({ ...f, backupFile: path.join(f.root, 'archive', 'before-2.5.0.json'), nextVersion: '2.5.0' });
  const nextHistory = inheritHistoricalAcceptance(next.previousReport, { root: f.root, previousReleaseReport: next.previousReleaseReport, currentSourceHashes: { 'ai.js': 'new' } });
  assert.equal(nextHistory.historicalAcceptances[0].originalRelease, '2.4.0');
  assert.deepEqual(nextHistory.historicalAcceptances[0].firstVerifiedInReport, carried.firstVerifiedInReport);
});
test('previous successful current batch and older history both survive; matching current code never promotes old wins', t => {
  const f = fixture(t), old = batch(f.root, 'old.json'), previous = batch(f.root, 'previous.json', 'same');
  const report = { appVersion: '2.4.1', acceptance: previous, historicalAcceptance: { ...old, previousRelease: '2.4.0' } };
  f.write(report); const chain = f.prepare('2.4.2');
  const carried = inheritHistoricalAcceptance(report, { root: f.root, previousReleaseReport: chain.previousReleaseReport, currentSourceHashes: { 'ai.js': 'same' } });
  assert.equal(carried.historicalAcceptances.length, 2); assert.equal(carried.acceptance, null); assert.equal(carried.strengthAccepted, false);
  assert.equal(carried.historicalAcceptances[0].matchesCurrentCandidate, true);
  for (const entry of carried.historicalAcceptances) { assert.equal(entry.strengthAccepted, false); assert.equal(entry.countsTowardAcceptance, false); }
});
test('missing history is allowed, duplicated historical batch is deduplicated, changed or missing evidence is refused', t => {
  const f = fixture(t); f.write({ appVersion: '2.4.1' }); const chain = f.prepare('2.4.2');
  const options = { root: f.root, previousReleaseReport: chain.previousReleaseReport, currentSourceHashes: {} };
  assert.deepEqual(inheritHistoricalAcceptance(chain.previousReport, options).historicalAcceptances, []);
  const old = { ...batch(f.root, 'old.json'), previousRelease: '2.4.0' };
  const report = { appVersion: '2.4.1', historicalAcceptance: old, historicalAcceptances: [old] };
  assert.equal(inheritHistoricalAcceptance(report, options).historicalAcceptances.length, 1);
  writeFileSync(path.join(f.root, 'old.json'), 'changed'); assert.throws(() => inheritHistoricalAcceptance(report, options), /bytes changed/);
  assert.throws(() => inheritHistoricalAcceptance({ ...report, historicalAcceptance: { ...old, file: '../outside.json' } }, options), /inside evidence root/);
});
test('archive closure follows a future-version directed report and includes its exact records and source snapshot', t => {
  const f = fixture(t), dir = path.join(f.root, 'future-3.7.9'); mkdirSync(dir);
  const write = (file, value) => { const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)); writeFileSync(path.join(f.root, file), bytes); return { file, sha256: sha256(bytes) }; };
  const record = write('future-3.7.9/game.json', { result: 'test' }), source = write('future-3.7.9/ai.js', 'fixture');
  const directedReport = { protocol: { sourceRoot: dir, sourceHashes: { 'ai.js': source.sha256 } }, rows: [{ recordPath: record.file, recordSha256: record.sha256 }] };
  const directed = { ...write('continuation-3.7.9.json', directedReport), report: directedReport };
  const report = { evidence: [directed], directedEndgame: directed };
  const files = collectReportEvidence(report, f.root).map(item => item.file);
  assert.deepEqual(files, ['continuation-3.7.9.json', 'future-3.7.9/ai.js', 'future-3.7.9/game.json']);
  report.directedEndgame = { ...directed, report: { ...directedReport, modified: true } };
  assert.throws(() => collectReportEvidence(report, f.root), /embedded report differs/);
  report.directedEndgame = directed; writeFileSync(path.join(f.root, record.file), 'modified');
  assert.throws(() => collectReportEvidence(report, f.root), /evidence bytes changed/);
});

test('explicit development manifest retains failed candidates and rejects altered bytes', t => {
  const f=fixture(t), bytes=Buffer.from('failed candidate evidence');
  writeFileSync(path.join(f.root,'failure.json'),bytes);
  const manifest=Buffer.from(JSON.stringify({schema:1,files:[{file:'failure.json',sha256:sha256(bytes)}]}));
  writeFileSync(path.join(f.root,'development.json'),manifest);
  const report={developmentEvidence:{file:'development.json',sha256:sha256(manifest)}};
  assert.deepEqual(collectReportEvidence(report,f.root).map(item=>item.file),['development.json','failure.json']);
  writeFileSync(path.join(f.root,'failure.json'),'rewritten');
  assert.throws(()=>collectReportEvidence(report,f.root),/evidence bytes changed/);
});
