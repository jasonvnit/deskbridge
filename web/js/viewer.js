const MIN_ZOOM = 1;
const MAX_ZOOM = 6;

/**
 * Draws remote frames on a canvas and manages the local zoom/pan of the view.
 * Coordinates sent to the server are normalized (0..1) to the remote screen.
 */
export class Viewer {
  #stage;
  #canvas;
  #context;
  #zoom = 1;
  #tx = 0;
  #ty = 0;
  #baseWidth = 0;
  #baseHeight = 0;
  #decoding = false;
  #pending = null;
  onFrameDrawn = () => {};
  onLayout = () => {};

  constructor(stage, canvas) {
    this.#stage = stage;
    this.#canvas = canvas;
    this.#context = canvas.getContext('2d', { alpha: false });
    new ResizeObserver(() => this.layout()).observe(stage);
  }

  get zoom() {
    return this.#zoom;
  }

  get hasFrame() {
    return this.#canvas.width > 0 && this.#baseWidth > 0;
  }

  /** Decodes and draws a JPEG frame (bytes). Frames arriving mid-decode replace each other. */
  pushJpeg(buffer) {
    if (this.#decoding) {
      if (this.#pending) this.onFrameDrawn(false);
      this.#pending = buffer;
      return;
    }
    this.#decode(buffer);
  }

  async #decode(buffer) {
    this.#decoding = true;
    try {
      const bitmap = await createImageBitmap(new Blob([buffer], { type: 'image/jpeg' }));
      this.drawSource(bitmap, bitmap.width, bitmap.height);
      bitmap.close();
    } catch {
      // A corrupt frame is skipped; the next one replaces it.
    } finally {
      this.#decoding = false;
      this.onFrameDrawn(true);
    }
    const next = this.#pending;
    this.#pending = null;
    if (next) this.#decode(next);
  }

  /** Draws any image source (ImageBitmap, VideoFrame) as the current screen. */
  drawSource(source, width, height) {
    if (width !== this.#canvas.width || height !== this.#canvas.height) {
      this.#canvas.width = width;
      this.#canvas.height = height;
      this.layout();
    }
    this.#context.drawImage(source, 0, 0, width, height);
  }

  layout() {
    const width = this.#canvas.width;
    const height = this.#canvas.height;
    if (!width || !height) return;
    const stageWidth = this.#stage.clientWidth;
    const stageHeight = this.#stage.clientHeight;
    const scale = Math.min(stageWidth / width, stageHeight / height);
    this.#baseWidth = width * scale;
    this.#baseHeight = height * scale;
    this.#canvas.style.width = `${this.#baseWidth}px`;
    this.#canvas.style.height = `${this.#baseHeight}px`;
    this.#clamp();
    this.#apply();
  }

  resetZoom() {
    this.#zoom = 1;
    this.#clamp();
    this.#apply();
  }

  /** Zooms by `factor` keeping the stage point (x, y) fixed. */
  zoomAt(factor, x, y) {
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.#zoom * factor));
    const contentX = (x - this.#tx) / this.#zoom;
    const contentY = (y - this.#ty) / this.#zoom;
    this.#zoom = next;
    this.#tx = x - contentX * next;
    this.#ty = y - contentY * next;
    this.#clamp();
    this.#apply();
  }

  panBy(dx, dy) {
    this.#tx += dx;
    this.#ty += dy;
    this.#clamp();
    this.#apply();
  }

  /** Pans so that a stage point stays inside the visible area (used for the trackpad cursor). */
  keepVisible(x, y, margin = 40) {
    if (this.#zoom <= 1) return;
    const width = this.#stage.clientWidth;
    const height = this.#stage.clientHeight;
    let dx = 0;
    let dy = 0;
    if (x < margin) dx = margin - x;
    else if (x > width - margin) dx = width - margin - x;
    if (y < margin) dy = margin - y;
    else if (y > height - margin) dy = height - margin - y;
    if (dx || dy) this.panBy(dx, dy);
  }

  /** Converts a viewport point to normalized remote coordinates. */
  toRemote(clientX, clientY) {
    const rect = this.#canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return { x: 0.5, y: 0.5 };
    return {
      x: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
    };
  }

  /** Converts normalized remote coordinates to a viewport point. */
  toClient(x, y) {
    const rect = this.#canvas.getBoundingClientRect();
    return { x: rect.left + x * rect.width, y: rect.top + y * rect.height };
  }

  /** Size of the displayed screen in CSS pixels, including zoom. */
  displayedSize() {
    const rect = this.#canvas.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }

  #clamp() {
    const stageWidth = this.#stage.clientWidth;
    const stageHeight = this.#stage.clientHeight;
    const width = this.#baseWidth * this.#zoom;
    const height = this.#baseHeight * this.#zoom;
    this.#tx = width <= stageWidth ? (stageWidth - width) / 2 : Math.min(0, Math.max(stageWidth - width, this.#tx));
    this.#ty = height <= stageHeight ? (stageHeight - height) / 2 : Math.min(0, Math.max(stageHeight - height, this.#ty));
  }

  #apply() {
    this.#canvas.style.transform = `translate(${this.#tx}px, ${this.#ty}px) scale(${this.#zoom})`;
    this.onLayout();
  }
}
