// Parallel independent games; the complete seed plan is committed before play.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, linkSync, unlinkSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, planGames, sourceHashes, validateRecord, DESKTOP_ENTRY, harnessFiles } from './self-play-v2.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const check = (condition, message) => { if (!condition) throw new Error(message); };
const loadedValidationSources = new Map();
function write(file, value, exclusive = false) {
  const tmp = file + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
    if (exclusive) linkSync(tmp, file); else renameSync(tmp, file);
  } finally { if (existsSync(tmp)) unlinkSync(tmp); }
}

const canonicalParts = config => config.seeds.map((seed, index) => ({ seed,
  output: path.join(config.output.replace(/\.json$/i, '.parts'), `${index + 1}-${seed}.json`) }));
export function validatePlan(plan, config = plan.config) {
  check(plan.schema === 1 && config.paired && Number.isSafeInteger(config.games) && config.games > 0 &&
    Array.isArray(config.seeds) && config.seeds.length * 2 === config.games &&
    config.seeds.every(seed => Number.isSafeInteger(seed) && seed >= 0 && seed <= 0xffffffff) &&
    new Set(config.seeds).size === config.seeds.length && same(plan.parts, canonicalParts(config)),
  'Batch parts must match the complete, unique frozen seed plan');
}

// Capture planned seeds as well as played seeds. A still-running parallel part
// is already exposed for tuning; its unfinished state cannot omit its seed.
export function collectExclusions(files, acceptanceSeeds = []) {
  const sources = [], seeds = new Set(), visiting = new Set(), visited = new Set();
  const visit = file => {
    file = path.resolve(file);
    check(!visiting.has(file), 'Cyclic seed exclusion references');
    if (visited.has(file)) return;
    visiting.add(file);
    const bytes = readFileSync(file), document = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    let planned, sourceMode, purpose;
    if (document.config?.seeds && document.parts) {
      validatePlan(document);
      planned = document.config.seeds; sourceMode = document.config.mode; purpose = 'complete-batch-plan';
    } else if (document.plan && document.parts) {
      sources.push({ file, sha256: hash(bytes), purpose: 'batch-report-reference', completed: document.verified === true });
      visit(path.resolve(path.dirname(file), document.plan));
    } else if (document.protocol?.seeds) {
      planned = Array.isArray(document.protocol.seeds) ? document.protocol.seeds : Object.values(document.protocol.seeds).flat();
      sourceMode = document.protocol.mode || 'comparison'; purpose = document.purpose || 'previous-run-seeds';
    } else throw new Error(`No complete seed plan in exclusion source: ${file}`);
    if (planned) {
      check(Array.isArray(planned) && planned.length > 0 && planned.every(seed => Number.isSafeInteger(seed) && seed >= 0 && seed <= 0xffffffff),
        `Invalid exclusion seeds: ${file}`);
      planned.forEach(seed => seeds.add(seed));
      sources.push({ file, sha256: hash(bytes), purpose, sourceMode, seeds: [...new Set(planned)],
        completed: document.completed === true, plannedGames: document.config?.games || document.protocol?.games || null });
    }
    visiting.delete(file); visited.add(file);
  };
  files.forEach(visit);
  check(acceptanceSeeds.every(seed => !seeds.has(seed)), 'Acceptance seeds overlap previously exposed training or evaluation seeds');
  return { schema: 1, purpose: 'seed-exclusion-snapshot-only-not-training-results',
    protocol: { mode: 'training', seeds: [...seeds].sort((a, b) => a - b) }, sources,
    note: 'The compatibility mode field lets the frozen self-play runner read this exclusion list. No wins, losses, training completion, or complete historical coverage are claimed.' };
}

