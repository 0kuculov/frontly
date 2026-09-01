'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Logo } from '../logo';
import './demo.css';

/**
 * The stage screen: a live call, the numbers behind it, and a reset button.
 *
 * The one rule this page is built around is that it must never look broken.
 * A venue network will drop, the API will cold-start, and none of that may
 * produce a blank projector in front of judges — so every failure keeps the
 * last known good state on screen and says so quietly in the corner.
 */

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080';

/**
 * Sent with the reset, because the deployed API will not empty the clinic for
 * an anonymous POST any more.
 *
 * NEXT_PUBLIC_ means this ends up in the browser bundle, so it is a lock on
 * the door rather than a real secret — it stops a scanner or a curious judge
 * blanking the numbers mid-pitch, which is the whole threat. The guard that
 * actually matters lives on the API: a dev server may only ever reset a local
 * file database, whatever token it presents.
 */
const RESET_TOKEN = process.env.NEXT_PUBLIC_DEMO_RESET_TOKEN ?? '';

/** Mirrors CallEvent in apps/api/src/demo/events.ts. */
type CallEvent =
  | { type: 'call.started'; callRef: string; from?: string; at: number }
  | { type: 'call.language'; callRef: string; language: string; at: number }
  | { type: 'said'; callRef: string; role: 'customer' | 'agent'; text: string; at: number }
  | { type: 'tool'; callRef: string; name: string; ok: boolean; at: number }
  | { type: 'turn.done'; callRef: string; callerFacingMs?: number; at: number }
  | { type: 'call.ended'; callRef: string; endedBy: string; outcome: string; at: number };

interface Metrics {
  callsHandled: number;
  appointmentsBooked: number;
  resolvedWithoutOwnerPct: number | null;
  avgCallerFacingMs: number | null;
  estimatedCostPerCallUsd: number;
}

type Entry =
  | { kind: 'said'; id: number; role: 'customer' | 'agent'; text: string }
  | { kind: 'tool'; id: number; name: string };

/** What each tool is doing, in the caller's terms rather than the code's. */
const TOOL_NOTE: Record<string, string> = {
  check_availability: 'чита слободни термини од календарот',
  book_appointment: 'запишува термин во календарот',
  transfer_to_human: 'бара сопственик',
};

