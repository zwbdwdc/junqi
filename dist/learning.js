/* Local, bounded experience learning from the AI's PUBLIC observation.
 * This is an interpretable policy adjustment, not neural-network training.
 * By explicit user choice, a FINISHED matching referee game may additionally
 * be reviewed after play. It is never supplied to the live move chooser.
 * We do not read observation.board, enemyRoster, or enemyCounts. All identity
 * maps are transient; the resulting profile has no positions or piece IDs.
 */
import { isCamp, isMountain } from './engine.js';
import { reviewCompletedPlans } from './postgame-review.js';

export const LEARNING_VERSION = 1;
export const WEIGHT_MIN = 0.8;
export const WEIGHT_MAX = 1.25;
export const LEARNING_KEYS = Object.freeze(['attack', 'scout', 'shelter', 'defend', 'develop', 'risk', 'bombCaution']);
const ACTIONS = new Set(['attack', 'scout', 'shelter', 'defend', 'develop']);
const COSTS = new Set(['risk', 'bombCaution']);
const NAMES = Object.freeze({ attack: '进攻取舍', scout: '侦察取舍', shelter: '进营避险', defend: '护旗防守',
  develop: '展开调动', risk: '大子风险控制', bombCaution: '疑炸谨慎程度' });
const OWN_VALUE = Object.freeze({ commander: 1, general: 0.85, division: 0.7, brigade: 0.58,
  regiment: 0.45, battalion: 0.35, company: 0.25, platoon: 0.2, engineer: 0.45, bomb: 0.65,
  mine: 0.3, flag: 1 });
const DEFAULT_STYLE = Object.freeze({ moves: 0, attackRate: 0.32, campRate: 0.16,
  retreatRate: 0.18, earlyPressure: 0.25, engineerRate: 0.06,
  encounters: 0, encounterBombRate: 0.08, encounterStrongRate: 0.16 });
// A fixed 65,536-bit Bloom filter remembers completed-game fingerprints.
// Unlike a recent-ID ring it never forgets a duplicate. False positives may
// conservatively skip an extremely rare new game; they cannot learn twice.
const DEDUP_WORDS = 2048;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const finite = (value, fallback) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const count = value => Math.floor(clamp(finite(value, 0), 0, 1e9));
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const position = value => Number.isInteger(value) && value >= 0 && value < 62;
const row = value => isMountain(value) ? 5.5 : Math.floor(value / 5);

function summaryText(summary) {
  if (!summary) return '尚无完整对局经验；职业和地狱均使用内置战术。';
  const prefix = `本局${summary.fullReview ? '终局明棋' : '公开结果'}复核 ${summary.movesReviewed} 步`;
  const exchange = summary.highRankBombTrades ? `其中 ${summary.highRankBombTrades} 次大子触炸交换。` : '';
  if (!summary.adjustments.length) return `${prefix}，更新对手走法习惯；战术权重保持稳定。${exchange}`;
  return prefix + '：' + summary.adjustments.map(change =>
    `${NAMES[change.key]}${change.after >= change.before ? '提高' : '降低'} ${Math.abs((change.after - change.before) * 100).toFixed(1)}%`).join('；') + '。' + exchange;
}

export function createLearningProfile() {
  return {
    version: LEARNING_VERSION, games: 0, replayGames: 0, outcomes: { wins: 0, losses: 0, draws: 0 },
    weights: Object.fromEntries(LEARNING_KEYS.map(key => [key, 1])),
    opponent: { ...DEFAULT_STYLE }, dedup: Array(DEDUP_WORDS).fill(0), lastSummary: null,
  };
}

/** Whitelist every field on load/save; importing a profile cannot import a
 * board, identity label, decision trace, or arbitrary text into the AI. */
