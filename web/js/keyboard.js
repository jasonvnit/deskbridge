import { charToCode, eventCode, META_CODES, MODIFIER_CODES } from './keymap.js';

// Keeps something in the hidden textarea so Backspace on an empty field still fires events (iOS).
const SINK_FILLER = '  ';

/**
 * Forwards keyboard input to the Mac.
 *
 * - Hardware keys are sent by physical key code (the Mac's own layout/input method applies).
 * - Text from IMEs and soft keyboards is sent as Unicode text.
 * - Toolbar modifiers (⌘ ⇧ ⌥ ⌃) latch and apply to the next key.
 */
export class KeyboardController {
  #sink;
  #send;
  #settings;
  #pressed = new Set();
  #latched = new Set();
  #latchButtons = [];
  #composing = false;
  clipboard = null;
  /** When false (e.g. paused), keys are left to the browser and nothing is sent. */
  enabled = true;

  constructor({ sink, send, settings }) {
    this.#sink = sink;
    this.#send = send;
    this.#settings = settings;
    this.#resetSink();

    document.addEventListener('keydown', (e) => this.#onKeyDown(e), true);
    document.addEventListener('keyup', (e) => this.#onKeyUp(e), true);
    sink.addEventListener('beforeinput', (e) => this.#onBeforeInput(e));
    sink.addEventListener('compositionend', (e) => this.#onCompositionEnd(e));
    sink.addEventListener('input', () => {
      if (!this.#composing) this.#resetSink();
    });
    sink.addEventListener('compositionstart', () => {
      this.#composing = true;
    });

    window.addEventListener('blur', () => this.releaseAll());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.releaseAll();
    });
  }

  // ---- Soft keyboard ----------------------------------------------------------

  get softKeyboardOpen() {
    return document.activeElement === this.#sink;
  }

  showSoftKeyboard() {
    this.#sink.focus({ preventScroll: true });
    this.#resetSink();
  }

  hideSoftKeyboard() {
    this.#sink.blur();
  }

  #resetSink() {
    this.#sink.value = SINK_FILLER;
    const end = SINK_FILLER.length;
    try {
      this.#sink.setSelectionRange(end, end);
    } catch {
      // Not focusable yet.
    }
  }

  // ---- Hardware keys --------------------------------------------------------

  #isForeignInput(target) {
    return target !== this.#sink && target instanceof Element && target.closest('input, textarea, select, [contenteditable]');
  }

  #onKeyDown(e) {
    if (!this.enabled) return;
    if (this.#isForeignInput(e.target)) return;
    if (e.isComposing || e.keyCode === 229 || e.key === 'Process') return; // IME: handled on compositionend.

    const code = eventCode(e);
    if (!code) return; // Printable key from a soft keyboard: handled by beforeinput.

    // Focus the sink so paste and IME events have a target. It is off-screen,
    // and with a hardware keyboard attached focusing it does not open the soft keyboard.
    if (document.activeElement !== this.#sink) this.#sink.focus({ preventScroll: true });

    const metaOnly = e.metaKey && !e.ctrlKey && !e.altKey;

    // ⌘V: let the browser fire a paste event so this device's clipboard can be sent first.
    if (code === 'KeyV' && metaOnly && this.#settings.get('pasteSync') && this.clipboard) {
      if (!e.repeat) this.clipboard.beginLocalPaste();
      return;
    }

    e.preventDefault();
    if (this.#latched.size && !MODIFIER_CODES.has(code)) {
      if (!e.repeat) this.#tapWithLatched(code);
      return;
    }
    this.#pressed.add(code);
    this.#send({ t: 'key', code, down: true, repeat: e.repeat });

    if ((code === 'KeyC' || code === 'KeyX') && metaOnly && !e.repeat && this.#settings.get('copySync')) {
      this.clipboard?.pullAfterCopy();
    }
  }

  #onKeyUp(e) {
    if (this.#isForeignInput(e.target)) return;
    const code = eventCode(e);
    if (!code || !this.#pressed.has(code)) return;
    e.preventDefault();
    this.#up(code);

    // macOS browsers swallow keyup for keys released while ⌘ is held; release them with ⌘.
    if (META_CODES.has(code)) {
      for (const other of [...this.#pressed]) {
        if (!MODIFIER_CODES.has(other)) this.#up(other);
      }
    }
  }

  #up(code) {
    this.#pressed.delete(code);
    this.#send({ t: 'key', code, down: false });
  }

  // ---- Text input -------------------------------------------------------------

  #onBeforeInput(e) {
    if (!this.enabled) return;
    switch (e.inputType) {
      case 'insertText':
        if (e.isComposing) return;
        e.preventDefault();
        if (e.data) this.typeText(e.data);
        break;
      case 'insertCompositionText':
        break; // Wait for compositionend.
      case 'deleteContentBackward':
        e.preventDefault();
        this.tap('Backspace');
        break;
      case 'deleteContentForward':
        e.preventDefault();
        this.tap('Delete');
        break;
      case 'insertLineBreak':
      case 'insertParagraph':
        e.preventDefault();
        this.tap('Enter');
        break;
      case 'insertFromPaste':
      case 'insertFromDrop':
        e.preventDefault(); // Handled by the paste event.
        break;
      default:
        break;
    }
  }

  #onCompositionEnd(e) {
    this.#composing = false;
    if (!this.enabled) return;
    if (e.data) this.typeText(e.data);
    this.#resetSink();
  }

  /** Types text on the Mac, or turns a single character into a shortcut when modifiers are latched. */
  typeText(text) {
    if (this.#latched.size && [...text].length === 1) {
      const code = charToCode(text.toLowerCase());
      if (code) {
        const needsShift = text !== text.toLowerCase();
        if (needsShift) this.#latched.add('ShiftLeft');
        this.#tapWithLatched(code);
        return;
      }
    }
    this.#send({ t: 'text', text });
  }

  // ---- Taps, combos and latches -----------------------------------------------

  /** Presses and releases a key, applying latched modifiers. */
  tap(code) {
    if (this.#latched.size) {
      this.#tapWithLatched(code);
      return;
    }
    this.#send({ t: 'key', code, down: true });
    this.#send({ t: 'key', code, down: false });
  }

  /** Sends a shortcut such as ['MetaLeft', 'KeyV'], without disturbing keys the user is holding. */
  combo(codes) {
    const modifiers = codes.slice(0, -1);
    const key = codes[codes.length - 1];
    const toPress = modifiers.filter((code) => !this.#pressed.has(code));
    for (const code of toPress) this.#send({ t: 'key', code, down: true });
    this.#send({ t: 'key', code: key, down: true });
    this.#send({ t: 'key', code: key, down: false });
    for (const code of toPress.reverse()) this.#send({ t: 'key', code, down: false });
  }

  #tapWithLatched(code) {
    this.combo([...this.#latched, code]);
    this.clearLatches();
  }

  bindLatchButtons(buttons) {
    this.#latchButtons = buttons;
  }

  toggleLatch(code) {
    if (this.#latched.has(code)) this.#latched.delete(code);
    else this.#latched.add(code);
    this.#renderLatches();
  }

  clearLatches() {
    this.#latched.clear();
    this.#renderLatches();
  }

  #renderLatches() {
    for (const button of this.#latchButtons) {
      button.classList.toggle('latched', this.#latched.has(button.dataset.mod));
    }
  }

  isPressed(code) {
    return this.#pressed.has(code);
  }

  releaseAll() {
    for (const code of [...this.#pressed]) this.#up(code);
    this.#send({ t: 'releaseAll' });
  }
}
