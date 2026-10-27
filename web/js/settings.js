const STORAGE_KEY = 'deskbridge.settings.v1';

// Measured through Cloudflare Tunnel with ~5-6 Mbit/s upload on a busy 3440x1440 screen:
// low ~35 KB/frame (~20 fps), balanced ~65 KB (~10 fps), high ~130 KB (~5 fps).
export const QUALITY_PRESETS = {
  low: { quality: 0.3, maxWidth: 1024, fps: 24 },
  balanced: { quality: 0.4, maxWidth: 1280, fps: 20 },
  high: { quality: 0.55, maxWidth: 1600, fps: 20 },
  max: { quality: 0.8, maxWidth: 0, fps: 24 },
};

const DEFAULTS = {
  // 'server' uses the defaults from the server's .env.
  qualityPreset: 'server',
  fps: 20,
  displayId: 0,
  mode: 'touch',
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

  /** Stream parameters sent to the server. */
  streamParams() {
    const preset =
      QUALITY_PRESETS[this.#values.qualityPreset] ?? this.#serverDefaults ?? QUALITY_PRESETS.balanced;
    return {
      quality: preset.quality,
      maxWidth: preset.maxWidth,
      fps: this.#values.fps,
      displayId: this.#values.displayId,
    };
  }
}
