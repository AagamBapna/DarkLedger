interface LandingPageProps {
  onOpenConsole: () => void;
  onOpenInspector: () => void;
  onOpenDarkAuction: () => void;
  stats: {
    tradeIntents: number;
    sellerNegotiations: number;
    buyerNegotiations: number;
    completedDeals: number;
    settlements: number;
    auditRecords: number;
  };
  parties: string[];
}

const STAT_CARDS = [
  { key: "tradeIntents", label: "Trade Intents", trend: "+12%", up: true, color: "#14B8A6", bars: [35, 55, 40, 65, 50, 80] },
  { key: "sellerNegotiations", label: "Seller Negotiations", trend: "+8%", up: true, color: "#8B5CF6", bars: [45, 30, 60, 75, 55, 70] },
  { key: "buyerNegotiations", label: "Buyer Negotiations", trend: "+5%", up: true, color: "#F97316", bars: [25, 45, 35, 50, 65, 55] },
  { key: "completedDeals", label: "Completed Deals", trend: "+21%", up: true, color: "#10B981", bars: [20, 35, 50, 45, 70, 85] },
];

const QUICK_ACTIONS = [
  { label: "Launch Trading Console", desc: "Start seller workflow", action: "console", gradient: "from-[#1E293B] to-[#334155]" },
  { label: "Open Dark Auction", desc: "Run commit-reveal auction", action: "auction", gradient: "from-[#14B8A6] to-[#0D9488]" },
  { label: "Visibility Inspector", desc: "Check contract privacy", action: "inspector", gradient: "from-[#8B5CF6] to-[#7C3AED]" },
];

const LIFECYCLE_STEPS = [
  { step: 1, title: "Intent Posted", desc: "Seller publishes trade intent." },
  { step: 2, title: "Discovery Signal", desc: "Scoped participants notified." },
  { step: 3, title: "Private Negotiation", desc: "Counterparties negotiate privately." },
  { step: 4, title: "Settlement Proof", desc: "Issuer approves and settles." },
];

function aliasOf(value: string): string {
  return value.includes("::") ? value.split("::")[0] : value;
}

function MiniBarChart({ bars, color, delay }: { bars: number[]; color: string; delay: number }) {
  return (
    <div className="mini-bars">
      {bars.map((h, i) => (
        <div key={i} className="mini-bar" style={{ height: `${h}%`, backgroundColor: i === bars.length - 1 ? color : `${color}40`, animationDelay: `${delay + i * 80}ms` }} />
      ))}
    </div>
  );
}