export function sanitizeProfile(input) {
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { return createLearningProfile(); }
  }
  const profile = createLearningProfile();
  if (!isObject(input) || input.version !== LEARNING_VERSION) return profile;
  profile.games = count(input.games);
  profile.replayGames = Math.min(profile.games, count(input.replayGames));
  for (const key of Object.keys(profile.outcomes)) profile.outcomes[key] = count(input.outcomes?.[key]);
  for (const key of LEARNING_KEYS) profile.weights[key] = clamp(finite(input.weights?.[key], 1), WEIGHT_MIN, WEIGHT_MAX);
  profile.opponent.moves = count(input.opponent?.moves);
  profile.opponent.encounters = count(input.opponent?.encounters);
  for (const key of Object.keys(DEFAULT_STYLE).filter(key => key !== 'moves' && key !== 'encounters'))
    profile.opponent[key] = clamp(finite(input.opponent?.[key], DEFAULT_STYLE[key]), 0, 1);
  if (Array.isArray(input.dedup) && input.dedup.length === DEDUP_WORDS)
    profile.dedup = input.dedup.map(word => Number.isInteger(word) && word >= 0 && word <= 0xffffffff ? word >>> 0 : 0);
  if (isObject(input.lastSummary)) {
    const seen = new Set();
    const adjustments = Array.isArray(input.lastSummary.adjustments) ? input.lastSummary.adjustments.flatMap(change => {
      if (!isObject(change) || !LEARNING_KEYS.includes(change.key) || seen.has(change.key) ||
        !Number.isFinite(change.before) || !Number.isFinite(change.after)) return [];
      seen.add(change.key);
      return [{ key: change.key, before: clamp(change.before, WEIGHT_MIN, WEIGHT_MAX),
        after: clamp(change.after, WEIGHT_MIN, WEIGHT_MAX) }];
    }) : [];
    profile.lastSummary = { movesReviewed: count(input.lastSummary.movesReviewed),
      fullReview: input.lastSummary.fullReview === true, highRankBombTrades: count(input.lastSummary.highRankBombTrades),
      missedKnownWins: count(input.lastSummary.missedKnownWins),
      result: ['win', 'loss', 'draw'].includes(input.lastSummary.result) ? input.lastSummary.result : 'draw', adjustments };
    profile.lastSummary.text = summaryText(profile.lastSummary);
  }
  return profile;
}

function fingerprintPositions(gameId) {
  let first = 0x811c9dc5, second = 0x9e3779b9;
  for (let index = 0; index < gameId.length; index++) {
    const code = gameId.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
    second = (second << 13 | second >>> 19) >>> 0;
  }
  second = (second | 1) >>> 0;
  return [0, 1, 2, 3].map(index => ((first + Math.imul(index, second)) >>> 0) % (DEDUP_WORDS * 32));
}

function hasGame(profile, positions) {
  return positions.every(bit => (profile.dedup[bit >>> 5] & (1 << (bit & 31))) !== 0);
}

function markGame(profile, positions) {
  for (const bit of positions) profile.dedup[bit >>> 5] = (profile.dedup[bit >>> 5] | (1 << (bit & 31))) >>> 0;
}

/** Importing an older backup is an intentional rollback. Acknowledge existing
 * archives without reapplying their rewards, so startup repair does not undo
 * that choice. Only bounded fingerprints are retained, never record contents. */
export function excludeLearningGames(input, gameIds) {
  const profile = sanitizeProfile(input);
  for (const gameId of Array.isArray(gameIds) ? gameIds : [])
    if (typeof gameId === 'string' && gameId.length > 0 && gameId.length <= 200)
      markGame(profile, fingerprintPositions(gameId));
  return profile;
}

export function hasLearnedGame(input, gameId) {
  return typeof gameId === 'string' && gameId.length > 0 && gameId.length <= 200 &&
    hasGame(sanitizeProfile(input), fingerprintPositions(gameId));
}

function publicEvents(observation) {
  if (!Array.isArray(observation.history)) return [];
  const seen = new Set();
  return observation.history.slice(0, 10000).filter(event => {
    if (!isObject(event) || !Number.isInteger(event.ply) || event.ply < 1 || seen.has(event.ply) ||
      !['ai', 'human'].includes(event.side) || !position(event.from) || !position(event.to) ||
      !['move', 'win', 'lose', 'both'].includes(event.result)) return false;
    seen.add(event.ply); return true;
  }).sort((a, b) => a.ply - b.ply);
}

