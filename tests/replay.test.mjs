import test from 'node:test';
import assert from 'node:assert/strict';
import { randomLayout, createGame, legalMoves, applyMove } from '../dist/engine.js';
import { buildReplay, describeReplay } from '../dist/replay.js';

test('replay cannot expose an active game and reconstructs every completed position without mutation', () => {
  let game = createGame(randomLayout('human'), randomLayout('ai'), {engineerMountains:true});
  assert.throws(() => buildReplay(game), /结束/);
  const expected = [structuredClone(game.board)];
  for (let n = 0; n < 32 && !game.result; n++) {
    const moves = game.board.flatMap((p, from) => p?.side === game.turn ? legalMoves(game.board, from).map(to => ({from,to})) : []);
    const move = moves.find(m => game.board[m.to]) || moves[n % moves.length];
    game = applyMove(game, move.from, move.to);
    expected.push(structuredClone(game.board));
  }
  game.result ||= {winner:'ai',reason:'resign'};
  const before = JSON.stringify(game), frames = buildReplay(game);
  assert.deepEqual(frames.map(f => f.board), expected);
  assert.equal(frames.length, game.ply + 1);
  assert.equal(JSON.stringify(game), before);
  assert.match(describeReplay(frames[0], game.initial, String), /初始布阵/);
  frames[0].board.find(Boolean).type = 'flag';
  assert.equal(JSON.stringify(game), before);
});

test('finished empty history supports resignation; corrupt battle records fail closed', () => {
  let game = createGame(randomLayout('human'), randomLayout('ai'));
  assert.equal(buildReplay({...game,result:{winner:'ai',reason:'resign'}}).length, 1);
  const from = game.board.findIndex((p,i) => p?.side === 'human' && legalMoves(game.board,i).length);
  game = applyMove(game,from,legalMoves(game.board,from)[0]);
  game.result = {winner:'ai',reason:'resign'};
  game.history[0].result = game.history[0].result === 'both' ? 'win' : 'both';
  assert.throws(() => buildReplay(game), /不一致/);
});

test('either side resignation appears at the final replay frame without a fictitious move', () => {
  let game = createGame(randomLayout('human'),randomLayout('ai'));
  for (const winner of ['human','ai']) {
    const frames=buildReplay({...game,result:{winner,reason:'resign'}});
    assert.equal(frames.length,1);
    assert.match(describeReplay(frames[0],game.initial,String),winner==='human'?/电脑认输/:/我方认输/);
  }
  const from=game.board.findIndex((p,i)=>p?.side==='human'&&legalMoves(game.board,i).length);
  game=applyMove(game,from,legalMoves(game.board,from)[0]);
  const frames=buildReplay({...game,result:{winner:'human',reason:'resign'}});
  assert.equal(frames.length,game.ply+1);
  assert.doesNotMatch(describeReplay(frames[0],game.initial,String),/认输/);
  assert.match(describeReplay(frames.at(-1),game.initial,String),/电脑认输/);
});
