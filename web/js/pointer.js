const TAP_SLOP = 10;
const TAP_MAX_MS = 300;
const LONG_PRESS_MS = 500;
const PINCH_THRESHOLD = 24;
const SCROLL_THRESHOLD = 6;
const WHEEL_LINE_PX = 16;

const MOUSE_BUTTONS = { 0: 'left', 1: 'middle', 2: 'right' };

function vibrate() {
  navigator.vibrate?.(10);
}

/**
 * Turns pointer input into remote mouse events.
 *
 * Mouse / pen / tablet trackpad: absolute position, real buttons, wheel scrolling.
 * Touch, "touch" mode:    tap = click, long press = right click, drag = drag,
 *                         two-finger drag = scroll, two-finger tap = right click, pinch = zoom.
 * Touch, "trackpad" mode: drag = move pointer, tap = click, hold then drag = drag,
 *                         two-finger drag = scroll, two-finger tap = right click, pinch = zoom.
 */
export class PointerController {
  #stage;
  #viewer;
  #send;
  #settings;
  #cursorOverlay;
  #touches = new Map();
  #ignored = new Set();
  #gesture = null;
  #cursor = { x: 0.5, y: 0.5 };
  #pendingMove = null;
  #scroll = { dx: 0, dy: 0, x: null, y: null };
  #frameRequested = false;

  /** Called on every new pointer; return false to swallow the gesture (e.g. to close a panel). */
  onPointerStart = () => true;

  constructor({ stage, viewer, send, settings, cursor }) {
    this.#stage = stage;
    this.#viewer = viewer;
    this.#send = send;
    this.#settings = settings;
    this.#cursorOverlay = cursor;

    stage.addEventListener('pointerdown', (e) => this.#onDown(e));
    stage.addEventListener('pointermove', (e) => this.#onMove(e));
    stage.addEventListener('pointerup', (e) => this.#onUp(e, false));
    stage.addEventListener('pointercancel', (e) => this.#onUp(e, true));
    stage.addEventListener('wheel', (e) => this.#onWheel(e), { passive: false });
    stage.addEventListener('contextmenu', (e) => e.preventDefault());
    // Safari pinch gestures would otherwise zoom the whole page.
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
      document.addEventListener(type, (e) => e.preventDefault());
    }

    viewer.onLayout = () => cursor.render();
  }

  get #mode() {
    return this.#settings.get('mode');
  }

  // ---- Sending ------------------------------------------------------------

  #queueMove(point) {
    this.#pendingMove = point;
    this.#cursorOverlay.setLocal(point);
    this.#requestFlush();
  }

  #flushMove() {
    if (!this.#pendingMove) return;
    const { x, y } = this.#pendingMove;
    this.#pendingMove = null;
    this.#send({ t: 'mouse', action: 'move', x, y });
  }

  #button(action, button, point) {
    this.#flushMove();
    this.#send({ t: 'mouse', action, button, x: point.x, y: point.y });
  }

  #click(point, button = 'left') {
    this.#button('down', button, point);
    this.#button('up', button, point);
  }

