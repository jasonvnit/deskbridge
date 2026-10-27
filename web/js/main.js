import { ClipboardController } from './clipboard.js';
import { CursorOverlay } from './cursor.js';
import { Connection } from './connection.js';
import { KeyboardController } from './keyboard.js';
import { PointerController } from './pointer.js';
import { QUALITY_PRESETS, Settings } from './settings.js';
import { closePanels, focusGuard, setConnectionState, setStatus, toast, togglePanel } from './ui.js';
import { isH264Supported, VideoPipeline } from './video.js';
import { Viewer } from './viewer.js';

const $ = (id) => document.getElementById(id);

const settings = new Settings();
const connection = new Connection();
const send = (message) => connection.send(message);

const viewer = new Viewer($('stage'), $('screen'));
const keyboard = new KeyboardController({ sink: $('kbd-sink'), send, settings });
const clipboard = new ClipboardController({ keyboard });
const cursor = new CursorOverlay({ element: $('remote-cursor'), viewer });
const video = new VideoPipeline({
  viewer,
  onDone: () => send({ t: 'ack' }),
  requestKeyFrame: () => send({ t: 'keyframe' }),
});
const pointer = new PointerController({
  stage: $('stage'),
  viewer,
  send,
  settings,
  cursor,
});

// ---- Stats ------------------------------------------------------------------

const stats = { frames: 0, bytes: 0, latency: null, width: 0, height: 0, codec: '' };

setInterval(() => {
  $('stat-fps').textContent = connection.isOpen ? String(stats.frames) : '–';
  $('stat-bandwidth').textContent = connection.isOpen ? `${Math.round((stats.bytes * 8) / 1000)} kbit/s` : '–';
  $('stat-latency').textContent = stats.latency === null ? '–' : `${stats.latency} ms`;
  $('stat-resolution').textContent = stats.width ? `${stats.width} × ${stats.height}` : '–';
  $('stat-codec').textContent = stats.codec ? (stats.codec === 'h264' ? 'H.264 video' : 'JPEG images') : '–';
  stats.frames = 0;
  stats.bytes = 0;
  send({ t: 'ping', ts: performance.now() });
}, 1000);

// ---- Connection ------------------------------------------------------------------

viewer.onFrameDrawn = () => send({ t: 'ack' });

connection.addEventListener('open', () => {
  setConnectionState('ok');
  setStatus('Waiting for the screen…');
});

connection.addEventListener('close', () => {
  setConnectionState('bad');
  stats.latency = null;
  setStatus('Reconnecting…');
});

// Binary messages: first byte 1 = JPEG image, 2 = H.264 access unit.
connection.addEventListener('frame', (event) => {
  const bytes = new Uint8Array(event.detail);
  stats.frames += 1;
  stats.bytes += bytes.byteLength;
  setStatus(null);
  if (bytes[0] === 2) video.push(bytes.subarray(1));
  else viewer.pushJpeg(bytes.subarray(1));
});

connection.addEventListener('message', (event) => {
  const message = event.detail;
  switch (message.t) {
    case 'welcome':
      idleLimitMs = Math.max(0, Number(message.idlePauseMinutes) || 0) * 60_000;
      settings.setServerDefaults(message.defaults);
      if (settings.get('qualityPreset') === 'server') {
        settings.set('fps', message.defaults.fps);
        syncFpsInput();
      }
      // After a reconnect while paused, wait for the user to press Resume.
      if (!paused) send({ t: 'stream', ...settings.streamParams() });
      break;
    case 'streamInfo':
      stats.width = message.width;
      stats.height = message.height;
      stats.codec = message.codec;
      if (message.codec !== 'h264') video.close();
      cursor.setDisplayPointWidth(message.pointWidth);
      break;
    case 'sleep':
      // The server already stopped the stream and input; show the overlay.
      pause(message.reason === 'local' ? 'local' : 'idle');
      break;
    case 'videoConfig':
      try {
        video.configure(message);
      } catch (error) {
        // Decoder unavailable after all: switch this device to JPEG.
        console.warn('[deskbridge] cannot configure H.264 decoder', error);
        settings.h264Supported = false;
        send({ t: 'stream', ...settings.streamParams() });
      }
      break;
    case 'cursor':
      cursor.setRemote(message.x, message.y, message.visible, message.seq ?? 0);
      break;
    case 'cursorShape':
      cursor.setShape(message);
      break;
    case 'streamError':
      setStatus(`Screen capture failed: ${message.message}`, { error: true });
      break;
    case 'pong':
      stats.latency = Math.round(performance.now() - message.ts);
      break;
    default:
      break;
  }
});

