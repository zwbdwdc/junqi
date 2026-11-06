// Isolated self-play runner. Referee records are never arguments to a policy.
// Production policies retain their own time budgets; this CLI has no speed-up flag.
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { createDesktopPolicy } from './desktop-policy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SOURCE = path.resolve(HERE, '../dist');
const loadedSources = new Map();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value);
const read = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const ensure = (ok, message) => { if (!ok) throw new Error(message); };

export function seeded(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const seedFor = (...parts) => createHash('sha256').update(parts.join(':')).digest().readUInt32LE(0);
const uint = value => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff;
export const DESKTOP_ENTRY = 'desktop-worker-v1';
export const harnessFiles = () => Object.fromEntries(['self-play-v2.mjs', 'desktop-policy.mjs']
  .map(name => [name, hash(readFileSync(path.join(HERE, name)))]));

export function parseArgs(args) {
  const values = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    ensure(name.startsWith('--') && !Object.hasOwn(values, name), `Invalid or repeated argument: ${name}`);
    if (['--resume', '--help'].includes(name)) values[name] = true;
    else {
      ensure(['--mode', '--opponent', '--seeds', '--seed', '--paired', '--games', '--max-plies',
        '--output', '--source-root', '--expected-sha', '--training-reports'].includes(name), `Unknown argument: ${name}`);
      ensure(args[i + 1] !== undefined && !args[i + 1].startsWith('--'), `Missing value for ${name}`);
      values[name] = args[++i];
    }
  }
  if (values['--help']) return { help: true };
  const mode = values['--mode'] || 'training', opponent = values['--opponent'] || 'professional';
  ensure(['training', 'acceptance'].includes(mode), 'Mode must be training or acceptance');
  ensure(['professional', 'hell'].includes(opponent), 'Opponent must be professional or hell');
  ensure(values['--paired'] === undefined || ['true', 'false'].includes(values['--paired']), '--paired must be true or false');
  const paired = values['--paired'] !== 'false', games = Number(values['--games'] || (mode === 'acceptance' ? 20 : 4));
  const maxPlies = Number(values['--max-plies'] || 400);
  ensure(Number.isSafeInteger(games) && games > 0 && games <= 10000 && (!paired || games % 2 === 0),
    'Games must be 1..10000 and even when paired');
  ensure(Number.isSafeInteger(maxPlies) && maxPlies > 0 && maxPlies <= 5000, 'Max plies must be 1..5000');
  ensure(!(values['--seeds'] && values['--seed']), 'Use either --seed or --seeds');
  const needed = paired ? games / 2 : games;
  let seeds, seedPool;
  if (values['--seeds']) {
    seeds = values['--seeds'].split(',').map(Number); seedPool = 'explicit';
  } else if (values['--seed'] !== undefined) {
    const start = Number(values['--seed']); ensure(uint(start), 'Seed must be an unsigned 32-bit integer');
    seeds = Array.from({ length: needed }, (_, i) => (start + Math.imul(i, 0x9e3779b9)) >>> 0); seedPool = 'explicit-base';
  } else {
    seeds = Array.from({ length: needed }, (_, i) => seedFor('junqi-self-play-v1', mode, i)); seedPool = `default-${mode}-v1`;
  }
  ensure(seeds.length === needed && seeds.every(uint) && new Set(seeds).size === seeds.length,
    `Exactly ${needed} distinct unsigned seeds are required`);
  const expectedSha = values['--expected-sha']?.toLowerCase() || null;
  ensure(!expectedSha || /^[0-9a-f]{64}$/.test(expectedSha), 'Expected SHA must be a SHA-256 hex string');
  ensure(mode !== 'acceptance' || expectedSha, 'Acceptance requires --expected-sha to freeze the candidate');
  return { mode, opponent, paired, games, maxPlies, seeds, seedPool, expectedSha,
    output: path.resolve(values['--output'] || path.join(HERE, `self-play-${mode}-hell-vs-${opponent}.json`)),
    sourceRoot: path.resolve(values['--source-root'] || DEFAULT_SOURCE), resume: values['--resume'] === true,
    trainingReports: values['--training-reports'] ? values['--training-reports'].split(',').map(file => path.resolve(file)) : [] };
}

