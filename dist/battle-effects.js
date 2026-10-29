// Animation reads only the already-visible tokens. It never receives ranks.
let cleanupTimer;
export function clearBattleEffect(board) {
  clearTimeout(cleanupTimer);
  board.querySelector('.battle-effect')?.remove();
}
export function captureBattlePieces(board, from, to) {
  const token = index => board.querySelector(`[data-index="${index}"] .piece`)?.cloneNode(true);
  return { attacker: token(from), defender: token(to) };
}
export function playBattleEffect(board, event, pieces = {}) {
  clearBattleEffect(board);
  if (!['win', 'lose', 'both'].includes(event?.result)) return;
  const cell = board.querySelector(`[data-index="${event.to}"]`);
  if (!cell) return;
  const effect = document.createElement('div');
  effect.className = `battle-effect battle-${event.result}`;
  effect.style.left = cell.style.left;
  effect.style.top = cell.style.top;
  effect.style.width = `${cell.offsetWidth}px`;
  effect.style.height = `${cell.offsetHeight}px`;
  effect.setAttribute('aria-hidden', 'true');
  const add = (className, text = '') => {
    const node = document.createElement('span'); node.className = className; node.textContent = text;
    effect.append(node); return node;
  };
  const ghost = (piece, className) => {
    if (!piece) return;
    const holder = add('battle-ghost ' + className); holder.append(piece);
  };
  if (event.result === 'win') {
    ghost(pieces.defender, 'defeated');
    add('slash-flash'); add('slash-trail'); add('battle-symbol blade', '🗡');
  } else if (event.result === 'lose') {
    add('shield-ring'); add('battle-symbol shield', '🛡');
    ghost(pieces.attacker, 'repelled');
  } else {
    ghost(pieces.attacker, 'dissolve left-token'); ghost(pieces.defender, 'dissolve right-token');
    for (let i = 0; i < 8; i++) {
      const puff = add('smoke-puff');
      const angle = i * Math.PI / 4;
      puff.style.setProperty('--dx', `${Math.cos(angle) * 24}px`);
      puff.style.setProperty('--dy', `${Math.sin(angle) * 12 - 4}px`);
      puff.style.setProperty('--delay', `${i % 3 * 15}ms`);
    }
    add('smoke-center');
  }
  board.append(effect);
  cleanupTimer = setTimeout(() => effect.remove(), 500);
}
