import { chooseMove, DIFFICULTIES } from './ai.js';
import { sanitizeAIContext } from './ai-context.js';
import { assessResignation } from './resignation.js';

self.onmessage = event => {
  const { observation, difficulty, requestId, learningProfile, context } = event.data;
  try {
    const started = performance.now(), totalBudget = DIFFICULTIES[difficulty === 'hell' ? 'hell' : 'professional'].timeLimitMs;
    const resignation = assessResignation(observation, {
      timeLimitMs: difficulty === 'hell' ? 240 : 120, maxPlies: 6,
    });
    if (resignation.resign) {
      self.postMessage({ requestId, move: null, info: null, resignation });
      return;
    }
    const proofMs = performance.now() - started;
    const move = chooseMove(observation, difficulty, Math.random, learningProfile, sanitizeAIContext(context),
      { timeLimitMs: Math.max(0, totalBudget - proofMs) });
    if (move?.info?.diagnostics) {
      const diagnostics = move.info.diagnostics;
      diagnostics.searchTimeLimitMs = diagnostics.timeLimitMs;
      diagnostics.resignationCheckMs = Math.round(proofMs * 100) / 100;
      diagnostics.timeLimitMs = totalBudget;
      diagnostics.elapsedMs = Math.round(performance.now() - started);
    }
    self.postMessage({ requestId, move, info: move?.info || null });
  } catch (error) {
    self.postMessage({ requestId, move: null, error: String(error?.message || error) });
  }
};
