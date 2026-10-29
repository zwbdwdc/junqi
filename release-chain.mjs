// Version-independent preservation and explicit archive evidence closure.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function parseVersion(version) {
  assert.equal(typeof version, 'string', 'version must be a string');
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'expected canonical major.minor.patch');
  return version.split('.').map(BigInt);
}
export function compareVersions(a, b) {
  const left = parseVersion(a), right = parseVersion(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}
function parseReport(bytes) {
  const report = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  assert.ok(report && typeof report === 'object' && !Array.isArray(report), 'invalid report');
  parseVersion(report.appVersion);
  if (report.packageMetadata) assert.equal(report.packageMetadata.version, report.appVersion, 'report/package version mismatch');
  return report;
}
function readRegular(file) {
  assert.ok(lstatSync(file).isFile(), 'evidence must be a regular file');
  return readFileSync(file);
}
function samePath(a, b) {
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(a) === normalize(b);
}
export function assertReportUnchanged(reportFile, expectedSha256) {
  assert.equal(sha256(readRegular(reportFile)), expectedSha256, 'current report changed during assembly');
}

/** Save exact previous bytes once. A retry must refer to the same predecessor;
 * finding just any older report is insufficient. Call assertReportUnchanged
 * immediately before the existing finalizer's atomic report replacement. */
export function preserveReportChain({ root, reportFile, backupFile, nextVersion }) {
  parseVersion(nextVersion);
  root = path.resolve(root); reportFile = path.resolve(root, reportFile); backupFile = path.resolve(root, backupFile);
  assert.ok(!samePath(reportFile, backupFile), 'backup and current report must differ');
  const currentBytes = readRegular(reportFile), current = parseReport(currentBytes);
  const currentSha256 = sha256(currentBytes), order = compareVersions(current.appVersion, nextVersion);
  assert.ok(order <= 0, 'release version rollback refused');
  if (!existsSync(backupFile)) {
    assert.ok(order < 0, 'same-version retry requires original predecessor backup');
    mkdirSync(path.dirname(backupFile), { recursive: true });
    writeFileSync(backupFile, currentBytes, { flag: 'wx' });
  }
  const previousBytes = readRegular(backupFile), previousReport = parseReport(previousBytes);
  const previousSha256 = sha256(previousBytes);
  assert.ok(compareVersions(previousReport.appVersion, nextVersion) < 0, 'backup must predate target version');
  if (order < 0) {
    assert.equal(previousSha256, currentSha256, 'existing backup differs from actual predecessor; refusing overwrite');
  } else {
    const reference = current.previousReleaseReport;
    assert.ok(reference && typeof reference.file === 'string', 'same-version report has no predecessor link');
    assert.equal(reference.sha256, previousSha256, 'same-version predecessor bytes do not match');
    assert.ok(samePath(path.resolve(root, reference.file), backupFile), 'same-version predecessor path does not match');
    if (reference.appVersion) assert.equal(reference.appVersion, previousReport.appVersion);
  }
  assertReportUnchanged(reportFile, currentSha256);
  return { previousReport, currentSha256, retry: order === 0,
    previousReleaseReport: { file: path.relative(root, backupFile).replaceAll('\\', '/'),
      sha256: previousSha256, appVersion: previousReport.appVersion } };
}

function sourcesMatch(a, b) {
  if (!a || !b) return false;
  const names = Object.keys(a).filter(name => name !== 'harness').sort();
  return JSON.stringify(names) === JSON.stringify(Object.keys(b).sort()) && names.every(name => a[name] === b[name]);
}
function evidencePath(root, file) {
  assert.equal(typeof file, 'string');
  const resolved = path.resolve(root, file), relative = path.relative(root, resolved);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'historical evidence must stay inside evidence root');
  return resolved;
}

/** Preserve every old batch, including a previous current batch and older
 * history. A byte-verified inherited batch NEVER supplies current acceptance,
 * even when a UI-only update leaves all AI source hashes identical. */
