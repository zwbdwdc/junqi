export function drawFirstTurn(random = globalThis.crypto) {
  const byte = new Uint8Array(1);
  random.getRandomValues(byte);
  return byte[0] < 128 ? 'human' : 'ai';
}
