import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { createLearningProfile, sanitizeProfile, LEARNING_VERSION } from '../dist/learning.js';

const require = createRequire(import.meta.url);
const { createExperienceStore, MAX_PROFILE_BYTES } = require('../storage.cjs');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'junqi-storage-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createExperienceStore({ directory, sanitizeProfile, version: LEARNING_VERSION });
  const profile = createLearningProfile();
  return { directory, store, profile };
}

test('experience survives independent store instances, keeps previous version, and strips private fields', async t => {
  const { directory, store, profile } = await fixture(t);
  assert.deepEqual(await store.load(), { profile: null, source: 'none' });
  profile.games = 1;
  profile.board = [{ type: 'bomb', origin: 38 }];
  assert.deepEqual(await store.save(profile), { ok: true });
  const restarted = createExperienceStore({ directory, sanitizeProfile, version: LEARNING_VERSION });
  const loaded = await restarted.load();
  assert.equal(loaded.source, 'primary');
  assert.equal(loaded.profile.games, 1);
  assert.equal(Object.hasOwn(loaded.profile, 'board'), false);
  assert.equal((await fs.readFile(store.primary, 'utf8')).includes('origin'), false);
  profile.games = 2;
  assert.deepEqual(await restarted.save(profile), { ok: true });
  assert.equal(JSON.parse(await fs.readFile(store.backup, 'utf8')).games, 1);
  assert.equal((await restarted.load()).profile.games, 2);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['learning-profile.json', 'learning-profile.previous.json']);
});

test('corrupt primary restores backup and never replaces it with corrupt content', async t => {
  const { store, profile } = await fixture(t);
  profile.games = 7;
  await store.save(profile);
  profile.games = 8;
  await store.save(profile);
  await fs.writeFile(store.primary, '{truncated', 'utf8');
  const loaded = await store.load();
  assert.equal(loaded.source, 'backup');
  assert.equal(loaded.profile.games, 7);
  assert.match(loaded.error, /备份/);
  profile.games = 9;
  assert.deepEqual(await store.save(profile), { ok: true });
  assert.equal(JSON.parse(await fs.readFile(store.backup, 'utf8')).games, 7);
  assert.equal((await store.load()).profile.games, 9);
});

test('save queue preserves request order and waitForIdle includes all queued writes', async t => {
  const { store, profile } = await fixture(t);
  const first = store.save({ ...profile, games: 11 });
  const second = store.save({ ...profile, games: 12 });
  await store.waitForIdle();
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(await second, { ok: true });
  assert.equal((await store.load()).profile.games, 12);
  assert.equal(JSON.parse(await fs.readFile(store.backup, 'utf8')).games, 11);
});

test('import validates JSON and size without replacing active experience; export is sanitized', async t => {
  const { directory, store, profile } = await fixture(t);
  await store.save({ ...profile, games: 3 });
  const external = path.join(directory, 'export.json');
  await store.exportFile(external, { ...profile, games: 99, replay: [{ secret: 'layout' }] });
  assert.equal((await store.importFile(external)).games, 99);
  assert.equal((await store.load()).profile.games, 3);
  assert.equal((await fs.readFile(external, 'utf8')).includes('secret'), false);
  await fs.writeFile(external, 'x'.repeat(MAX_PROFILE_BYTES + 1));
  await assert.rejects(store.importFile(external), /大小/);
  await fs.writeFile(external, '{"version":999,"games":1,"weights":{}}');
  await assert.rejects(store.importFile(external), /版本/);
  await fs.writeFile(external, 'null');
  await assert.rejects(store.importFile(external), /格式/);
});

test('invalid input and disk failures report failure without destroying saved experience', async t => {
  const { directory, store, profile } = await fixture(t);
  await store.save({ ...profile, games: 4 });
  const invalid = await store.save({ ...profile, games: -1 });
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /格式/);
  const large = await store.save({ ...profile, junk: 'x'.repeat(MAX_PROFILE_BYTES + 1) });
  assert.equal(large.ok, false);
  assert.equal((await store.load()).profile.games, 4);
  const blocker = path.join(directory, 'not-a-directory');
  await fs.writeFile(blocker, 'blocked');
  const blocked = createExperienceStore({ directory: blocker, sanitizeProfile, version: LEARNING_VERSION });
  const failedSave = await blocked.save(profile);
  assert.equal(failedSave.ok, false);
  assert.match(failedSave.error, /保存失败/);
});

test('strict validation rejects malformed restore inputs before sanitizing or changing disk', async t => {
  const { store, profile } = await fixture(t);
  await store.save({ ...profile, games: 4 });
  assert.throws(() => store.validate(null), /格式/);
  assert.throws(() => store.validate({ ...profile, version: 999 }), /版本/);
  assert.throws(() => store.validate({ ...profile, weights: {} }), /格式/);
  assert.throws(() => store.validate({ ...profile, dedup: [] }), /格式/);
  const valid = store.validate({ ...profile, games: 2, history: [{ secret: 'ignored' }] });
  assert.equal(valid.games, 2);
  assert.equal(Object.hasOwn(valid, 'history'), false);
  assert.equal((await store.load()).profile.games, 4);
});