export function planGames(config) {
  return config.seeds.flatMap((seed, pair) => (config.paired ? ['human', 'ai'] : [pair % 2 ? 'ai' : 'human'])
    .map(challengerSide => ({ seed, pair, challengerSide })))
    .map((game, index) => ({ ...game, index, id: String(index + 1).padStart(5, '0') }));
}

export function sourceHashes(sourceRoot) {
  const modules = [];
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      ensure(!entry.isSymbolicLink(), 'Source bundles must contain ordinary files, not untracked symbolic links');
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.js'))
        modules.push(path.relative(sourceRoot, file).split(path.sep).join('/'));
    }
  };
  visit(sourceRoot);
  ensure(['ai.js', 'ai-worker.js', 'resignation.js', 'engine.js', 'formations.js', 'beliefs.js', 'ai-context.js'].every(name => modules.includes(name)),
    'Source bundle is missing a required module');
  return { ...Object.fromEntries(modules.sort().map(name => [name, hash(readFileSync(path.join(sourceRoot, name)))])),
    harness: hash(json(harnessFiles())) };
}

async function bundle(sourceRoot, hashes) {
  const signature = json(hashes), previous = loadedSources.get(sourceRoot);
  ensure(!previous || previous === signature, 'Source changed in this process; start a fresh process to load the new candidate');
  loadedSources.set(sourceRoot, signature);
  const [ai, engine, formations, context, resignation] = await Promise.all(['ai.js', 'engine.js', 'formations.js', 'ai-context.js', 'resignation.js']
    .map(name => import(pathToFileURL(path.join(sourceRoot, name)).href)));
  return { ...engine, ...formations, ...context, ...ai, ...resignation };
}

function atomicWrite(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, json(value) + '\n', { flag: 'wx' }); renameSync(temporary, file); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function requireIsolation(output) {
  ensure(path.extname(output).toLowerCase() === '.json', 'Output must be a JSON report file');
  if (process.env.APPDATA) {
    const realData = path.resolve(process.env.APPDATA, '军棋·暗战').toLowerCase();
    const location = output.toLowerCase();
    ensure(location !== realData && !location.startsWith(realData + path.sep), 'Self-play output cannot use the real game userData directory');
  }
}
function exclusions(config) {
  const used = new Set(), reports = [];
  for (const file of config.trainingReports) {
    const bytes = readFileSync(file), report = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    ensure([1, 2].includes(report.schema) && report.protocol?.mode === 'training' && Array.isArray(report.protocol.seeds),
      `Not a self-play training report: ${file}`);
    report.protocol.seeds.forEach(seed => used.add(seed));
    reports.push({ file, sha256: hash(bytes), seeds: report.protocol.seeds.slice() });
  }
  if (config.mode === 'acceptance') ensure(config.seeds.every(seed => !used.has(seed)), 'Acceptance seeds overlap a supplied training report');
  return reports;
}

function newRecord(descriptor, protocol, api) {
  const { seed, challengerSide, id } = descriptor;
  const levels = { challenger: 'hell', opponent: protocol.opponent };
  const layouts = Object.fromEntries(Object.entries(levels).map(([policy, difficulty]) =>
    [policy, api.createAILayout(difficulty, seeded(seedFor(seed, policy, 'layout')))]));
  const sides = { [challengerSide]: 'challenger', [challengerSide === 'human' ? 'ai' : 'human']: 'opponent' };
  const boardFor = side => {
    const base = layouts[sides[side]];
    return Array.from({ length: 60 }, (_, at) => {
      const piece = base[side === 'human' ? 59 - at : at];
      return piece ? { ...piece, id: `self-${id}-${side}-${at}`, side, origin: at, moved: false } : null;
    });
  };
  const game = api.createGame(boardFor('human'), boardFor('ai'), { engineerMountains: true });
  game.gameId = `self-play-${protocol.mode}-${seed}-${challengerSide}`;
  const contexts = Object.fromEntries(Object.entries(sides).map(([side, policy]) =>
    [side, api.sanitizeAIContext(api.createAIContext(seedFor(seed, policy, 'context')))]));
  return { schema: 2, descriptor, sides, contexts, game, decisions: [], resignationDecision: null, failures: [], status: 'active',
    terminal: false, terminalKind: null, winner: null, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}

// Verify the claim with the frozen public proof, not with the saved boolean or
// private referee ranks. A deterministic node bound rechecks the certificate;
// it does not recreate the recorded wall-clock decision or its actual budget.
export function verifyResignation(observation, response, api) {
  const proof = response?.resignation?.proof;
  ensure(!observation.result && observation.turn === observation.side && response?.move === null && response?.info === null &&
    !response.error && response.resignation?.resign === true && response.resignation.reason === 'forced-loss' &&
    proof && [2, 4, 6].includes(proof.maxPlies) && Number.isFinite(proof.elapsedMs) && proof.elapsedMs >= 0,
  'Malformed resignation response');
  const verified = api.assessResignation(observation, { clock: () => 0, nodeLimit: 500000, maxPlies: 6 });
  ensure(verified.resign === true && verified.reason === 'forced-loss', 'Resignation has no complete public forced-loss proof');
  const facts = value => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'elapsedMs'));
  ensure(json(facts(proof)) === json(facts(verified.proof)), 'Resignation proof facts differ from the independent public check');
  return verified;
}

