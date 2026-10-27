export const MODIFIER_CODES = new Set([
  'MetaLeft', 'MetaRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'ControlLeft', 'ControlRight',
]);

export const META_CODES = new Set(['MetaLeft', 'MetaRight']);

/** Named keys some soft keyboards report without a `code`. */
const KEY_TO_CODE = {
  Backspace: 'Backspace',
  Enter: 'Enter',
  Tab: 'Tab',
  Escape: 'Escape',
  Delete: 'Delete',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
};

const ALIASES = { OSLeft: 'MetaLeft', OSRight: 'MetaRight' };

// Codes the server accepts; anything else (media keys, IME keys) is ignored.
const SUPPORTED = /^(Key[A-Z]|Digit\d|Numpad\w+|F\d{1,2}|Arrow\w+|Meta\w+|Shift\w+|Alt\w+|Control\w+|Intl\w+|Lang\d|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Space|Tab|Enter|Backspace|Escape|Delete|Insert|Home|End|PageUp|PageDown|ContextMenu|Help|NumLock)$/;

export function eventCode(event) {
  const code = ALIASES[event.code] ?? event.code;
  if (code && SUPPORTED.test(code)) return code;
  if (!code) return KEY_TO_CODE[event.key] ?? null;
  return null;
}

const CHAR_TO_CODE = {
  ' ': 'Space', '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash',
  ';': 'Semicolon', "'": 'Quote', ',': 'Comma', '.': 'Period', '/': 'Slash', '`': 'Backquote',
};

/** Maps a single typed character to a US-layout key code, for shortcuts from soft keyboards. */
export function charToCode(char) {
  if (/^[a-z]$/i.test(char)) return `Key${char.toUpperCase()}`;
  if (/^[0-9]$/.test(char)) return `Digit${char}`;
  return CHAR_TO_CODE[char] ?? null;
}
