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

// Local input wins over the position reported by the Mac for this long.
const LOCAL_PRIORITY_MS = 400;
// Keep the cursor readable when a large screen is shown on a small device.
const MIN_SCALE = 0.6;

/**
 * Draws the Mac's cursor on top of the stream.
 *
 * The cursor is not part of the video: its shape and position come as small
 * messages, and while the user moves the pointer it is drawn at the local
 * position immediately, so it never waits for a video frame.
 */
export class CursorOverlay {
  #element;
  #viewer;
  #shape = DEFAULT_SHAPE;
  #remote = { x: 0.5, y: 0.5, visible: false };
  #local = null;
  #localTime = 0;
  #pointWidth = 0;
  #frameRequested = false;
  #shapes = new Map();

  constructor({ element, viewer }) {
    this.#element = element;
    this.#viewer = viewer;
    this.#applyShape();
  }

  /** The latest position reported by the Mac (normalized). */
  get remotePosition() {
    return this.#remote;
  }

  /** True while local input is driving the cursor. */
  get isLocallyDriven() {
    return this.#local !== null && performance.now() - this.#localTime < LOCAL_PRIORITY_MS;
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
    this.#shape = shape;
    this.#applyShape();
    this.render();
  }

  setRemote(x, y, visible) {
    this.#remote = { x, y, visible };
    if (!this.isLocallyDriven) this.render();
  }

  /** Called for every pointer move sent to the Mac. */
  setLocal(point) {
    this.#local = { x: point.x, y: point.y };
    this.#localTime = performance.now();
    this.render();
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
