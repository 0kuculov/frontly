import type { Language } from '@frontly/shared';

/**
 * What the demo screen is told about a live call.
 *
 * Typed domain events, deliberately NOT scraped from log messages. The
 * simulator reads the call by matching on strings like 'turn complete', which
 * is fine for a script someone runs by hand and far too brittle for the thing
 * projected behind a live pitch: a reworded log line would silently blank the
 * screen mid-demo.
 *
 * The session emits these without knowing who listens. Nothing here reaches
 * packages/core — the engine has no idea a screen exists.
 */

export type CallEvent =
  | { type: 'call.started'; callRef: string; from?: string | undefined; at: number }
  | { type: 'call.language'; callRef: string; language: Language; at: number }
  | { type: 'said'; callRef: string; role: 'customer' | 'agent'; text: string; at: number }
  /**
   * A tool firing is the point of the whole demo — it is the moment the thing
   * stops looking like a chatbot — so it is its own event rather than a detail
   * inside a turn, and it is emitted when the tool RUNS, not when the turn ends.
   */
  | { type: 'tool'; callRef: string; name: string; ok: boolean; summary?: string; at: number }
  | {
      type: 'turn.done';
      callRef: string;
      /** Caller stopped speaking -> first audio. The honest number. */
      callerFacingMs?: number | undefined;
      at: number;
    }
  | {
      type: 'call.ended';
      callRef: string;
      endedBy: string;
      outcome: string;
      durationMs: number;
      at: number;
    };

export type CallEventListener = (event: CallEvent) => void;

/**
 * A `CallEvent` before the timestamp is stamped on.
 *
 * Distributive on purpose: a plain `Omit<CallEvent, 'at'>` over a discriminated
 * union collapses to the keys every member shares, which is `type` and
 * `callRef` — so every payload field becomes a type error. Mapping over each
 * member separately keeps the discrimination intact.
 */
export type CallEventDraft = CallEvent extends infer T
  ? T extends CallEvent
    ? Omit<T, 'at'>
    : never
  : never;

/**
 * In-process fan-out to whoever is watching.
 *
 * One Render instance serves the demo, so an in-memory bus is enough and a
 * second instance would simply show its own calls. Anything durable belongs in
 * the conversations table, which is where the metrics come from — this bus is
 * only ever the live view.
 */
export class CallEventBus {
  private readonly listeners = new Set<CallEventListener>();
  /**
   * The last few events, replayed to a screen that connects late or reconnects.
   *
   * A venue network drops; a projector gets unplugged. Coming back to a blank
   * screen mid-call is the failure worth engineering against, so a reconnecting
   * client is handed recent history and carries on as if nothing happened.
   */
  private readonly recent: { id: number; event: CallEvent }[] = [];
  private nextId = 1;

  constructor(private readonly historySize = 200) {}

  publish(event: CallEvent): void {
    const id = this.nextId++;
    this.recent.push({ id, event });
    if (this.recent.length > this.historySize) this.recent.shift();

    for (const listener of this.listeners) {
      // One broken screen must never take down the call or the other screens.
      try {
        listener(event);
      } catch {
        /* a listener that throws is not the call's problem */
      }
    }
  }

  subscribe(listener: CallEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Events after `afterId`, for a client resuming with Last-Event-ID. */
  since(afterId: number): { id: number; event: CallEvent }[] {
    return this.recent.filter((row) => row.id > afterId);
  }

  get lastId(): number {
    return this.nextId - 1;
  }
}

/** The bus for this process. */
export const callEvents = new CallEventBus();
