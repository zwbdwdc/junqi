const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_PROFILE_BYTES = 512 * 1024;

/** Durable experience only. No game board, replay, or private layout is stored. */
function createExperienceStore({ directory, sanitizeProfile, version, maxBytes = MAX_PROFILE_BYTES }) {
  const primary = path.join(directory, 'learning-profile.json');
  const backup = path.join(directory, 'learning-profile.previous.json');
  const template = sanitizeProfile(null);
  let queue = Promise.resolve();

  function normalize(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || input.version !== version ||
      !Number.isSafeInteger(input.games) || input.games < 0 ||
      !input.weights || typeof input.weights !== 'object' || Array.isArray(input.weights) ||
      Object.keys(template.weights).some(key => !Number.isFinite(input.weights[key])) ||
      !Array.isArray(input.dedup) || input.dedup.length !== template.dedup.length ||
      input.dedup.some(word => !Number.isInteger(word) || word < 0 || word > 0xffffffff)) {
      throw new Error('经验文件格式或版本不受支持');
    }
    const raw = JSON.stringify(input);
    if (Buffer.byteLength(raw, 'utf8') > maxBytes) throw new Error('经验文件超过大小限制');
    const clean = sanitizeProfile(input);
    const text = JSON.stringify(clean, null, 2) + '\n';
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('经验文件超过大小限制');
    return { profile: clean, text };
  }

  async function readProfile(file) {
    // Read no more than the limit even if the file grows after opening.
    const handle = await fs.open(file, 'r');
    try {
      const buffer = Buffer.alloc(maxBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > maxBytes) throw new Error('经验文件超过大小限制');
      return normalize(JSON.parse(buffer.subarray(0, length).toString('utf8')));
    } finally { await handle.close(); }
  }

  async function atomicWrite(file, text) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = path.join(path.dirname(file), '.' + path.basename(file) + '.' + randomUUID() + '.tmp');
    let handle;
    try {
      handle = await fs.open(temp, 'wx');
      await handle.writeFile(text, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temp, file);
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  async function load() {
    await queue;
    let primaryError;
    try { return { profile: (await readProfile(primary)).profile, source: 'primary' }; }
    catch (error) { primaryError = error; }
    try {
      return { profile: (await readProfile(backup)).profile, source: 'backup',
        error: '主经验文件未能读取，已恢复上一份有效备份。' };
    } catch (backupError) {
      if (primaryError.code === 'ENOENT' && backupError.code === 'ENOENT')
        return { profile: null, source: 'none' };
      return { profile: null, source: 'none', error: '经验文件和备份未能读取，请从导出的经验备份恢复。' };
    }
  }

  function save(input) {
    let normalized;
    try { normalized = normalize(input); }
    catch (error) { return Promise.resolve({ ok: false, error: error.message }); }
    const task = queue.then(async () => {
      try {
        // A broken primary must never replace the last known-good backup.
        let previous;
        try { previous = await readProfile(primary); }
        catch (error) {
          if (error.code && error.code !== 'ENOENT') throw error;
        }
        if (previous) await atomicWrite(backup, previous.text);
        await atomicWrite(primary, normalized.text);
        return { ok: true };
      } catch (error) { return { ok: false, error: '经验保存失败：' + error.message }; }
    });
    // Keep later operations alive after one failure and serialize concurrent saves.
    queue = task.then(() => undefined, () => undefined);
    return task;
  }

  async function exportFile(file, input) {
    const clean = normalize(input);
    await atomicWrite(file, clean.text);
    return { ok: true };
  }

  return { load, save, validate: input => normalize(input).profile,
    importFile: async file => (await readProfile(file)).profile,
    exportFile, waitForIdle: () => queue, primary, backup };
}

module.exports = { createExperienceStore, MAX_PROFILE_BYTES };