export function scoreBatch(plan, reports) {
  const games = reports.flatMap(report => report.games || []);
  const count = outcome => games.filter(game => game.status === 'finished' && game.winner === outcome).length;
  const wins = count('challenger'), losses = count('opponent'), draws = count('draw'), capped = count('capped');
  const errors = reports.reduce((total, report) => total + (report.summary?.errors || 0) + Number(!!report.error), 0);
  const expectedSeeds = plan.config.seeds || plan.parts.map(part => part.seed);
  const pairs = reports.flatMap(report => report.games || []).map(game => `${game.seed}:${game.challengerSide}`);
  const expectedPairs = expectedSeeds.flatMap(seed => [`${seed}:human`, `${seed}:ai`]);
  const reportSeeds = reports.map(report => report.protocol?.seeds?.length === 1 ? report.protocol.seeds[0] : null);
  const coverage = expectedSeeds.length * 2 === plan.config.games && new Set(expectedSeeds).size === expectedSeeds.length &&
    plan.parts.length === expectedSeeds.length && plan.parts.every((part, index) => part.seed === expectedSeeds[index]) &&
    reportSeeds.every(seed => expectedSeeds.includes(seed)) && new Set(reportSeeds).size === reportSeeds.length &&
    pairs.every(pair => expectedPairs.includes(pair)) && new Set(pairs).size === pairs.length &&
    games.every(game => game.status !== 'finished' ||
      (['challenger', 'opponent', 'draw', 'capped'].includes(game.winner) && game.terminal === (game.winner !== 'capped') &&
        (game.terminal ? ['rule', 'resignation'].includes(game.terminalKind) : game.terminalKind === null)));
  const complete = coverage && reports.length === plan.parts.length && pairs.length === expectedPairs.length &&
    reports.every(report => report.completed === true && report.sourceUnchanged === true && report.games.length === 2);
  const terminal = games.filter(game => game.status === 'finished' && game.terminal).length;
  const ruleTerminals = games.filter(game => game.status === 'finished' && game.terminalKind === 'rule').length;
  const resignations = games.filter(game => game.status === 'finished' && game.terminalKind === 'resignation').length;
  const eligible = plan.config.mode === 'acceptance' && plan.config.opponent === 'professional' &&
    plan.config.games === 20 && plan.config.paired && plan.config.trainingReports.length > 0 &&
    reports.every(report => report.schema === 2 && report.protocol.testOnly === false &&
      report.protocol.decisionEntry === DESKTOP_ENTRY && same(report.protocol.harnessFiles, harnessFiles())) && !errors;
  return { planned: plan.config.games, wins, losses, draws, capped, errors, terminal, ruleTerminals, resignations,
    pending: Math.max(0, plan.config.games - wins - losses - draws - capped), complete, coverageValid: coverage,
    winRate: wins / plan.config.games, eligible,
    // All twenty must finish under the actual rules. A cap is never a victory.
    passed: eligible && complete && terminal === 20 && games.length === 20 && wins >= 19 };
}

