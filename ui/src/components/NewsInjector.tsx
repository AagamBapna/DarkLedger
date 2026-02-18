import { useState } from "react";
import { injectMarketEvent } from "../lib/ledgerClient";

const EVENTS = [
  { id: "positive_earnings", label: "Positive Earnings", color: "bg-signal-mint" },
  { id: "acquisition_rumor", label: "Acquisition Rumor", color: "bg-signal-amber" },
  { id: "sec_investigation", label: "SEC Investigation", color: "bg-signal-coral" },
  { id: "market_crash", label: "Market Crash", color: "bg-red-600" },
  { id: "stable_market", label: "Stable Market", color: "bg-blue-500" },
] as const;

interface InjectedEvent {
  id: string;
  type: string;
  at: string;
}

export function NewsInjector() {
  const [injectedEvents, setInjectedEvents] = useState<InjectedEvent[]>([]);
  const [sending, setSending] = useState(false);

  const inject = async (eventType: string) => {
    setSending(true);
    try {
      await injectMarketEvent(eventType);
      setInjectedEvents((prev) => [
        { id: crypto.randomUUID(), type: eventType, at: new Date().toLocaleTimeString() },
        ...prev.slice(0, 19),
      ]);
    } catch {
      /* market API may not be running */
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="rounded-xl border border-shell-700 bg-shell-900/70 p-4">
      <h3 className="mb-3 text-lg font-semibold text-signal-amber">News Event Injector</h3>
      <p className="mb-3 text-xs text-signal-slate">
        Inject market events to trigger AI agent repricing in real time.
      </p>
      <div className="flex flex-wrap gap-2">
        {EVENTS.map((ev) => (
          <button
            key={ev.id}
            disabled={sending}
            className={`rounded-md ${ev.color} px-3 py-1.5 text-sm font-semibold text-shell-950 transition hover:opacity-80 disabled:opacity-50`}
            onClick={() => inject(ev.id)}
          >
            {ev.label}
          </button>
        ))}
      </div>
      {injectedEvents.length > 0 && (
        <div className="mt-3 max-h-32 overflow-y-auto">
          {injectedEvents.map((ev) => (
            <div key={ev.id} className="flex justify-between border-b border-shell-800 py-1 text-xs text-signal-slate">
              <span className="font-medium text-white">{ev.type.replace(/_/g, " ")}</span>
              <span>{ev.at}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
