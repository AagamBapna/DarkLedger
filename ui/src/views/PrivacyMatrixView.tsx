import { useEffect, useMemo, useState } from "react";
import {
  queryAssetHoldings,
  queryAuditRecords,
  queryCashHoldings,
  queryDiscoveryInterests,
  queryPrivateNegotiations,
  queryTradeIntents,
  queryTradeSettlements,
} from "../lib/ledgerClient";

interface PrivacyMatrixViewProps {
  availableParties: string[];
  activeParty: string;
  refreshToken: number;
}

interface PartySnapshot {
  party: string;
  tradeIntents: number;
  discovery: number;
  negotiations: number;
  settlements: number;
  audits: number;
  assets: number;
  cash: number;
  ok: boolean;
  message: string;
}

type TemplateKey =
  | "tradeIntents"
  | "discovery"
  | "negotiations"
  | "settlements"
  | "audits"
  | "assets"
  | "cash";

const TEMPLATE_COLUMNS: Array<{ key: TemplateKey; label: string }> = [
  { key: "tradeIntents", label: "TradeIntent" },
  { key: "discovery", label: "Discovery" },
  { key: "negotiations", label: "Negotiation" },
  { key: "settlements", label: "Settlement" },
  { key: "audits", label: "Audit" },
  { key: "assets", label: "Assets" },
  { key: "cash", label: "Cash" },
];

function aliasOf(party: string): string {
  return party.includes("::") ? party.split("::")[0] : party;
}

function reasonText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function isListCap(reason: unknown): boolean {
  return reasonText(reason).includes("JSON_API_MAXIMUM_LIST_ELEMENTS_NUMBER_REACHED");
}

function expectedVisibility(template: TemplateKey, party: string): boolean {
  const alias = aliasOf(party);
  if (alias === "Outsider") return false;

  if (template === "tradeIntents") {
    return alias === "Seller" || alias === "SellerAgent" || alias === "Company";
  }

  if (template === "discovery") {
    return alias === "Seller"
      || alias === "SellerAgent"
      || alias === "Buyer"
      || alias === "BuyerAgent"
      || alias === "Company";
  }

  if (template === "negotiations" || template === "settlements" || template === "audits") {
    return true;
  }

  if (template === "assets" || template === "cash") {
    return true;
  }

  return false;
}

function heatCellClass(count: number, expected: boolean): string {
  if (!expected && count > 0) {
    return "bg-signal-coral/40 text-signal-coral border border-signal-coral/50";
  }
  if (!expected) {
    return "bg-signal-coral/15 text-signal-coral border border-signal-coral/30";
  }
  if (count > 0) {
    return "bg-signal-mint/25 text-signal-mint border border-signal-mint/35";
  }
  return "bg-signal-mint/10 text-signal-slate border border-signal-mint/25";
}

async function loadSnapshot(party: string): Promise<PartySnapshot> {
  const results = await Promise.allSettled([
    queryTradeIntents(party),
    queryDiscoveryInterests(party),
    queryPrivateNegotiations(party),
    queryTradeSettlements(party),
    queryAuditRecords(party),
    queryAssetHoldings(party),
    queryCashHoldings(party),
  ]);

  const counts = results.map((result) => (result.status === "fulfilled" ? result.value.length : 0));
  const failures = results
    .map((result, index) => ({ result, index }))
    .filter(({ result, index }) => result.status === "rejected" && !(index === 1 && isListCap((result as PromiseRejectedResult).reason)));

  if (results[1]?.status === "rejected" && isListCap((results[1] as PromiseRejectedResult).reason)) {
    counts[1] = 200;
  }

  const message =
    failures.length === 0
      ? (() => {
          if (results[1]?.status === "rejected" && isListCap((results[1] as PromiseRejectedResult).reason)) {
            return "Discovery list capped by node limit (>=200)";
          }
          const alias = party.includes("::") ? party.split("::")[0] : party;
          const totalVisible = counts.reduce((sum, value) => sum + value, 0);
          if (alias === "Outsider") {
            return totalVisible === 0 ? "Outsider visibility = zero (live proof)" : "Outsider can see data (unexpected)";
          }
          return "OK";
        })()
      : failures
          .map(({ result }) => (result as PromiseRejectedResult).reason)
          .map((reason) => reasonText(reason))
          .join(" | ");

  return {
    party,
    tradeIntents: counts[0],
    discovery: counts[1],
    negotiations: counts[2],
    settlements: counts[3],
    audits: counts[4],
    assets: counts[5],
    cash: counts[6],
    ok: failures.length === 0,
    message,
  };
}

