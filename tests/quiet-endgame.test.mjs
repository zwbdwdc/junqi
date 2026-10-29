import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseMove } from '../dist/ai.js';
import { randomLayout, createGame, makeObservation, applyMove } from '../dist/engine.js';
const seeded = initial => { let seed = initial; return () => ((seed = (Math.imul(seed,1664525)+1013904223) >>> 0) / 4294967296); };
const options = { clock: () => 0, nodeLimit: 100000, maxDepth: 4 };
function fixture() {
  const rng = seeded(810), game = createGame(randomLayout('human',rng),randomLayout('ai',rng),{engineerMountains:true});
  const own = type => ({ ...game.initial.find(p => p?.side === 'ai' && p.type === type), moved:!['flag','mine'].includes(type) });
  const enemy = (type, index = 0) => ({ ...game.initial.filter(p => p?.side === 'human' && p.type === type)[index], moved:!['flag','mine'].includes(type) });
  game.board.fill(null); game.board[1] = own('flag'); game.board[58] = enemy('flag'); game.turn = 'ai'; game.revealedFlags.human = true;
  return {game,own,enemy};
}

test('quiet99 is a real draw before the opponent can capture our exposed flag', () => {
  const {game,own,enemy} = fixture(); game.board[25] = own('commander'); game.board[6] = enemy('engineer'); game.board[30] = enemy('engineer',1); game.quiet = 99;
  for (const level of ['professional','hell']) {
    const selected = chooseMove(makeObservation(game,'ai'),level,seeded(33),null,null,options);
    assert.equal(game.board[selected.to],null,'the chosen quiet move terminates immediately');
    assert.equal(selected.info.diagnostics.quietDraw,true);
    assert.equal(selected.info.diagnostics.repetitionDraw,false);
    assert.deepEqual(applyMove(game,selected.from,selected.to).result,{winner:null,reason:'quiet'});
  }
});

test('an immediate flag win has priority over the quiet99 draw option', () => {
  const {game,own,enemy} = fixture(); game.board[53] = own('engineer'); game.board[20] = own('commander'); game.board[6] = enemy('engineer'); game.quiet = 99;
  const selected = chooseMove(makeObservation(game,'ai'),'hell',seeded(33),null,null,options);
  assert.deepEqual([selected.from,selected.to],[53,58]);
  assert.equal(selected.info.diagnostics.quietDraw,false);
  assert.equal(selected.info.diagnostics.provenWin,true);
  assert.equal(applyMove(game,selected.from,selected.to).result.winner,'ai');
});

test('quiet98 caps a promising empty move by the draw the opponent can choose next', () => {
  const {game,own,enemy} = fixture(); game.board[35] = own('commander'); game.board[21] = own('general'); game.board[31] = own('division'); game.board[60] = enemy('engineer'); game.quiet = 98;
  game.history.push({ply:1,side:'human',from:26,to:60,attackerId:game.board[60].id,defenderId:null,result:'move',engineerTurn:false,mountainMove:true,flagRevealed:[]});
  const selected = chooseMove(makeObservation(game,'ai'),'hell',seeded(31),null,null,options);
  assert.equal(selected.info.diagnostics.allowOpponentDraw,true);
  assert.equal(selected.info.diagnostics.quietDraw,false,'not a terminal draw yet');
  assert.ok(selected.info.expectedScore <= -350,'material advantage cannot be cashed in after an optional enemy draw');
  const after = applyMove(game,selected.from,selected.to);
  assert.equal(after.result,null);
  assert.equal(applyMove(after,60,26).result?.reason,'quiet');
});

test('immobilizing all opposing pieces wins before the quiet limit is adjudicated', () => {
  const {game,own} = fixture(); game.board[20] = own('commander'); game.quiet = 99;
  const selected = chooseMove(makeObservation(game,'ai'),'hell',seeded(8),null,null,options);
  assert.equal(selected.info.diagnostics.provenWin,true);
  assert.equal(selected.info.diagnostics.quietDraw,false);
  assert.equal(applyMove(game,selected.from,selected.to).result?.winner,'ai');
});
