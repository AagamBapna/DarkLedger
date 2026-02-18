import type { ContractRecord, Party, PrivateNegotiationPayload } from "../types/contracts";

interface MarketViewProps {
  party: Party;
  negotiations: Array<ContractRecord<PrivateNegotiationPayload>>;
  onOpenChannel: () => void;
}

function pseudonymFor(party: Party, negotiation: PrivateNegotiationPayload): string {
  if (party === "Seller" || party === "SellerAgent") {
    return `Buyer-${negotiation.buyer.slice(0, 6)}`;
  }
  if (party === "Buyer" || party === "BuyerAgent") {
    return `Seller-${negotiation.seller.slice(0, 6)}`;
  }
  return `Pair-${negotiation.instrument.slice(0, 6)}`;
}

export function MarketView({ party, negotiations, onOpenChannel }: MarketViewProps) {
  if (negotiations.length === 0) {
    return (
      <section className="flex min-h-[58vh] items-center justify-center rounded-2xl border border-dashed border-shell-700 bg-shell-900/50 p-8 text-center">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-signal-slate">Market View</p>
          <h2 className="mt-4 text-3xl font-semibold text-white">No discoverable market data</h2>
          <p className="mt-3 text-sm text-signal-slate">
            Discovery uses private interest signaling only. Price and volume remain hidden until a
            direct private match is formed.
          </p>
        </div>
      </section>
    );
  }

  const latest = negotiations[0].payload;
  return (
    <section className="space-y-4 rounded-2xl border border-shell-700 bg-shell-900/60 p-6">
      <p className="text-xs uppercase tracking-[0.2em] text-signal-mint">Match Found</p>
      <h2 className="text-2xl font-semibold text-white">{latest.instrument}</h2>
      <p className="text-sm text-signal-slate">Counterparty: {pseudonymFor(party, latest)}</p>
      <button
        className="rounded-md bg-signal-mint px-4 py-2 text-sm font-semibold text-shell-950"
        onClick={onOpenChannel}
      >
        Open Negotiation Channel
      </button>
    </section>
  );
}
