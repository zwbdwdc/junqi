/* Main-process-only consolidation of completed archives. Never pass records
 * or this module to an AI worker. Live workers receive the resulting sanitized
 * aggregate profile through the same observation boundary as ordinary play. */
import { makeObservation } from './engine.js';
import { buildReplay } from './replay.js';
import { sanitizeProfile, learnFromGame, excludeLearningGames, hasLearnedGame } from './learning.js';

const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 200;
const recordTime = record => typeof record?.finishedAt === 'string' && Number.isFinite(Date.parse(record.finishedAt)) ? record.finishedAt : '';
function orderedRecords(records) {
  return (Array.isArray(records) ? records : []).slice().sort((a, b) =>
    recordTime(a).localeCompare(recordTime(b)) || String(a?.id || '').localeCompare(String(b?.id || '')));
}
function completedRecord(record) {
  // Check terminal status before touching board/initial/history. Files supplied
  // by the main process have already passed archiveStore.load validation; the
  // replay check here is defense in depth for offline recovery tooling.
  const game = record?.game;
  if (!game?.result || !['human', 'ai', null].includes(game.result.winner) || !validId(game.gameId))
    throw new Error('只处理有效的已结束对局');
  buildReplay(game);
  return game;
}

/** Call after archiveStore.load has validated each file, in a main-process
 * transaction that serializes load -> consolidate -> save. An invalid record
 * is reported and cannot prevent valid later records from being learned. */
export function consolidateCompletedGames(input, records) {
  let profile = sanitizeProfile(input), learned = 0, skipped = 0;
  const failed = [];
  for (const record of orderedRecords(records)) {
    try {
      const game = completedRecord(record);
      if (hasLearnedGame(profile, game.gameId)) { skipped++; continue; }
      if (game.skipRestoredExperience === true) {
        profile = excludeLearningGames(profile, [game.gameId]); skipped++; continue;
      }
      const next = learnFromGame(profile, { gameId: game.gameId, observation: makeObservation(game, 'ai'),
        decisions: game.aiDecisions || [], completedGame: game });
      if (next.games !== profile.games + 1) throw new Error('完整棋谱未能生成经验');
      profile = next; learned++;
    } catch (error) {
      failed.push({ id: typeof record?.id === 'string' ? record.id.slice(0, 200) : null,
        error: error?.message || String(error) });
    }
  }
  return { profile, learned, skipped, failed };
}

/** Preserve explicit backup-restore semantics: mark all currently retained,
 * validated games as acknowledged without changing counts or policy weights. */
export function excludeCompletedGames(input, records) {
  const ids = [], failed = [];
  for (const record of orderedRecords(records)) {
    try { ids.push(completedRecord(record).gameId); }
    catch (error) { failed.push({ id: typeof record?.id === 'string' ? record.id.slice(0, 200) : null,
      error: error?.message || String(error) }); }
  }
  return { profile: excludeLearningGames(input, ids), excluded: new Set(ids).size, failed };
}
