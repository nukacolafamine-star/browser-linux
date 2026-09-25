// SPDX-License-Identifier: GPL-2.0-only
// SDL receives physical keyboard events only while its canvas has focus.
export function connectCanvasKeyboard(canvas) {
  const held = new Map();
  const remember = event => {
    if (document.activeElement !== canvas) return;
    held.set(event.code || event.key, {code: event.code, key: event.key,
      location: event.location, keyCode: event.keyCode, which: event.which});
    // SDL handles Tab, arrows and shortcuts inside Linux. Its worker callback
    // runs too late to cancel the browser's default navigation/scroll behavior.
    event.preventDefault();
  };
  const forget = event => held.delete(event.code || event.key);
  const release = () => {
    const keys = [...held.values()]; held.clear();
    for (const key of keys) {
      const event = new KeyboardEvent('keyup', {...key, bubbles: true, cancelable: true});
      // Some constructors omit these legacy properties; Emscripten copies them.
      for (const field of ['keyCode', 'which']) {
        if (event[field] !== key[field]) Object.defineProperty(event, field, {value: key[field]});
      }
      canvas.dispatchEvent(event);
    }
  };
  canvas.addEventListener('keydown', remember);
  canvas.addEventListener('keyup', forget);
  canvas.addEventListener('blur', release);
  window.addEventListener('blur', release);
  return () => {
    release();
    canvas.removeEventListener('keydown', remember);
    canvas.removeEventListener('keyup', forget);
    canvas.removeEventListener('blur', release);
    window.removeEventListener('blur', release);
  };
}
