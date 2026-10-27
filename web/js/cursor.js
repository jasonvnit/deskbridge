// Arrow used until the Mac sends its real cursor shape.
const DEFAULT_SHAPE = {
  url:
    'data:image/svg+xml,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="25" viewBox="0 0 17 25"><path d="M1 1v20l5-5 3.5 7.5 3-1.5L9 14.5h7z" fill="#000" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>',
    ),
  hotX: 1,
  hotY: 1,
  width: 17,
  height: 25,
};

// Right after local input, always show the local position (covers moves not sent yet).
const LOCAL_MIN_MS = 150;
// Fallback if the Mac never confirms our latest move (e.g. an older helper without seq).
const LOCAL_MAX_MS = 3000;
// Keep the cursor readable when a large screen is shown on a small device.
const MIN_SCALE = 0.6;

/**
 * Draws the Mac's cursor on top of the stream.
 *
 * The cursor is not part of the video: its shape and position come as small
 * messages, and while the user moves the pointer it is drawn at the local
 * position immediately, so it never waits for a video frame.
 *
 * Every pointer message carries a sequence number, and the Mac echoes the last
 * one it applied with each position report. Reports older than our latest move
 * are still in flight from before, so they are ignored; this prevents the cursor
 * from jumping back to where it was and then crawling to the new point.
 */
export class CursorOverlay {
  #element;
  #viewer;
  #shape = DEFAULT_SHAPE;
  #remote = { x: 0.5, y: 0.5, visible: false, seq: 0 };
  #local = null;
  #localSeq = 0;
  #localTime = 0;
  /** The local pointer moved and the Mac has not been told yet (resting / click-only sync). */
  #unsent = false;
  /** Click-only sync: the Mac's cursor shape describes another spot, so show a plain arrow. */
  #detached = false;
  #fallbackTimer = 0;
  #pointWidth = 0;
  #frameRequested = false;
  #shapes = new Map();
  #macShape = DEFAULT_SHAPE;

  constructor({ element, viewer }) {
    this.#element = element;
    this.#viewer = viewer;
    this.#applyShape();
  }

  /** The latest position reported by the Mac (normalized). */
  get remotePosition() {
    return this.#remote;
  }

  /** True while local input is ahead of what the Mac has confirmed. */
  get isLocallyDriven() {
    if (!this.#local) return false;
    if (this.#unsent) return true;
    const age = performance.now() - this.#localTime;
    if (age < LOCAL_MIN_MS) return true;
    if (age > LOCAL_MAX_MS) return false;
    return this.#remote.seq < this.#localSeq;
  }

  setDisplayPointWidth(width) {
    this.#pointWidth = width || 0;
    this.render();
  }

  /** A shape with `png` is new; one with only `id` was sent before and is cached. */
  setShape({ id, png, hotX, hotY, width, height }) {
    if (png) {
      this.#shapes.set(id, { url: `data:image/png;base64,${png}`, hotX, hotY, width, height });
    }
    const shape = this.#shapes.get(id);
    if (!shape) return;
    this.#macShape = shape;
    if (this.#detached) return;
    this.#shape = shape;
    this.#applyShape();
    this.render();
  }

  /** Click-only sync shows a plain arrow; other modes show the Mac's real cursor shape. */
  setDetached(detached) {
    this.#detached = detached;
    this.#shape = detached ? DEFAULT_SHAPE : this.#macShape;
    this.#applyShape();
    this.render();
  }

  setRemote(x, y, visible, seq = 0) {
    this.#remote = { x, y, visible, seq };
    if (!this.isLocallyDriven) this.render();
  }

  /** Shows a pointer position immediately (before it is sent, or without sending it). */
  showLocal(point) {
    this.#local = { x: point.x, y: point.y };
    this.#localTime = performance.now();
    this.#unsent = true;
    this.render();
  }

  /** Records a pointer position that was sent to the Mac with sequence number `seq`. */
  setLocal(point, seq) {
    this.#localSeq = seq;
    this.showLocal(point);
    this.#unsent = false;
    clearTimeout(this.#fallbackTimer);
    this.#fallbackTimer = setTimeout(() => this.render(), LOCAL_MAX_MS + 50);
  }

  render() {
    if (this.#frameRequested) return;
    this.#frameRequested = true;
    requestAnimationFrame(() => {
      this.#frameRequested = false;
      this.#draw();
    });
  }

  #applyShape() {
    this.#element.src = this.#shape.url;
  }

  #draw() {
    const local = this.isLocallyDriven;
    const position = local ? this.#local : this.#remote;
    const visible = this.#viewer.hasFrame && (local || this.#remote.visible);
    this.#element.hidden = !visible;
    if (!visible) return;

    const size = this.#viewer.displayedSize();
    const scale = Math.max(MIN_SCALE, this.#pointWidth ? size.width / this.#pointWidth : 1);
    const point = this.#viewer.toClient(position.x, position.y);
    const { hotX, hotY, width, height } = this.#shape;
    this.#element.style.width = `${width * scale}px`;
    this.#element.style.height = `${height * scale}px`;
    this.#element.style.transform = `translate(${point.x - hotX * scale}px, ${point.y - hotY * scale}px)`;
  }
}