// Reconstruct saved state with the referee before resuming; never trust an
// edited board, outcome, move count, or checkpoint's private repetition hash.
export function validateRecord(record, descriptor, protocol, api) {
  ensure(protocol.decisionEntry === (protocol.testOnly ? 'test-policy' : DESKTOP_ENTRY) &&
    json(protocol.harnessFiles) === json(harnessFiles()), 'Checkpoint uses a different decision entry or harness');
  const expected = newRecord(descriptor, protocol, api);
  ensure(record.schema === 2 && json(record.descriptor) === json(descriptor) &&
    json(record.sides) === json(expected.sides) && json(record.contexts) === json(expected.contexts) &&
    json(record.game.initial) === json(expected.game.initial), 'Checkpoint layout, sides, or context differ from the frozen protocol');
  ensure(Array.isArray(record.decisions) && record.decisions.length === record.game.history.length, 'Checkpoint is missing decisions');
  let reconstructed = expected.game;
  for (let index = 0; index < record.game.history.length; index++) {
    const event = record.game.history[index], decision = record.decisions[index];
    ensure(decision.ply === index + 1 && decision.side === reconstructed.turn &&
      decision.policy === record.sides[reconstructed.turn] && decision.from === event.from && decision.to === event.to &&
      decision.difficulty === (decision.policy === 'challenger' ? 'hell' : protocol.opponent) &&
      decision.rngSeed === seedFor(descriptor.seed, decision.policy, index, 'move') &&
      Number.isFinite(decision.elapsedMs) && decision.elapsedMs >= 0 && decision.info && typeof decision.info === 'object',
    'Checkpoint decision does not match its move or policy');
    const observation = api.makeObservation(reconstructed, reconstructed.turn);
    ensure(decision.observationSha256 === hash(json(observation)), 'Checkpoint decision did not record the expected public observation');
    reconstructed = api.applyMove(reconstructed, event.from, event.to);
    ensure(json(reconstructed.history.at(-1)) === json(event), 'Checkpoint combat record differs from the referee');
  }
  const resignation = record.resignationDecision;
  if (resignation !== null) {
    ensure(resignation && !reconstructed.result && reconstructed.ply < protocol.maxPlies &&
      resignation.afterPly === reconstructed.ply && resignation.side === reconstructed.turn &&
      resignation.policy === record.sides[reconstructed.turn] &&
      resignation.difficulty === (resignation.policy === 'challenger' ? 'hell' : protocol.opponent) &&
      resignation.rngSeed === seedFor(descriptor.seed, resignation.policy, reconstructed.ply, 'move') &&
      Number.isFinite(resignation.elapsedMs) && resignation.elapsedMs >= 0,
    'Resignation decision does not match the final public turn');
    const observation = api.makeObservation(reconstructed, reconstructed.turn);
    ensure(resignation.observationSha256 === hash(json(observation)), 'Resignation observation hash mismatch');
    verifyResignation(observation, resignation.response, api);
    reconstructed = { ...reconstructed, result: { winner: reconstructed.turn === 'ai' ? 'human' : 'ai', reason: 'resign' } };
  }
  for (const key of ['board', 'turn', 'ply', 'quiet', 'result', 'rules', 'revealedFlags', 'repetitions', 'gameId'])
    ensure(json(record.game[key]) === json(reconstructed[key]), `Checkpoint referee state mismatch: ${key}`);
  ensure(record.game.ply <= protocol.maxPlies, 'Checkpoint exceeds the game limit');
  const terminal = !!reconstructed.result, capped = !terminal && reconstructed.ply >= protocol.maxPlies;
  const terminalKind = terminal ? resignation ? 'resignation' : 'rule' : null;
  const winner = terminal ? reconstructed.result.winner === null ? 'draw' : record.sides[reconstructed.result.winner] : capped ? 'capped' : null;
  ensure(record.terminal === terminal && record.terminalKind === terminalKind && record.winner === winner &&
    (terminal || capped ? record.status === 'finished' : ['active', 'failed'].includes(record.status)), 'Checkpoint outcome mismatch');
  return record;
}

