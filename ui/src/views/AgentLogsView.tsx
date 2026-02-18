import { useEffect, useState } from "react";
import { queryDecisionLogs } from "../lib/ledgerClient";
import type { AgentDecisionLogPayload, AgentLogEntry, ContractRecord, Party } from "../types/contracts";

interface AgentLogsViewProps {
  party: Party;
  logs: AgentLogEntry[];
  onClear: () => void;
}

export function AgentLogsView({ party, logs, onClear }: AgentLogsViewProps) {
  const [decisionLogs, setDecisionLogs] = useState<ContractRecord<AgentDecisionLogPayload>[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await queryDecisionLogs(party);
        if (!cancelled) setDecisionLogs(data);
      } catch {
        /* ledger may not be available */
      }
    };
    load();
    const timer = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [party]);

  const parseContext = (raw: string) => {
    try { return JSON.parse(raw); } catch { return {}; }
  };

  return (
    <section className="space-y-6">
      {/* On-ledger AI Decision Logs */}
      <div className="rounded-xl border border-shell-700 bg-shell-900/70 p-4">
        <h3 className="mb-1 text-lg font-semibold text-signal-mint">AI Agent Decision Reasoning</h3>
        <p className="mb-3 text-xs text-signal-slate">On-ledger AgentDecisionLog contracts — the AI explains its thinking.</p>
        {decisionLogs.length === 0 ? (
          <p className="text-sm text-signal-slate">No decision logs found for this party.</p>
        ) : (
          <div className="space-y-2">
            {decisionLogs.map((entry) => {
              const ctx = parseContext(entry.payload.marketContext);
              const isExpanded = expandedId === entry.contractId;
              return (
                <article
                  key={entry.contractId}
                  className="cursor-pointer rounded-lg border border-shell-700 bg-shell-950/60 p-3 transition hover:border-signal-mint/30"
                  onClick={() => setExpandedId(isExpanded ? null : entry.contractId)}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className={`inline-block h-2 w-2 rounded-full ${
                        entry.payload.decision === "accept" ? "bg-signal-mint" :
                        entry.payload.decision === "reprice" ? "bg-signal-amber" :
                        entry.payload.decision === "counter" ? "bg-signal-coral" :
                        "bg-signal-slate"
                      }`} />
                      <span className="font-medium text-white">{entry.payload.decision.toUpperCase()}</span>
                      <span className="text-xs text-signal-slate">{entry.payload.instrument}</span>
                    </div>
                    <span className="text-xs text-signal-slate">{new Date(entry.payload.timestamp).toLocaleTimeString()}</span>
                  </div>
                  <p className="mt-1 text-sm text-signal-slate">{entry.payload.reasoning}</p>
                  {isExpanded && (
                    <div className="mt-2 rounded-md bg-shell-900 p-2 text-xs text-signal-slate">
                      <p>Agent: <span className="text-white">{entry.payload.agent}</span></p>
                      <p>Volatility: <span className="text-white">{ctx.volatility ?? "—"}</span></p>
                      <p>Sentiment: <span className="text-white">{ctx.sentiment ?? "—"}</span></p>
                      <p>Confidence: <span className="text-white">{ctx.confidence ?? "—"}</span></p>
                      <p>Recommended Price: <span className="text-white">{ctx.recommended_price ?? "—"}</span></p>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </div>

      {/* Local UI log stream */}
      <div className="rounded-xl border border-shell-700 bg-shell-900/70 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-signal-amber">Local Event Stream</h3>
          <button className="rounded-md border border-shell-700 px-3 py-1 text-sm text-signal-slate" onClick={onClear}>
            Clear
          </button>
        </div>
        {logs.length === 0 ? (
          <p className="text-sm text-signal-slate">No log events yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b border-shell-700 text-left text-xs uppercase tracking-[0.15em] text-signal-slate">
                  <th className="py-2">Time</th>
                  <th className="py-2">Source</th>
                  <th className="py-2">Decision</th>
                  <th className="py-2">Metadata</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((entry) => (
                  <tr key={entry.id} className="border-b border-shell-800 text-signal-slate">
                    <td className="py-3">{new Date(entry.at).toLocaleTimeString()}</td>
                    <td className="py-3">{entry.source}</td>
                    <td className="py-3 font-medium text-white">{entry.decision}</td>
                    <td className="py-3">{entry.metadata}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
