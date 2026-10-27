const CLOSE_REPLACED = 4001;
const CLOSE_SESSION_EXPIRED = 4003;

/**
 * WebSocket connection to the server with automatic reconnect.
 *
 * Events: 'open', 'close', 'frame' (detail: ArrayBuffer), 'message' (detail: object),
 *         'replaced', 'unauthorized'
 */
export class Connection extends EventTarget {
  #ws = null;
  #retryDelay = 500;
  #retryTimer = 0;
  #stopped = false;

  get isOpen() {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  connect() {
    this.#stopped = false;
    clearTimeout(this.#retryTimer);
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    this.#ws = ws;

    ws.addEventListener('open', () => {
      this.#retryDelay = 500;
      this.dispatchEvent(new Event('open'));
    });

    ws.addEventListener('message', (event) => {
      if (typeof event.data === 'string') {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        this.dispatchEvent(new CustomEvent('message', { detail: message }));
      } else {
        this.dispatchEvent(new CustomEvent('frame', { detail: event.data }));
      }
    });

    ws.addEventListener('close', (event) => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.dispatchEvent(new Event('close'));
      if (this.#stopped) return;

      if (event.code === CLOSE_REPLACED) {
        this.#stopped = true;
        this.dispatchEvent(new Event('replaced'));
        return;
      }
      if (event.code === CLOSE_SESSION_EXPIRED) {
        this.#stopped = true;
        this.dispatchEvent(new Event('unauthorized'));
        return;
      }
      this.#scheduleReconnect();
    });
  }

  close() {
    this.#stopped = true;
    clearTimeout(this.#retryTimer);
    this.#ws?.close();
  }

  send(message) {
    if (this.isOpen) this.#ws.send(JSON.stringify(message));
  }

  async #scheduleReconnect() {
    // A rejected upgrade looks like a normal network error, so ask the server directly.
    try {
      const response = await fetch('/api/session', { cache: 'no-store' });
      if (response.status === 401) {
        this.#stopped = true;
        this.dispatchEvent(new Event('unauthorized'));
        return;
      }
    } catch {
      // Network is down; keep retrying.
    }
    if (this.#stopped) return;
    this.#retryTimer = setTimeout(() => this.connect(), this.#retryDelay);
    this.#retryDelay = Math.min(this.#retryDelay * 2, 8000);
  }
}
