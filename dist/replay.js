import { createGame, applyMove, TYPES } from './engine.js';

/** Referee-only feature: never import this module into the decision worker. */
export function buildReplay(game) {
  if (!game?.result) throw new Error('对局结束后才能明棋复盘');
  if (!Array.isArray(game.initial) || !Array.isArray(game.history)) throw new Error('棋谱不完整');
  const layout = side => game.initial.slice(0, 60).map(p => p?.side === side ? { ...p } : null);
  let state = createGame(layout('human'), layout('ai'), { ...game.rules, firstTurn: game.firstTurn });
  const frame = event => ({ board: state.board.map(p => p ? { ...p } : null), event,
    ply: state.ply, revealedFlags: { ...state.revealedFlags } });
  const frames = [frame(null)];
  for (const event of game.history) {
    if (state.turn !== event.side || state.board[event.from]?.id !== event.attackerId) throw new Error('棋谱顺序不一致');
    state = applyMove(state, event.from, event.to);
    const actual = state.history.at(-1);
    if (actual.result !== event.result || actual.defenderId !== event.defenderId) throw new Error('棋谱交战记录不一致');
    frames.push(frame(actual));
  }
  if (JSON.stringify(state.board) !== JSON.stringify(game.board)) throw new Error('棋谱与终局不一致');
  if (state.turn !== game.turn) throw new Error('棋谱行棋方不一致');
  if (game.result.reason === 'resign') frames.at(-1).result = { ...game.result };
  return frames;
}

export function describeReplay(frame, initial, coordinate) {
  const ending = frame.result?.reason === 'resign' ? `；${frame.result.winner === 'human' ? '电脑' : '我方'}认输` : '';
  if (!frame.event) return '初始布阵 · 双方棋子已明置' + ending;
  const e = frame.event;
  const name = id => TYPES[initial.find(p => p?.id === id)?.type]?.name || '棋子';
  const side = e.side === 'human' ? '我方' : '电脑';
  const action = `${side}${name(e.attackerId)} ${coordinate(e.from)} → ${coordinate(e.to)}`;
  if (e.result === 'move') return action + ending;
  const enemy = `${e.side === 'human' ? '电脑' : '我方'}${name(e.defenderId)}`;
  return `${action}；${e.result === 'win' ? `吃掉${enemy}` : e.result === 'lose' ? `被${enemy}吃掉` : `与${enemy}同归于尽`}` + ending;
}
