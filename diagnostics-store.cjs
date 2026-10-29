const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const EVENTS = new Set(['startup', 'second-instance', 'experience-review', 'experience-save',
  'experience-restore', 'archive-save', 'renderer-failed']);
const SHORT = ['launchId', 'appVersion', 'electronVersion', 'source', 'requestedVersion'];
const PATHS = ['executable', 'portableExecutable'];
const COUNTS = ['before', 'after', 'learned', 'failed'];
function cleanEntry(input) {
  if (!input || !EVENTS.has(input.event)) throw new Error('诊断事件无效');
  const entry = { at: typeof input.at === 'string' && Number.isFinite(Date.parse(input.at)) ?
    new Date(input.at).toISOString() : new Date().toISOString(), event: input.event };
  for (const key of SHORT) if (typeof input[key] === 'string') entry[key] = input[key].slice(0, 100);
  for (const key of PATHS) if (typeof input[key] === 'string') entry[key] = input[key].slice(0, 1800);
  for (const key of COUNTS) if (Number.isSafeInteger(input[key]) && input[key] >= 0) entry[key] = input[key];
  if (typeof input.ok === 'boolean') entry.ok = input.ok;
  if (typeof input.error === 'string') entry.error = input.error.slice(0, 600);
  return entry;
}

/** Small operational history, deliberately excluding board, game ID, moves,
 * profile weights and stack traces. Failure must not interrupt a match. */
function createDiagnosticsStore({ directory, maxEntries = 64, maxBytes = 256 * 1024 }) {
  const file = path.join(directory, 'runtime-diagnostics.json');
  let queue = Promise.resolve();
  async function previousEntries() {
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > maxBytes) return [];
      const saved = JSON.parse(await fs.readFile(file, 'utf8'));
      if (saved?.schema !== 1 || !Array.isArray(saved.entries)) return [];
      return saved.entries.slice(-maxEntries).flatMap(entry => {
        try { return [cleanEntry(entry)]; } catch { return []; }
      });
    } catch { return []; }
  }
  function append(input) {
    let entry;
    try { entry = cleanEntry(input); }
    catch (error) { return Promise.resolve({ ok: false, error: error.message }); }
    const task = queue.then(async () => {
      const temporary = path.join(directory, `.runtime-diagnostics.${randomUUID()}.tmp`);
      try {
        await fs.mkdir(directory, { recursive: true });
        const entries = [...await previousEntries(), entry].slice(-maxEntries);
        let text = JSON.stringify({ schema: 1, entries }, null, 2) + '\n';
        while (Buffer.byteLength(text) > maxBytes && entries.length > 1) {
          entries.shift(); text = JSON.stringify({ schema: 1, entries }, null, 2) + '\n';
        }
        if (Buffer.byteLength(text) > maxBytes) throw new Error('诊断记录过大');
        await fs.writeFile(temporary, text, { flag: 'wx' });
        await fs.rename(temporary, file);
        return { ok: true };
      } catch (error) { return { ok: false, error: error.message }; }
      finally { await fs.unlink(temporary).catch(() => {}); }
    });
    queue = task.then(() => undefined, () => undefined);
    return task;
  }
  return { append, waitForIdle: () => queue, file };
}

module.exports = { createDiagnosticsStore };
