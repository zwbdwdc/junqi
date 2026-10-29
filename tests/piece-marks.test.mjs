import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeMarks } from '../dist/piece-marks.js';
import { randomLayout, createGame, makeObservation } from '../dist/engine.js';

test('notes follow surviving enemy IDs, reject malformed data and discard revealed pieces', () => {
  const board = [{id:'a',side:'ai'},null,{id:'b',side:'human'},{id:'c',side:'ai'}];
  const notes = {a:'bomb',b:'marshal',c:'mine',captured:'engineer'};
  const clean = sanitizeMarks(notes,board,new Set(['c']));
  assert.deepEqual({...clean},{a:'bomb'});
  assert.deepEqual({...sanitizeMarks(clean,[null,board[0]])},{a:'bomb'});
  assert.deepEqual({...sanitizeMarks(clean,[])},{});
  assert.deepEqual({...sanitizeMarks({a:'constructor'},board)},{});
  assert.deepEqual({...sanitizeMarks(['mine'],board)},{});
  assert.deepEqual({...sanitizeMarks(Object.create({a:'bomb'}),board)},{});
  assert.equal(Object.getPrototypeOf(clean),null);
});

test('player notes are separate session data and do not modify any game or observation', () => {
  const game = createGame(randomLayout('human'),randomLayout('ai'));
  const before = JSON.stringify(game), observation = makeObservation(game,'ai');
  const enemy = game.board.find(p=>p?.side==='ai');
  const session = {game,marks:sanitizeMarks({[enemy.id]:'bomb'},game.board)};
  const restored = JSON.parse(JSON.stringify(session));
  assert.equal(restored.marks[enemy.id],'bomb');
  assert.equal(JSON.stringify(game),before);
  assert.deepEqual(makeObservation(restored.game,'ai'),observation);
  assert.equal(Object.hasOwn(restored.game,'marks'),false);
});
