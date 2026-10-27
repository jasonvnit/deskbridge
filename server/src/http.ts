import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import {
  type Auth,
  clearedSessionCookie,
  clientIp,
  isHttps,
  isSameOrigin,
  sessionCookie,
  sessionToken,
} from './auth.ts';
import type { Config } from './config.ts';
import type { Helper } from './helper.ts';
import { log } from './log.ts';
import { notify } from './notify.ts';
import type { SessionHub } from './session.ts';

const MAX_JSON_BODY = 256 * 1024;
const MAX_IMAGE_BODY = 30 * 1024 * 1024;
const FAILED_LOGIN_DELAY_MS = 600;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface Deps {
  config: Config;
  auth: Auth;
  helper: Helper;
  hub: SessionHub;
}

function securityHeaders(req: IncomingMessage): Record<string, string> {
  const host = req.headers.host ?? '';
  return {
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' blob: data:",
      `connect-src 'self' wss://${host} ws://${host}`,
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; '),
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > limit) throw new HttpError(413, 'payload too large');

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'payload too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(req, MAX_JSON_BODY);
  try {
    const value = JSON.parse(body.toString('utf8')) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Fall through.
  }
  throw new HttpError(400, 'invalid JSON body');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createRequestHandler({ config, auth, helper, hub }: Deps) {
  const staticRoot = config.webDir + path.sep;
  const sessionMaxAgeSec = Math.floor(config.sessionTtlMs / 1000);

  // Files are small and served from localhost; always revalidate so updates apply immediately.
  async function serveFile(req: IncomingMessage, res: ServerResponse, relative: string): Promise<void> {
    const filePath = path.resolve(config.webDir, relative);
    if (!filePath.startsWith(staticRoot)) throw new HttpError(404, 'not found');
    let content: Buffer;
    try {
      content = await readFile(filePath);
    } catch {
      throw new HttpError(404, 'not found');
    }
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ...securityHeaders(req),
    });
    res.end(content);
  }

  function requireSession(req: IncomingMessage): string {
    const token = sessionToken(req);
    if (!auth.touch(token)) throw new HttpError(401, 'not signed in');
    return token as string;
  }

  function requireSameOrigin(req: IncomingMessage): void {
    if (!isSameOrigin(req)) throw new HttpError(403, 'cross-origin request rejected');
  }

  async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    requireSameOrigin(req);
    const ip = clientIp(req);
    const gate = auth.checkLoginAllowed(ip);
    if (!gate.allowed) {
      sendJson(res, 429, { error: 'too_many_attempts', retryAfterSec: gate.retryAfterSec }, {
        'Retry-After': String(gate.retryAfterSec),
      });
      return;
    }

    const body = await readJson(req);
    const password = typeof body.password === 'string' ? body.password : '';
    if (!auth.verifyPassword(password)) {
      const globalLock = auth.recordFailure(ip);
      log.warn(`failed login from ${ip}`);
      if (globalLock) {
        log.warn('too many failed logins overall; login is locked for everyone for a while');
        notify('DeskBridge', 'Too many failed logins. Login is temporarily locked.');
      }
      await sleep(FAILED_LOGIN_DELAY_MS);
      sendJson(res, 401, { error: 'invalid_password' });
      return;
    }

    auth.recordSuccess(ip);
    const token = auth.createSession();
    log.info(`login from ${ip}`);
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(token, sessionMaxAgeSec, isHttps(req)) });
  }

  async function handleClipboardGet(res: ServerResponse): Promise<void> {
    const result = await helper.request('clipboardGet');
    sendJson(res, 200, {
      text: typeof result.text === 'string' ? result.text : null,
      image: typeof result.image === 'string' ? result.image : null,
    });
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    const pathname = url.pathname;

    if (method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === 'GET' && pathname === '/login') {
      await serveFile(req, res, 'login.html');
      return;
    }

    if (method === 'GET' && pathname.startsWith('/static/')) {
      await serveFile(req, res, decodeURIComponent(pathname.slice('/static/'.length)));
      return;
    }

    if (method === 'GET' && pathname === '/') {
      if (!auth.touch(sessionToken(req))) {
        redirect(res, '/login');
        return;
      }
      await serveFile(req, res, 'index.html');
      return;
    }

    if (method === 'POST' && pathname === '/api/login') {
      await handleLogin(req, res);
      return;
    }

    if (method === 'POST' && pathname === '/api/logout') {
      requireSameOrigin(req);
      const token = sessionToken(req);
      if (token) {
        hub.closeSession(token);
        auth.revoke(token);
      }
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearedSessionCookie(isHttps(req)) });
      return;
    }

    if (pathname.startsWith('/api/')) {
      requireSession(req);

      if (method === 'GET' && pathname === '/api/session') {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (method === 'GET' && pathname === '/api/displays') {
        sendJson(res, 200, await helper.request('displays'));
        return;
      }
      if (method === 'GET' && pathname === '/api/clipboard') {
        await handleClipboardGet(res);
        return;
      }
      if (method === 'POST' && pathname === '/api/clipboard/text') {
        requireSameOrigin(req);
        const body = await readJson(req);
        if (typeof body.text !== 'string') throw new HttpError(400, 'text is required');
        await helper.request('clipboardSetText', { text: body.text });
        sendJson(res, 200, { ok: true });
        return;
      }
      if (method === 'POST' && pathname === '/api/clipboard/image') {
        requireSameOrigin(req);
        const contentType = req.headers['content-type'] ?? '';
        if (!contentType.startsWith('image/')) throw new HttpError(415, 'an image body is required');
        const body = await readBody(req, MAX_IMAGE_BODY);
        if (body.length === 0) throw new HttpError(400, 'empty image');
        await helper.request('clipboardSetImage', { data: body.toString('base64') }, 30_000);
        sendJson(res, 200, { ok: true });
        return;
      }
    }

    throw new HttpError(404, 'not found');
  }

  return (req: IncomingMessage, res: ServerResponse): void => {
    route(req, res).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) log.error(`request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, status, { error: error instanceof Error ? error.message : 'internal error' });
    });
  };
}
