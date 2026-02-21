import { useState } from "react";
import { CreditLendingView } from "./CreditLendingView";

export function LendingWorkspaceView() {
  const [demoRunToken, setDemoRunToken] = useState(0);

  return (
    <section className="space-y-6">
      <article className="dash-card lending-desk-hero">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-signal-slate">Lending + Order Book</p>
        <h2 className="mt-1 text-2xl font-bold text-shell-950">Unified Credit Desk</h2>
        <p className="mt-2 text-sm text-signal-slate">
          Canton privacy lending demo with participant verification, anonymous quoting, and guided lifecycle playback.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <p className="inline-flex items-center rounded-full border border-signal-mint/40 bg-signal-mint/15 px-3 py-1 text-xs font-semibold uppercase tracking-[0.1em] text-signal-mint">
            Interactive Demo Mode
          </p>
          <button
            className="rounded-full border border-shell-700/70 bg-shell-950 px-4 py-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-shell-900"
            type="button"
            onClick={() => setDemoRunToken((value) => value + 1)}
          >
            Run Guided Demo
          </button>
        </div>
      </article>
      <CreditLendingView forceDemo demoRunToken={demoRunToken} />
    </section>
  );
}