export function LandingPage({ onOpenConsole, onOpenInspector, onOpenDarkAuction, stats, parties }: LandingPageProps) {
  const statValues: Record<string, number> = { tradeIntents: stats.tradeIntents, sellerNegotiations: stats.sellerNegotiations, buyerNegotiations: stats.buyerNegotiations, completedDeals: stats.completedDeals };
  const actionHandlers: Record<string, () => void> = { console: onOpenConsole, auction: onOpenDarkAuction, inspector: onOpenInspector };

  return (
    <div className="stagger-children space-y-6">
      {/* Stat Cards */}
      <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
        {STAT_CARDS.map((card, idx) => (
          <div key={card.key} className="stat-card">
            <div className="flex items-start justify-between">
              <div>
                <p className="stat-label">{card.label}</p>
                <p className="stat-value animate-count-up" style={{ animationDelay: `${idx * 100}ms` }}>{statValues[card.key] ?? 0}</p>
                <span className={`stat-trend ${card.up ? "up" : "down"} mt-2`}>
                  <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>{card.up ? <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" /> : <polyline points="23 18 13.5 8.5 8.5 13.5 1 6" />}</svg>
                  {card.trend}
                </span>
              </div>
              <MiniBarChart bars={card.bars} color={card.color} delay={idx * 120} />
            </div>
          </div>
        ))}
      </div>

      {/* Actions + Parties */}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="dash-card lg:col-span-2">
          <h3 className="text-lg font-semibold text-[#1E293B]">Quick Actions</h3>
          <p className="mt-0.5 text-sm text-[#64748B]">Jump into any workflow.</p>
          <div className="mt-5 grid gap-4 sm:grid-cols-3">
            {QUICK_ACTIONS.map((qa) => (
              <button key={qa.action} className={`group relative overflow-hidden rounded-2xl bg-gradient-to-br ${qa.gradient} p-5 text-left text-white shadow-card transition-all duration-300 hover:shadow-card-hover hover:-translate-y-1`} onClick={actionHandlers[qa.action]}>
                <div className="pointer-events-none absolute -right-4 -top-4 h-20 w-20 rounded-full bg-white/10 transition-transform duration-500 group-hover:scale-150" />
                <p className="text-sm font-bold">{qa.label}</p>
                <p className="mt-1 text-xs text-white/70">{qa.desc}</p>
                <svg className="mt-3 h-5 w-5 text-white/60 transition-transform duration-300 group-hover:translate-x-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></svg>
              </button>
            ))}
          </div>
        </div>

        <div className="dash-card">
          <div className="mb-4 flex items-center justify-between"><h3 className="text-lg font-semibold text-[#1E293B]">Active Parties</h3><span className="badge badge-mint">{parties.length}</span></div>
          <div className="space-y-1">
            {parties.map((party, idx) => {
              const alias = aliasOf(party);
              const colors = ["#14B8A6", "#8B5CF6", "#F97316", "#EC4899", "#3B82F6", "#10B981", "#EF4444", "#F59E0B"];
              return (
                <div key={party} className="leaderboard-item">
                  <span className="flex h-6 w-6 items-center justify-center rounded-md text-xs font-bold text-[#64748B]">{idx + 1}</span>
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg text-xs font-bold text-white" style={{ background: colors[idx % colors.length] }}>{alias.charAt(0).toUpperCase()}</div>
                  <p className="min-w-0 flex-1 truncate text-sm font-medium text-[#1E293B]">{alias}</p>
                  <span className="badge badge-mint text-[10px]">active</span>
                </div>
              );
            })}
            {parties.length === 0 && <p className="text-sm text-[#64748B]">No parties.</p>}
          </div>
        </div>
      </div>

      {/* Lifecycle + Summary */}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="dash-card lg:col-span-2">
          <p className="text-xs font-semibold uppercase tracking-widest text-[#64748B]">Lifecycle</p>
          <h3 className="mt-2 text-lg font-semibold text-[#1E293B]">How a deal moves through DarkLedger</h3>
          <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {LIFECYCLE_STEPS.map((s) => (
              <div key={s.step} className="group rounded-xl border border-[#E2E8F0] bg-slate-50 p-4 transition-all duration-300 hover:border-[#14B8A6]/30 hover:bg-white hover:shadow-card">
                <div className="mb-2 flex h-8 w-8 items-center justify-center rounded-lg bg-[#14B8A6]/10 text-sm font-bold text-[#14B8A6] transition-colors group-hover:bg-[#14B8A6] group-hover:text-white">{s.step}</div>
                <p className="text-sm font-semibold text-[#1E293B]">{s.title}</p>
                <p className="mt-1 text-xs text-[#64748B]">{s.desc}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="dash-card">
          <h3 className="text-lg font-semibold text-[#1E293B]">Network Summary</h3>
          <div className="mt-5 space-y-4">
            {[
              { label: "Settlements", value: stats.settlements, color: "#14B8A6" },
              { label: "Audit Records", value: stats.auditRecords, color: "#8B5CF6" },
              { label: "Trade Intents", value: stats.tradeIntents, color: "#F97316" },
              { label: "Completed", value: stats.completedDeals, color: "#10B981" },
            ].map((r) => (
              <div key={r.label} className="flex items-center justify-between">
                <div className="flex items-center gap-3"><div className="h-2 w-2 rounded-full" style={{ background: r.color }} /><span className="text-sm text-[#64748B]">{r.label}</span></div>
                <span className="text-sm font-semibold text-[#1E293B]">{r.value}</span>
              </div>
            ))}
          </div>
          <div className="mt-6 rounded-xl border border-[#E2E8F0] bg-slate-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-[#64748B]">Network Health</p>
            <div className="mt-3 flex items-end gap-1">
              {[40, 65, 50, 80, 55, 70, 90, 60, 75, 85, 45, 95].map((h, i) => (
                <div key={i} className="mini-bar flex-1 rounded-sm" style={{ height: `${h * 0.5}px`, backgroundColor: i === 11 ? "#14B8A6" : "#14B8A620", animationDelay: `${800 + i * 50}ms` }} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
