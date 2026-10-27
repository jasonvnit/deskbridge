import http from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { Auth, clientIp, isSameOrigin, sessionToken } from './auth.ts';
import { loadConfig } from './config.ts';
import { Helper } from './helper.ts';
import { createRequestHandler } from './http.ts';
import { log } from './log.ts';
import { SessionHub } from './session.ts';

let config;
try {
  config = loadConfig();
} catch (error) {
  log.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const auth = new Auth(config.password, config.sessionTtlMs, config.sessionIdleMs);
const helper = new Helper(config.helperPath);
const hub = new SessionHub(helper, auth, config.stream, config.notifyOnConnect);

try {
  helper.start();
} catch (error) {
  log.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const server = http.createServer(createRequestHandler({ config, auth, helper, hub }));
server.requestTimeout = 120_000;

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (pathname !== '/ws') {
    rejectUpgrade(socket, 404, 'Not Found');
    return;
  }
  if (!isSameOrigin(req)) {
    rejectUpgrade(socket, 403, 'Forbidden');
    return;
  }
  const token = sessionToken(req);
  if (!token || !auth.touch(token)) {
    rejectUpgrade(socket, 401, 'Unauthorized');
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => hub.attach(ws, req, clientIp(req), token));
});

server.listen(config.port, config.host, () => {
  log.info(`DeskBridge listening on http://${config.host}:${config.port}`);
});

server.on('error', (error) => {
  log.error(`server error: ${error.message}`);
  process.exit(1);
});

function shutdown(signal: string): void {
  log.info(`received ${signal}, shutting down`);
  hub.closeAll();
  helper.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
