// Keyboard and pointer input. Keys typed into form fields are never touched,
// and Space/Enter on a focused button keep their normal meaning.

const MOVE_LEFT = new Set(['ArrowLeft', 'KeyA']);
const MOVE_RIGHT = new Set(['ArrowRight', 'KeyD']);
const FIRE = new Set(['Space', 'KeyJ', 'KeyZ', 'ArrowUp', 'KeyW']);
const COMMANDS = { KeyP: 'pause', Escape: 'pause', KeyM: 'mute', KeyR: 'restart', KeyI: 'intel', Enter: 'start' };

export function isTypingTarget(el) {
  if (!el || typeof el !== 'object') return false;
  if (el.isContentEditable) return true;
  const tag = String(el.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function createInput({ canvas, toWorldX, onCommand }) {
  const keys = new Set();
  let pointerX = null;
  let pointerFire = false;
  let pointerId = null;

  function onKeyDown(ev) {
    if (ev.ctrlKey || ev.metaKey || ev.altKey || isTypingTarget(ev.target)) return;
    const onButton = ev.target && ev.target.tagName === 'BUTTON';
    if (onButton && (ev.code === 'Space' || ev.code === 'Enter')) return;
    const code = ev.code;
    if (COMMANDS[code]) {
      if (!ev.repeat) onCommand(COMMANDS[code]);
      ev.preventDefault();
      return;
    }
    if (MOVE_LEFT.has(code) || MOVE_RIGHT.has(code) || FIRE.has(code)) {
      if (code === 'Space' && !ev.repeat) onCommand('launch');
      keys.add(code);
      pointerX = null; // keyboard takes over from a stale pointer
      ev.preventDefault();
    }
  }

  function onKeyUp(ev) {
    keys.delete(ev.code);
  }

  function pointerPos(ev) {
    pointerX = toWorldX(ev.clientX);
  }

  function onPointerDown(ev) {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    if (pointerId !== null) return; // the first contact owns the drag until it ends
    pointerId = ev.pointerId;
    try {
      canvas.setPointerCapture(ev.pointerId);
    } catch {
      // capture is optional
    }
    pointerPos(ev);
    pointerFire = true;
    onCommand('launch');
    canvas.focus({ preventScroll: true });
    ev.preventDefault();
  }

  function onPointerMove(ev) {
    if (pointerId === ev.pointerId) pointerPos(ev);
  }

  function onPointerUp(ev) {
    if (pointerId !== ev.pointerId) return;
    pointerId = null;
    pointerFire = false;
    pointerX = null;
  }

  function clear() {
    keys.clear();
    pointerFire = false;
    pointerX = null;
    pointerId = null;
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', clear);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('lostpointercapture', onPointerUp);
  canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

  const has = (set) => {
    for (const k of set) if (keys.has(k)) return true;
    return false;
  };

  return {
    sample() {
      return { left: has(MOVE_LEFT), right: has(MOVE_RIGHT), fire: has(FIRE) || pointerFire, pointerX };
    },
    clear,
  };
}
