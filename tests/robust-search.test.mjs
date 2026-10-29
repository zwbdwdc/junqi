import test from 'node:test';
import assert from 'node:assert/strict';
import { legalMoves, combat, makeObservation } from '../dist/engine.js';
import { tacticalSearch, conservativeContinuation } from '../dist/ai.js';

function hiddenWorlds() {
  const piece = (id, side, type, origin) => ({ id, side, type, origin, moved: type !== 'flag' });
  const first = Array(62).fill(null);
  first[1] = piece('our-flag', 'ai', 'flag', 1);
  first[25] = piece('our-commander', 'ai', 'commander', 25);
  first[56] = piece('their-flag', 'human', 'flag', 56);
  first[26] = piece('unknown-a', 'human', 'bomb', 50);
  first[30] = piece('unknown-b', 'human', 'platoon', 51);
  const second = structuredClone(first);
  second[26].type = 'platoon'; second[30].type = 'bomb';
  return [first, second];
}

// Independent material accounting: the two hidden pieces cannot be told apart
// by the current public record, so a real player must select one common move.
const values = { commander: 280, bomb: 120, platoon: 28, flag: 50000 };
function immediateMaterial(board, from, to) {
  const attacker = board[from], defender = board[to];
  if (!defender) return 0;
  const result = combat(attacker.type, defender.type);
  return result === 'win' ? values[defender.type] : result === 'lose' ? -values[attacker.type] :
    values[defender.type] - values[attacker.type];
}

test('bounded continuation limits a demonstrated gain invented by incompatible hidden-world replies', () => {
  const worlds = hiddenWorlds();
  const observation = board => makeObservation({board,initial:board,turn:'ai',ply:40,quiet:4,result:null,
    history:[],revealedFlags:{ai:false,human:false},rules:{engineerMountains:true}}, 'ai');
  assert.deepEqual(observation(worlds[0]), observation(worlds[1]), 'neither public record identifies the bomb');
  const destinations = legalMoves(worlds[0], 25);
  assert.deepEqual(legalMoves(worlds[1],25),destinations);
  const perWorldBest = worlds.map(board => destinations.map(to => ({to,gain:immediateMaterial(board,25,to)}))
    .sort((a,b) => b.gain-a.gain)[0]);
  assert.deepEqual(perWorldBest, [{to:30,gain:28},{to:26,gain:28}], 'knowing the sampled rank picks different replies');
  const commonBest = Math.max(...destinations.map(to => worlds.reduce((sum,board) => sum+immediateMaterial(board,25,to),0)/2));
  assert.equal(commonBest,0,'every shared capture has negative expectation; a quiet shelter can preserve material');
  assert.equal((immediateMaterial(worlds[0],25,26)+immediateMaterial(worlds[1],25,26))/2,-66);

  const deepValues = worlds.map(board => tacticalSearch(board,'ai',2,{beam:5},{replies:0,nodes:0}));
  const optimistic = (deepValues[0]+deepValues[1])/2;
  assert.ok(optimistic>20,`independent searches wrongly predict reliable recovery: ${optimistic}`);
  // Feed this real, incompatible search estimate through the same bound used
  // by the production chooser. The bound mitigates fusion; it does not claim
  // that separate perfect-information trees solve imperfect-information play.
  const bounded = conservativeContinuation(commonBest,optimistic);
  assert.ok(bounded>commonBest,'a small exploratory allowance remains');
  assert.ok(bounded<optimistic/3,'most of the unsupported recovery must be discounted');
  assert.ok(bounded<=commonBest+15);
});

test('conservative continuation keeps adverse search evidence instead of smoothing it into optimism', () => {
  const [board] = hiddenWorlds();
  // Advancing the commander onto the known bomb loses the commander and bomb
  // together; the real combat accounting supplies the adverse estimate.
  const lostTrade = immediateMaterial(board,25,26);
  assert.equal(lostTrade,-160);
  assert.equal(conservativeContinuation(0,lostTrade),lostTrade);
});
