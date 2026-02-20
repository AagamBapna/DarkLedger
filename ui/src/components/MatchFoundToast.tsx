interface MatchFoundToastProps {
  instrument: string;
  counterparty: string;
  onOpenChannel: () => void;
  onDismiss: () => void;
}

export function MatchFoundToast({
  instrument,
  counterparty,
  onOpenChannel,
  onDismiss
}: MatchFoundToastProps) {
  return (
    <div className="fixed bottom-6 right-6 z-50 w-[min(90vw,400px)] rounded-2xl border border-shell-700 bg-shell-900/95 p-4 shadow-pulse backdrop-blur-sm">
      <p className="text-xs uppercase tracking-[0.2em] text-signal-slate">Match Found</p>
      <p className="mt-2 text-lg font-semibold text-shell-950">{instrument}</p>
      <p className="mt-1 text-sm text-signal-slate">Counterparty: {counterparty}</p>
      <div className="mt-4 flex gap-2">
        <button
          className="rounded-md bg-shell-950 px-3 py-2 text-sm font-semibold text-white"
          onClick={onOpenChannel}
        >
          Open Negotiation Channel
        </button>
        <button
          className="rounded-md border border-shell-700 px-3 py-2 text-sm text-shell-950"
          onClick={onDismiss}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
