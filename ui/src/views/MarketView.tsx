import type { ContractRecord, Party, PrivateNegotiationPayload } from "../types/contracts";

interface MarketViewProps {
  party: Party;
  negotiations: Array<ContractRecord<PrivateNegotiationPayload>>;
  onOpenChannel: () => void;
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

function pseudonymFor(party: Party, negotiation: PrivateNegotiationPayload): string {
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

export function MarketView({ party, negotiations, onOpenChannel }: MarketViewProps) {
  if (negotiations.length === 0) {
    return (
      <section className="flex min-h-[58vh] items-center justify-center rounded-2xl border border-dashed border-shell-700 bg-white/55 backdrop-blur-xl p-8 text-center">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-signal-slate">Market View</p>
          <h2 className="mt-4 text-3xl font-semibold text-shell-950">No discoverable market data</h2>
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
    <section className="space-y-4 rounded-2xl border border-shell-700 bg-white/60 backdrop-blur-xl p-6">
      <p className="text-xs uppercase tracking-[0.2em] text-signal-mint">Match Found</p>
      <h2 className="text-2xl font-semibold text-shell-950">{latest.instrument}</h2>
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
