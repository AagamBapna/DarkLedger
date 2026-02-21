interface ContractCounts {
  tradeIntents: number;
  discovery: number;
  negotiations: number;
  settlements: number;
  audits: number;
  assets: number;
  cash: number;
}

const TEMPLATE_QUERIES: Array<{ name: string; query: string; key: keyof ContractCounts }> = [
  { name: "TradeIntent", query: 'queryTradeIntents("Outsider")', key: "tradeIntents" },
  { name: "DiscoveryInterest", query: 'queryDiscoveryInterests("Outsider")', key: "discovery" },
  { name: "PrivateNegotiation", query: 'queryPrivateNegotiations("Outsider")', key: "negotiations" },
  { name: "TradeSettlement", query: 'queryTradeSettlements("Outsider")', key: "settlements" },
  { name: "AuditRecord", query: 'queryAuditRecords("Outsider")', key: "audits" },
  { name: "AssetHolding", query: 'queryAssetHoldings("Outsider")', key: "assets" },
  { name: "CashHolding", query: 'queryCashHoldings("Outsider")', key: "cash" },
];

export function OutsiderBlockade({ counts }: { counts: ContractCounts }) {
  return (
    <section className="panel-shell relative overflow-hidden border-signal-coral/30 bg-shell-950/[0.97]">
      {/* Scanline effect */}
      <div className="pointer-events-none absolute inset-0 z-0">
        <div
          className="absolute left-0 right-0 h-[30%] opacity-[0.04]"
          style={{
            background: "linear-gradient(180deg, transparent 0%, rgba(255,255,255,0.6) 50%, transparent 100%)",
            animation: "scanline 8s ease-in-out infinite",
          }}
        />
      </div>

      <div className="relative z-10 py-8 text-center">
        <p className="text-[10px] font-semibold uppercase tracking-[0.3em] text-signal-coral/70">
          Canton Sub-Transaction Privacy
        </p>
        <h2
          className="mt-3 text-4xl font-bold tracking-tight text-signal-coral md:text-5xl"
          style={{ fontFamily: '"Bodoni Moda", Georgia, serif' }}
        >
          ZERO VISIBILITY
        </h2>
        <p className="mx-auto mt-2 max-w-xl text-sm text-shell-700">
          Canton's sub-transaction privacy in action. The Outsider party is not a signatory
          or observer on any contract in this workflow — every query returns zero results.
        </p>

        <div className="mx-auto mt-8 grid max-w-4xl gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {TEMPLATE_QUERIES.map((t) => (
            <article
              key={t.name}
              className="rounded-xl border border-signal-coral/20 bg-shell-950/80 p-4 text-left backdrop-blur"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-white/80">{t.name}</span>
                <span className="lock-pulse text-signal-coral">
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0110 0v4" />
                  </svg>
                </span>
              </div>
              <p className="mt-2 text-2xl font-bold tabular-nums text-signal-coral">{counts[t.key]}</p>
              <p className="mt-1.5 rounded bg-black/30 px-2 py-1 font-mono text-[10px] text-white/40">
                {t.query} <span className="text-signal-coral">&rarr; 0 results</span>
              </p>
            </article>
          ))}
        </div>

        <div className="mx-auto mt-8 max-w-2xl rounded-xl border border-white/10 bg-white/5 p-5 text-left">
          <h3 className="text-sm font-semibold text-white/90">Why Zero?</h3>
          <p className="mt-2 text-xs leading-relaxed text-white/50">
            Canton's unique sub-transaction privacy model ensures that only parties who are
            signatories or observers on a contract can see it. Unlike public blockchains where
            all nodes see all transactions, Canton participants only receive the sub-transactions
            they are entitled to. The Outsider party has no role in any template in this workflow,
            so every ledger query returns an empty result set — not because data is encrypted, but
            because it was <span className="font-semibold text-white/70">never transmitted</span> to
            this participant's node in the first place.
          </p>
        </div>
      </div>
    </section>
  );
}