export async function verifyPart(plan, part, report) {
  check(report.schema === 2, `Invalid report schema in ${part.output}; current verification requires desktop Worker reports`);
  check(same(report.sourceHashes, plan.sourceHashes), `Different source in ${part.output}`);
  check(report.protocol.mode === plan.config.mode && report.protocol.opponent === plan.config.opponent &&
    report.protocol.games === 2 && report.protocol.paired && same(report.protocol.seeds, [part.seed]) &&
    report.protocol.maxPlies === plan.config.maxPlies && report.protocol.sourceRoot === plan.config.sourceRoot &&
    report.protocol.budgets.hell === 5000 && report.protocol.budgets.professional === 900 &&
    report.protocol.testOnly === false && report.protocol.decisionEntry === DESKTOP_ENTRY &&
    same(report.protocol.harnessFiles, harnessFiles()), `Different protocol in ${part.output}`);
  check(report.protocol.trainingReports.length === plan.exclusions.length &&
    report.protocol.trainingReports.every((item, i) => item.file === plan.exclusions[i].file &&
      item.sha256 === plan.exclusions[i].sha256 && same(item.seeds, plan.exclusions[i].seeds)), `Different training exclusions in ${part.output}`);
  const expectedGames = planGames({ seeds: [part.seed], paired: true });
  check(report.games.length === 2 && new Set(report.games.map(game => game.id)).size === 2,
    `Missing paired colors in ${part.output}`);
  check(same(sourceHashes(plan.config.sourceRoot), plan.sourceHashes), 'Validation source differs from the frozen candidate');
  const sourceSignature = JSON.stringify(plan.sourceHashes), priorSignature = loadedValidationSources.get(plan.config.sourceRoot);
  check(!priorSignature || priorSignature === sourceSignature, 'Source changed in this verifier process; restart before verifying a new candidate');
  loadedValidationSources.set(plan.config.sourceRoot, sourceSignature);
  const modules = await Promise.all(['engine.js', 'formations.js', 'ai-context.js', 'resignation.js']
    .map(name => import(pathToFileURL(path.join(plan.config.sourceRoot, name)).href)));
  const api = Object.assign({}, ...modules);
  const records = [];
  for (const item of report.games) {
    const descriptor = expectedGames.find(game => game.id === item.id);
    check(descriptor && Object.entries(descriptor).every(([key, value]) => item[key] === value), 'Game identity differs from the frozen paired plan');
    const recordPath = path.join(part.output.replace(/\.json$/i, '.games'), descriptor.id + '.json');
    check(path.resolve(path.dirname(part.output), item.file) === recordPath, 'Record path differs from its canonical game identity');
    const bytes = readFileSync(recordPath);
    check(hash(bytes) === item.recordSha256, 'Recorded game hash mismatch');
    const record = JSON.parse(bytes);
    validateRecord(record, descriptor, report.protocol, api);
    check(Array.isArray(record.failures) && record.failures.every(failure => typeof failure.error === 'string' &&
      Number.isInteger(failure.ply) && failure.ply >= 1), 'Invalid recorded policy failures');
    check(item.seed === part.seed && item.terminal === record.terminal && item.winner === record.winner &&
      item.plies === record.game.ply && item.status === record.status && item.terminalKind === record.terminalKind &&
      item.reason === (record.game.result?.reason || (record.winner === 'capped' ? 'evaluation-ply-cap' : null)), 'Report disagrees with replay');
    for (const decision of record.decisions) {
      const diagnostic = decision.info.diagnostics;
      check(diagnostic && diagnostic.timeLimitMs === report.protocol.budgets[decision.difficulty] &&
        Number.isSafeInteger(diagnostic.completedDepth) && diagnostic.completedDepth >= 0 &&
        Number.isSafeInteger(diagnostic.attemptedDepth) && diagnostic.completedDepth <= diagnostic.attemptedDepth &&
        Number.isSafeInteger(decision.info.searchedNodes) && decision.info.searchedNodes >= 0 &&
        Number.isFinite(diagnostic.elapsedMs) && diagnostic.elapsedMs >= 0 &&
        Number.isFinite(diagnostic.resignationCheckMs) && diagnostic.resignationCheckMs >= 0 &&
        Number.isFinite(diagnostic.searchTimeLimitMs) && diagnostic.searchTimeLimitMs >= 0 &&
        diagnostic.searchTimeLimitMs <= report.protocol.budgets[decision.difficulty] &&
        Math.abs(diagnostic.searchTimeLimitMs - Math.max(0, diagnostic.timeLimitMs - diagnostic.resignationCheckMs)) <= 0.02 &&
        decision.info.searchDepth === diagnostic.completedDepth, 'Missing production search diagnostics');
    }
    records.push(record);
  }
  const finished = records.filter(record => record.status === 'finished');
  const count = winner => finished.filter(record => record.winner === winner).length;
  const wins = count('challenger'), losses = count('opponent'), draws = count('draw'), capped = count('capped');
  const errors = records.reduce((total, record) => total + record.failures.length, 0);
  const actual = { planned: 2, finished: finished.length, terminal: finished.length - capped,
    ruleTerminals: finished.filter(record => record.terminalKind === 'rule').length,
    resignations: finished.filter(record => record.terminalKind === 'resignation').length,
    challengerWins: wins, opponentWins: losses, ruleDraws: draws, capped, errors, unfinished: 2 - finished.length, winsNeeded: 2,
    winRate: wins / 2, scoreBounds: [(wins + draws * .5) / 2, (wins + draws * .5 + capped + 2 - finished.length) / 2] };
  check(same(report.summary, actual), 'Report summary disagrees with raw outcomes or policy failures');
  check(report.completed === (finished.length === 2 && !report.error && report.sourceUnchanged === true), 'Report completion disagrees with raw games');
  return structuredClone(report);
}

