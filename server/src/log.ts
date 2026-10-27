type Level = 'info' | 'warn' | 'error';

function write(level: Level, message: string): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const log = {
  info: (message: string) => write('info', message),
  warn: (message: string) => write('warn', message),
  error: (message: string) => write('error', message),
};
