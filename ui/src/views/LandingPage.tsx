interface LandingPageProps {
  onOpenConsole: () => void;
  onOpenInspector: () => void;
  onOpenDarkAuction: () => void;
}

const valueProps = [
  {
    title: "Private By Default",
    copy: "Orders and negotiations stay scoped to involved parties until settlement evidence is published.",
  },
  {
    title: "Commit-Reveal Integrity",
    copy: "Both sides can commit terms, reveal later, and verify exact match conditions without leaking early.",
  },
  {
    title: "Auditable Settlement",
    copy: "Finalized outcomes produce clear proofs while outsider visibility remains limited to approved signals.",
  },
];

const flowSteps = [
  "Intent posted by seller",
  "Discovery signal shared with scoped participants",
  "Private negotiation and acceptance",
  "Issuer approval and settlement proof",
];

export function LandingPage({ onOpenConsole, onOpenInspector, onOpenDarkAuction }: LandingPageProps) {
  return (
    <section className="mt-6 animate-fade-rise space-y-6">
      <article className="app-panel panel-sheen relative overflow-hidden rounded-[1.75rem] border border-shell-700 p-7 lg:p-10">
        <div className="pointer-events-none absolute -top-24 right-[-6.5rem] h-60 w-60 rounded-full bg-signal-mint/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-20 left-[-7rem] h-56 w-56 rounded-full bg-[#46a8c9]/25 blur-3xl" />
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-signal-slate">DarkLedger</p>
        <h2 className="mt-2 max-w-4xl text-4xl font-bold leading-tight text-shell-950 md:text-5xl">
          Private capital-market execution with verifiable settlement trails.
        </h2>
        <p className="mt-4 max-w-2xl text-base text-signal-slate">
          DarkLedger is a privacy-first trading rail for negotiated deals, where counterparties coordinate off the public
          path and reveal only what compliance requires.
        </p>
        <div className="mt-7 flex flex-wrap gap-3">
          <button
            className="rounded-xl bg-shell-950 px-5 py-2.5 text-sm font-semibold text-shell-900 shadow-soft"
            onClick={onOpenConsole}
          >
            Launch Trading Console
          </button>
          <button
            className="rounded-xl border border-shell-700 bg-white/85 px-5 py-2.5 text-sm font-semibold text-shell-950 shadow-soft"
            onClick={onOpenDarkAuction}
          >
            Open Dark Auction
          </button>
          <button
            className="rounded-xl border border-shell-700 bg-white/85 px-5 py-2.5 text-sm font-semibold text-shell-950 shadow-soft"
            onClick={onOpenInspector}
          >
            Open Visibility Inspector
          </button>
        </div>
      </article>

      <div className="grid gap-4 lg:grid-cols-3">
        {valueProps.map((item, index) => (
          <article
            key={item.title}
            className="rounded-2xl border border-shell-700 bg-white p-5"
            style={{ animationDelay: `${120 + index * 80}ms` }}
          >
            <p className="text-sm font-semibold text-shell-950">{item.title}</p>
            <p className="mt-2 text-sm text-signal-slate">{item.copy}</p>
          </article>
        ))}
      </div>

      <article className="rounded-2xl border border-shell-700 bg-white p-5">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-signal-slate">Lifecycle</p>
        <h3 className="mt-2 text-2xl font-semibold text-shell-950">How a deal moves through DarkLedger</h3>
        <div className="mt-4 grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          {flowSteps.map((step, index) => (
            <div key={step} className="rounded-xl border border-shell-700/70 bg-shell-900/55 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-signal-slate">Step {index + 1}</p>
              <p className="mt-1 text-sm font-medium text-shell-950">{step}</p>
            </div>
          ))}
        </div>
      </article>
    </section>
  );
}
