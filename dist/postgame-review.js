import { legalMoves, combat, isMountain } from './engine.js';
import { buildReplay } from './replay.js';

const other = side => side === 'ai' ? 'human' : 'ai';
const value = { commander:1, general:.85, division:.7, brigade:.58, regiment:.45, battalion:.35,
  company:.25, platoon:.2, engineer:.45, bomb:.65, mine:.3, flag:2 };
const row = at => isMountain(at) ? 5.5 : Math.floor(at / 5);
const col = at => isMountain(at) ? (at === 60 ? 1 : 3) : at % 5;
const distance = (a, b) => Math.abs(row(a)-row(b)) + Math.abs(col(a)-col(b));
function threatensFlag(board, side) {
  const flag = board.findIndex(p => p?.side === side && p.type === 'flag');
  return flag >= 0 && board.some((p, at) => p?.side === other(side) && legalMoves(board, at).includes(flag));
}
function endangered(board, id) {
  const at = board.findIndex(p => p?.id === id), piece = board[at];
  return !!piece && board.some((enemy, from) => enemy && enemy.side !== piece.side &&
    legalMoves(board, from).includes(at) && combat(enemy.type, piece.type) !== 'lose');
}
function projected(board, from, to) {
  const next = board.slice(), attacker = board[from], target = board[to];
  const result = target ? combat(attacker.type, target.type) : 'move';
  next[from] = null;
  next[to] = result === 'lose' ? target : result === 'both' ? null : attacker;
  return next;
}

// A bounded postgame route audit: how many moves could an enemy need to
// reach the flag if the remaining pieces stayed put? This gives credit for
// closing a railway entry before the flag is under immediate attack. It is
// not a forced-win solver and never supplies identities to the live policy.
function flagRoute(board, side) {
  const flag = board.findIndex(p => p?.side === side && p.type === 'flag');
  if (flag < 0) return 0;
  let frontier = board.flatMap((p, at) => p?.side === other(side) && !['mine','flag'].includes(p.type) ?
    [{ board, at, id:p.id, removed:[] }] : []);
  const seen = new Set(frontier.map(item => `${item.id}:${item.at}:`));
  for (let step=1;step<=3;step++) {
    const next=[];
    for (const node of frontier) {
      const attacker=node.board[node.at];
      for (const to of legalMoves(node.board,node.at)) {
        const target=node.board[to], outcome=target?combat(attacker.type,target.type):'move';
        if(to===flag && outcome!=='lose')return step;
        if(step===3 || outcome==='lose' || outcome==='both')continue;
        const removed=target?[...node.removed,target.id].sort():node.removed;
        const key=`${node.id}:${to}:${removed.join(',')}`;
        if(seen.has(key))continue;
        seen.add(key);next.push({board:projected(node.board,node.at,to),at:to,id:node.id,removed});
      }
    }
    frontier=next;
  }
  return 4;
}

/** Called only with an already-authorized FINISHED replay, never by live AI. */
export function reviewCompletedPlans(game) {
  if (!game?.result) return new Map();
  let frames;
  try { frames = buildReplay(game); } catch { return new Map(); }
  return reviewPlanFrames(frames, game.history);
}

export function reviewPlanFrames(frames, history) {
  const notes = new Map();
  for (const event of history) {
    if (event.side !== 'ai') continue;
    const before = frames[event.ply - 1]?.board, after = frames[event.ply]?.board;
    if (!before || !after) continue;
    const flagRiskBefore = threatensFlag(before, 'ai'), flagRiskAfter = threatensFlag(after, 'ai');
    const routeBefore=flagRoute(before,'ai'),routeAfter=flagRoute(after,'ai');
    const escape = endangered(before, event.attackerId) && !endangered(after, event.attackerId) &&
      after.some(p => p?.id === event.attackerId);
    const defended = flagRiskBefore && !flagRiskAfter || routeAfter > routeBefore;
    let avoidableFlagLoss = false;
    if (flagRiskAfter && event.capturedFlagSide !== 'human') {
      avoidableFlagLoss = before.some((p, from) => p?.side === 'ai' && legalMoves(before, from).some(to =>
        before[to]?.type === 'flag' && before[to].side === 'human' || !threatensFlag(projected(before, from, to), 'ai')));
    }
    // When the railway already offers a short route to our flag, an unrelated
    // escape must not earn credit if a legal move could close that route.
    // This is missed-cover evidence, weaker than an avoidable immediate loss.
    const missedFlagCover = !avoidableFlagLoss && !defended && routeAfter>0 && routeAfter<=3 &&
      event.capturedFlagSide!=='human' && before.some((p,from)=>p?.side==='ai' &&
        legalMoves(before,from).some(to=>flagRoute(projected(before,from,to),'ai')>routeAfter));
    const recent = history.filter(e => e.side === 'ai' && e.ply < event.ply && e.ply >= event.ply - 12);
    const shuttle = event.result === 'move' && !escape && !defended && recent.some(e =>
      e.attackerId === event.attackerId && e.from === event.to && e.to === event.from && e.result === 'move');
    const enemyFlag = before.findIndex(p => p?.side === 'human' && p.type === 'flag');
    // Do not use the revealed postgame layout to blame an earlier dark move.
    // This omission is certain only when the flag was already face-up and a
    // legal capture existed. Taking a different immediate win is also valid.
    const missedKnownWin = frames[event.ply - 1]?.revealedFlags?.human === true && enemyFlag >= 0 &&
      event.capturedFlagSide !== 'human' &&
      before.some((piece, from) => piece?.side === 'ai' && legalMoves(before, from).includes(enemyFlag)) &&
      after.some((piece, from) => piece?.side === 'human' && legalMoves(after, from).length > 0);
    const followup = history.find(e => e.ply > event.ply && e.ply <= event.ply + 6 && e.side === 'ai' &&
      e.attackerId === event.attackerId && ['win', 'both'].includes(e.result));
    const followupBoard=followup&&frames[followup.ply-1]?.board;
    const followupTarget=followupBoard?.[followup.to],followupAttacker=followupBoard?.[followup.from];
    const usefulExchange=followupTarget && followupAttacker && (followup.result==='win' ||
      value[followupTarget.type]>=value[followupAttacker.type]);
    const productive = event.result === 'move' && !shuttle && !flagRiskAfter && enemyFlag >= 0 &&
      distance(event.to, enemyFlag) < distance(event.from, enemyFlag) && !!usefulExchange;
    notes.set(event.ply, { escape, defended, avoidableFlagLoss, missedFlagCover, shuttle, productive, missedKnownWin });
  }
  return notes;
}