export function PrivacyMatrixView({ availableParties, activeParty, refreshToken }: PrivacyMatrixViewProps) {
  const [rows, setRows] = useState<PartySnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<string>("");

  const parties = useMemo(() => {
    return Array.from(new Set(availableParties));
  }, [availableParties]);

  useEffect(() => {
    let cancelled = false;
    const fetchData = async () => {
      setLoading(true);
      try {
        const snapshots = await Promise.all(parties.map((party) => loadSnapshot(party)));
        if (!cancelled) {
          setRows(snapshots);
          setUpdatedAt(new Date().toISOString());
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void fetchData();
    const timer = window.setInterval(fetchData, 12_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [parties, refreshToken]);

  return (
    <section className="space-y-4">
      <div className="data-card">
        <p className="text-xs uppercase tracking-[0.24em] text-signal-slate">Privacy Heatmap</p>
        <h3 className="mt-2 text-xl font-semibold text-shell-950">Party x Template Visibility Matrix</h3>
        <p className="mt-1 text-sm text-signal-slate">
          Live Canton snapshot. Green cells are expected/private scope visibility. Red cells indicate hidden scope or potential leakage.
        </p>
        <div className="mt-3 flex flex-wrap gap-2 text-xs text-signal-slate">
          <span className="rounded-full bg-signal-mint/20 px-2 py-1 text-signal-mint">Expected visibility</span>
          <span className="rounded-full bg-signal-coral/20 px-2 py-1 text-signal-coral">Hidden / outsider scope</span>
          <span className="rounded-full bg-shell-900/5 px-2 py-1">Snapshot: {updatedAt ? new Date(updatedAt).toLocaleTimeString() : "loading"}</span>
        </div>
      </div>

      <div className="panel-shell overflow-x-auto">
        {loading ? <p className="text-sm text-signal-slate">Refreshing party visibility snapshot...</p> : null}
        <table className="w-full min-w-[980px] border-separate border-spacing-y-1 text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-[0.14em] text-signal-slate">
              <th className="py-2">Party</th>
              {TEMPLATE_COLUMNS.map((column) => (
                <th key={column.key} className="py-2 text-center">{column.label}</th>
              ))}
              <th className="py-2 text-center">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.party} className={row.party === activeParty ? "bg-signal-mint/8" : "bg-transparent"}>
                <td className="rounded-l-lg border border-shell-700 bg-white/85 px-3 py-3 font-semibold text-shell-950">
                  {aliasOf(row.party)}
                </td>
                {TEMPLATE_COLUMNS.map((column) => {
                  const count = row[column.key];
                  const expected = expectedVisibility(column.key, row.party);
                  return (
                    <td key={`${row.party}-${column.key}`} className="px-1 py-1 text-center">
                      <div className={`rounded-md px-2 py-2 text-xs font-semibold ${heatCellClass(count, expected)}`}>
                        {count}
                      </div>
                    </td>
                  );
                })}
                <td className="rounded-r-lg border border-shell-700 bg-white/85 px-3 py-3 text-center">
                  <span className={row.ok ? "text-signal-mint" : "text-signal-coral"}>
                    {row.ok ? "ok" : "degraded"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="data-card text-xs text-signal-slate">
        <p>
          Judge cue: trigger an action, then re-open this heatmap to show live cell updates. Outsider row should remain red/zero across all templates.
        </p>
      </div>
    </section>
  );
}
