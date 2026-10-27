import { execFile } from 'node:child_process';

/** Shows a macOS notification. Text is passed as an argument, never interpolated into the script. */
export function notify(title: string, message: string): void {
  execFile(
    'osascript',
    [
      '-e', 'on run argv',
      '-e', 'display notification (item 2 of argv) with title (item 1 of argv)',
      '-e', 'end run',
      title,
      message,
    ],
    () => {
      // Notifications are best effort.
    },
  );
}
