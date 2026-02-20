import { useMemo, useState } from "react";
import { NewsInjector } from "../components/NewsInjector";
import { numberLike, optionalToNumber } from "../lib/ledgerClient";
import type {
  AgentLogEntry,
  AssetHoldingPayload,
  CashHoldingPayload,
  ContractRecord,
  Party,
  PrivateNegotiationPayload,
  TradeIntentPayload,
} from "../types/contracts";

interface OwnerViewProps {
  party: Party;
  tradeIntents: Array<ContractRecord<TradeIntentPayload>>;
  negotiations: Array<ContractRecord<PrivateNegotiationPayload>>;
  assetHoldings: Array<ContractRecord<AssetHoldingPayload>>;
  cashHoldings: Array<ContractRecord<CashHoldingPayload>>;
  logs: AgentLogEntry[];
  intentLastUpdate: Record<string, string>;
  autoReprice: boolean;
  onAutoRepriceToggle: (enabled: boolean) => void;
  onOverrideMinPrice: (contractId: string, nextMinPrice: number) => Promise<void>;
}

function aliasOf(party: string): string {
  return party.includes("::") ? party.split("::")[0] : party;
}

function pseudonymToken(value: string): string {
  let acc = 0;
  for (let i = 0; i < value.length; i += 1) {
    acc = (acc * 33 + value.charCodeAt(i)) >>> 0;
  }
  return acc.toString(16).toUpperCase().slice(-4).padStart(4, "0");
}

function maskedCounterparty(party: Party, negotiation: PrivateNegotiationPayload): string {
  const alias = aliasOf(party);
  if (alias === "Company") {
    return `${aliasOf(negotiation.seller)} ↔ ${aliasOf(negotiation.buyer)}`;
  }
  if (alias === "Seller" || alias === "SellerAgent") {
    return `Buyer-${pseudonymToken(negotiation.buyer)}`;
  }
  if (alias === "Buyer" || alias === "BuyerAgent") {
    return `Seller-${pseudonymToken(negotiation.seller)}`;
  }
  return `Pair-${pseudonymToken(negotiation.instrument)}`;
}