export default function DemoPage() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [live, setLive] = useState(false);
  const [connected, setConnected] = useState(false);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(0);

  const loadMetrics = useCallback(async () => {
    try {
      const response = await fetch(`${API}/demo/metrics`);
      if (!response.ok) return;
      setMetrics((await response.json()) as Metrics);
    } catch {
      // Keep whatever is on screen. A stale number reads as fine; a number
      // that vanishes mid-pitch reads as a crash.
    }
  }, []);

  useEffect(() => {
    void loadMetrics();
    const poll = setInterval(() => void loadMetrics(), 5000);
    return () => clearInterval(poll);
  }, [loadMetrics]);

  useEffect(() => {
    /**
     * EventSource, not a WebSocket: it reconnects on its own with backoff and
     * replays from Last-Event-ID, so surviving the venue wifi is the browser's
     * job rather than reconnect logic of ours to get wrong under pressure.
     */
    const source = new EventSource(`${API}/demo/stream`);

    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false); // EventSource retries by itself

    source.onmessage = (message) => {
      setConnected(true);
      let event: CallEvent;
      try {
        event = JSON.parse(message.data) as CallEvent;
      } catch {
        return; // a malformed frame is not worth a broken screen
      }

      if (event.type === 'call.started') {
        setLive(true);
        setEntries([]); // a new call gets a clean screen
        return;
      }
      if (event.type === 'call.ended') {
        setLive(false);
        void loadMetrics();
        return;
      }
      if (event.type === 'said' && event.text.trim()) {
        setEntries((current) => [
          ...current,
          { kind: 'said', id: nextId.current++, role: event.role, text: event.text },
        ]);
        return;
      }
      if (event.type === 'tool') {
        setEntries((current) => [
          ...current,
          { kind: 'tool', id: nextId.current++, name: event.name },
        ]);
      }
    };

    return () => source.close();
  }, [loadMetrics]);

  // Follow the conversation as it grows.
  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: 'smooth' });
  }, [entries]);

  const reset = async () => {
    setResetting(true);
    try {
      const response = await fetch(`${API}/demo/reset`, {
        method: 'POST',
        headers: RESET_TOKEN ? { Authorization: `Bearer ${RESET_TOKEN}` } : {},
      });
      /**
       * A refused reset must not look like a successful one.
       *
       * Clearing the transcript regardless would show an empty screen beside
       * metrics that never moved — the exact "is it broken or is it working?"
       * moment there is no time for on stage. The guard refuses on purpose
       * (a dev server pointed at production, or a missing token), so say so
       * quietly in the corner and leave the screen alone.
       */
      if (!response.ok) {
        setResetError(response.status === 403 ? 'reset blocked: live database' : 'reset refused');
        return;
      }
      setResetError(null);
      setEntries([]);
      await loadMetrics();
    } catch {
      // Leave the screen as it was rather than half-clearing it.
      setResetError('reset unreachable');
    } finally {
      setResetting(false);
    }
  };

  return (
    <main className="stage">
      <header className="bar">
        {/* Same mark as the dashboard and the landing page, at projector size.
            One product, three scales. */}
        <Logo size={30} title="Frontly" />
        <span className="line" data-live={live}>
          <span className="dot" />
          {live ? 'Во тек' : 'Слободна линија'}
        </span>
        <span className="who">Дентал Охрид</span>
        {/*
          The number is off the stage screen for now, on request.

          Both places it appeared are commented rather than deleted: the demo
          exists to be dialled, so this is a temporary state and the markup
          should be one uncomment away from coming back, not a rebuild.
        */}
        {/* <span className="number">+1 619 349 7599</span> */}

        <span className="spacer" />
        <span className="link" data-state={connected ? 'up' : 'down'}>
          {connected ? 'Поврзано' : 'Се поврзува'}
        </span>
        {/* Quiet, in the corner, in the same register as the link indicator —
            never a dialog in front of judges. */}
        {resetError ? <span className="link" data-state="down">{resetError}</span> : null}
        <button className="reset" onClick={() => void reset()} disabled={resetting}>
          {resetting ? 'Се ресетира' : 'Ресетирај демо'}
        </button>
      </header>

      <div className="feed" ref={feedRef}>
        {entries.length === 0 ? (
          <div className="idle">
            {/*
              An empty stage screen is the state the room looks at longest —
              before the first call and between calls. The mark is what turns
              it from "nothing has loaded" into a product waiting for a call.
            */}
            <Logo size={96} />
            <p className="idle-lead">Јавете се и закажете термин.</p>
            {/* <p className="idle-number">+1 619 349 7599</p> */}
          </div>
        ) : (
          entries.map((entry) =>
            entry.kind === 'tool' ? (
              <div className="turn tool" key={entry.id}>
                <span className="tool-name">{entry.name}</span>
                <span className="tool-note">{TOOL_NOTE[entry.name] ?? 'работи со календарот'}</span>
              </div>
            ) : (
              <div className="turn" data-role={entry.role} key={entry.id}>
                <span className="role">{entry.role === 'customer' ? 'Пациент' : 'Фронтли'}</span>
                <p className="said">{entry.text}</p>
              </div>
            ),
          )
        )}
      </div>

      <footer className="metrics">
        <Metric value={metrics?.callsHandled} label="Повици" />
        <Metric value={metrics?.appointmentsBooked} label="Закажани" />
        <Metric
          value={metrics?.avgCallerFacingMs}
          label="Одговор"
          format={(ms) => `${(ms / 1000).toFixed(1)}s`}
        />
        <Metric
          value={metrics?.resolvedWithoutOwnerPct}
          label="Без сопственик"
          format={(pct) => `${pct}%`}
        />
        <Metric
          value={metrics?.estimatedCostPerCallUsd}
          label="Цена по повик"
          format={(usd) => `$${usd.toFixed(2)}`}
        />
      </footer>
    </main>
  );
}

/**
 * One number.
 *
 * An em dash when there is nothing measured yet, never a zero: on a screen
 * behind a pitch, "0.0s" reads as a claim and "—" reads as "no calls yet".
 */
function Metric({
  value,
  label,
  format,
}: {
  value: number | null | undefined;
  label: string;
  format?: (value: number) => string;
}) {
  const shown =
    value === null || value === undefined ? '—' : format ? format(value) : String(value);
  return (
    <div className="metric">
      <span className="metric-value">{shown}</span>
      <span className="metric-label">{label}</span>
    </div>
  );
}
