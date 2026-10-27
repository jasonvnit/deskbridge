import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const MIN_PASSWORD_LENGTH = 12;

export interface StreamDefaults {
  fps: number;
  quality: number;
  maxWidth: number;
}

export interface Config {
  host: string;
  port: number;
  password: string;
  sessionTtlMs: number;
  sessionIdleMs: number;
  stream: StreamDefaults;
  helperPath: string;
  webDir: string;
  notifyOnConnect: boolean;
}

function readInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}`);
  }
  return value;
}

function readBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

export function loadConfig(): Config {
  const envFile = process.env.DESKBRIDGE_ENV_FILE ?? path.join(ROOT_DIR, '.env');
  if (existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }

  const password = process.env.DESKBRIDGE_PASSWORD ?? '';
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`DESKBRIDGE_PASSWORD must be set and at least ${MIN_PASSWORD_LENGTH} characters long`);
  }

  return {
    host: process.env.DESKBRIDGE_HOST?.trim() || '127.0.0.1',
    port: readInt('DESKBRIDGE_PORT', 8765, 1, 65535),
    password,
    sessionTtlMs: readInt('DESKBRIDGE_SESSION_TTL_HOURS', 12, 1, 720) * 3_600_000,
    sessionIdleMs: readInt('DESKBRIDGE_SESSION_IDLE_MINUTES', 60, 1, 10_080) * 60_000,
    stream: {
      fps: readInt('DESKBRIDGE_STREAM_FPS', 15, 1, 60),
      quality: readInt('DESKBRIDGE_STREAM_QUALITY', 50, 10, 100) / 100,
      maxWidth: readInt('DESKBRIDGE_STREAM_MAX_WIDTH', 1600, 0, 8192),
    },
    helperPath:
      process.env.DESKBRIDGE_HELPER_PATH?.trim() ||
      path.join(ROOT_DIR, 'helper-macos/.build/release/deskbridge-helper'),
    webDir: path.join(ROOT_DIR, 'web'),
    notifyOnConnect: readBool('DESKBRIDGE_NOTIFY_ON_CONNECT', true),
  };
}
