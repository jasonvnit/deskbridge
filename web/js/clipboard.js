import { sleep, toast } from './ui.js';

const PASTE_EVENT_WAIT_MS = 400;
const COPY_SETTLE_MS = 350;

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`request failed (${response.status})`);
}

function base64ToBlob(base64, type) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type });
}

/** Moves text and images between this device and the Mac clipboard. */
export class ClipboardController {
  #keyboard;
  #pasteTimer = 0;
  #awaitingPaste = false;
  #remoteImageUrl = null;
  #remote = { text: null, image: null };

  constructor({ keyboard }) {
    this.#keyboard = keyboard;
    keyboard.clipboard = this;
    document.addEventListener('paste', (e) => this.#onPaste(e));
    this.#bindPanel();
  }

  // ---- Mac side ---------------------------------------------------------------

  async setRemoteText(text) {
    await postJson('/api/clipboard/text', { text });
  }

  async setRemoteImage(blob) {
    const response = await fetch('/api/clipboard/image', {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'image/png' },
      body: blob,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error ?? `upload failed (${response.status})`);
    }
  }

  async getRemote() {
    const response = await fetch('/api/clipboard', { cache: 'no-store' });
    if (!response.ok) throw new Error(`request failed (${response.status})`);
    return response.json();
  }

  pasteOnRemote() {
    this.#keyboard.combo(['MetaLeft', 'KeyV']);
  }

  // ---- ⌘V from this device ----------------------------------------------------

  /** Called on ⌘V keydown: wait briefly for the browser's paste event. */
  beginLocalPaste() {
    this.#awaitingPaste = true;
    clearTimeout(this.#pasteTimer);
    this.#pasteTimer = setTimeout(() => {
      if (!this.#awaitingPaste) return;
      // No paste event (empty clipboard or not allowed): paste whatever the Mac has.
      this.#awaitingPaste = false;
      this.pasteOnRemote();
    }, PASTE_EVENT_WAIT_MS);
  }

  async #onPaste(e) {
    const target = e.target;
    const inPanel = target instanceof Element && target.closest('input, textarea:not(#kbd-sink), select');
    if (inPanel) return;

    e.preventDefault();
    const fromShortcut = this.#awaitingPaste;
    this.#awaitingPaste = false;
    clearTimeout(this.#pasteTimer);

    const data = e.clipboardData;
    const imageFile = [...(data?.files ?? [])].find((file) => file.type.startsWith('image/'));
    const text = data?.getData('text/plain') ?? '';

    try {
      if (imageFile) {
        toast('Sending image…');
        await this.setRemoteImage(imageFile);
      } else if (text) {
        await this.setRemoteText(text);
      }
      this.pasteOnRemote();
      if (imageFile) toast('Image pasted on the Mac');
    } catch (error) {
      toast(`Paste failed: ${error.message}`, { error: true });
      if (fromShortcut) this.pasteOnRemote();
    }
  }

  // ---- ⌘C on the Mac ----------------------------------------------------------

  /**
   * Called on ⌘C/⌘X keydown. Must run inside the key event so the browser allows
   * the clipboard write; the content is resolved after the Mac has copied it.
   */
  pullAfterCopy() {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return;
    const textBlob = (async () => {
      await sleep(COPY_SETTLE_MS);
      const remote = await this.getRemote();
      if (!remote.text) throw new Error('no text on the Mac clipboard');
      return new Blob([remote.text], { type: 'text/plain' });
    })();
    navigator.clipboard
      .write([new ClipboardItem({ 'text/plain': textBlob })])
      .then(() => toast('Copied from the Mac'))
      .catch(() => {
        // Not permitted, or the Mac copied an image: the clipboard panel still works.
      });
  }

  // ---- Panel --------------------------------------------------------------------

  #bindPanel() {
    const $ = (id) => document.getElementById(id);
    const textArea = $('clip-text');
    const autoPaste = $('clip-auto-paste');

    const run = async (task, success) => {
      try {
        await task();
        if (success) toast(success);
      } catch (error) {
        toast(error.message, { error: true });
      }
    };

    $('clip-set').addEventListener('click', () =>
      run(() => this.setRemoteText(textArea.value), 'Copied to the Mac clipboard'),
    );
    $('clip-set-paste').addEventListener('click', () =>
      run(async () => {
        await this.setRemoteText(textArea.value);
        this.pasteOnRemote();
      }, 'Pasted on the Mac'),
    );
    $('clip-type').addEventListener('click', () => {
      if (textArea.value) this.#keyboard.typeText(textArea.value);
    });

    $('clip-image').addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      run(async () => {
        toast('Sending image…');
        await this.setRemoteImage(file);
        if (autoPaste.checked) this.pasteOnRemote();
      }, autoPaste.checked ? 'Image pasted on the Mac' : 'Image copied to the Mac clipboard');
    });

    $('clip-from-device').addEventListener('click', () =>
      run(async () => {
        if (!navigator.clipboard?.read) throw new Error('This browser cannot read the clipboard here. Use ⌘V or Choose image.');
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const imageType = item.types.find((type) => type.startsWith('image/'));
          if (imageType) {
            await this.setRemoteImage(await item.getType(imageType));
            if (autoPaste.checked) this.pasteOnRemote();
            return;
          }
          if (item.types.includes('text/plain')) {
            const text = await (await item.getType('text/plain')).text();
            await this.setRemoteText(text);
            if (autoPaste.checked) this.pasteOnRemote();
            return;
          }
        }
        throw new Error('The clipboard on this device is empty');
      }, 'Sent to the Mac'),
    );

    $('clip-fetch').addEventListener('click', () => run(() => this.#showRemote()));
    $('clip-remote-copy').addEventListener('click', () => run(() => this.#copyRemoteToDevice(), 'Copied to this device'));
  }

  async #showRemote() {
    const $ = (id) => document.getElementById(id);
    const remote = await this.getRemote();
    this.#remote = remote;
    const textBox = $('clip-remote-text');
    const image = $('clip-remote-image');
    const save = $('clip-remote-save');

    if (this.#remoteImageUrl) URL.revokeObjectURL(this.#remoteImageUrl);
    this.#remoteImageUrl = null;

    if (remote.image) {
      this.#remoteImageUrl = URL.createObjectURL(base64ToBlob(remote.image, 'image/png'));
      image.src = this.#remoteImageUrl;
      save.href = this.#remoteImageUrl;
    }
    image.hidden = !remote.image;
    save.hidden = !remote.image;
    textBox.hidden = !remote.text || Boolean(remote.image);
    textBox.value = remote.text ?? '';
    $('clip-remote').hidden = false;
    if (!remote.image && !remote.text) toast('The Mac clipboard is empty');
  }

  async #copyRemoteToDevice() {
    const { text, image } = this.#remote;
    if (image) {
      if (!navigator.clipboard?.write) throw new Error('Copying images is not supported here. Long-press the image or use Save.');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': base64ToBlob(image, 'image/png') })]);
      return;
    }
    if (text) {
      await navigator.clipboard.writeText(text);
      return;
    }
    throw new Error('Nothing to copy');
  }
}
