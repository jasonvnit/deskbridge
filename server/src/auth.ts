import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const SESSION_COOKIE = 'deskbridge_session';

// Per-IP limit: this many failures inside the window locks that IP.
const IP_MAX_FAILURES = 5;
const IP_WINDOW_MS = 15 * 60_000;
const IP_LOCK_MS = 15 * 60_000;

// Global limit: protects against attackers rotating IP addresses.
const GLOBAL_MAX_FAILURES = 30;
const GLOBAL_WINDOW_MS = 60 * 60_000;
const GLOBAL_LOCK_MS = 30 * 60_000;

interface Session {
  createdAt: number;
  lastSeen: number;
}

interface FailureRecord {
  count: number;
  firstAt: number;
  lockedUntil: number;
}

export type LoginGate = { allowed: true } | { allowed: false; retryAfterSec: number };

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export class Auth {
  readonly #passwordHash: Buffer;
  readonly #ttlMs: number;
  readonly #idleMs: number;
  readonly #sessions = new Map<string, Session>();
  readonly #failures = new Map<string, FailureRecord>();
  #globalFailures: number[] = [];
  #globalLockedUntil = 0;

  constructor(password: string, ttlMs: number, idleMs: number) {
    this.#passwordHash = sha256(password);
    this.#ttlMs = ttlMs;
    this.#idleMs = idleMs;
    setInterval(() => this.#sweep(), 60_000).unref();
  }

  // ---- Login throttling -------------------------------------------------

  checkLoginAllowed(ip: string, now = Date.now()): LoginGate {
    if (this.#globalLockedUntil > now) {
      return { allowed: false, retryAfterSec: Math.ceil((this.#globalLockedUntil - now) / 1000) };
    }
    const record = this.#failures.get(ip);
    if (record && record.lockedUntil > now) {
      return { allowed: false, retryAfterSec: Math.ceil((record.lockedUntil - now) / 1000) };
    }
    return { allowed: true };
  }

  verifyPassword(candidate: string): boolean {
    return timingSafeEqual(sha256(candidate), this.#passwordHash);
  }

  /** Returns true when this failure triggered the global lock. */
  recordFailure(ip: string, now = Date.now()): boolean {
    const record = this.#failures.get(ip);
    if (!record || now - record.firstAt > IP_WINDOW_MS) {
      this.#failures.set(ip, { count: 1, firstAt: now, lockedUntil: 0 });
    } else {
      record.count += 1;
      if (record.count >= IP_MAX_FAILURES) {
        record.lockedUntil = now + IP_LOCK_MS;
      }
    }

    this.#globalFailures = this.#globalFailures.filter((t) => now - t < GLOBAL_WINDOW_MS);
    this.#globalFailures.push(now);
    if (this.#globalFailures.length >= GLOBAL_MAX_FAILURES && this.#globalLockedUntil <= now) {
      this.#globalLockedUntil = now + GLOBAL_LOCK_MS;
      this.#globalFailures = [];
      return true;
    }
    return false;
  }

  recordSuccess(ip: string): void {
    this.#failures.delete(ip);
  }

  // ---- Sessions -----------------------------------------------------------

  createSession(now = Date.now()): string {
    const token = randomBytes(32).toString('base64url');
    this.#sessions.set(this.#key(token), { createdAt: now, lastSeen: now });
    return token;
  }

  /** Validates a session token and marks it as recently used. */
  touch(token: string | undefined, now = Date.now()): boolean {
    if (!token) return false;
    const key = this.#key(token);
    const session = this.#sessions.get(key);
    if (!session) return false;
    if (now - session.createdAt > this.#ttlMs || now - session.lastSeen > this.#idleMs) {
      this.#sessions.delete(key);
      return false;
    }
    session.lastSeen = now;
    return true;
  }

  revoke(token: string | undefined): void {
    if (token) this.#sessions.delete(this.#key(token));
  }

  #key(token: string): string {
    return sha256(token).toString('hex');
  }

  #sweep(now = Date.now()): void {
    for (const [key, session] of this.#sessions) {
      if (now - session.createdAt > this.#ttlMs || now - session.lastSeen > this.#idleMs) {
        this.#sessions.delete(key);
      }
    }
    for (const [ip, record] of this.#failures) {
      if (record.lockedUntil < now && now - record.firstAt > IP_WINDOW_MS) {
        this.#failures.delete(ip);
      }
    }
  }
}

// ---- Request helpers ------------------------------------------------------

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) {
      try {
        cookies[name] = decodeURIComponent(value);
      } catch {
        cookies[name] = value;
      }
    }
  }
  return cookies;
}

export function sessionToken(req: IncomingMessage): string | undefined {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE];
}

/** Client IP as seen by Cloudflare; the server only listens on localhost. */
export function clientIp(req: IncomingMessage): string {
  const cfIp = req.headers['cf-connecting-ip'];
  if (typeof cfIp === 'string' && cfIp) return cfIp;
  return req.socket.remoteAddress ?? 'unknown';
}

export function isHttps(req: IncomingMessage): boolean {
  const proto = req.headers['x-forwarded-proto'];
  if (typeof proto === 'string' && proto.split(',')[0]?.trim() === 'https') return true;
  const visitor = req.headers['cf-visitor'];
  return typeof visitor === 'string' && visitor.includes('"https"');
}

/** Rejects cross-site requests: the Origin header must match the Host header. */
export function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function sessionCookie(token: string, maxAgeSec: number, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSec}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearedSessionCookie(secure: boolean): string {
  return sessionCookie('', 0, secure);
}