export function inheritHistoricalAcceptance(previous, { root, previousReleaseReport, currentSourceHashes }) {
  parseVersion(previous.appVersion);
  assert.equal(previousReleaseReport.appVersion, previous.appVersion);
  const candidates = [];
  if (previous.acceptance != null) candidates.push({ entry: previous.acceptance, origin: previous.appVersion });
  if (previous.historicalAcceptance != null) candidates.push({ entry: previous.historicalAcceptance });
  if (previous.historicalAcceptances != null) {
    assert.ok(Array.isArray(previous.historicalAcceptances), 'historicalAcceptances must be an array');
    for (const entry of previous.historicalAcceptances) candidates.push({ entry });
  }
  const seen = new Set(), historicalAcceptances = [];
  for (const { entry, origin } of candidates) {
    assert.ok(entry && typeof entry === 'object', 'invalid historical acceptance');
    assert.match(entry.sha256 || '', /^[a-f0-9]{64}$/, 'historical batch hash missing');
    const file = evidencePath(root, entry.file);
    assert.equal(sha256(readRegular(file)), entry.sha256, 'historical batch bytes changed');
    assert.ok(entry.sourceHashes && entry.summary, 'historical batch provenance missing');
    // Hash identifies the batch even if an identical file was copied or renamed.
    if (seen.has(entry.sha256)) continue;
    seen.add(entry.sha256);
    const originalRelease = origin || entry.originalRelease || entry.previousRelease;
    assert.ok(originalRelease, 'historical origin version missing');
    assert.ok(compareVersions(originalRelease, previous.appVersion) <= 0, 'historical origin is newer than its report');
    historicalAcceptances.push({ ...structuredClone(entry),
      file: path.relative(root, file).replaceAll('\\', '/'), originalRelease,
      historical: true, notCurrent: true, countsTowardAcceptance: false, strengthAccepted: false,
      matchesCurrentCandidate: sourcesMatch(entry.sourceHashes, currentSourceHashes),
      firstVerifiedInReport: entry.firstVerifiedInReport || entry.verifiedInPreviousReport || previousReleaseReport,
      carriedFromReport: previousReleaseReport,
      note: 'Inherited historical batch; its original results are retained and do not establish current-version strength.' });
  }
  return { acceptance: null, historicalAcceptances, strengthAccepted: false,
    strengthAssessment: { strengthAccepted: false, reason: 'no-new-independent-acceptance' } };
}

/** Explicit evidence closure for the archive script. No version/date glob and
 * no directory scan that could accidentally collect player profile backups. */
export function collectReportEvidence(report, root) {
  root = path.resolve(root); const entries = new Map();
  const add = item => {
    assert.ok(item && typeof item === 'object', 'invalid evidence reference');
    assert.match(item.sha256 || '', /^[a-f0-9]{64}$/, 'evidence hash missing');
    const file = evidencePath(root, item.file), name = path.relative(root, file).replaceAll('\\', '/');
    assert.equal(sha256(readRegular(file)), item.sha256, `evidence bytes changed: ${name}`);
    if (entries.has(name)) assert.equal(entries.get(name).sha256, item.sha256, 'conflicting evidence reference');
    entries.set(name, { file: name, sha256: item.sha256 });
  };
  for (const item of report.evidence || []) add(item);
  // Development failures are retained explicitly, without scanning arbitrary
  // analysis folders (which may also contain private player-profile backups).
  if (report.developmentEvidence) {
    add(report.developmentEvidence);
    const manifest = JSON.parse(readRegular(evidencePath(root, report.developmentEvidence.file)).toString('utf8').replace(/^\uFEFF/, ''));
    assert.equal(manifest.schema, 1);
    assert.ok(Array.isArray(manifest.files));
    for (const item of manifest.files) add(item);
  }
  if (report.previousReleaseReport) add(report.previousReleaseReport);
  for (const item of [report.acceptance, report.historicalAcceptance, ...(report.historicalAcceptances || [])]) if (item) add(item);
  const directed = report.directedEndgame;
  if (directed) {
    add(directed);
    const saved = JSON.parse(readRegular(evidencePath(root, directed.file)).toString('utf8').replace(/^\uFEFF/, ''));
    assert.deepEqual(saved, directed.report, 'directed embedded report differs from its actual file');
    assert.ok(Array.isArray(saved.rows), 'directed records missing');
    for (const row of saved.rows) add({ file: row.recordPath, sha256: row.recordSha256 });
    const protocol = saved.protocol;
    assert.ok(protocol?.sourceRoot && protocol.sourceHashes, 'directed source snapshot missing');
    for (const [name, sha256] of Object.entries(protocol.sourceHashes))
      add({ file: path.resolve(root, protocol.sourceRoot, name), sha256 });
  }
  return [...entries.values()].sort((a, b) => a.file.localeCompare(b.file));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv[2], '--collect');
  const root = path.dirname(fileURLToPath(import.meta.url));
  const report = JSON.parse(readRegular(path.resolve(root, process.argv[3] || 'research/validation-result.json')).toString('utf8').replace(/^\uFEFF/, ''));
  console.log(JSON.stringify(collectReportEvidence(report, root)));
}