function summary(records, protocol) {
  const list = [...records.values()], finished = list.filter(record => record.status === 'finished');
  const count = winner => finished.filter(record => record.winner === winner).length;
  const wins = count('challenger'), losses = count('opponent'), draws = count('draw'), capped = count('capped');
  const errors = list.reduce((sum, record) => sum + record.failures.length, 0);
  return { planned: protocol.games, finished: finished.length, terminal: finished.length - capped,
    ruleTerminals: finished.filter(record => record.terminalKind === 'rule').length,
    resignations: finished.filter(record => record.terminalKind === 'resignation').length,
    challengerWins: wins, opponentWins: losses, ruleDraws: draws, capped, errors,
    unfinished: protocol.games - finished.length, winsNeeded: Math.floor(protocol.games * .9) + 1,
    winRate: wins / protocol.games, scoreBounds: [(wins + draws * .5) / protocol.games,
      (wins + draws * .5 + capped + protocol.games - finished.length) / protocol.games] };
}
function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return { count: sorted.length, min: sorted[0], median: sorted[Math.floor(sorted.length * .5)],
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))], max: sorted.at(-1),
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length };
}
export function searchSummary(records) {
  const rows = [...records.values()].flatMap(record => record.decisions), result = {};
  for (const policy of ['challenger', 'opponent']) {
    const decisions = rows.filter(row => row.policy === policy);
    const resignations = [...records.values()].map(record => record.resignationDecision).filter(row => row?.policy === policy);
    result[policy] = { moves: decisions.length, elapsedMs: distribution(decisions.map(row => row.elapsedMs)),
      resignations: resignations.length, resignationElapsedMs: distribution(resignations.map(row => row.elapsedMs)),
      completedDepth: distribution(decisions.map(row => row.info.diagnostics?.completedDepth)),
      searchedNodes: distribution(decisions.map(row => row.info.searchedNodes)),
      depthCounts: decisions.reduce((counts, row) => { const depth = row.info.diagnostics?.completedDepth ?? 'unreported';
        counts[depth] = (counts[depth] || 0) + 1; return counts; }, {}) };
  }
  return result;
}

