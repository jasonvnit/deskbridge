import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { WebSocket, RawData } from 'ws';
import type { Auth } from './auth.ts';
import type { StreamDefaults } from './config.ts';
import type { Helper, HelperEvent } from './helper.ts';
import { log } from './log.ts';
import { notify } from './notify.ts';

// Frames that may be in flight to the client before it acknowledges them.
const INITIAL_CREDITS = 2;
const HEARTBEAT_MS = 15_000;
const SESSION_CHECK_MS = 30_000;
const MAX_TEXT_LENGTH = 20_000;
const KEY_CODE_PATTERN = /^[A-Za-z0-9]{1,32}$/;

export const CLOSE_REPLACED = 4001;
export const CLOSE_SESSION_EXPIRED = 4003;

interface StreamSettings {
  codec: 'h264' | 'jpeg';
  fps: number;
  quality: number;
  bitrate: number;
  maxWidth: number;
  displayId: number;
}

// Binary messages to the browser start with one byte telling what follows.
const BINARY_JPEG = 1;
const BINARY_H264 = 2;

interface Client {
  id: string;
  ws: WebSocket;
  ip: string;
  token: string;
  stream: StreamSettings;
  alive: boolean;
  /** Paused clients get no frames and cannot send input until they resume. */
  paused: boolean;
  timers: NodeJS.Timeout[];
}

type ClientMessage = { t?: unknown; [key: string]: unknown };