export async function runBatch(config, jobs = 4) {
  check(path.extname(config.output).toLowerCase() === '.json', 'Batch output must be JSON');
  if (process.env.APPDATA) {
    const realData = path.resolve(process.env.APPDATA, '军棋·暗战').toLowerCase(), output = path.resolve(config.output).toLowerCase();
    check(output !== realData && !output.startsWith(realData + path.sep), 'Batch output cannot use real game userData');
  }
  check(config.paired, 'Batch runner requires paired games');
  check(Number.isInteger(jobs) && jobs >= 1 && jobs <= 8, 'Use 1..8 concurrent workers');
  const directory = config.output.replace(/\.json$/i, '.parts');
  const manifestFile = config.output.replace(/\.json$/i, '.plan.json');
  const hashes = sourceHashes(config.sourceRoot);
  check(!config.expectedSha || config.expectedSha === hashes['ai.js'], 'Candidate hash mismatch');
  const snapshotFile = config.output.replace(/\.json$/i, '.excluded-seeds.json');
  const exclusionSnapshot = collectExclusions(config.trainingReports, config.mode === 'acceptance' ? config.seeds : []);
  const snapshotText = JSON.stringify(exclusionSnapshot, null, 2) + '\n';
  const exclusions = config.trainingReports.length ? [{ file: snapshotFile, sha256: hash(snapshotText), seeds: exclusionSnapshot.protocol.seeds }] : [];
  const savedConfig = { ...config, resume: false };
  let plan = { schema: 1, createdAt: new Date().toISOString(), config: savedConfig,
    jobs, sourceHashes: hashes, exclusions, aggregatorSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
    parts: canonicalParts(config) };
  validatePlan(plan, config);
  if (config.resume) {
    const saved = read(manifestFile);
    validatePlan(saved, savedConfig);
    check(same(saved.config, savedConfig) && same(saved.sourceHashes, hashes) && same(saved.exclusions, exclusions) &&
      saved.aggregatorSha256 === plan.aggregatorSha256,
      'Cannot resume a different candidate or seed plan');
    if (exclusions.length) check(hash(readFileSync(snapshotFile)) === exclusions[0].sha256, 'Seed exclusion snapshot changed');
    plan = saved;
  } else {
    check(!existsSync(config.output) && !existsSync(manifestFile) && !existsSync(snapshotFile), 'Batch output exists; use --resume');
    mkdirSync(directory, { recursive: true });
    write(manifestFile, plan, true);
    if (exclusions.length) write(snapshotFile, exclusionSnapshot, true);
  }
  let next = 0;
  const failures = [];
  const save = (verifiedReports = null) => {
    const verified = Array.isArray(verifiedReports);
    const reports = verifiedReports || plan.parts.filter(part => existsSync(part.output)).map(part => read(part.output));
    const score = scoreBatch(plan, reports);
    const report = { schema: 1, plan: manifestFile, updatedAt: new Date().toISOString(), sourceHashes: hashes,
      summary: { ...score, passed: verified && score.passed }, verified, failures,
      parts: plan.parts.map(part => { const source = reports.find(report => same(report.protocol?.seeds, [part.seed]));
        return { ...part, ...(source ? { summary: source.summary } : {}) }; }) };
    write(config.output, report); return report;
  };
  save();
  const worker = async () => {
    while (next < plan.parts.length) {
      const part = plan.parts[next++];
      const args = [path.join(HERE, 'self-play-v2.mjs'), '--mode', config.mode, '--opponent', config.opponent,
        '--games', '2', '--paired', 'true', '--seeds', String(part.seed), '--max-plies', String(config.maxPlies),
        '--source-root', config.sourceRoot, '--output', part.output, '--expected-sha', hashes['ai.js']];
      if (exclusions.length) args.push('--training-reports', snapshotFile);
      if (config.resume && existsSync(part.output)) args.push('--resume');
      const exitCode = await new Promise(resolve => {
        const child = spawn(process.execPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', bytes => process.stdout.write(bytes));
        child.stderr.on('data', bytes => process.stderr.write(bytes));
        child.on('error', error => { failures.push({ seed: part.seed, error: String(error) }); resolve(-1); });
        child.on('close', resolve);
      });
      if (exitCode !== 0) failures.push({ seed: part.seed, exitCode });
      save();
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, plan.parts.length) }, worker));
  check(same(sourceHashes(config.sourceRoot), hashes), 'Source changed during the batch');
  const verifiedReports = [];
  if (!failures.length) for (const part of plan.parts) verifiedReports.push(await verifyPart(plan, part, read(part.output)));
  check(same(sourceHashes(config.sourceRoot), hashes), 'Source changed while verifying the batch');
  const final = save(!failures.length ? verifiedReports : null);
  console.log(JSON.stringify({ batch: config.output, ...final.summary, verified: final.verified }));
  return final;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), at = args.indexOf('--jobs');
  const jobs = at < 0 ? 4 : Number(args.splice(at, 2)[1]);
  try {
    const config = parseArgs(args);
    if (config.help) console.log('Use the self-play-v2.mjs options plus --jobs 1..8. This records the full paired seed plan before launching workers, retains all games, then independently replays every result. Seed-exclusion inputs may be previous runs, batch plans/reports, or earlier acceptance/comparison reports.');
    else { const result = await runBatch(config, jobs); if (result.failures.length) process.exitCode = 1; }
  } catch (error) { console.error(error.stack || error); process.exitCode = 1; }
}
