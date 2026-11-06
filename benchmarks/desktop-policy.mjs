// Node transport only: the unmodified desktop Worker owns resignation and budgets.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function seeded(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

if (!isMainThread) {
  let active = null;
  globalThis.self = { postMessage(response) {
    if (!active || active.sent || response?.requestId !== active.id) throw new Error('Invalid desktop Worker response');
    active.sent = true; parentPort.postMessage({ kind: 'response', response });
  } };
  await import(pathToFileURL(path.join(workerData.sourceRoot, 'ai-worker.js')).href);
  if (typeof self.onmessage !== 'function') throw new Error('Desktop Worker has no message handler');
  parentPort.on('message', message => {
    const originalRandom = Math.random;
    try {
      if (active || !Number.isSafeInteger(message.rngSeed) || message.rngSeed < 0 || message.rngSeed > 0xffffffff)
        throw new Error('Invalid or overlapping decision');
      active = { id: message.requestId, sent: false };
      Math.random = seeded(message.rngSeed);
      // The layout/referee never enters this envelope. rngSeed only seeds the
      // random function; it is not a field in the desktop policy's observation.
      self.onmessage({ data: freeze({ requestId: message.requestId, observation: message.observation,
        difficulty: message.difficulty, context: message.context, learningProfile: null }) });
      if (!active.sent) throw new Error('Desktop Worker did not return a decision');
    } catch (error) {
      parentPort.postMessage({ kind: 'failure', requestId: message.requestId, error: String(error.stack || error) });
    } finally { Math.random = originalRandom; active = null; }
  });
  parentPort.postMessage({ kind: 'ready' });
}

export function createDesktopPolicy(sourceRoot) {
  if (!isMainThread) throw new Error('Policy clients belong in the referee process');
  const worker = new Worker(new URL(import.meta.url), { workerData: { sourceRoot: path.resolve(sourceRoot) }, execArgv: [] });
  let sequence = 0, pending = null, closed = false, fatal = null, readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  // Attach immediately so initialization errors cannot become unhandled while
  // the referee is preparing a record. decide() still receives the rejection.
  ready.catch(() => {});
  const fail = error => {
    fatal = error; readyReject(error);
    if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = null; }
  };
  const startup = setTimeout(() => { fail(new Error('Desktop Worker initialization timed out')); void worker.terminate(); }, 25000);
  worker.on('error', fail);
  worker.on('exit', code => { clearTimeout(startup); if (!closed) fail(new Error(`Desktop Worker exited unexpectedly (${code})`)); });
  worker.on('message', message => {
    if (message.kind === 'ready') { clearTimeout(startup); readyResolve(); return; }
    if (!pending) { fail(new Error('Unsolicited desktop Worker response')); return; }
    const requestId = message.response?.requestId ?? message.requestId;
    if (requestId !== pending.id) { fail(new Error('Desktop Worker request identity mismatch')); return; }
    const current = pending; pending = null; clearTimeout(current.timer);
    if (message.kind === 'response') current.resolve(message.response);
    else current.reject(new Error(message.error || 'Desktop Worker failed'));
  });
  return {
    async decide({ observation, difficulty, context, rngSeed }) {
      await ready;
      if (closed || fatal) throw fatal || new Error('Desktop Worker client is closed');
      if (pending) throw new Error('Overlapping desktop policy decisions');
      const requestId = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { fail(new Error('Desktop policy exceeded the desktop 25-second watchdog')); void worker.terminate(); }, 25000);
        pending = { id: requestId, resolve, reject, timer };
        worker.postMessage({ requestId, observation, difficulty, context, rngSeed });
      });
    },
    async close() { closed = true; clearTimeout(startup); fail(new Error('Desktop Worker client closed')); await worker.terminate(); },
  };
}
