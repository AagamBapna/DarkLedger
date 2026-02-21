import { useMemo, useState } from "react";
import { TEMPLATE_IDS, queryContractsByTemplate } from "../lib/ledgerClient";

type TemplateKey = keyof typeof TEMPLATE_IDS;

interface PartyResult {
  party: string;
  ok: boolean;
  visible: boolean;
  count: number;
  matchedCount: number;
  sampleContractId: string;
  reason: string;
  error: string;
}

interface ContractVisibilityInspectorProps {
  availableParties: string[];
  activeParty: string;
}

function aliasOf(value: string): string {
  return value.includes("::") ? value.split("::")[0] : value;
}

const TEMPLATE_OPTIONS: Array<{ key: TemplateKey; label: string }> = [
  { key: "tradeIntent", label: "TradeIntent" },
  { key: "privateNegotiation", label: "PrivateNegotiation" },
];

const CORE_PARTIES = new Set(["Seller", "Buyer", "Outsider"]);

function expectedVisibilityReason(templateKey: TemplateKey, partyAlias: string): string {
  if (templateKey === "tradeIntent") {
    if (partyAlias === "Seller") return "Seller is signatory on TradeIntent.";
    if (partyAlias === "Buyer") return "Buyer is observer on TradeIntent.";
    if (partyAlias === "Outsider") return "Outsider has no stakeholder role.";
  }

  if (templateKey === "privateNegotiation") {
    if (partyAlias === "Outsider") return "Outsider sees accepted orders only through the outsider panel.";
    return "Only negotiation stakeholders can read it.";
  }

  return "Visibility is scoped by signatory/observer rules.";
}

export function ContractVisibilityInspector({
  availableParties,
  activeParty,
}: ContractVisibilityInspectorProps) {
  const [templateKey, setTemplateKey] = useState<TemplateKey>("privateNegotiation");
  const [contractId, setContractId] = useState("");
  const [instrument, setInstrument] = useState("");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<PartyResult[]>([]);

  const parties = useMemo(
    () =>
      Array.from(new Set(availableParties))
        .filter((party) => CORE_PARTIES.has(aliasOf(party))),
    [availableParties],
  );

  const runCheck = async () => {
    setLoading(true);
    const trimmedContractId = contractId.trim();
    const trimmedInstrument = instrument.trim();

    const queryFilter: Record<string, unknown> | null = trimmedInstrument
      ? { instrument: trimmedInstrument }
      : null;

    const runs = await Promise.all(
      parties.map(async (party) => {
        try {
          const rows = await queryContractsByTemplate<Record<string, unknown>>(
            party,
            TEMPLATE_IDS[templateKey],
            queryFilter,
          );

          const matchedRows = trimmedContractId
            ? rows.filter((row) => row.contractId === trimmedContractId)
            : rows;

          return {
            party,
            ok: true,
            visible: matchedRows.length > 0,
            count: rows.length,
            matchedCount: matchedRows.length,
            sampleContractId: matchedRows[0]?.contractId ?? rows[0]?.contractId ?? "",
            reason: expectedVisibilityReason(templateKey, aliasOf(party)),
            error: "",
          } satisfies PartyResult;
        } catch (reason) {
          const message = reason instanceof Error ? reason.message : String(reason);
          return {
            party,
            ok: false,
            visible: false,
            count: 0,
            matchedCount: 0,
            sampleContractId: "",
            reason: expectedVisibilityReason(templateKey, aliasOf(party)),
            error: message,
          } satisfies PartyResult;
        }
      }),
    );

    setResults(runs);
    setLoading(false);
  };

  return (
    <section className="app-panel panel-sheen space-y-4 rounded-2xl border border-shell-700 bg-white/80 p-5">
      <div>
        <p className="text-xs uppercase tracking-[0.2em] text-signal-slate">Visibility Inspector</p>
        <h2 className="mt-2 text-2xl font-semibold text-shell-950">Contract Visibility Inspector</h2>
        <p className="mt-2 text-sm text-signal-slate">
          Check template visibility across parties, with optional contract ID and instrument filters.
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
        <label className="text-xs font-semibold uppercase tracking-[0.12em] text-signal-slate">
          Template
          <select
            className="mt-1 w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
            value={templateKey}
            onChange={(event) => setTemplateKey(event.target.value as TemplateKey)}
          >
            {TEMPLATE_OPTIONS.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="text-xs font-semibold uppercase tracking-[0.12em] text-signal-slate">
          Contract ID (optional)
          <input
            className="mt-1 w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
            value={contractId}
            onChange={(event) => setContractId(event.target.value)}
            placeholder="00..."
          />
        </label>

        <label className="text-xs font-semibold uppercase tracking-[0.12em] text-signal-slate">
          Instrument (optional)
          <input
            className="mt-1 w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
            value={instrument}
            onChange={(event) => setInstrument(event.target.value)}
            placeholder="COMPANY-SERIES-A"
          />
        </label>

        <div className="flex items-end">
          <button
            className="w-full rounded-md bg-shell-950 px-4 py-2 text-sm font-semibold text-shell-900"
            onClick={() => void runCheck()}
            disabled={loading}
          >
            {loading ? "Checking..." : "Run Check"}
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-shell-700/70 bg-shell-900/30 p-3 text-xs text-signal-slate">
        Active party: <span className="font-semibold text-shell-950">{aliasOf(activeParty)}</span>. The table below queries every known party independently.
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[880px] text-sm">
          <thead>
            <tr className="border-b border-shell-700 text-left text-xs uppercase tracking-[0.15em] text-signal-slate">
              <th className="py-2">Party</th>
              <th className="py-2">Visible</th>
              <th className="py-2">Template Count</th>
              <th className="py-2">Matched Count</th>
              <th className="py-2">Sample Contract</th>
              <th className="py-2">Reason</th>
              <th className="py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {results.map((row) => (
              <tr key={row.party} className="border-b border-shell-800 text-signal-slate">
                <td className="py-3 font-medium text-shell-950">{aliasOf(row.party)}</td>
                <td className="py-3">
                  <span className={row.visible ? "text-signal-mint" : "text-signal-coral"}>
                    {row.visible ? "yes" : "no"}
                  </span>
                </td>
                <td className="py-3">{row.count}</td>
                <td className="py-3">{row.matchedCount}</td>
                <td className="py-3 font-mono text-xs text-shell-950">{row.sampleContractId || "-"}</td>
                <td className="py-3">{row.reason}</td>
                <td className="py-3">
                  {row.ok ? (
                    <span className="text-signal-mint">ok</span>
                  ) : (
                    <span className="text-signal-coral">{row.error}</span>
                  )}
                </td>
              </tr>
            ))}
            {results.length === 0 ? (
              <tr>
                <td className="py-3 text-signal-slate" colSpan={7}>
                  Run a check to populate party-by-party visibility.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