function updateOpponent(profile, events) {
  const moves = events.filter(event => event.side === 'human');
  if (!moves.length) return;
  const early = moves.filter(event => event.ply <= 20);
  const rates = {
    attackRate: moves.filter(event => event.result !== 'move').length / moves.length,
    campRate: moves.filter(event => isCamp(event.to) || isMountain(event.to)).length / moves.length,
    retreatRate: moves.filter(event => row(event.to) > row(event.from)).length / moves.length,
    earlyPressure: early.length ? early.filter(event => row(event.to) < 6).length / early.length : null,
    engineerRate: moves.filter(event => event.engineerTurn === true || event.mountainMove === true).length / moves.length,
  };
  // A bounded EWMA adapts to changing habits without one game replacing prior experience.
  const alpha = clamp(moves.length / (moves.length + 24), 0.08, 0.55);
  for (const [key, value] of Object.entries(rates)) if (value !== null)
    profile.opponent[key] = profile.opponent[key] * (1 - alpha) + value * alpha;
  profile.opponent.moves = count(profile.opponent.moves + moves.length);
}

function featuresOf(decision) {
  const source = decision.info?.learningFeatures ?? decision.learningFeatures;
  const features = Object.fromEntries(LEARNING_KEYS.map(key => [key, clamp(finite(source?.[key], 0), 0, 1)]));
  const action = decision.info?.actionClass ?? decision.actionClass;
  // A named class is diagnostic only; it cannot invent an unscored feature.
  return { features, action: ACTIONS.has(action) ? action : null };
}

/** Return transient identities ONLY after both views prove this is the same
 * finished game. Validation happens before even accessing the private initial
 * array, so an active game (or a mismatched replay) cannot reveal identities. */
function completedIdentities(completedGame, observation, own) {
  if (!isObject(completedGame) || !isObject(completedGame.result) ||
    completedGame.result.winner !== observation.result.winner ||
    completedGame.result.reason !== observation.result.reason ||
    completedGame.ply !== observation.ply || !Array.isArray(completedGame.history) ||
    !Array.isArray(observation.history) || completedGame.history.length !== observation.history.length) return null;
  const fields = ['ply', 'side', 'from', 'to', 'attackerId', 'defenderId', 'result', 'engineerTurn', 'mountainMove', 'capturedFlagSide'];
  for (let index = 0; index < observation.history.length; index++) {
    const publicEvent = observation.history[index], recorded = completedGame.history[index];
    if (!isObject(publicEvent) || !isObject(recorded) || fields.some(key => publicEvent[key] !== recorded[key]) ||
      JSON.stringify(publicEvent.flagRevealed ?? []) !== JSON.stringify(recorded.flagRevealed ?? [])) return null;
  }
  if (!Array.isArray(completedGame.initial) || ![60, 62].includes(completedGame.initial.length)) return null;
  const identities = new Map();
  for (const piece of completedGame.initial) {
    if (piece === null) continue;
    if (!isObject(piece) || typeof piece.id !== 'string' || identities.has(piece.id) ||
      !['human', 'ai'].includes(piece.side) || !Object.hasOwn(OWN_VALUE, piece.type)) return null;
    if (piece.side === 'ai' && own.get(piece.id) !== piece.type) return null;
    identities.set(piece.id, { side: piece.side, type: piece.type });
  }
  if ([...own].some(([id, type]) => identities.get(id)?.side !== 'ai' || identities.get(id)?.type !== type)) return null;
  return identities;
}

function updateReviewedEncounters(profile, events, identities) {
  if (!identities) return;
  const encountered = new Set();
  for (const event of events) if (event.result !== 'move') {
    const id = event.side === 'ai' ? event.defenderId : event.attackerId;
    if (identities.get(id)?.side === 'human') encountered.add(id);
  }
  if (!encountered.size) return;
  const types = [...encountered].map(id => identities.get(id).type);
  // These are rates of fought pieces, not claims about any hidden square.
  const prior = Math.min(80, profile.opponent.encounters) + 16;
  const blend = (key, rate) => { profile.opponent[key] =
    (profile.opponent[key] * prior + rate * types.length) / (prior + types.length); };
  blend('encounterBombRate', types.filter(type => type === 'bomb').length / types.length);
  blend('encounterStrongRate', types.filter(type => ['commander', 'general', 'division'].includes(type)).length / types.length);
  profile.opponent.encounters = count(profile.opponent.encounters + types.length);
}

