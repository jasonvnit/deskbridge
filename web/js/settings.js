// v2: defaults changed to Max quality and Trackpad mode; older saved settings are ignored.
const STORAGE_KEY = 'deskbridge.settings.v2';

// JPEG (quality, maxWidth) was measured through Cloudflare Tunnel with ~5-6 Mbit/s upload:
// low ~35 KB/frame (~20 fps), balanced ~65 KB (~10 fps), high ~130 KB (~5 fps).
// H.264 (bitrate in kbit/s, videoMaxWidth) stays under that upload limit.
export const QUALITY_PRESETS = {
  low: { quality: 0.3, maxWidth: 1024, bitrate: 1200, videoMaxWidth: 1280, fps: 24 },
  balanced: { quality: 0.4, maxWidth: 1280, bitrate: 2500, videoMaxWidth: 1920, fps: 30 },
  high: { quality: 0.55, maxWidth: 1600, bitrate: 4000, videoMaxWidth: 2560, fps: 30 },
  // JPEG is capped at 2560 px: native-size JPEG frames would drop below 1 fps.
  max: { quality: 0.8, maxWidth: 2560, bitrate: 6000, videoMaxWidth: 0, fps: 30 },
};

const DEFAULTS = {
  // 'server' uses the defaults from the server's .env.
  qualityPreset: 'max',
  // 'server' follows DESKBRIDGE_STREAM_CODEC; 'auto' uses H.264 when supported.
  codec: 'server',
  fps: QUALITY_PRESETS.max.fps,
  displayId: 0,
  mode: 'trackpad',
  // When plain pointer moves reach the Mac: 'live', 'resting' (after a short pause) or 'click'.
  pointerSync: 'resting',
  trackpadSpeed: 1.4,
  scrollSpeed: 1.6,
  pasteSync: true,
  copySync: true,
  toolbarHidden: false,
  pauseOnBlur: true,
};

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    // Storage may be unavailable (private mode); fall back to defaults.
  }
  return { ...DEFAULTS };
}

/** Small observable settings store persisted in localStorage. */
export class Settings extends EventTarget {
  #values = load();
  #serverDefaults = null;
  /** Set at startup: whether this browser can decode H.264. */
  h264Supported = false;

  /** Stream defaults announced by the server (from .env). */
  setServerDefaults(defaults) {
    this.#serverDefaults = defaults;
  }

  get serverDefaults() {
    return this.#serverDefaults;
  }

  get(key) {
    return this.#values[key];
  }

  set(key, value) {
    if (this.#values[key] === value) return;
    this.#values[key] = value;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.#values));
    } catch {
      // Ignore: settings just won't persist.
    }
    this.dispatchEvent(new CustomEvent('change', { detail: { key, value } }));
  }

  /** The codec to request: H.264 only if wanted and supported here. */
  resolvedCodec() {
    let choice = this.#values.codec;
    if (choice === 'server') choice = this.#serverDefaults?.codec ?? 'auto';
    return choice !== 'jpeg' && this.h264Supported ? 'h264' : 'jpeg';
  }

  /** Stream parameters sent to the server. */
  streamParams() {
    const preset =
      QUALITY_PRESETS[this.#values.qualityPreset] ?? this.#serverDefaults ?? QUALITY_PRESETS.balanced;
    const codec = this.resolvedCodec();
    return {
      codec,
      quality: preset.quality,
      bitrate: preset.bitrate,
      maxWidth: codec === 'h264' ? preset.videoMaxWidth : preset.maxWidth,
      fps: this.#values.fps,
      displayId: this.#values.displayId,
    };
  }
}
