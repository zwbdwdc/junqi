import { TYPES } from './engine.js';

// Private player notes live beside the session, never in the referee game or AI observation.
export function sanitizeMarks(value, board, revealed = new Set()) {
  const clean = Object.create(null);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return clean;
  for (const piece of board || []) {
    if (piece?.side === 'ai' && !revealed.has(piece.id) &&
        Object.hasOwn(value, piece.id) && typeof value[piece.id] === 'string' && Object.hasOwn(TYPES, value[piece.id])) {
      clean[piece.id] = value[piece.id];
    }
  }
  return clean;
}
