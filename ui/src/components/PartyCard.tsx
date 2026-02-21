type PartyAlias = "Seller" | "SellerAgent" | "Buyer" | "BuyerAgent" | "Company" | "Outsider";

interface PartyMeta {
  description: string;
  borderColor: string;
  activeBg: string;
  canSee: string;
  hidden: string;
}

const PARTY_META: Record<PartyAlias, PartyMeta> = {
  Seller: {
    description: "Sells shares, sets minimum price",
    borderColor: "border-l-signal-mint",
    activeBg: "bg-signal-mint/10 border-signal-mint/40",
    canSee: "TI, DI, PN, TS, AR, AH",
    hidden: "CH (Buyer's cash)",
  },
  SellerAgent: {
    description: "Autonomous agent acting for Seller",
    borderColor: "border-l-signal-mint",
    activeBg: "bg-signal-mint/10 border-signal-mint/40",
    canSee: "TI, DI, PN, TS, AR",
    hidden: "AH, CH",
  },
  Buyer: {
    description: "Buys shares, holds cash position",
    borderColor: "border-l-blue-500",
    activeBg: "bg-blue-500/10 border-blue-500/40",
    canSee: "DI, PN, TS, AR, CH",
    hidden: "TI (Seller's reserve price)",
  },
  BuyerAgent: {
    description: "Autonomous agent acting for Buyer",
    borderColor: "border-l-blue-500",
    activeBg: "bg-blue-500/10 border-blue-500/40",
    canSee: "DI, PN, TS, AR",
    hidden: "TI, AH, CH",
  },
  Company: {
    description: "Issuer with full regulatory access",
    borderColor: "border-l-signal-amber",
    activeBg: "bg-signal-amber/10 border-signal-amber/40",
    canSee: "All templates",
    hidden: "None",
  },
  Outsider: {
    description: "No role in any contract",
    borderColor: "border-l-signal-coral",
    activeBg: "bg-signal-coral/10 border-signal-coral/40",
    canSee: "Nothing",
    hidden: "Everything",
  },
};

function aliasOf(party: string): string {
  return party.includes("::") ? party.split("::")[0] : party;
}

export function PartyCardSelector({
  availableParties,
  activeParty,
  onSelect,
}: {
  availableParties: string[];
  activeParty: string;
  onSelect: (party: string) => void;
}) {
  const activeAlias = aliasOf(activeParty) as PartyAlias;
  const activeMeta = PARTY_META[activeAlias] ?? PARTY_META.Outsider;

  // Split into main parties and outsider
  const mainParties = availableParties.filter((p) => aliasOf(p) !== "Outsider");
  const outsiderParty = availableParties.find((p) => aliasOf(p) === "Outsider");

  return (
    <div>
      <div className="flex flex-wrap items-stretch gap-2">
        {mainParties.map((entry) => {
          const alias = aliasOf(entry) as PartyAlias;
          const meta = PARTY_META[alias] ?? PARTY_META.Company;
          const isActive = entry === activeParty;
          return (
            <button
              key={entry}
              className={`flex flex-col items-start rounded-lg border-l-[3px] px-3 py-2 text-left transition-all ${
                meta.borderColor
              } ${
                isActive
                  ? `${meta.activeBg} shadow-md`
                  : "border border-shell-700 bg-white/80 hover:bg-white"
              }`}
              onClick={() => onSelect(entry)}
            >
              <span className={`text-sm font-bold ${isActive ? "text-shell-950" : "text-shell-950/70"}`}>
                {alias}
              </span>
              <span className="text-[10px] text-signal-slate">{meta.description}</span>
            </button>
          );
        })}

        {outsiderParty && (
          <button
            className={`flex flex-col items-start rounded-lg border-l-[3px] border-dashed px-3 py-2 text-left transition-all ${
              PARTY_META.Outsider.borderColor
            } ${
              outsiderParty === activeParty
                ? `${PARTY_META.Outsider.activeBg} shadow-md`
                : "border border-dashed border-signal-coral/30 bg-signal-coral/5 hover:bg-signal-coral/10"
            }`}
            onClick={() => onSelect(outsiderParty)}
          >
            <span className={`text-sm font-bold ${outsiderParty === activeParty ? "text-signal-coral" : "text-signal-coral/70"}`}>
              Outsider
            </span>
            <span className="text-[10px] text-signal-coral/60">{PARTY_META.Outsider.description}</span>
          </button>
        )}
      </div>

      <p className="mt-2 text-[11px] text-signal-slate">
        <span className="font-semibold">Can see:</span> {activeMeta.canSee}
        {activeMeta.hidden !== "None" && (
          <span className="ml-2 text-signal-coral">
            <span className="font-semibold">Hidden:</span> {activeMeta.hidden}
          </span>
        )}
      </p>
    </div>
  );
}
