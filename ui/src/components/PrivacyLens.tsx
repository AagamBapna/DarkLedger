interface ContractCounts {
  tradeIntents: number;
  discovery: number;
  negotiations: number;
  settlements: number;
  audits: number;
  assets: number;
  cash: number;
}

type PartyAlias = "Seller" | "SellerAgent" | "Buyer" | "BuyerAgent" | "Company" | "Outsider";

interface TemplateIndicator {
  code: string;
  label: string;
  key: keyof ContractCounts;
}

const TEMPLATES: TemplateIndicator[] = [
  { code: "TI", label: "TradeIntent", key: "tradeIntents" },
  { code: "DI", label: "DiscoveryInterest", key: "discovery" },
  { code: "PN", label: "PrivateNegotiation", key: "negotiations" },
  { code: "TS", label: "TradeSettlement", key: "settlements" },
  { code: "AR", label: "AuditRecord", key: "audits" },
  { code: "AH", label: "AssetHolding", key: "assets" },
  { code: "CH", label: "CashHolding", key: "cash" },
];

// Derived from Daml signatory/observer model:
// true = this party is signatory or observer and SHOULD see contracts of this template
const EXPECTED_VISIBILITY: Record<PartyAlias, Record<keyof ContractCounts, boolean>> = {
  Seller:      { tradeIntents: true, discovery: true, negotiations: true, settlements: true, audits: true, assets: true, cash: false },
  SellerAgent: { tradeIntents: true, discovery: true, negotiations: true, settlements: true, audits: true, assets: false, cash: false },
  Buyer:       { tradeIntents: true, discovery: true, negotiations: true, settlements: true, audits: true, assets: false, cash: true },
  BuyerAgent:  { tradeIntents: false, discovery: true, negotiations: true, settlements: true, audits: true, assets: false, cash: false },
  Company:     { tradeIntents: true, discovery: true, negotiations: true, settlements: true, audits: true, assets: true, cash: true },
  Outsider:    { tradeIntents: false, discovery: false, negotiations: false, settlements: false, audits: false, assets: false, cash: false },
};

const PARTY_SUMMARIES: Record<PartyAlias, { text: string; color: string }> = {
  Seller:      { text: "Seller's reserve price hidden from Buyer", color: "text-signal-amber" },
  SellerAgent: { text: "Agent view -- no holdings visible", color: "text-signal-amber" },
  Buyer:       { text: "Buyer's cash position hidden from Seller", color: "text-signal-amber" },
  BuyerAgent:  { text: "Agent view -- no holdings visible", color: "text-signal-amber" },
  Company:     { text: "Full regulatory access", color: "text-signal-mint" },
  Outsider:    { text: "ZERO VISIBILITY", color: "text-signal-coral" },
};

function dotColor(count: number, expected: boolean): string {
  if (expected && count > 0) return "bg-signal-mint";       // green: visible & expected
  if (!expected && count === 0) return "bg-signal-coral";   // red: hidden & expected-hidden
  if (expected && count === 0) return "bg-signal-amber";    // amber: expected but missing
  return "bg-signal-mint";                                   // visible unexpectedly (still green)
}

function dotLabel(count: number, expected: boolean): string {
  if (expected && count > 0) return "Visible";
  if (!expected && count === 0) return "Hidden";
  if (expected && count === 0) return "Expected";
  return "Visible";
}

export function PrivacyLens({ partyAlias, counts }: { partyAlias: string; counts: ContractCounts }) {
  const alias = (EXPECTED_VISIBILITY[partyAlias as PartyAlias] ? partyAlias : "Outsider") as PartyAlias;
  const expected = EXPECTED_VISIBILITY[alias];
  const summary = PARTY_SUMMARIES[alias];
  const isOutsider = alias === "Outsider";

  return (
    <div
      className={`mt-3 rounded-lg border px-4 py-2.5 transition-all ${
        isOutsider
          ? "outsider-glow border-signal-coral/60 bg-signal-coral/5"
          : "border-shell-700 bg-white/60"
      }`}
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-signal-slate">Privacy Lens</span>
        <div className="flex flex-wrap gap-2">
          {TEMPLATES.map((t) => {
            const count = counts[t.key];
            const exp = expected[t.key];
            const color = dotColor(count, exp);
            const label = dotLabel(count, exp);
            return (
              <div
                key={t.code}
                className="flex items-center gap-1.5 rounded-md border border-shell-700/50 bg-white/80 px-2 py-1"
                title={`${t.label}: ${count} contract(s) - ${label}`}
              >
                <span className={`inline-block h-2 w-2 rounded-full ${color} ${!exp && count === 0 ? "lock-pulse" : ""}`} />
                <span className="text-[11px] font-semibold text-shell-950">{t.code}</span>
                <span className="text-[10px] tabular-nums text-signal-slate">{count}</span>
              </div>
            );
          })}
        </div>
        <span className={`ml-auto text-xs font-semibold ${summary.color}`}>
          {summary.text}
        </span>
      </div>
    </div>
  );
}
