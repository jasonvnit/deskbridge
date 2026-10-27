// Codec used to check support before the Mac sends its exact parameters.
const PROBE_CODEC = 'avc1.640028';

/** True when this browser can decode H.264 with WebCodecs. */
export async function isH264Supported() {
  if (typeof VideoDecoder === 'undefined' || typeof EncodedVideoChunk === 'undefined') return false;
  try {
    const { supported } = await VideoDecoder.isConfigSupported({ codec: PROBE_CODEC, optimizeForLatency: true });
    return Boolean(supported);
  } catch {
    return false;
  }
}

function base64ToBytes(base64) {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

/**
 * Decodes the H.264 stream from the Mac and hands each picture to the viewer.
 *
 * Every chunk received is acknowledged exactly once (after it is shown, or
 * immediately if it has to be skipped), which keeps the server's flow control in sync.
 */
export class VideoPipeline {
  #viewer;
  #onDone;
  #requestKeyFrame;
  #decoder = null;
  #config = null;
  #waitingForKey = true;
  #timestamp = 0;

  /**
   * @param viewer          Viewer that draws the pictures.
   * @param onDone          Called once per chunk (shown or skipped) to acknowledge it.
   * @param requestKeyFrame Called when the decoder needs a fresh key frame.
   */
  constructor({ viewer, onDone, requestKeyFrame }) {
    this.#viewer = viewer;
    this.#onDone = onDone;
    this.#requestKeyFrame = requestKeyFrame;
  }

  /** Sets up decoding for a new stream (the Mac sends this before each new key frame format). */
  configure({ codec, description }) {
    this.#config = { codec, description: base64ToBytes(description), optimizeForLatency: true };
    this.#createDecoder();
  }

  #createDecoder() {
    this.#closeDecoder();
    this.#decoder = new VideoDecoder({
      output: (frame) => this.#onFrame(frame),
      error: (error) => this.#onError(error),
    });
    this.#decoder.configure(this.#config);
    this.#waitingForKey = true;
  }

  /** @param data Uint8Array: 1 byte key-frame flag followed by AVCC data. */
  push(data) {
    const isKey = data[0] === 1;
    const decoder = this.#decoder;
    if (!decoder || decoder.state !== 'configured' || (this.#waitingForKey && !isKey)) {
      this.#onDone();
      return;
    }
    this.#waitingForKey = false;
    this.#timestamp += 1000;
    try {
      decoder.decode(new EncodedVideoChunk({ type: isKey ? 'key' : 'delta', timestamp: this.#timestamp, data: data.subarray(1) }));
    } catch (error) {
      this.#onDone();
      this.#onError(error);
    }
  }

  /** Stops decoding (e.g. when switching to JPEG). */
  close() {
    this.#closeDecoder();
    this.#config = null;
  }

  #closeDecoder() {
    if (this.#decoder && this.#decoder.state !== 'closed') this.#decoder.close();
    this.#decoder = null;
  }

  #onFrame(frame) {
    try {
      this.#viewer.drawSource(frame, frame.displayWidth, frame.displayHeight);
    } finally {
      frame.close();
      this.#onDone();
    }
  }

  #onError(error) {
    console.warn('[deskbridge] video decoder error, requesting a key frame', error);
    this.#closeDecoder();
    if (this.#config) {
      try {
        this.#createDecoder();
      } catch {
        // Leave it closed; the next videoConfig creates a new one.
      }
    }
    this.#requestKeyFrame();
  }
}
