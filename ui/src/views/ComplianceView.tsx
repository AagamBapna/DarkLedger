import { useEffect, useState } from "react";
import { exerciseChoice, optionalToNumber, queryAuditRecords, TEMPLATE_IDS } from "../lib/ledgerClient";
import type {
  AssetHoldingPayload,
  CashHoldingPayload,
  ContractRecord,
  Party,
  PrivateNegotiationPayload,
  TradeAuditRecordPayload,
  TradeSettlementPayload,
} from "../types/contracts";

interface ComplianceViewProps {
  party: Party;
  negotiations: Array<ContractRecord<PrivateNegotiationPayload>>;
  settlements: Array<ContractRecord<TradeSettlementPayload>>;
  assetHoldings: Array<ContractRecord<AssetHoldingPayload>>;
  cashHoldings: Array<ContractRecord<CashHoldingPayload>>;
  onApproveMatch: (contractId: string) => Promise<void>;
}

const STEPS = ["Discovery Match", "Negotiation", "Both Accept", "ROFR Approved", "Settlement Started", "DvP Finalized"];

function settlementStep(s: TradeSettlementPayload): number {
  if (s.settled) return 5;
  if (s.rofrApproved) return 4;
  return 3;
}

export function ComplianceView({
  party,
  negotiations,
  settlements,
  assetHoldings,
  cashHoldings,
  onApproveMatch,
}: ComplianceViewProps) {
  const isIssuer = party === "Company";
  const [auditRecords, setAuditRecords] = useState<ContractRecord<TradeAuditRecordPayload>[]>([]);
  const [settling, setSettling] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await queryAuditRecords(party);
        if (!cancelled) setAuditRecords(data);
      } catch { /* background poll — non-critical */ }
    };
    load();
    const timer = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [party]);

  const handleStartSettlement = async (contractId: string) => {
    setSettling(contractId);
    setActionError(null);
    try {
      await exerciseChoice(party, TEMPLATE_IDS.privateNegotiation, contractId, "StartSettlement", {});
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "StartSettlement failed");
    }
    setSettling(null);
  };

  const handleFinalize = async (
    contractId: string,
    sellerAssetCid: string,
    buyerCashCid: string,
  ) => {
    setSettling(contractId);
    setActionError(null);
    try {
      await exerciseChoice(party, TEMPLATE_IDS.tradeSettlement, contractId, "FinalizeSettlement", {
        sellerAssetCid,
        buyerCashCid,
      });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "FinalizeSettlement failed");
    }
    setSettling(null);
  };

  const handleSimpleFinalize = async (contractId: string) => {
    setSettling(contractId);
    setActionError(null);
    try {
      await exerciseChoice(party, TEMPLATE_IDS.tradeSettlement, contractId, "SimpleFinalizeSettlement", {});
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "SimpleFinalizeSettlement failed");
    }
    setSettling(null);
  };

  return (
    <section className="space-y-6">
      {/* Negotiation Queue */}
      <div className="rounded-xl border border-shell-700 bg-shell-900/70 p-4">
        <h3 className="mb-3 text-lg font-semibold text-signal-mint">Pending Negotiations</h3>
        {negotiations.length === 0 ? (
          <p className="text-sm text-signal-slate">No negotiations visible for compliance review.</p>
        ) : (
          <div className="space-y-3">
            {negotiations.map((item) => {
              const qty = optionalToNumber(item.payload.proposedQty);
              const price = optionalToNumber(item.payload.proposedUnitPrice);
              const readyToApprove =
                item.payload.sellerAccepted && item.payload.buyerAccepted && qty !== null && price !== null && !item.payload.issuerApproved;
              const readyToSettle = item.payload.issuerApproved;
              return (
                <article key={item.contractId} className="rounded-lg border border-shell-700 bg-shell-950/50 p-3">
                  <p className="font-semibold text-white">{item.payload.instrument}</p>
                  <div className="mt-1 flex gap-3 text-xs">
                    <span className={item.payload.sellerAccepted ? "text-signal-mint" : "text-signal-slate"}>
                      Seller: {item.payload.sellerAccepted ? "Yes" : "No"}
                    </span>
                    <span className={item.payload.buyerAccepted ? "text-signal-mint" : "text-signal-slate"}>
                      Buyer: {item.payload.buyerAccepted ? "Yes" : "No"}
                    </span>
                    <span className={item.payload.issuerApproved ? "text-signal-mint" : "text-signal-slate"}>
                      ROFR: {item.payload.issuerApproved ? "Approved" : "Pending"}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-signal-slate">Qty: {qty ?? "—"} | Price: {price ?? "—"}</p>
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      className="rounded-md bg-signal-amber px-3 py-1.5 text-sm font-semibold text-shell-950 disabled:cursor-not-allowed disabled:bg-shell-700 disabled:text-signal-slate"
                      disabled={!isIssuer || !readyToApprove}
                      onClick={() => onApproveMatch(item.contractId)}
                    >
                      Approve Match
                    </button>
                    <button
                      className="rounded-md bg-signal-mint px-3 py-1.5 text-sm font-semibold text-shell-950 disabled:cursor-not-allowed disabled:bg-shell-700 disabled:text-signal-slate"
                      disabled={!isIssuer || !readyToSettle || settling === item.contractId}
                      onClick={() => handleStartSettlement(item.contractId)}
                    >
                      {settling === item.contractId ? "Settling..." : "Start Settlement"}
                    </button>
                    {!isIssuer && <span className="text-xs text-signal-slate">Issuer-only actions.</span>}
                  </div>
                </article>
              );
            })}
          </div>
        )}
        {actionError && (
          <p className="mt-3 text-sm text-signal-coral">{actionError}</p>
        )}
      </div>

      {/* Settlement Monitor with DvP Visualization */}
      <div className="rounded-xl border border-shell-700 bg-shell-900/70 p-4">
        <h3 className="mb-3 text-lg font-semibold text-signal-coral">Settlement & DvP Monitor</h3>
        {settlements.length === 0 ? (
          <p className="text-sm text-signal-slate">No TradeSettlement contracts visible.</p>
        ) : (
          <div className="space-y-4">
            {settlements.map((item) => {
              const step = settlementStep(item.payload);
              const totalValue = Number(item.payload.quantity) * Number(item.payload.unitPrice);
              const sellerAsset = assetHoldings.find((holding) =>
                holding.payload.owner === item.payload.seller
                && holding.payload.instrument === item.payload.instrument
                && Number(holding.payload.quantity) >= Number(item.payload.quantity)
              );
              const buyerCash = cashHoldings.find((holding) =>
                holding.payload.owner === item.payload.buyer
                && Number(holding.payload.amount) >= totalValue
              );
              const canFinalizeDvP = Boolean(sellerAsset && buyerCash);
              return (
                <article key={item.contractId} className="rounded-lg border border-shell-700 bg-shell-950/50 p-4">
                  <div className="flex items-center justify-between">
                    <p className="font-semibold text-white">{item.payload.instrument}</p>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${item.payload.settled ? "bg-signal-mint/20 text-signal-mint" : "bg-signal-amber/20 text-signal-amber"}`}>
                      {item.payload.settled ? "Settled" : "Pending"}
                    </span>
                  </div>

                  {/* DvP Flow Visualization */}
                  <div className="mt-4 rounded-lg border border-shell-700 bg-shell-900 p-3">
                    <p className="mb-2 text-xs uppercase tracking-[0.2em] text-signal-slate">Delivery vs Payment</p>
                    <div className="flex items-center justify-between gap-2 text-sm">
                      <div className="flex-1 rounded-md bg-shell-950 p-2 text-center">
                        <p className="text-xs text-signal-slate">Seller</p>
                        <p className="font-semibold text-signal-coral">{Number(item.payload.quantity).toLocaleString()} shares</p>
                      </div>
                      <div className="flex flex-col items-center text-signal-mint">
                        <span className={`text-lg ${item.payload.settled ? "animate-pulse-settled" : ""}`}>{item.payload.settled ? "⟶" : "⇢"}</span>
                        <span className="text-[10px] text-signal-slate">Asset</span>
                      </div>
                      <div className="flex-1 rounded-md bg-shell-950 p-2 text-center">
                        <p className="text-xs text-signal-slate">Buyer</p>
                        <p className="font-semibold text-signal-mint">${totalValue.toLocaleString()}</p>
                      </div>
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-2 text-sm">
                      <div className="flex-1" />
                      <div className="flex flex-col items-center text-signal-amber">
                        <span className="text-[10px] text-signal-slate">Cash</span>
                        <span className={`text-lg ${item.payload.settled ? "animate-pulse-settled" : ""}`}>{item.payload.settled ? "⟵" : "⇠"}</span>
                      </div>
                      <div className="flex-1" />
                    </div>
                  </div>

                  {/* Step Progress */}
                  <div className="mt-3 flex gap-1">
                    {STEPS.map((label, i) => (
                      <div key={label} className="flex-1">
                        <div className={`h-1.5 rounded-full ${i <= step ? "bg-signal-mint" : "bg-shell-700"}`} />
                        <p className={`mt-1 text-center text-[9px] ${i <= step ? "text-signal-mint" : "text-signal-slate"}`}>{label}</p>
                      </div>
                    ))}
                  </div>

                  {!item.payload.settled && isIssuer && (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <button
                        className="rounded-md bg-signal-mint px-3 py-1.5 text-sm font-semibold text-shell-950 disabled:opacity-50"
                        disabled={settling === item.contractId || !canFinalizeDvP}
                        onClick={() => handleFinalize(item.contractId, sellerAsset!.contractId, buyerCash!.contractId)}
                      >
                        {settling === item.contractId ? "Finalizing..." : "Finalize Atomic DvP"}
                      </button>
                      <button
                        className="rounded-md border border-signal-amber bg-signal-amber/10 px-3 py-1.5 text-sm font-semibold text-signal-amber disabled:opacity-50"
                        disabled={settling === item.contractId}
                        onClick={() => handleSimpleFinalize(item.contractId)}
                      >
                        Simple Finalize (Audit Only)
                      </button>
                    </div>
                  )}
                  {!item.payload.settled && isIssuer && !canFinalizeDvP && (
                    <p className="mt-2 text-xs text-signal-coral">
                      Missing asset/cash for atomic DvP. Use "Simple Finalize" to record settlement without on-chain transfer.
                    </p>
                  )}
                  {actionError && settling === null && (
                    <p className="mt-2 text-sm text-signal-coral">{actionError}</p>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </div>

      {/* Audit Trail */}
      <div className="rounded-xl border border-shell-700 bg-shell-900/70 p-4">
        <h3 className="mb-3 text-lg font-semibold text-signal-amber">Immutable Audit Trail</h3>
        {auditRecords.length === 0 ? (
          <p className="text-sm text-signal-slate">No audit records found.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-sm">
              <thead>
                <tr className="border-b border-shell-700 text-left text-xs uppercase tracking-[0.15em] text-signal-slate">
                  <th className="py-2">Instrument</th>
                  <th className="py-2">Qty</th>
                  <th className="py-2">Unit Price</th>
                  <th className="py-2">Total</th>
                  <th className="py-2">Settled At</th>
                </tr>
              </thead>
              <tbody>
                {auditRecords.map((item) => (
                  <tr key={item.contractId} className="border-b border-shell-800 text-signal-slate">
                    <td className="py-3 font-medium text-white">{item.payload.instrument}</td>
                    <td className="py-3">{String(item.payload.quantity)}</td>
                    <td className="py-3">{String(item.payload.unitPrice)}</td>
                    <td className="py-3">${(Number(item.payload.quantity) * Number(item.payload.unitPrice)).toLocaleString()}</td>
                    <td className="py-3">{new Date(item.payload.settledAt).toLocaleString()}</td>
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