/** Finish-only, idempotent consolidation. `decisions` contain only
 * {ply,from,to,info:{learningFeatures,actionClass}} recorded BEFORE each move.
 * `ply` is the actual event ply (pre-move observation.ply + 1).
 * It returns a fresh sanitized profile; neither argument is mutated.
 */
export function learnFromGame(input, { gameId, observation, decisions = [], completedGame = null } = {}) {
  const profile = sanitizeProfile(input);
  if (typeof gameId !== 'string' || !gameId.length || gameId.length > 200 ||
    !isObject(observation) || observation.side !== 'ai' || !isObject(observation.result) ||
    !['ai', 'human', null].includes(observation.result.winner)) return profile;
  const positions = fingerprintPositions(gameId);
  if (hasGame(profile, positions)) return profile;

  const events = publicEvents(observation);
  const eventByPly = new Map(events.map(event => [event.ply, event]));
  const own = new Map((Array.isArray(observation.ownRoster) ? observation.ownRoster : [])
    .filter(piece => isObject(piece) && typeof piece.id === 'string' && Object.hasOwn(OWN_VALUE, piece.type))
    .map(piece => [piece.id, piece.type]));
  const identities = completedIdentities(completedGame, observation, own);
  const planReview = identities ? reviewCompletedPlans(completedGame) : new Map();
  // Public outcomes tell us WHICH of our pieces died, never what an anonymous
  // opponent casualty was. Do not assign enemy value or enemy type as a label.
  const ownDeathPly = new Map();
  const ownDeathEvent = new Map();
  for (const event of events) {
    if (event.side === 'ai' && ['lose', 'both'].includes(event.result) && own.has(event.attackerId))
      { ownDeathPly.set(event.attackerId, event.ply); ownDeathEvent.set(event.attackerId, event); }
    if (event.side === 'human' && ['win', 'both'].includes(event.result) && own.has(event.defenderId))
      { ownDeathPly.set(event.defenderId, event.ply); ownDeathEvent.set(event.defenderId, event); }
  }
  const gradient = Object.fromEntries(LEARNING_KEYS.map(key => [key, 0]));
  const exposure = Object.fromEntries(LEARNING_KEYS.map(key => [key, 0]));
  const reviewed = new Set();
  let highRankBombTrades = 0;
  for (const decision of (Array.isArray(decisions) ? decisions : []).slice(0, 5000)) {
    if (!isObject(decision)) continue;
    const event = eventByPly.get(decision.ply);
    if (!event || event.side !== 'ai' || event.from !== decision.from || event.to !== decision.to ||
      reviewed.has(event.ply) || !own.has(event.attackerId)) continue;
    const { features, action } = featuresOf(decision);
    if (!Object.values(features).some(value => value > 0)) continue;
    reviewed.add(event.ply);
    const plan = planReview.get(event.ply);
    const value = OWN_VALUE[own.get(event.attackerId)];
    const deathPly = ownDeathPly.get(event.attackerId);
    const enemyType = identities?.get(event.defenderId)?.side === 'human' ? identities.get(event.defenderId).type : null;
    const enemyValue = enemyType ? OWN_VALUE[enemyType] : null;
    let reward = event.result === 'win' ? 0.28 : 0;
    if (event.result === 'win' && enemyValue !== null) reward = 0.12 + enemyValue * 0.55;
    if (event.result === 'lose') reward = -0.25 - value * 0.7;
    if (event.result === 'both') reward = 0.08 - value * 0.7;
    if (event.result === 'both' && enemyValue !== null) reward = enemyValue * 0.55 - value * 0.7;
    // Credit horizon spans at most two replies. A delayed loss is discounted;
    // a much later strategic error is not blamed on an unrelated early move.
    if (deathPly > event.ply && deathPly <= event.ply + 4) {
      const deathEvent = ownDeathEvent.get(event.attackerId);
      const enemyAttacker = identities?.get(deathEvent?.attackerId);
      const exchangeCredit = deathEvent?.side === 'human' && deathEvent.result === 'both' && enemyAttacker?.side === 'human' ?
        OWN_VALUE[enemyAttacker.type] * 0.55 : 0;
      reward += (exchangeCredit - value * 0.7) * Math.pow(0.7, Math.floor((deathPly - event.ply - 1) / 2));
    }
    const horizonObserved = events.some(later => later.side === 'human' && later.ply > event.ply && later.ply <= event.ply + 4);
    if (event.result === 'move' && action === 'shelter' && (isCamp(event.to) || isMountain(event.to)) &&
      plan?.escape && !plan.missedFlagCover && !plan.avoidableFlagLoss && horizonObserved && !(deathPly && deathPly <= event.ply + 4)) reward += 0.10;
    if (event.result === 'move' && action === 'defend' && plan?.defended && horizonObserved &&
      !(deathPly && deathPly <= event.ply + 4)) reward += 0.10;
    if (plan?.productive) reward += 0.07;
    if (plan?.missedKnownWin) reward = Math.min(reward, -0.5);
    else if (plan?.avoidableFlagLoss) reward = Math.min(reward, -0.4);
    else if (plan?.missedFlagCover) reward = Math.min(reward, -0.18);
    if (event.capturedFlagSide === 'human') reward += 0.6;
    reward = clamp(reward, -1, 1);
    for (const key of LEARNING_KEYS) {
      exposure[key] += features[key];
      // Costs learn more from a loss than from a single lucky blind capture.
      const evidence = COSTS.has(key) ? -reward * (reward > 0 ? 0.35 : 1) : reward;
      gradient[key] += features[key] * evidence;
    }
    // Learn the missed objective, not a blanket preference for never moving.
    if (plan?.avoidableFlagLoss) { gradient.defend += 0.75; exposure.defend += 1; }
    else if (plan?.missedFlagCover) { gradient.defend += 0.3; exposure.defend += 1; }
    if (plan?.shuttle) {
      gradient.develop += 0.15; exposure.develop += 1;
      gradient.scout += 0.04; exposure.scout += 1;
      if (action === 'shelter') { gradient.shelter -= 0.18; exposure.shelter += 1; }
    }
    if (plan?.missedKnownWin) { gradient.attack += 0.4; exposure.attack += 1; }
    // This identity is available exclusively in the finished full review. A
    // large officer trading into a bomb strengthens bomb caution even if the
    // live estimate had understated that feature. No bomb label is retained.
    if (enemyType === 'bomb' && event.result === 'both' && value >= 0.7) {
      highRankBombTrades++;
      gradient.bombCaution += (value - OWN_VALUE.bomb) * 1.5 + 0.15;
      exposure.bombCaution += 1;
    }
  }

  const before = { ...profile.weights };
  for (const key of LEARNING_KEYS) {
    const delta = 0.045 * gradient[key] / Math.max(1, exposure[key]);
    profile.weights[key] = clamp(profile.weights[key] + clamp(delta, -0.04, 0.04), WEIGHT_MIN, WEIGHT_MAX);
  }
  // A flag defeat is a directly observed objective failure, even when the last
  // threatened defender was unable to move. It warrants a modest defence bias.
  if (observation.result.winner === 'human' && observation.result.reason === 'flag')
    profile.weights.defend = clamp(Math.max(profile.weights.defend, before.defend + 0.025), WEIGHT_MIN, WEIGHT_MAX);
  updateOpponent(profile, events);
  updateReviewedEncounters(profile, events, identities);
  profile.games = count(profile.games + 1);
  if (identities) profile.replayGames = count(profile.replayGames + 1);
  const result = observation.result.winner === 'ai' ? 'win' : observation.result.winner === 'human' ? 'loss' : 'draw';
  profile.outcomes[result === 'win' ? 'wins' : result === 'loss' ? 'losses' : 'draws']++;
  markGame(profile, positions);
  const adjustments = LEARNING_KEYS.filter(key => Math.abs(profile.weights[key] - before[key]) >= 0.0005)
    .map(key => ({ key, before: before[key], after: profile.weights[key] }));
  profile.lastSummary = { movesReviewed: reviewed.size, result, fullReview: identities !== null, highRankBombTrades,
    missedKnownWins: [...planReview.values()].filter(plan => plan.missedKnownWin).length, adjustments };
  profile.lastSummary.text = summaryText(profile.lastSummary);
  return profile;
}

export const serializeProfile = profile => JSON.stringify(sanitizeProfile(profile));
