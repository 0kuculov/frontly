import { FRAME_BYTES } from './types.js';

/**
 * Mulaw framing for the carrier.
 *
 * Carriers play whatever they are sent, as fast as it is sent — there is no
 * back-pressure and no clock. Dumping six seconds of audio in one message
 * works, but then a barge-in cannot stop it: the caller has to talk over
 * everything already buffered on the carrier's side.
 *
 * So audio goes out in 20 ms frames on a real timer. The cost is a little
 * bookkeeping; the benefit is that "stop talking" means stopping within 20 ms.
 */

/** Mulaw silence. 0xFF is zero amplitude in mu-law, not 0x00. */
export const MULAW_SILENCE = 0xff;

/** Split raw mulaw into the 160-byte frames the carrier expects. */
export function toFrames(audio: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  for (let offset = 0; offset < audio.length; offset += FRAME_BYTES) {
    const frame = audio.subarray(offset, offset + FRAME_BYTES);
    if (frame.length === FRAME_BYTES) {
      frames.push(frame);
    } else {
      // Pad the tail with silence so every frame is exactly 20 ms — a short
      // final frame makes some carriers click.
      const padded = Buffer.alloc(FRAME_BYTES, MULAW_SILENCE);
      frame.copy(padded);
      frames.push(padded);
    }
  }
  return frames;
}

/** Duration of raw mulaw at 8 kHz, in milliseconds. */
export function durationMs(audio: Buffer): number {
  return Math.round((audio.length / 8000) * 1000);
}

export interface PlaybackSink {
  /** Send one media frame (base64 mulaw). */
  sendFrame(base64: string): void;
  /** Tell the carrier to discard anything it has buffered — the barge-in primitive. */
  clear(): void;
}

/**
 * Paced playback with an interruptible queue.
 *
 * One of these per call. Sentences are appended as they are synthesized, so
 * the caller hears sentence one while sentence two is still being generated.
 */
export class PlaybackQueue {
  private frames: Buffer[] = [];
  private timer: NodeJS.Timeout | undefined;
  private onDrained: (() => void) | undefined;

  constructor(
    private readonly sink: PlaybackSink,
    private readonly frameIntervalMs = 20,
  ) {}

  get isPlaying(): boolean {
    return this.timer !== undefined;
  }

  get queuedMs(): number {
    return this.frames.length * this.frameIntervalMs;
  }

  /** Append audio and start playing if idle. */
  enqueue(audio: Buffer): void {
    this.frames.push(...toFrames(audio));
    this.start();
  }

  /** Resolves when everything queued has been sent. */
  whenDrained(): Promise<void> {
    if (!this.isPlaying) return Promise.resolve();
    return new Promise((resolve) => {
      this.onDrained = resolve;
    });
  }

  /**
   * Barge-in. Drops everything not yet sent and tells the carrier to bin what it
   * already has, so the agent goes quiet within a frame rather than finishing
   * its sentence over the caller.
   */
  interrupt(): void {
    const had = this.frames.length > 0 || this.isPlaying;
    this.frames = [];
    this.stopTimer();
    if (had) this.sink.clear();
    this.onDrained?.();
    this.onDrained = undefined;
  }

  private start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const frame = this.frames.shift();
      if (!frame) {
        this.stopTimer();
        this.onDrained?.();
        this.onDrained = undefined;
        return;
      }
      this.sink.sendFrame(frame.toString('base64'));
    }, this.frameIntervalMs);
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