connection.addEventListener('replaced', () => {
  setConnectionState('bad');
  setStatus('Another device took over this session.', {
    error: true,
    action: {
      label: 'Take back control',
      onClick: () => {
        setStatus('Reconnecting…');
        connection.connect();
      },
    },
  });
});

connection.addEventListener('unauthorized', () => {
  location.replace('/login');
});

// ---- Toolbar --------------------------------------------------------------------

function renderMode() {
  $('btn-mode').textContent = settings.get('mode') === 'trackpad' ? 'Trackpad' : 'Touch';
  $('set-mode').value = settings.get('mode');
}

function setToolbarHidden(hidden) {
  settings.set('toolbarHidden', hidden);
  $('toolbar').hidden = hidden;
  $('btn-show-toolbar').hidden = !hidden;
  if (hidden) closePanels();
}

$('btn-mode').addEventListener('click', () => {
  settings.set('mode', settings.get('mode') === 'touch' ? 'trackpad' : 'touch');
  toast(settings.get('mode') === 'trackpad' ? 'Trackpad mode: drag to move the pointer, tap to click' : 'Touch mode: tap where you want to click');
});

$('btn-keyboard').addEventListener('click', () => {
  if (keyboard.softKeyboardOpen) {
    keyboard.hideSoftKeyboard();
  } else {
    closePanels();
    keyboard.showSoftKeyboard();
  }
});

$('btn-keys').addEventListener('click', () => {
  const bar = $('keys-bar');
  bar.hidden = !bar.hidden;
  $('btn-keys').classList.toggle('active', !bar.hidden);
});

$('btn-clipboard').addEventListener('click', () => {
  $('btn-clipboard').classList.toggle('active', togglePanel('panel-clipboard'));
  $('btn-settings').classList.remove('active');
});

$('btn-settings').addEventListener('click', () => {
  const open = togglePanel('panel-settings');
  $('btn-settings').classList.toggle('active', open);
  $('btn-clipboard').classList.remove('active');
  if (open) loadDisplays();
});

$('btn-fit').addEventListener('click', () => viewer.resetZoom());
$('btn-hide').addEventListener('click', () => setToolbarHidden(true));
$('btn-show-toolbar').addEventListener('click', () => setToolbarHidden(false));

for (const button of document.querySelectorAll('.panel-close')) {
  button.addEventListener('click', () => {
    closePanels();
    $('btn-clipboard').classList.remove('active');
    $('btn-settings').classList.remove('active');
  });
}

// A tap on the screen while a panel is open only closes the panel.
pointer.onPointerStart = () => {
  const open = !$('panel-clipboard').hidden || !$('panel-settings').hidden;
  if (open) {
    closePanels();
    $('btn-clipboard').classList.remove('active');
    $('btn-settings').classList.remove('active');
    return false;
  }
  return true;
};

const root = document.documentElement;
if (document.fullscreenEnabled || document.webkitFullscreenEnabled) {
  $('btn-fullscreen').hidden = false;
  $('btn-fullscreen').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        await (document.exitFullscreen?.() ?? document.webkitExitFullscreen?.());
        navigator.keyboard?.unlock?.();
      } else {
        await (root.requestFullscreen?.({ navigationUI: 'hide' }) ?? root.webkitRequestFullscreen?.());
        // Chrome: capture shortcuts such as ⌘W / Ctrl+W while in full screen.
        await navigator.keyboard?.lock?.().catch(() => {});
      }
    } catch {
      toast('Full screen is not available here', { error: true });
    }
  });
}

// ---- Special keys bar --------------------------------------------------------------

