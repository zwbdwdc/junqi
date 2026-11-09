// Existing integration scenarios assume the human opens. Control only that
// one-byte draw; formation seeds and the Worker keep their normal randomness.
async function forceHumanFirstTurn(win) {
  await win.webContents.executeJavaScript(`(() => {
    window.__qaOriginalRandomValues ||= crypto.getRandomValues.bind(crypto);
    crypto.getRandomValues = bytes => {
      const result = window.__qaOriginalRandomValues(bytes);
      if (bytes instanceof Uint8Array && bytes.length === 1) bytes[0] = 0;
      return result;
    };
  })()`);
}

module.exports = { forceHumanFirstTurn };