export function OwnerView({
  party,
  tradeIntents,
  negotiations,
  assetHoldings,
  cashHoldings,
  logs,
  intentLastUpdate,
  autoReprice,
  onAutoRepriceToggle,
  onOverrideMinPrice,
}: OwnerViewProps) {
  const [draftOverrides, setDraftOverrides] = useState<Record<string, string>>({});
  const canOverride = party === "SellerAgent";
  const canToggleAutoReprice =
    party === "Seller"
    || party === "SellerAgent"
    || party === "Buyer"
    || party === "BuyerAgent";

  const timeline = useMemo(
    () => logs.filter((entry) => entry.source !== "market-feed").slice(0, 12),
    [logs],
  );

  return (
    <section className="space-y-6">
      <div className="grid gap-4 md:grid-cols-3">
        <article className="rounded-xl border border-shell-700 bg-white/80 backdrop-blur-xl p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-signal-slate">Private Holdings</p>
          <p className="mt-3 text-3xl font-semibold text-signal-mint">
            {tradeIntents.reduce((sum, i) => sum + numberLike(i.payload.quantity), 0).toLocaleString()}
          </p>
          <p className="mt-1 text-xs text-signal-slate">Visible only on your participant node.</p>
        </article>
        <article className="rounded-xl border border-shell-700 bg-white/80 backdrop-blur-xl p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-signal-slate">Active Trade Intents</p>
          <p className="mt-3 text-3xl font-semibold text-signal-amber">{tradeIntents.length}</p>
          <p className="mt-1 text-xs text-signal-slate">Private inventory directives.</p>
        </article>
        <article className="rounded-xl border border-shell-700 bg-white/80 backdrop-blur-xl p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-signal-slate">Negotiations</p>
          <p className="mt-3 text-3xl font-semibold text-signal-coral">{negotiations.length}</p>
          <p className="mt-1 text-xs text-signal-slate">Private channels visible to your party.</p>
        </article>
      </div>

      <div className="rounded-xl border border-shell-700 bg-white/70 backdrop-blur-xl p-4">
        <h3 className="mb-3 text-lg font-semibold text-signal-mint">On-Chain Holdings</h3>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <p className="mb-2 text-xs uppercase tracking-[0.15em] text-signal-slate">Asset Holdings</p>
            {assetHoldings.length === 0 ? (
              <p className="text-sm text-signal-slate">No asset holdings visible.</p>
            ) : (
              <div className="space-y-2">
                {assetHoldings.map((a) => (
                  <div key={a.contractId} className="flex items-center justify-between rounded-lg border border-shell-700 bg-white/80 px-3 py-2">
                    <span className="font-medium text-shell-950">{a.payload.instrument}</span>
                    <span className="text-signal-mint">{numberLike(a.payload.quantity).toLocaleString()} units</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div>
            <p className="mb-2 text-xs uppercase tracking-[0.15em] text-signal-slate">Cash Holdings</p>
            {cashHoldings.length === 0 ? (
              <p className="text-sm text-signal-slate">No cash holdings visible.</p>
            ) : (
              <div className="space-y-2">
                {cashHoldings.map((c) => (
                  <div key={c.contractId} className="flex items-center justify-between rounded-lg border border-shell-700 bg-white/80 px-3 py-2">
                    <span className="font-medium text-shell-950">{c.payload.currency}</span>
                    <span className="text-signal-amber">${numberLike(c.payload.amount).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-shell-700 bg-white/70 backdrop-blur-xl p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-signal-mint">Active Trade Intents</h3>
          <label className="flex items-center gap-2 text-sm text-signal-slate">
            <input
              type="checkbox"
              className="h-4 w-4 accent-signal-mint"
              checked={autoReprice}
              disabled={!canToggleAutoReprice}
              onChange={(e) => onAutoRepriceToggle(e.target.checked)}
            />
            AI agent auto-reprice
          </label>
        </div>
        {tradeIntents.length === 0 ? (
          <p className="text-sm text-signal-slate">No TradeIntent contracts visible for this party.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[740px] text-sm">
              <thead>
                <tr className="border-b border-shell-700 text-left text-xs uppercase tracking-[0.15em] text-signal-slate">
                  <th className="py-2">Instrument</th>
                  <th className="py-2">Quantity</th>
                  <th className="py-2">Min Price</th>
                  <th className="py-2">Last Update</th>
                  <th className="py-2">Manual Override</th>
                </tr>
              </thead>
              <tbody>
                {tradeIntents.map((intent) => {
                  const currentMin = numberLike(intent.payload.minPrice);
                  const draft = draftOverrides[intent.contractId] ?? currentMin.toFixed(2);
                  return (
                    <tr key={intent.contractId} className="border-b border-shell-800 text-signal-slate">
                      <td className="py-3 font-medium text-shell-950">{intent.payload.instrument}</td>
                      <td className="py-3">{numberLike(intent.payload.quantity).toFixed(2)}</td>
                      <td className="py-3">{currentMin.toFixed(2)}</td>
                      <td className="py-3">
                        {new Date(intentLastUpdate[intent.contractId] ?? new Date().toISOString()).toLocaleTimeString()}
                      </td>
                      <td className="py-3">
                        <div className="flex gap-2">
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            className="w-32 rounded-md border border-shell-700 bg-white px-2 py-1 text-shell-950"
                            value={draft}
                            onChange={(e) =>
                              setDraftOverrides((prev) => ({ ...prev, [intent.contractId]: e.target.value }))
                            }
                          />
                          <button
                            className="rounded-md bg-signal-mint/90 px-3 py-1 font-semibold text-shell-950 disabled:cursor-not-allowed disabled:bg-shell-700 disabled:text-signal-slate"
                            disabled={!canOverride}
                            onClick={() => onOverrideMinPrice(intent.contractId, Number.parseFloat(draft))}
                          >
                            Update
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-shell-700 bg-white/70 backdrop-blur-xl p-4">
          <h3 className="mb-3 text-lg font-semibold text-signal-amber">Private Negotiations</h3>
          {negotiations.length === 0 ? (
            <p className="text-sm text-signal-slate">No active PrivateNegotiation contracts.</p>
          ) : (
            <div className="space-y-3">
              {negotiations.map((n) => {
                const qty = optionalToNumber(n.payload.proposedQty);
                const price = optionalToNumber(n.payload.proposedUnitPrice);
                const termsVisible = aliasOf(party) === "Company" || (n.payload.sellerTermsRevealed && n.payload.buyerTermsRevealed);
                return (
                  <article key={n.contractId} className="rounded-lg border border-shell-700 bg-white/80 p-3">
                    <p className="font-semibold text-shell-950">{n.payload.instrument}</p>
                    <p className="mt-1 text-xs text-signal-slate">Counterparty: {maskedCounterparty(party, n.payload)}</p>
                    <div className="mt-1 flex gap-3 text-xs text-signal-slate">
                      <span className={n.payload.sellerAccepted ? "text-signal-mint" : ""}>
                        Seller: {n.payload.sellerAccepted ? "Accepted" : "Pending"}
                      </span>
                      <span className={n.payload.buyerAccepted ? "text-signal-mint" : ""}>
                        Buyer: {n.payload.buyerAccepted ? "Accepted" : "Pending"}
                      </span>
                      <span className={n.payload.issuerApproved ? "text-signal-mint" : ""}>
                        Issuer: {n.payload.issuerApproved ? "Approved" : "Pending"}
                      </span>
                    </div>
                    {termsVisible ? (
                      <p className="mt-1 text-sm text-signal-slate">
                        Qty: {qty ?? "—"} | Price: {price ?? "—"}
                      </p>
                    ) : (
                      <p className="mt-1 text-sm text-signal-slate">
                        Terms hidden until both parties reveal commitment hashes.
                      </p>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </div>

        <NewsInjector />
      </div>

      <div className="rounded-xl border border-shell-700 bg-white/70 backdrop-blur-xl p-4">
        <h3 className="mb-3 text-lg font-semibold text-signal-coral">Agent Activity Timeline</h3>
        {timeline.length === 0 ? (
          <p className="text-sm text-signal-slate">No agent activity logged yet.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {timeline.map((entry) => (
              <li key={entry.id} className="rounded-md border border-shell-800 bg-white/80 p-2">
                <p className="font-medium text-shell-950">{entry.decision}</p>
                <p className="text-xs text-signal-slate">{entry.metadata}</p>
                <p className="text-xs text-signal-slate">{new Date(entry.at).toLocaleString()}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
