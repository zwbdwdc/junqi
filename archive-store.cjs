const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const ARCHIVE_SCHEMA = 1;
const MAX_GAME_BYTES = 4 * 1024 * 1024;
const MAX_ARCHIVED_GAMES = 100;
const ID_PATTERN = /^[a-f0-9]{64}$/;
const FILE_PATTERN = /^[a-f0-9]{64}\.json$/;
const SIDES = new Set(['human', 'ai']);
const REASONS = new Set(['flag', 'no-moves', 'quiet', 'repetition', 'resign']);
const TYPES = new Set(['flag', 'mine', 'bomb', 'commander', 'general', 'division', 'brigade', 'regiment', 'battalion', 'company', 'platoon', 'engineer']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fingerprint = gameId => createHash('sha256').update(gameId, 'utf8').digest('hex');

/** Completed referee records live here, never in an AI observation or worker. */
function createArchiveStore({ directory, buildReplay, createGame, applyMove,
  maxBytes = MAX_GAME_BYTES, maxGames = MAX_ARCHIVED_GAMES }) {
  const archiveDirectory = path.resolve(directory, 'games');
  let queue = Promise.resolve();

  function fileFor(id) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new Error('棋谱编号无效');
    return path.join(archiveDirectory, id + '.json');
  }

  function validateGame(game, replay = true) {
    if (!object(game) || !object(game.result)) throw new Error('对局结束后才能保存棋谱');
    if (typeof game.gameId !== 'string' || !game.gameId.length || game.gameId.length > 200 ||
      !Number.isSafeInteger(game.ply) || game.ply < 0 || game.ply > 5000 ||
      !Array.isArray(game.history) || game.history.length !== game.ply ||
      !Array.isArray(game.initial) || ![60, 62].includes(game.initial.length) ||
      !Array.isArray(game.board) || game.board.length !== game.initial.length ||
      !SIDES.has(game.turn) || (game.firstTurn !== undefined && !SIDES.has(game.firstTurn)) ||
      !Number.isSafeInteger(game.quiet) || game.quiet < 0 || game.quiet > 100 ||
      !REASONS.has(game.result.reason) || !(game.result.winner === null || SIDES.has(game.result.winner)) ||
      !object(game.rules) || typeof game.rules.engineerMountains !== 'boolean' ||
      game.board.length !== (game.rules.engineerMountains ? 62 : 60)) throw new Error('棋谱格式不完整');
    for (const board of [game.initial, game.board]) {
      const ids = new Set();
      for (const piece of board) {
        if (piece === null) continue;
        if (!object(piece) || !TYPES.has(piece.type) || !SIDES.has(piece.side) ||
          typeof piece.id !== 'string' || !piece.id.length || piece.id.length > 200 || ids.has(piece.id) ||
          !Number.isSafeInteger(piece.origin) || piece.origin < 0 || piece.origin >= 60 ||
          typeof piece.moved !== 'boolean') throw new Error('棋谱棋子信息无效');
        ids.add(piece.id);
      }
    }
    for (let index = 0; index < game.history.length; index++) {
      const event = game.history[index];
      if (!object(event) || event.ply !== index + 1 || !SIDES.has(event.side) ||
        !Number.isSafeInteger(event.from) || event.from < 0 || event.from >= game.board.length ||
        !Number.isSafeInteger(event.to) || event.to < 0 || event.to >= game.board.length ||
        typeof event.attackerId !== 'string' || event.attackerId.length > 200 ||
        !(event.defenderId === null || typeof event.defenderId === 'string') ||
        !['move', 'win', 'lose', 'both'].includes(event.result)) throw new Error('棋谱步骤无效');
    }
    if (!replay) return;
    // Use the same referee replay validation as the visible post-game viewer.
    buildReplay(game);
    // The result, turn and quiet counter must also agree with that history.
    // Resignation is the sole terminal action that has no board move of its own.
    const layout = side => game.initial.slice(0, 60).map(piece => piece?.side === side ? piece : null);
    let state = createGame(layout('human'), layout('ai'), { ...game.rules, firstTurn: game.firstTurn });
    for (const event of game.history) state = applyMove(state, event.from, event.to);
    if (state.turn !== game.turn || state.quiet !== game.quiet ||
      (state.result ? state.result.reason !== game.result.reason || state.result.winner !== game.result.winner :
        game.result.reason !== 'resign' || game.result.winner === null)) throw new Error('棋谱终局结果不一致');
  }

  function envelope(input, replay = true) {
    if (!object(input) || input.schema !== ARCHIVE_SCHEMA || !ID_PATTERN.test(input.id || '') ||
      !['professional', 'hell'].includes(input.difficulty) || typeof input.finishedAt !== 'string' ||
      !Number.isFinite(Date.parse(input.finishedAt)) || new Date(input.finishedAt).toISOString() !== input.finishedAt)
      throw new Error('棋谱文件格式或版本不受支持');
    validateGame(input.game, replay);
    if (fingerprint(input.game.gameId) !== input.id) throw new Error('棋谱编号不一致');
    return input;
  }

  function summary(record) {
    return { id: record.id, finishedAt: record.finishedAt, difficulty: record.difficulty,
      ply: record.game.ply, result: { winner: record.game.result.winner, reason: record.game.result.reason } };
  }

  async function readRecord(id, replay = true) {
    const file = fileFor(id);
    const stat = await fs.lstat(file);
    if (!stat.isFile()) throw new Error('棋谱文件类型无效');
    if (stat.size > maxBytes) throw new Error('棋谱文件超过大小限制');
    const handle = await fs.open(file, 'r');
    try {
      const buffer = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > maxBytes) throw new Error('棋谱文件超过大小限制');
      if (length !== stat.size) throw new Error('棋谱文件在读取时发生变化');
      const record = envelope(JSON.parse(buffer.subarray(0, length).toString('utf8')), replay);
      if (record.id !== id) throw new Error('棋谱文件编号不一致');
      return record;
    } finally { await handle.close(); }
  }

  async function records() {
    let entries;
    try { entries = await fs.readdir(archiveDirectory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const items = [];
    for (const entry of entries) {
      if (!entry.isFile() || !FILE_PATTERN.test(entry.name)) continue;
      try { items.push(summary(await readRecord(entry.name.slice(0, -5), false))); }
      catch { /* An unreadable file cannot prevent other games from opening. */ }
    }
    return items.sort((a, b) => b.finishedAt.localeCompare(a.finishedAt) || a.id.localeCompare(b.id));
  }

  async function atomicCreate(file, text) {
    await fs.mkdir(archiveDirectory, { recursive: true });
    const temporary = path.join(archiveDirectory, '.' + randomUUID() + '.tmp');
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(text, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      // A hard link publishes the complete file atomically without ever
      // overwriting a same-ID record from another queued writer.
      await fs.link(temporary, file);
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  function save(input) {
    let clean, text;
    try {
      const raw = JSON.stringify(input);
      if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > maxBytes) throw new Error('棋谱文件超过大小限制');
      const cloned = JSON.parse(raw);
      const finishedAt = cloned.finishedAt === undefined ? new Date().toISOString() : new Date(cloned.finishedAt).toISOString();
      clean = envelope({ schema: ARCHIVE_SCHEMA, id: fingerprint(cloned.game?.gameId || ''),
        finishedAt, difficulty: cloned.difficulty, game: cloned.game });
      text = JSON.stringify(clean) + '\n';
      if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('棋谱文件超过大小限制');
    } catch (error) { return Promise.resolve({ ok: false, error: error.message }); }
    const task = queue.then(async () => {
      try {
        try {
          await readRecord(clean.id);
          return { ok: true, id: clean.id, duplicate: true };
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        try { await atomicCreate(fileFor(clean.id), text); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          await readRecord(clean.id);
          return { ok: true, id: clean.id, duplicate: true };
        }
        const saved = await records();
        for (const item of saved.slice(maxGames)) {
          // Only our own, validated, regular JSON files are ever removed.
          const oldFile = fileFor(item.id);
          const stat = await fs.lstat(oldFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
          if (stat?.isFile()) await fs.unlink(oldFile);
        }
        return { ok: true, id: clean.id };
      } catch (error) { return { ok: false, error: '棋谱保存失败：' + error.message }; }
    });
    queue = task.then(() => undefined, () => undefined);
    return task;
  }

  return {
    save,
    list: async () => {
      await queue;
      try { return { ok: true, games: (await records()).slice(0, maxGames) }; }
      catch (error) { return { ok: false, games: [], error: '棋谱读取失败：' + error.message }; }
    },
    load: async id => {
      await queue;
      try { return { ok: true, record: await readRecord(id) }; }
      catch (error) { return { ok: false, error: '棋谱读取失败：' + error.message }; }
    },
    waitForIdle: () => queue,
    directory: archiveDirectory,
  };
}

module.exports = { createArchiveStore, ARCHIVE_SCHEMA, MAX_GAME_BYTES, MAX_ARCHIVED_GAMES };