const latchButtons = [...document.querySelectorAll('.key.mod')];
keyboard.bindLatchButtons(latchButtons);

for (const button of document.querySelectorAll('#keys-bar .key')) {
  // Keep focus where it is (so the soft keyboard stays open).
  button.addEventListener('pointerdown', (e) => e.preventDefault());
  button.addEventListener('click', () => {
    if (button.dataset.mod) keyboard.toggleLatch(button.dataset.mod);
    else if (button.dataset.key) keyboard.tap(button.dataset.key);
    else if (button.dataset.combo) {
      keyboard.combo(button.dataset.combo.split('+'));
      keyboard.clearLatches();
    }
  });
}

// Keep the keys bar above the soft keyboard.
function updateKeyboardOffset() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const offset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
  root.style.setProperty('--keyboard-offset', `${offset}px`);
}
window.visualViewport?.addEventListener('resize', updateKeyboardOffset);
window.visualViewport?.addEventListener('scroll', updateKeyboardOffset);

// ---- Settings panel ---------------------------------------------------------------

function bindRange(id, key, format) {
  const input = $(id);
  const label = $(`${id}-value`);
  input.value = settings.get(key);
  label.textContent = format(settings.get(key));
  input.addEventListener('input', () => {
    settings.set(key, Number(input.value));
    label.textContent = format(Number(input.value));
  });
}

function bindCheckbox(id, key) {
  const input = $(id);
  input.checked = settings.get(key);
  input.addEventListener('change', () => settings.set(key, input.checked));
}

let streamUpdateTimer = 0;
function updateStream() {
  clearTimeout(streamUpdateTimer);
  streamUpdateTimer = setTimeout(() => {
    if (!paused) send({ t: 'stream', ...settings.streamParams() });
  }, 250);
}

$('set-quality').value = settings.get('qualityPreset');
function syncFpsInput() {
  $('set-fps').value = settings.get('fps');
  $('set-fps-value').textContent = `${settings.get('fps')}`;
}

$('set-quality').addEventListener('change', (e) => {
  const preset = QUALITY_PRESETS[e.target.value] ?? settings.serverDefaults;
  settings.set('qualityPreset', e.target.value);
  if (preset) settings.set('fps', preset.fps);
  syncFpsInput();
  updateStream();
});

$('set-codec').value = settings.get('codec');
$('set-codec').addEventListener('change', (e) => {
  settings.set('codec', e.target.value);
  if (e.target.value !== 'jpeg' && !settings.h264Supported) toast('This browser cannot decode H.264; using JPEG');
  updateStream();
});

bindRange('set-fps', 'fps', (v) => `${v}`);
$('set-fps').addEventListener('change', updateStream);
bindRange('set-trackpad', 'trackpadSpeed', (v) => `${Number(v).toFixed(1)}×`);
bindRange('set-scroll', 'scrollSpeed', (v) => `${Number(v).toFixed(1)}×`);
bindCheckbox('set-paste-sync', 'pasteSync');
bindCheckbox('set-copy-sync', 'copySync');
bindCheckbox('set-pause-on-blur', 'pauseOnBlur');

$('set-mode').addEventListener('change', (e) => settings.set('mode', e.target.value));

$('set-pointer-sync').value = settings.get('pointerSync');
cursor.setDetached(settings.get('pointerSync') === 'click');
$('set-pointer-sync').addEventListener('change', (e) => {
  settings.set('pointerSync', e.target.value);
  cursor.setDetached(e.target.value === 'click');
});
settings.addEventListener('change', (e) => {
  if (e.detail.key === 'mode') renderMode();
});

$('set-display').addEventListener('change', (e) => {
  settings.set('displayId', Number(e.target.value));
  viewer.resetZoom();
  updateStream();
});

