import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { log } from './log.ts';

const KIND_JSON = 1;
const KIND_FRAME = 2;
const KIND_VIDEO = 3;
const HEADER_SIZE = 5;

export type HelperEvent = { type: string; [key: string]: unknown };

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Runs the native helper as a child process and restarts it if it crashes.
 *
 * Events:
 *   'frame'   (jpeg: Buffer)
 *   'video'   (accessUnit: Buffer)       1 byte key-frame flag + AVCC data
 *   'event'   (message: HelperEvent)   e.g. streamInfo, streamError
 *   'ready'   ()                       helper (re)started and is accepting commands
 */
export class Helper extends EventEmitter {
  readonly #path: string;
  #process: ChildProcessWithoutNullStreams | null = null;
  #buffer: Buffer = Buffer.alloc(0);
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #stopped = false;
  #restartDelayMs = 500;

  constructor(path: string) {
    super();
    this.#path = path;
  }

  start(): void {
    if (!existsSync(this.#path)) {
      throw new Error(`Helper binary not found at ${this.#path}. Run scripts/setup.sh first.`);
    }
    this.#stopped = false;
    this.#spawn();
  }

  stop(): void {
    this.#stopped = true;
    this.#process?.kill('SIGTERM');
    this.#process = null;
  }

  send(message: Record<string, unknown>): void {
    const stdin = this.#process?.stdin;
    if (!stdin || !stdin.writable) return;
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(type: string, payload: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<Record<string, unknown>> {
    if (!this.#process) {
      return Promise.reject(new Error('helper is not running'));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`helper request "${type}" timed out`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.send({ ...payload, type, id });
    });
  }

  #spawn(): void {
    const child = spawn(this.#path, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.#process = child;
    this.#buffer = Buffer.alloc(0);

    child.stdout.on('data', (chunk: Buffer) => this.#onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (text: string) => {
      for (const line of text.split('\n')) {
        if (line.trim()) log.info(line.trim());
      }
    });
    child.stdin.on('error', () => {
      // Ignored: the exit handler restarts the helper.
    });
    child.on('error', (error) => log.error(`helper failed to start: ${error.message}`));
    child.on('exit', (code, signal) => {
      if (this.#process === child) this.#process = null;
      for (const [id, pending] of this.#pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error('helper exited'));
        this.#pending.delete(id);
      }
      if (this.#stopped) return;
      log.warn(`helper exited (code=${code}, signal=${signal}); restarting in ${this.#restartDelayMs}ms`);
      setTimeout(() => {
        if (!this.#stopped) this.#spawn();
      }, this.#restartDelayMs);
      this.#restartDelayMs = Math.min(this.#restartDelayMs * 2, 10_000);
    });
  }

  #onData(chunk: Buffer): void {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);

    while (this.#buffer.length >= HEADER_SIZE) {
      const kind = this.#buffer[0];
      const length = this.#buffer.readUInt32BE(1);
      if (this.#buffer.length < HEADER_SIZE + length) break;

      const payload = this.#buffer.subarray(HEADER_SIZE, HEADER_SIZE + length);
      this.#buffer = this.#buffer.subarray(HEADER_SIZE + length);

      if (kind === KIND_FRAME) {
        this.emit('frame', Buffer.from(payload));
      } else if (kind === KIND_VIDEO) {
        this.emit('video', Buffer.from(payload));
      } else if (kind === KIND_JSON) {
        this.#onMessage(payload.toString('utf8'));
      }
    }
  }

  #onMessage(text: string): void {
    let message: HelperEvent;
    try {
      message = JSON.parse(text) as HelperEvent;
    } catch {
      log.warn('helper sent malformed JSON');
      return;
    }

    if (message.type === 'reply') {
      const id = message.id as number;
      const pending = this.#pending.get(id);
      if (!pending) return;
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      if (message.ok) {
        pending.resolve((message.result as Record<string, unknown>) ?? {});
      } else {
        pending.reject(new Error(String(message.error ?? 'helper error')));
      }
      return;
    }

    if (message.type === 'ready') {
      this.#restartDelayMs = 500;
      const permissions = message.permissions as Record<string, boolean> | undefined;
      if (permissions && (!permissions.screenRecording || !permissions.accessibility)) {
        log.warn(
          `helper is missing permissions: screenRecording=${permissions.screenRecording}, accessibility=${permissions.accessibility}`,
        );
      }
      this.emit('ready');
      return;
    }

    this.emit('event', message);
  }
}
