// A small, persistent choice of playing style. This contains no board or ranks.
export const AI_STYLES = Object.freeze(['balanced', 'pressure', 'maneuver']);

export function sanitizeAIContext(input) {
  if (!input || !AI_STYLES.includes(input.style) || ![-1, 1].includes(input.wing) ||
      !Number.isInteger(input.seed) || input.seed < 0 || input.seed > 0xffffffff) return null;
  return { style: input.style, wing: input.wing, seed: input.seed >>> 0 };
}

export function createAIContext(seed) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('Invalid playing-style seed');
  return { style: AI_STYLES[seed % AI_STYLES.length], wing: seed & 4 ? 1 : -1, seed: seed >>> 0 };
}

export function decisionDiagnostics(info) {
  // Archive only compact facts needed to examine a decision after the game.
  // Arbitrary worker objects must not be copied into the saved record.
  const diagnostics = info?.diagnostics || {};
  // Older records have no phase timings. Keep that distinct from a measured
  // zero, and retain overruns instead of clamping them to the nominal budget.
  const optionalMilliseconds = value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
  return {
    expectedScore: Number.isFinite(info?.expectedScore) ? info.expectedScore : null,
    selectionGap: Number.isFinite(diagnostics.selectionGap) ? diagnostics.selectionGap : 0,
    selectionPool: Number.isInteger(diagnostics.selectionPool) ? diagnostics.selectionPool : 1,
    provenWin: diagnostics.provenWin === true,
    quietDraw: diagnostics.quietDraw === true,
    repetitionDraw: diagnostics.repetitionDraw === true,
    allowOpponentDraw: diagnostics.allowOpponentDraw === true,
    quietTerminals: Number.isSafeInteger(diagnostics.quietTerminals) ? Math.max(0, diagnostics.quietTerminals) : 0,
    lastUnitRisk: Number.isFinite(diagnostics.lastUnitRisk) ? Math.max(0, Math.min(1, diagnostics.lastUnitRisk)) : 0,
    winInOwnMoves: [1, 2].includes(diagnostics.winInOwnMoves) ? diagnostics.winInOwnMoves : 0,
    mode: typeof diagnostics.mode === 'string' ? diagnostics.mode.slice(0, 40) : null,
    completedDepth: Number.isInteger(diagnostics.completedDepth) ? diagnostics.completedDepth : 0,
    attemptedDepth: Number.isInteger(diagnostics.attemptedDepth) ? diagnostics.attemptedDepth : 0,
    searchAborted: diagnostics.searchAborted === true,
    elapsedMs: Number.isFinite(diagnostics.elapsedMs) ? Math.max(0, Math.round(diagnostics.elapsedMs)) : 0,
    timeLimitMs: Number.isFinite(diagnostics.timeLimitMs) ? Math.max(0, Math.round(diagnostics.timeLimitMs)) : 0,
    resignationCheckMs: optionalMilliseconds(diagnostics.resignationCheckMs),
    searchTimeLimitMs: optionalMilliseconds(diagnostics.searchTimeLimitMs),
    searchedNodes: Number.isSafeInteger(info?.searchedNodes) ? Math.max(0, info.searchedNodes) : 0,
    flagReserveRisk: Number.isFinite(diagnostics.flagReserveRisk) ? Math.max(0, Math.min(1, diagnostics.flagReserveRisk)) : 0,
    flagBreachRisk: Number.isFinite(diagnostics.flagBreachRisk) ? Math.max(0, Math.min(1, diagnostics.flagBreachRisk)) : 0,
    flagRouteRisk: Number.isFinite(diagnostics.flagRouteRisk) ? Math.max(0, Math.min(1, diagnostics.flagRouteRisk)) : 0,
    flagPlannerEnabled: diagnostics.flagPlannerEnabled === true,
    flagPlannerReason: ['certified-win', 'flag-unconfirmed', 'inconsistent-beliefs', 'missing-public-domain', 'budget'].includes(diagnostics.flagPlannerReason) ? diagnostics.flagPlannerReason : null,
    flagPlannerNodes: Number.isSafeInteger(diagnostics.flagPlannerNodes) ? Math.max(0, Math.min(12000, diagnostics.flagPlannerNodes)) : 0,
    flagPlannerElapsedMs: Number.isFinite(diagnostics.flagPlannerElapsedMs) ? Math.max(0, Math.round(diagnostics.flagPlannerElapsedMs)) : 0,
    flagAttackProgress: Number.isFinite(diagnostics.flagAttackProgress) ? Math.max(-256, Math.min(256, diagnostics.flagAttackProgress)) : 0,
    flagAttackTurns: Number.isInteger(diagnostics.flagAttackTurns) && diagnostics.flagAttackTurns >= 0 && diagnostics.flagAttackTurns <= 7 ? diagnostics.flagAttackTurns : null,
    retainedFlagAdvance: ['from', 'to'].every(key => Number.isInteger(diagnostics.retainedFlagAdvance?.[key]) && diagnostics.retainedFlagAdvance[key] >= 0 && diagnostics.retainedFlagAdvance[key] < 62)
      ? { from: diagnostics.retainedFlagAdvance.from, to: diagnostics.retainedFlagAdvance.to } : null,
  };
}