function num(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Owns the single active remote-control connection.
 * A new connection replaces the previous one.
 */
export class SessionHub {
  readonly #helper: Helper;
  readonly #auth: Auth;
  readonly #defaults: StreamDefaults;
  readonly #notifyOnConnect: boolean;
  readonly #idlePauseMinutes: number;
  #active: Client | null = null;
  #displayId = 0;

  constructor(helper: Helper, auth: Auth, defaults: StreamDefaults, notifyOnConnect: boolean, idlePauseMinutes: number) {
    this.#helper = helper;
    this.#auth = auth;
    this.#defaults = defaults;
    this.#notifyOnConnect = notifyOnConnect;
    this.#idlePauseMinutes = idlePauseMinutes;

    helper.on('frame', (jpeg: Buffer) => this.#sendBinary(BINARY_JPEG, jpeg));
    helper.on('video', (accessUnit: Buffer) => this.#sendBinary(BINARY_H264, accessUnit));
    helper.on('event', (event: HelperEvent) => this.#onHelperEvent(event));
    helper.on('ready', () => {
      if (this.#active && !this.#active.paused) this.#startStream(this.#active);
    });
  }

  get hasActiveClient(): boolean {
    return this.#active !== null;
  }

  attach(ws: WebSocket, req: IncomingMessage, ip: string, token: string): void {
    const previous = this.#active;
    if (previous) {
      log.info(`replacing session from ${previous.ip} with a new one from ${ip}`);
      this.#send(previous, { t: 'replaced' });
      previous.ws.close(CLOSE_REPLACED, 'replaced by another device');
      this.#detach(previous);
    }

    const client: Client = {
      id: randomUUID(),
      ws,
      ip,
      token,
      stream: {
        codec: 'jpeg',
        fps: this.#defaults.fps,
        quality: this.#defaults.quality,
        bitrate: this.#defaults.bitrate,
        maxWidth: this.#defaults.maxWidth,
        displayId: 0,
      },
      alive: true,
      paused: false,
      timers: [],
    };
    this.#active = client;
    log.info(`client connected from ${ip} (${req.headers['user-agent'] ?? 'unknown agent'})`);
    if (this.#notifyOnConnect) {
      notify('DeskBridge', `A device connected from ${ip}`);
    }

    ws.on('message', (data, isBinary) => {
      if (!isBinary) this.#onClientMessage(client, data);
    });
    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('close', () => {
      if (this.#active === client) {
        log.info(`client from ${ip} disconnected`);
        this.#detach(client);
      }
    });
    ws.on('error', (error) => log.warn(`websocket error: ${error.message}`));

    client.timers.push(
      setInterval(() => {
        if (!client.alive) {
          ws.terminate();
          return;
        }
        client.alive = false;
        ws.ping();
      }, HEARTBEAT_MS),
      setInterval(() => {
        if (!this.#auth.touch(client.token)) {
          this.#send(client, { t: 'sessionExpired' });
          ws.close(CLOSE_SESSION_EXPIRED, 'session expired');
        }
      }, SESSION_CHECK_MS),
    );

    this.#send(client, { t: 'welcome', defaults: this.#defaults, idlePauseMinutes: this.#idlePauseMinutes });
  }

  /** Closes every connection that uses the given session token (logout). */
  closeSession(token: string): void {
    const client = this.#active;
    if (client && client.token === token) {
      client.ws.close(CLOSE_SESSION_EXPIRED, 'logged out');
      this.#detach(client);
    }
  }

  closeAll(): void {
    const client = this.#active;
    if (client) {
      client.ws.close(1001, 'server shutting down');
      this.#detach(client);
    }
  }

  #detach(client: Client): void {
    for (const timer of client.timers) clearInterval(timer);
    client.timers = [];
    if (this.#active !== client) return;
    this.#active = null;
    this.#helper.send({ type: 'releaseAll' });
    this.#helper.send({ type: 'stop' });
  }

  #startStream(client: Client): void {
    this.#helper.send({ type: 'resetCredits', n: INITIAL_CREDITS });
    this.#helper.send({ type: 'start', ...client.stream });
  }

  #sendBinary(kind: number, payload: Buffer): void {
    const client = this.#active;
    if (!client || client.paused || client.ws.readyState !== client.ws.OPEN) return;
    client.ws.send(Buffer.concat([Buffer.from([kind]), payload]), { binary: true });
  }

  #onHelperEvent(event: HelperEvent): void {
    const client = this.#active;
    if (!client || client.paused) return;
    if (event.type === 'cursor') {
      this.#send(client, { t: 'cursor', x: event.x, y: event.y, visible: event.visible, seq: event.seq });
    } else if (event.type === 'cursorShape') {
      this.#send(client, {
        t: 'cursorShape',
        id: event.id,
        png: event.png,
        hotX: event.hotX,
        hotY: event.hotY,
        width: event.width,
        height: event.height,
      });
    } else if (event.type === 'streamInfo') {
      this.#displayId = Number(event.displayId) || 0;
      this.#send(client, {
        t: 'streamInfo',
        displayId: this.#displayId,
        codec: event.codec,
        width: event.width,
        height: event.height,
        pointWidth: event.pointWidth,
        pointHeight: event.pointHeight,
        fps: event.fps,
      });
    } else if (event.type === 'videoConfig') {
      this.#send(client, {
        t: 'videoConfig',
        codec: event.codec,
        description: event.description,
        width: event.width,
        height: event.height,
      });
    } else if (event.type === 'streamError') {
      this.#send(client, { t: 'streamError', message: event.message });
    }
  }

  #onClientMessage(client: Client, data: RawData): void {
    if (this.#active !== client) return;

    let message: ClientMessage;
    try {
      message = JSON.parse(data.toString()) as ClientMessage;
    } catch {
      return;
    }

    // While paused, only resuming (stream) and keep-alive messages are accepted.
    if (client.paused && message.t !== 'stream' && message.t !== 'ping') return;

    switch (message.t) {
      case 'ack':
        this.#helper.send({ type: 'credit', n: 1 });
        break;

      case 'pause':
        client.paused = true;
        this.#helper.send({ type: 'releaseAll' });
        this.#helper.send({ type: 'stop' });
        log.info(`client from ${client.ip} paused`);
        break;

      case 'stream':
        if (client.paused) {
          client.paused = false;
          log.info(`client from ${client.ip} resumed`);
        }
        client.stream = {
          codec: message.codec === 'h264' ? 'h264' : 'jpeg',
          fps: Math.round(num(message.fps, client.stream.fps, 1, 60)),
          quality: num(message.quality, client.stream.quality, 0.1, 1),
          bitrate: Math.round(num(message.bitrate, client.stream.bitrate, 200, 50_000)),
          maxWidth: Math.round(num(message.maxWidth, client.stream.maxWidth, 0, 8192)),
          displayId: Math.round(num(message.displayId, client.stream.displayId, 0, 2 ** 32 - 1)),
        };
        this.#startStream(client);
        break;

      case 'refresh':
        this.#helper.send({ type: 'refresh' });
        break;

      case 'keyframe':
        // The browser's decoder lost track (error or reset): restart flow control
        // and send a fresh key frame.
        this.#helper.send({ type: 'resetCredits', n: INITIAL_CREDITS });
        this.#helper.send({ type: 'keyframe' });
        break;

      case 'mouse': {
        const action = message.action;
        if (action !== 'move' && action !== 'down' && action !== 'up' && action !== 'scroll') return;
        const button = message.button;
        const command: Record<string, unknown> = { type: 'mouse', action, displayId: this.#displayId };
        if (typeof message.seq === 'number' && Number.isSafeInteger(message.seq)) command.seq = message.seq;
        if (typeof message.x === 'number' && typeof message.y === 'number') {
          command.x = num(message.x, 0, 0, 1);
          command.y = num(message.y, 0, 0, 1);
        }
        if (action === 'down' || action === 'up') {
          command.button = button === 'right' || button === 'middle' ? button : 'left';
        }
        if (action === 'scroll') {
          command.dx = num(message.dx, 0, -5000, 5000);
          command.dy = num(message.dy, 0, -5000, 5000);
        }
        this.#helper.send(command);
        break;
      }

      case 'key': {
        if (typeof message.code !== 'string' || !KEY_CODE_PATTERN.test(message.code)) return;
        this.#helper.send({
          type: 'key',
          code: message.code,
          down: message.down !== false,
          repeat: message.repeat === true,
        });
        break;
      }

      case 'text':
        if (typeof message.text !== 'string' || message.text.length === 0) return;
        this.#helper.send({ type: 'text', text: message.text.slice(0, MAX_TEXT_LENGTH) });
        break;

      case 'releaseAll':
        this.#helper.send({ type: 'releaseAll' });
        break;

      case 'ping':
        this.#send(client, { t: 'pong', ts: message.ts });
        break;

      default:
        break;
    }
  }

  #send(client: Client, message: Record<string, unknown>): void {
    if (client.ws.readyState === client.ws.OPEN) {
      client.ws.send(JSON.stringify(message));
    }
  }
}
