'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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
      await fetch(`${API}/demo/reset`, { method: 'POST' });
      setEntries([]);
      await loadMetrics();
    } catch {
      // Leave the screen as it was rather than half-clearing it.
    } finally {
      setResetting(false);
    }
  };

  return (
    <main className="stage">
      <header className="bar">
        <span className="line" data-live={live}>
          <span className="dot" />
          {live ? 'Во тек' : 'Слободна линија'}
        </span>
        <span className="who">Дентал Охрид</span>
        <span className="number">+1 619 349 7599</span>

        <span className="spacer" />
        <span className="link" data-state={connected ? 'up' : 'down'}>
          {connected ? 'Поврзано' : 'Се поврзува'}
        </span>
        <button className="reset" onClick={() => void reset()} disabled={resetting}>
          {resetting ? 'Се ресетира' : 'Ресетирај демо'}
        </button>
      </header>

      <div className="feed" ref={feedRef}>
        {entries.length === 0 ? (
          <div className="idle">
            <p className="idle-lead">Јавете се и закажете термин.</p>
            <p className="idle-number">+1 619 349 7599</p>
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