export async function runSelfPlay(config, controls = {}) {
  requireIsolation(config.output);
  const hashes = sourceHashes(config.sourceRoot), sourceUnchanged = () => json(sourceHashes(config.sourceRoot)) === json(hashes);
  ensure(!config.expectedSha || config.expectedSha === hashes['ai.js'], 'Candidate AI hash differs from --expected-sha');
  ensure(!controls.policy || config.mode === 'training', 'Test policies cannot run an acceptance protocol');
  const api = await bundle(config.sourceRoot, hashes), trainingReports = exclusions(config);
  const protocol = { mode: config.mode, challenger: 'hell', opponent: config.opponent, paired: config.paired,
    games: config.games, maxPlies: config.maxPlies, seeds: config.seeds, seedPool: config.seedPool,
    sourceRoot: config.sourceRoot, trainingReports, testOnly: !!controls.policy,
    decisionEntry: controls.policy ? 'test-policy' : DESKTOP_ENTRY, harnessFiles: harnessFiles(),
    budgets: Object.fromEntries(['hell', 'professional'].map(level => [level, api.DIFFICULTIES[level].timeLimitMs])),
    information: 'makeObservation and sanitized playing context only; no profile, archive, referee board, or seed describing the opposing layout is passed to either policy.',
    pairing: 'Each policy keeps its own generated difficulty-specific formation and context while rotating the board and swapping first/second move.',
    adjudication: 'Referee rule terminals and independently public-proven desktop resignations are recorded separately. Ply caps remain unresolved and never count as wins or rule draws.',
    reproducibility: 'Layouts and decision RNG seeds are fixed. Real wall-clock budgets may produce different completed depths across loads or hardware.' };
  const plan = planGames(config), records = new Map(), directory = config.output.replace(/\.json$/i, '.games');
  const recordPath = descriptor => path.join(directory, descriptor.id + '.json');
  let startedAt = new Date().toISOString(), stopped = false, runError = null;
  if (config.resume) {
    const saved = read(config.output);
    ensure(saved.schema === 2 && json(saved.sourceHashes) === json(hashes) && json(saved.protocol) === json(protocol),
      'Resume requires identical source hashes, seed plan, policy, budgets and protocol');
    startedAt = saved.startedAt;
    for (const descriptor of plan) if (existsSync(recordPath(descriptor)))
      records.set(descriptor.id, validateRecord(read(recordPath(descriptor)), descriptor, protocol, api));
  } else {
    ensure(!existsSync(config.output), 'Output already exists; use --resume with the identical protocol or choose a new output');
    ensure(!existsSync(directory) || readdirSync(directory).length === 0, 'Checkpoint directory already contains records');
  }
  const saveReport = () => {
    const aggregate = summary(records, protocol), unchanged = sourceUnchanged();
    const completed = aggregate.finished === protocol.games && !runError && unchanged;
    const eligible = protocol.mode === 'acceptance' && protocol.opponent === 'professional' && protocol.paired &&
      protocol.games === 20 && !protocol.testOnly && protocol.decisionEntry === DESKTOP_ENTRY && trainingReports.length > 0 && !aggregate.errors;
    const report = { schema: 2, startedAt, updatedAt: new Date().toISOString(), completed, sourceUnchanged: unchanged,
      sourceHashes: hashes, protocol, summary: aggregate, search: searchSummary(records),
      acceptance: { eligible, passed: eligible && completed && aggregate.terminal === protocol.games && aggregate.challengerWins >= 19,
        reason: protocol.mode !== 'acceptance' ? 'training-run' : !trainingReports.length ? 'training-seed-exclusion-not-evidenced' :
          !eligible ? 'protocol-not-eligible' : !completed ? 'incomplete-run' : aggregate.capped ? 'unresolved-caps' : 'at-least-19-wins-in-20-rule-terminal-games-required' },
      games: plan.map(descriptor => { const record = records.get(descriptor.id); return { ...descriptor,
        file: path.relative(path.dirname(config.output), recordPath(descriptor)), status: record?.status || 'pending',
        terminal: record?.terminal || false, winner: record?.winner || null, plies: record?.game.ply || 0,
        terminalKind: record?.terminalKind || null,
        reason: record?.game.result?.reason || (record?.winner === 'capped' ? 'evaluation-ply-cap' : null),
        recordSha256: record ? hash(readFileSync(recordPath(descriptor))) : null }; }),
      ...(runError ? { error: runError } : {}), interrupted: stopped };
    atomicWrite(config.output, report); return report;
  };
  const stop = () => { stopped = true; };
  if (controls.signals !== false) { process.on('SIGINT', stop); process.on('SIGTERM', stop); }
  let advanced = 0;
  const clients = new Map();
  const closeClients = async () => { await Promise.all([...clients.values()].map(client => client.close())); clients.clear(); };
  try {
    saveReport();
    for (const descriptor of plan) {
      if (stopped || controls.shouldStop?.() || advanced >= (controls.stopAfterPlies ?? Infinity)) { stopped = true; break; }
      let record = records.get(descriptor.id);
      if (record?.status === 'finished') continue;
      if (!record) { record = newRecord(descriptor, protocol, api); records.set(descriptor.id, record); }
      record.status = 'active'; atomicWrite(recordPath(descriptor), record); saveReport();
      while (!record.game.result && record.game.ply < protocol.maxPlies) {
        if (stopped || controls.shouldStop?.() || advanced >= (controls.stopAfterPlies ?? Infinity)) { stopped = true; break; }
        ensure(sourceUnchanged(), 'Source changed during this run; its results cannot be combined with a new candidate');
        const side = record.game.turn, policy = record.sides[side], difficulty = policy === 'challenger' ? 'hell' : protocol.opponent;
        const observation = freeze(api.makeObservation(record.game, side)), observationSha256 = hash(json(observation));
        const rngSeed = seedFor(descriptor.seed, policy, record.game.ply, 'move'), tick = performance.now();
        let move, response;
        try {
          const context = freeze(api.sanitizeAIContext(record.contexts[side]));
          if (controls.policy) {
            move = controls.policy(observation, difficulty, seeded(rngSeed), null, context);
            response = { move, info: move?.info || null };
          } else {
            if (!clients.has(side)) clients.set(side, createDesktopPolicy(config.sourceRoot));
            response = await clients.get(side).decide({ observation, difficulty, context, rngSeed });
            ensure(response && !response.error, response?.error || 'Desktop Worker returned no response');
            move = response.move;
          }
          const elapsedMs = performance.now() - tick;
          ensure(sourceUnchanged(), 'Source changed while a decision was being computed');
          if (response.resignation?.resign === true) {
            verifyResignation(observation, response, api);
            record.resignationDecision = { afterPly: record.game.ply, side, policy, difficulty, rngSeed,
              observationSha256, elapsedMs, response: structuredClone(response) };
            record.game = { ...record.game, result: { winner: side === 'ai' ? 'human' : 'ai', reason: 'resign' } };
          } else {
            ensure(move && record.game.board[move.from]?.side === side && api.legalMoves(record.game.board, move.from).includes(move.to),
              `Policy returned an illegal move at ply ${record.game.ply + 1}`);
            const decision = { ply: record.game.ply + 1, side, policy, difficulty, rngSeed, observationSha256,
              from: move.from, to: move.to, elapsedMs, info: structuredClone(move.info || {}) };
            record.game = api.applyMove(record.game, move.from, move.to);
            record.decisions.push(decision); advanced++;
          }
        } catch (error) {
          record.failures.push({ at: new Date().toISOString(), ply: record.game.ply + 1, side, policy,
            error: String(error.message || error), elapsedMs: performance.now() - tick,
            ...(response ? { response: structuredClone(response) } : {}),
            ...(move ? { attemptedMove: { from: move.from, to: move.to, info: structuredClone(move.info || {}) } } : {}) });
          record.status = 'failed'; atomicWrite(recordPath(descriptor), record); throw error;
        }
        record.terminal = !!record.game.result;
        record.terminalKind = record.terminal ? record.resignationDecision ? 'resignation' : 'rule' : null;
        if (record.terminal || record.game.ply >= protocol.maxPlies) {
          record.status = 'finished';
          record.winner = record.terminal ? record.game.result.winner === null ? 'draw' : record.sides[record.game.result.winner] : 'capped';
        }
        record.updatedAt = new Date().toISOString(); atomicWrite(recordPath(descriptor), record); saveReport();
        controls.onProgress?.({ game: descriptor.id, seed: descriptor.seed, challengerSide: descriptor.challengerSide,
          ply: record.game.ply, status: record.status, terminal: record.terminal, winner: record.winner });
        await yieldTurn();
      }
      await closeClients();
      if (stopped) break;
    }
    return saveReport();
  } catch (error) { runError = String(error.message || error); saveReport(); throw error; }
  finally { await closeClients(); if (controls.signals !== false) { process.off('SIGINT', stop); process.off('SIGTERM', stop); } }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config = parseArgs(process.argv.slice(2));
    if (config.help) console.log('node benchmarks/self-play-v2.mjs --mode training|acceptance --opponent professional|hell --games 4 --paired true --seed 123 [--seeds 123,456] --max-plies 400 --source-root ./dist --output benchmarks/run.json [--resume] [--expected-sha SHA256] [--training-reports train1.json,train2.json]\nAcceptance defaults to a separate 20-game seed pool. Keep it unused during tuning. Complete training-report exclusions are required before a score is marked accepted. Resume must use the same arguments, hashes and source bundle. Every JavaScript file in the source bundle is frozen, including nested modules.');
    else {
      const report = await runSelfPlay(config, { onProgress: row => {
        if (row.ply % 10 === 0 || row.status === 'finished') console.log(json({ progress: row }));
      } });
      console.log(json({ output: config.output, completed: report.completed, summary: report.summary, acceptance: report.acceptance }));
      if (report.interrupted) process.exitCode = 130;
    }
  } catch (error) { console.error(String(error.stack || error)); process.exitCode = 1; }
}