  #queueScroll(dx, dy, point) {
    this.#scroll.dx += dx;
    this.#scroll.dy += dy;
    if (point) {
      this.#scroll.x = point.x;
      this.#scroll.y = point.y;
    }
    this.#requestFlush();
  }

  #requestFlush() {
    if (this.#frameRequested) return;
    this.#frameRequested = true;
    requestAnimationFrame(() => {
      this.#frameRequested = false;
      this.#flushMove();
      const { dx, dy, x, y } = this.#scroll;
      if (dx || dy) {
        const message = { t: 'mouse', action: 'scroll', dx: Math.round(dx), dy: Math.round(dy) };
        if (x !== null) Object.assign(message, { x, y });
        this.#send(message);
        this.#scroll.dx -= Math.round(dx);
        this.#scroll.dy -= Math.round(dy);
      }
    });
  }

  // ---- Pointer events -----------------------------------------------------

  #onDown(e) {
    if (this.onPointerStart() === false) {
      this.#ignored.add(e.pointerId);
      return;
    }
    e.preventDefault();
    this.#stage.setPointerCapture?.(e.pointerId);

    if (e.pointerType === 'touch') {
      this.#touchDown(e);
      return;
    }
    const point = this.#viewer.toRemote(e.clientX, e.clientY);
    this.#queueMove(point);
    this.#button('down', MOUSE_BUTTONS[e.button] ?? 'left', point);
  }

  #onMove(e) {
    if (this.#ignored.has(e.pointerId)) return;
    if (e.pointerType === 'touch') {
      this.#touchMove(e);
      return;
    }
    this.#queueMove(this.#viewer.toRemote(e.clientX, e.clientY));
  }

  #onUp(e, cancelled) {
    if (this.#ignored.delete(e.pointerId)) return;
    if (e.pointerType === 'touch') {
      this.#touchUp(e, cancelled);
      return;
    }
    const point = this.#viewer.toRemote(e.clientX, e.clientY);
    this.#button('up', MOUSE_BUTTONS[e.button] ?? 'left', point);
  }

  #onWheel(e) {
    e.preventDefault();
    const rect = this.#stage.getBoundingClientRect();
    if (e.ctrlKey) {
      // Pinch on a trackpad arrives as ctrl + wheel: zoom the local view.
      this.#viewer.zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - rect.left, e.clientY - rect.top);
      return;
    }
    const unit = e.deltaMode === 1 ? WHEEL_LINE_PX : e.deltaMode === 2 ? rect.height : 1;
    this.#queueScroll(-e.deltaX * unit, -e.deltaY * unit, null);
  }

  // ---- Touch gestures -------------------------------------------------------

  #touchDown(e) {
    this.#touches.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.#touches.size === 1) {
      const gesture = {
        type: 'one',
        id: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        startTime: performance.now(),
        moved: false,
        dragging: false,
        longPressed: false,
        timer: 0,
      };
      gesture.timer = setTimeout(() => this.#onLongPress(gesture), LONG_PRESS_MS);
      this.#gesture = gesture;
      return;
    }

    if (this.#touches.size === 2) {
      this.#endOneFinger();
      const [a, b] = [...this.#touches.values()];
      const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      this.#gesture = {
        type: 'two',
        startTime: performance.now(),
        startDistance: distance,
        lastDistance: distance,
        startCenter: center,
        lastCenter: center,
        kind: null,
      };
      return;
    }

    this.#endOneFinger();
    this.#gesture = { type: 'ended' };
  }

  #onLongPress(gesture) {
    if (this.#gesture !== gesture || gesture.moved) return;
    gesture.longPressed = true;
    vibrate();
    if (this.#mode === 'touch') {
      this.#click(this.#viewer.toRemote(gesture.startX, gesture.startY), 'right');
    } else {
      // Trackpad mode: holding still arms a drag at the pointer position.
      gesture.dragging = true;
      this.#button('down', 'left', this.#cursor);
    }
  }

  #touchMove(e) {
    const touch = this.#touches.get(e.pointerId);
    if (!touch) return;
    touch.x = e.clientX;
    touch.y = e.clientY;
    const gesture = this.#gesture;
    if (!gesture) return;

    if (gesture.type === 'one' && gesture.id === e.pointerId) {
      const dx = e.clientX - gesture.lastX;
      const dy = e.clientY - gesture.lastY;
      gesture.lastX = e.clientX;
      gesture.lastY = e.clientY;
      if (!gesture.moved && Math.hypot(e.clientX - gesture.startX, e.clientY - gesture.startY) > TAP_SLOP) {
        gesture.moved = true;
        if (!gesture.longPressed) clearTimeout(gesture.timer);
      }
      if (!gesture.moved) return;

      if (this.#mode === 'touch') {
        if (gesture.longPressed) return;
        if (!gesture.dragging) {
          gesture.dragging = true;
          const start = this.#viewer.toRemote(gesture.startX, gesture.startY);
          this.#queueMove(start);
          this.#button('down', 'left', start);
        }
        this.#queueMove(this.#viewer.toRemote(e.clientX, e.clientY));
      } else {
        this.#moveCursorBy(dx, dy);
      }
      return;
    }

    if (gesture.type === 'two' && this.#touches.size === 2) {
      const [a, b] = [...this.#touches.values()];
      const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const distance = Math.hypot(a.x - b.x, a.y - b.y);

      if (!gesture.kind) {
        if (Math.abs(distance - gesture.startDistance) > PINCH_THRESHOLD) {
          gesture.kind = 'pinch';
        } else if (Math.hypot(center.x - gesture.startCenter.x, center.y - gesture.startCenter.y) > SCROLL_THRESHOLD) {
          gesture.kind = 'scroll';
          // Scroll goes to the window under the pointer, so move it there first in touch mode.
          if (this.#mode === 'touch') this.#queueMove(this.#viewer.toRemote(gesture.startCenter.x, gesture.startCenter.y));
        }
      }

      if (gesture.kind === 'pinch') {
        const rect = this.#stage.getBoundingClientRect();
        this.#viewer.zoomAt(distance / gesture.lastDistance, center.x - rect.left, center.y - rect.top);
        this.#viewer.panBy(center.x - gesture.lastCenter.x, center.y - gesture.lastCenter.y);
      } else if (gesture.kind === 'scroll') {
        const speed = this.#settings.get('scrollSpeed');
        this.#queueScroll((center.x - gesture.lastCenter.x) * speed, (center.y - gesture.lastCenter.y) * speed, null);
      }
      gesture.lastCenter = center;
      gesture.lastDistance = distance;
    }
  }

  #touchUp(e, cancelled) {
    const touch = this.#touches.get(e.pointerId);
    this.#touches.delete(e.pointerId);
    const gesture = this.#gesture;
    if (!touch || !gesture) return;

    if (gesture.type === 'one') {
      clearTimeout(gesture.timer);
      const quick = performance.now() - gesture.startTime < TAP_MAX_MS * 2;
      if (gesture.dragging) {
        const point = this.#mode === 'touch' ? this.#viewer.toRemote(e.clientX, e.clientY) : this.#cursor;
        this.#button('up', 'left', point);
      } else if (!cancelled && !gesture.moved && !gesture.longPressed && quick) {
        if (this.#mode === 'touch') {
          const point = this.#viewer.toRemote(gesture.startX, gesture.startY);
          this.#queueMove(point);
          this.#click(point);
        } else {
          this.#click(this.#cursor);
        }
      }
      this.#gesture = null;
      return;
    }

    if (gesture.type === 'two') {
      const quick = performance.now() - gesture.startTime < TAP_MAX_MS;
      if (!cancelled && !gesture.kind && quick) {
        const point = this.#mode === 'touch' ? this.#viewer.toRemote(gesture.startCenter.x, gesture.startCenter.y) : this.#cursor;
        this.#queueMove(point);
        this.#click(point, 'right');
      }
      this.#gesture = this.#touches.size === 0 ? null : { type: 'ended' };
      return;
    }

    if (this.#touches.size === 0) this.#gesture = null;
  }

  /** Stops a one-finger gesture when more fingers join, releasing any drag. */
  #endOneFinger() {
    const gesture = this.#gesture;
    if (gesture?.type !== 'one') return;
    clearTimeout(gesture.timer);
    if (gesture.dragging) {
      const point = this.#mode === 'touch' ? this.#viewer.toRemote(gesture.lastX, gesture.lastY) : this.#cursor;
      this.#button('up', 'left', point);
    }
  }

  // ---- Trackpad cursor ------------------------------------------------------

  #moveCursorBy(dx, dy) {
    const size = this.#viewer.displayedSize();
    if (!size.width || !size.height) return;
    // Start from where the Mac's cursor really is unless we are already moving it.
    if (!this.#cursorOverlay.isLocallyDriven) {
      const { x, y } = this.#cursorOverlay.remotePosition;
      this.#cursor = { x, y };
    }
    const speed = this.#settings.get('trackpadSpeed');
    // Simple acceleration: fast swipes travel further.
    const acceleration = 1 + Math.min(Math.hypot(dx, dy), 40) / 25;
    this.#cursor = {
      x: Math.min(1, Math.max(0, this.#cursor.x + (dx * speed * acceleration) / size.width)),
      y: Math.min(1, Math.max(0, this.#cursor.y + (dy * speed * acceleration) / size.height)),
    };
    this.#queueMove(this.#cursor);
    const client = this.#viewer.toClient(this.#cursor.x, this.#cursor.y);
    this.#viewer.keepVisible(client.x, client.y);
  }
}