async function loadDisplays() {
  const select = $('set-display');
  try {
    const response = await fetch('/api/displays', { cache: 'no-store' });
    if (!response.ok) return;
    const { displays = [] } = await response.json();
    select.replaceChildren(
      ...displays.map((display) => {
        const option = document.createElement('option');
        option.value = String(display.id);
        option.textContent = `${display.name}${display.isMain ? ' (main)' : ''} – ${display.width}×${display.height}`;
        return option;
      }),
    );
    const current = settings.get('displayId');
    const main = displays.find((display) => display.isMain);
    select.value = String(displays.some((display) => display.id === current) ? current : main?.id ?? '');
  } catch {
    // Keep whatever is shown.
  }
}

$('btn-release').addEventListener('click', () => {
  keyboard.releaseAll();
  keyboard.clearLatches();
  toast('Released all keys and buttons');
});

$('btn-logout').addEventListener('click', async () => {
  connection.close();
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  location.replace('/login');
});

// ---- Pause / resume ------------------------------------------------------------------
// Leaving the page (other tab, other app, locked screen) pauses streaming and input,
// so nothing is sent to the Mac by accident. Coming back shows an overlay with Resume.

let paused = false;

// Why the session is paused: 'away' (left the page) or 'idle' (no input for a while).
const PAUSE_REASONS = {
  away: {
    title: 'Paused',
    text: 'Remote control was paused while you were away. The Mac is not being streamed or controlled.',
    button: 'Resume',
  },
  local: {
    title: 'Mac in use',
    text: 'Someone is using the Mac\'s own keyboard or mouse, so remote control went to sleep to avoid getting in each other\'s way.',
    button: 'Wake up',
  },
  idle: {
    title: 'Sleeping',
    text: 'No activity for a while, so remote control went to sleep. Nothing is streamed or sent to the Mac, so it will not get in the way if you are using the Mac directly.',
    button: 'Wake up',
  },
};

function closeToolbarPanels() {
  closePanels();
  $('btn-clipboard').classList.remove('active');
  $('btn-settings').classList.remove('active');
}

function pause(reason = 'away') {
  if (paused) return;
  paused = true;
  const copy = PAUSE_REASONS[reason] ?? PAUSE_REASONS.away;
  $('pause-title').textContent = copy.title;
  $('pause-text').textContent = copy.text;
  $('btn-resume').textContent = copy.button;
  keyboard.releaseAll();
  keyboard.clearLatches();
  keyboard.hideSoftKeyboard();
  keyboard.enabled = false;
  send({ t: 'pause' });
  closeToolbarPanels();
  $('pause-overlay').hidden = false;
}

function resume() {
  if (!paused) return;
  paused = false;
  markActivity();
  keyboard.enabled = true;
  $('pause-overlay').hidden = true;
  send({ t: 'stream', ...settings.streamParams() });
}

$('btn-resume').addEventListener('click', resume);

document.addEventListener('visibilitychange', () => {
  if (document.hidden) pause();
  else if (paused) $('btn-resume').focus({ preventScroll: true });
});
window.addEventListener('pagehide', pause);
window.addEventListener('blur', () => {
  if (settings.get('pauseOnBlur') && !focusGuard.expected) pause();
});
window.addEventListener('focus', () => {
  focusGuard.expected = false;
  if (paused) $('btn-resume').focus({ preventScroll: true });
});

// ---- Sleep when idle -------------------------------------------------------------------
// If nobody touches the web UI for a while (e.g. the remote was left open while the user
// works on the Mac itself), stop streaming and input until "Wake up" is pressed.

let idleLimitMs = 3 * 60_000;
let lastActivity = performance.now();

function markActivity() {
  lastActivity = performance.now();
}

for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart']) {
  document.addEventListener(type, markActivity, { capture: true, passive: true });
}

setInterval(() => {
  if (paused || idleLimitMs <= 0) return;
  if (performance.now() - lastActivity >= idleLimitMs) pause('idle');
}, 5000);

// ---- Start -------------------------------------------------------------------------

renderMode();
setToolbarHidden(settings.get('toolbarHidden'));
settings.h264Supported = await isH264Supported();
connection.connect();

// Expose for debugging in the browser console.
window.deskbridge = {
  settings, connection, viewer, keyboard, clipboard, pointer, cursor, video,
  idle: { get lastActivity() { return lastActivity; }, set lastActivity(value) { lastActivity = value; } },
};
