import { useEffect, useMemo, useRef, useState } from "react";

type AuctionPhase = "Idle" | "Commit" | "Reveal" | "Settled";

type BuyerStatus = "Waiting" | "Committed" | "Revealed" | "Disqualified" | "Winner" | "Lost";

interface BuyerBlueprint {
  name: string;
  price: number;
  complianceTag: string;
  tamperReveal?: boolean;
}

interface BuyerState {
  id: string;
  name: string;
  targetPrice: number;
  complianceTag: string;
  tamperReveal: boolean;
  commitmentHash: string;
  nonce: string;
  status: BuyerStatus;
  committedAt: string | null;
  revealedAt: string | null;
  revealedPrice: number | null;
  revealNonce: string | null;
  recomputedHash: string | null;
  hashValid: boolean | null;
  qualified: boolean | null;
}

interface AuctionEvent {
  id: string;
  at: string;
  actor: string;
  action: string;
  detail: string;
}

interface SettlementProof {
  rfqId: string;
  instrument: string;
  quantity: number;
  reservePrice: number;
  winner: string | null;
  winningPrice: number | null;
  qualifiedBids: number;
  disqualifiedBids: number;
  settledAt: string;
  outcome: "WinnerSelected" | "NoQualifiedBids";
  proofHash: string;
}

interface RfqState {
  id: string;
  instrument: string;
  quantity: number;
  reservePrice: number;
  commitWindowSeconds: number;
  revealWindowSeconds: number;
}

const BUYERS: BuyerBlueprint[] = [
  { name: "Fund-Aster", price: 101.25, complianceTag: "KYC-PASS" },
  { name: "Fund-Orion", price: 103.1, complianceTag: "KYC-PASS" },
  { name: "Fund-Nova", price: 98.5, complianceTag: "KYC-PASS" },
  { name: "Fund-Helix", price: 102.4, complianceTag: "KYC-REVIEW", tamperReveal: true },
];

function nowIso(): string {
  return new Date().toISOString();
}

function formatLocal(iso: string): string {
  return new Date(iso).toLocaleString();
}

function shortHash(value: string): string {
  if (!value) return "-";
  return `${value.slice(0, 10)}...${value.slice(-8)}`;
}

function parsePositiveNumber(value: string): number | null {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function parsePositiveInt(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function countdownLabel(seconds: number): string {
  const safe = Math.max(0, seconds);
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

function randomNonce(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `${slug}-${crypto.randomUUID().slice(0, 8)}`;
}

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = Array.from(new Uint8Array(digest));
  return bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function newRfqId(): string {
  return `RFQ-${Date.now().toString().slice(-6)}`;
}

function stateBadgeClass(status: BuyerStatus): string {
  switch (status) {
    case "Winner":
      return "border-signal-mint/45 bg-signal-mint/12 text-shell-950";
    case "Disqualified":
      return "border-signal-coral/45 bg-signal-coral/12 text-signal-coral";
    case "Committed":
      return "border-shell-700/70 bg-shell-900/50 text-shell-950";
    case "Revealed":
    case "Lost":
      return "border-shell-700/70 bg-white text-shell-950";
    default:
      return "border-shell-700/70 bg-white text-signal-slate";
  }
}

export function DarkAuctionView() {
  const [phase, setPhase] = useState<AuctionPhase>("Idle");
  const [secondsLeft, setSecondsLeft] = useState(0);

  const [instrument, setInstrument] = useState("COMPANY-SERIES-A");
  const [quantityInput, setQuantityInput] = useState("7500");
  const [reserveInput, setReserveInput] = useState("99");
  const [commitWindowInput, setCommitWindowInput] = useState("8");
  const [revealWindowInput, setRevealWindowInput] = useState("10");

  const [rfq, setRfq] = useState<RfqState | null>(null);
  const [buyers, setBuyers] = useState<BuyerState[]>([]);
  const [events, setEvents] = useState<AuctionEvent[]>([]);
  const [proof, setProof] = useState<SettlementProof | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const phaseRef = useRef<AuctionPhase>(phase);
  const buyersRef = useRef<BuyerState[]>(buyers);
  const rfqRef = useRef<RfqState | null>(rfq);
  const tickerRef = useRef<number | null>(null);
  const phaseDeadlineRef = useRef<number | null>(null);
  const actionTimerRefs = useRef<number[]>([]);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    buyersRef.current = buyers;
  }, [buyers]);

  useEffect(() => {
    rfqRef.current = rfq;
  }, [rfq]);

  useEffect(() => {
    return () => {
      if (tickerRef.current !== null) window.clearInterval(tickerRef.current);
      if (phaseDeadlineRef.current !== null) window.clearTimeout(phaseDeadlineRef.current);
      actionTimerRefs.current.forEach((timerId) => window.clearTimeout(timerId));
    };
  }, []);

  const revealedCount = useMemo(
    () => buyers.filter((entry) => entry.status === "Revealed" || entry.status === "Winner" || entry.status === "Lost").length,
    [buyers],
  );

  const pendingCount = useMemo(() => buyers.filter((entry) => entry.status === "Committed").length, [buyers]);

  const qualifiedCount = useMemo(
    () => buyers.filter((entry) => entry.qualified && (entry.status === "Revealed" || entry.status === "Winner" || entry.status === "Lost")).length,
    [buyers],
  );

  const disqualifiedCount = useMemo(() => buyers.filter((entry) => entry.status === "Disqualified").length, [buyers]);

  const clearPhaseTimers = () => {
    if (tickerRef.current !== null) {
      window.clearInterval(tickerRef.current);
      tickerRef.current = null;
    }
    if (phaseDeadlineRef.current !== null) {
      window.clearTimeout(phaseDeadlineRef.current);
      phaseDeadlineRef.current = null;
    }
  };

  const clearActionTimers = () => {
    actionTimerRefs.current.forEach((timerId) => window.clearTimeout(timerId));
    actionTimerRefs.current = [];
  };

  const pushEvent = (actor: string, action: string, detail: string) => {
    setEvents((prev) => [
      {
        id: crypto.randomUUID(),
        at: nowIso(),
        actor,
        action,
        detail,
      },
      ...prev,
    ].slice(0, 24));
  };

  const beginPhase = (nextPhase: AuctionPhase, durationSeconds: number, onDone?: () => void) => {
    clearPhaseTimers();
    setPhase(nextPhase);
    setSecondsLeft(durationSeconds);

    if (durationSeconds <= 0) {
      onDone?.();
      return;
    }

    tickerRef.current = window.setInterval(() => {
      setSecondsLeft((prev) => Math.max(prev - 1, 0));
    }, 1000);

    phaseDeadlineRef.current = window.setTimeout(() => {
      clearPhaseTimers();
      setSecondsLeft(0);
      onDone?.();
    }, durationSeconds * 1000);
  };

  const revealBuyer = async (buyerId: string) => {
    const currentRfq = rfqRef.current;
    if (!currentRfq || phaseRef.current !== "Reveal") return;

    const currentBuyer = buyersRef.current.find((entry) => entry.id === buyerId);
    if (!currentBuyer || currentBuyer.status !== "Committed") return;

    const revealNonce = currentBuyer.tamperReveal ? `${currentBuyer.nonce}-tampered` : currentBuyer.nonce;
    const recomputedHash = await sha256Hex(
      `${currentRfq.id}|${currentBuyer.name}|${currentBuyer.targetPrice}|${revealNonce}`,
    );
    const hashValid = recomputedHash === currentBuyer.commitmentHash;
    const qualified = hashValid && currentBuyer.targetPrice >= currentRfq.reservePrice;

    setBuyers((prev) =>
      prev.map((entry) => {
        if (entry.id !== buyerId) return entry;
        return {
          ...entry,
          status: hashValid ? "Revealed" : "Disqualified",
          revealedAt: nowIso(),
          revealedPrice: currentBuyer.targetPrice,
          revealNonce,
          recomputedHash,
          hashValid,
          qualified,
        };
      }),
    );

    pushEvent(
      currentBuyer.name,
      "RevealBid",
      hashValid
        ? qualified
          ? `Reveal valid at ${currentBuyer.targetPrice} (qualified).`
          : `Reveal valid at ${currentBuyer.targetPrice} (below reserve).`
        : "Reveal rejected: commitment hash mismatch.",
    );
  };

  const settleRound = async () => {
    const currentRfq = rfqRef.current;
    if (!currentRfq) return;

    clearPhaseTimers();
    clearActionTimers();

    const normalized = buyersRef.current.map((entry) => {
      if (entry.status === "Committed") {
        return {
          ...entry,
          status: "Disqualified" as BuyerStatus,
          revealedAt: nowIso(),
          revealedPrice: entry.targetPrice,
          revealNonce: "TIMEOUT",
          recomputedHash: entry.recomputedHash,
          hashValid: false,
          qualified: false,
        };
      }
      return entry;
    });

    const qualified = normalized.filter((entry) => entry.qualified && entry.status !== "Disqualified");

    let winnerId: string | null = null;
    let winnerName: string | null = null;
    let winningPrice: number | null = null;

    if (qualified.length > 0) {
      const sorted = [...qualified].sort((left, right) => right.targetPrice - left.targetPrice);
      const winner = sorted[0];
      winnerId = winner.id;
      winnerName = winner.name;
      winningPrice = winner.targetPrice;
    }

    const finalBuyers = normalized.map((entry) => {
      if (!winnerId) {
        if (entry.status === "Revealed") return { ...entry, status: "Lost" as BuyerStatus };
        return entry;
      }
      if (entry.id === winnerId) return { ...entry, status: "Winner" as BuyerStatus };
      if (entry.status === "Revealed") return { ...entry, status: "Lost" as BuyerStatus };
      return entry;
    });

    setBuyers(finalBuyers);
    setPhase("Settled");
    setSecondsLeft(0);

    const settledAt = nowIso();
    const proofHash = await sha256Hex(
      `${currentRfq.id}|${winnerName ?? "NO_WINNER"}|${winningPrice ?? 0}|${settledAt}|${qualified.length}`,
    );

    const nextProof: SettlementProof = {
      rfqId: currentRfq.id,
      instrument: currentRfq.instrument,
      quantity: currentRfq.quantity,
      reservePrice: currentRfq.reservePrice,
      winner: winnerName,
      winningPrice,
      qualifiedBids: qualified.length,
      disqualifiedBids: finalBuyers.filter((entry) => entry.status === "Disqualified").length,
      settledAt,
      outcome: winnerName ? "WinnerSelected" : "NoQualifiedBids",
      proofHash,
    };

    setProof(nextProof);

    if (winnerName && winningPrice !== null) {
      setStatus(`Round settled. Winner: ${winnerName} @ ${winningPrice}.`);
      pushEvent("Issuer", "SettleRFQ", `Winner selected: ${winnerName} @ ${winningPrice}.`);
    } else {
      setStatus("Round settled with no qualified bids.");
      pushEvent("Issuer", "SettleRFQ", "No qualified bids. RFQ closed without winner.");
    }
  };

  const scheduleCommitments = (preparedBuyers: BuyerState[], commitSeconds: number) => {
    const spacingMs = Math.max(700, Math.floor((commitSeconds * 1000) / (preparedBuyers.length + 1)));
    preparedBuyers.forEach((buyer, index) => {
      const timerId = window.setTimeout(() => {
        if (phaseRef.current !== "Commit") return;
        setBuyers((prev) =>
          prev.map((entry) => {
            if (entry.id !== buyer.id) return entry;
            return {
              ...entry,
              status: "Committed",
              committedAt: nowIso(),
            };
          }),
        );
        pushEvent(buyer.name, "CommitBid", "Sealed commitment submitted.");
      }, 500 + index * spacingMs);
      actionTimerRefs.current.push(timerId);
    });
  };

  const openRevealWindow = (revealSeconds: number) => {
    setStatus("Reveal window opened. Buyers are now revealing bids.");
    pushEvent("Issuer", "OpenRevealWindow", "Reveal phase started.");

    const currentBuyers = buyersRef.current;
    const spacingMs = Math.max(900, Math.floor((revealSeconds * 1000) / (currentBuyers.length + 1)));
    currentBuyers.forEach((buyer, index) => {
      const timerId = window.setTimeout(() => {
        void revealBuyer(buyer.id);
      }, 800 + index * spacingMs);
      actionTimerRefs.current.push(timerId);
    });

    beginPhase("Reveal", revealSeconds, () => {
      void settleRound();
    });
  };

  const startRound = async () => {
    const quantity = parsePositiveNumber(quantityInput);
    const reservePrice = parsePositiveNumber(reserveInput);
    const commitSeconds = parsePositiveInt(commitWindowInput);
    const revealSeconds = parsePositiveInt(revealWindowInput);

    if (!instrument.trim()) {
      setError("Instrument is required.");
      return;
    }
    if (!quantity) {
      setError("Quantity must be positive.");
      return;
    }
    if (!reservePrice) {
      setError("Reserve price must be positive.");
      return;
    }
    if (!commitSeconds) {
      setError("Commit timer must be a positive integer.");
      return;
    }
    if (!revealSeconds) {
      setError("Reveal timer must be a positive integer.");
      return;
    }

    setBusy(true);
    setError(null);
    setStatus(null);
    setProof(null);
    clearPhaseTimers();
    clearActionTimers();

    try {
      const nextRfq: RfqState = {
        id: newRfqId(),
        instrument: instrument.trim(),
        quantity,
        reservePrice,
        commitWindowSeconds: commitSeconds,
        revealWindowSeconds: revealSeconds,
      };

      const preparedBuyers = await Promise.all(
        BUYERS.map(async (entry) => {
          const nonce = randomNonce(entry.name);
          const commitmentHash = await sha256Hex(`${nextRfq.id}|${entry.name}|${entry.price}|${nonce}`);
          return {
            id: crypto.randomUUID(),
            name: entry.name,
            targetPrice: entry.price,
            complianceTag: entry.complianceTag,
            tamperReveal: Boolean(entry.tamperReveal),
            commitmentHash,
            nonce,
            status: "Waiting" as BuyerStatus,
            committedAt: null,
            revealedAt: null,
            revealedPrice: null,
            revealNonce: null,
            recomputedHash: null,
            hashValid: null,
            qualified: null,
          };
        }),
      );

      setRfq(nextRfq);
      setBuyers(preparedBuyers);
      setEvents([
        {
          id: crypto.randomUUID(),
          at: nowIso(),
          actor: "SellerDesk",
          action: "StartRFQ",
          detail: `RFQ ${nextRfq.id} opened for ${nextRfq.instrument}.`,
        },
      ]);
      setStatus("Round started. Buyer bots are submitting sealed commitments.");

      scheduleCommitments(preparedBuyers, commitSeconds);
      beginPhase("Commit", commitSeconds, () => {
        openRevealWindow(revealSeconds);
      });
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      setPhase("Idle");
      setSecondsLeft(0);
    } finally {
      setBusy(false);
    }
  };

  const resetRound = () => {
    clearPhaseTimers();
    clearActionTimers();
    setPhase("Idle");
    setSecondsLeft(0);
    setRfq(null);
    setBuyers([]);
    setEvents([]);
    setProof(null);
    setStatus(null);
    setError(null);
  };

  const finalizeNow = () => {
    if (phase !== "Reveal") return;
    if (pendingCount > 0) {
      setError("Wait for remaining reveals or timer expiry before finalizing.");
      return;
    }
    void settleRound();
  };

  const exportProof = () => {
    if (!proof) return;
    const blob = new Blob([JSON.stringify(proof, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `dark-auction-proof-${proof.rfqId}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const copyProofHash = async () => {
    if (!proof) return;
    try {
      await navigator.clipboard.writeText(proof.proofHash);
      setStatus("Copied proof hash.");
      setError(null);
    } catch {
      setError("Unable to copy proof hash. Clipboard permission may be blocked.");
    }
  };

  const phaseLabel =
    phase === "Idle"
      ? "Ready"
      : phase === "Commit"
        ? `Commit window (${countdownLabel(secondsLeft)})`
        : phase === "Reveal"
          ? `Reveal window (${countdownLabel(secondsLeft)})`
          : "Settled";

  const phaseColor =
    phase === "Commit"
      ? "border-signal-amber/45 bg-signal-amber/10"
      : phase === "Reveal"
        ? "border-signal-mint/45 bg-signal-mint/10"
        : phase === "Settled"
          ? "border-shell-700/75 bg-shell-900/55"
          : "border-shell-700/75 bg-white";

  return (
    <section className="mt-6 animate-fade-rise space-y-6">
      <article className="rounded-2xl border border-shell-700 bg-white p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-signal-slate">Dark Auction</p>
            <h2 className="mt-1 text-3xl font-semibold text-shell-950">4-Buyer Confidential Auction Race</h2>
            <p className="mt-2 max-w-3xl text-sm text-signal-slate">
              One-click demo flow. Four buyer bots commit hashed bids, reveal against commitments, then issuer settles winner
              with cryptographic proof.
            </p>
          </div>
          <div className={`rounded-xl border px-4 py-3 text-xs text-signal-slate ${phaseColor}`}>
            Phase: <span className="font-semibold text-shell-950">{phaseLabel}</span>
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <label className="text-xs font-semibold uppercase tracking-[0.1em] text-signal-slate">
            Instrument
            <input
              className="mt-1 w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
              value={instrument}
              onChange={(event) => setInstrument(event.target.value)}
              disabled={phase === "Commit" || phase === "Reveal" || busy}
            />
          </label>

          <label className="text-xs font-semibold uppercase tracking-[0.1em] text-signal-slate">
            Quantity
            <input
              className="mt-1 w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
              value={quantityInput}
              onChange={(event) => setQuantityInput(event.target.value)}
              disabled={phase === "Commit" || phase === "Reveal" || busy}
            />
          </label>

          <label className="text-xs font-semibold uppercase tracking-[0.1em] text-signal-slate">
            Reserve
            <input
              className="mt-1 w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
              value={reserveInput}
              onChange={(event) => setReserveInput(event.target.value)}
              disabled={phase === "Commit" || phase === "Reveal" || busy}
            />
          </label>

          <label className="text-xs font-semibold uppercase tracking-[0.1em] text-signal-slate">
            Commit Timer (s)
            <input
              className="mt-1 w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
              value={commitWindowInput}
              onChange={(event) => setCommitWindowInput(event.target.value)}
              disabled={phase === "Commit" || phase === "Reveal" || busy}
            />
          </label>

          <label className="text-xs font-semibold uppercase tracking-[0.1em] text-signal-slate">
            Reveal Timer (s)
            <input
              className="mt-1 w-full rounded-md border border-shell-700 px-3 py-2 text-sm"
              value={revealWindowInput}
              onChange={(event) => setRevealWindowInput(event.target.value)}
              disabled={phase === "Commit" || phase === "Reveal" || busy}
            />
          </label>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            className="rounded-xl bg-shell-950 px-4 py-2 text-sm font-semibold text-shell-900 disabled:opacity-55"
            onClick={() => void startRound()}
            disabled={busy || phase === "Commit" || phase === "Reveal"}
          >
            Start 4-Buyer Race
          </button>
          <button
            className="rounded-xl border border-shell-700 bg-white px-4 py-2 text-sm font-semibold text-shell-950 disabled:opacity-55"
            onClick={finalizeNow}
            disabled={busy || phase !== "Reveal" || pendingCount > 0}
          >
            Finalize Now
          </button>
          <button
            className="rounded-xl border border-shell-700 bg-white px-4 py-2 text-sm font-semibold text-shell-950 disabled:opacity-55"
            onClick={resetRound}
            disabled={busy}
          >
            Reset
          </button>
        </div>

        {rfq ? (
          <p className="mt-3 text-xs text-signal-slate">
            RFQ <span className="font-semibold text-shell-950">{rfq.id}</span> · {rfq.instrument} · qty {rfq.quantity} · reserve {rfq.reservePrice}
          </p>
        ) : null}

        {status ? <p className="mt-4 rounded-lg bg-signal-mint/15 px-3 py-2 text-sm text-shell-950">{status}</p> : null}
        {error ? <p className="mt-4 rounded-lg bg-signal-coral/15 px-3 py-2 text-sm text-signal-coral">{error}</p> : null}
      </article>

      <article className="rounded-2xl border border-shell-700 bg-white p-5">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-signal-slate">Buyer Instances</p>
        <div className="mt-3 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {buyers.map((entry) => (
            <div key={entry.id} className="rounded-xl border border-shell-700/70 bg-shell-900/45 p-4">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-shell-950">{entry.name}</p>
                <span className={`rounded-full border px-2 py-1 text-[11px] font-semibold ${stateBadgeClass(entry.status)}`}>
                  {entry.status}
                </span>
              </div>

              <div className="mt-3 space-y-1 text-xs text-signal-slate">
                <p>
                  Bid: <span className="font-semibold text-shell-950">{entry.status === "Waiting" || entry.status === "Committed" ? "SEALED" : entry.targetPrice}</span>
                </p>
                <p>
                  Compliance: <span className="font-semibold text-shell-950">{entry.complianceTag}</span>
                </p>
                <p>
                  Commitment: <code className="font-mono text-shell-950">{shortHash(entry.commitmentHash)}</code>
                </p>
                <p>
                  Verify: {entry.hashValid === null ? "pending" : entry.hashValid ? "valid hash" : "invalid hash"}
                </p>
                <p>
                  Qualified: {entry.qualified === null ? "pending" : entry.qualified ? "yes" : "no"}
                </p>
                {entry.revealNonce ? (
                  <p>
                    Reveal nonce: <code className="font-mono text-shell-950">{entry.revealNonce}</code>
                  </p>
                ) : null}
              </div>
            </div>
          ))}
          {buyers.length === 0 ? (
            <p className="text-sm text-signal-slate">Start a round to spawn buyer instances.</p>
          ) : null}
        </div>
      </article>

      <div className="grid gap-6 xl:grid-cols-2">
        <article className="rounded-2xl border border-shell-700 bg-white p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-signal-slate">Live Counters</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-4">
            <div className="rounded-xl border border-shell-700/70 bg-shell-900/50 p-3">
              <p className="text-xs uppercase tracking-[0.12em] text-signal-slate">Commitments</p>
              <p className="mt-1 text-2xl font-semibold text-shell-950">{buyers.length}</p>
            </div>
            <div className="rounded-xl border border-shell-700/70 bg-shell-900/50 p-3">
              <p className="text-xs uppercase tracking-[0.12em] text-signal-slate">Pending</p>
              <p className="mt-1 text-2xl font-semibold text-shell-950">{pendingCount}</p>
            </div>
            <div className="rounded-xl border border-shell-700/70 bg-shell-900/50 p-3">
              <p className="text-xs uppercase tracking-[0.12em] text-signal-slate">Qualified</p>
              <p className="mt-1 text-2xl font-semibold text-shell-950">{qualifiedCount}</p>
            </div>
            <div className="rounded-xl border border-shell-700/70 bg-shell-900/50 p-3">
              <p className="text-xs uppercase tracking-[0.12em] text-signal-slate">Disqualified</p>
              <p className="mt-1 text-2xl font-semibold text-shell-950">{disqualifiedCount}</p>
            </div>
          </div>
        </article>

        <article className="rounded-2xl border border-shell-700 bg-white p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-signal-slate">Settlement Proof</p>
          {proof ? (
            <div className="space-y-3">
              <p className="text-sm text-signal-slate">
                Outcome:{" "}
                <span className="font-semibold text-shell-950">
                  {proof.winner ? `${proof.winner} wins at ${proof.winningPrice}` : "No qualified winner"}
                </span>
              </p>
              <div className="rounded-xl border border-shell-700/70 bg-shell-900/55 p-3 text-xs text-signal-slate">
                <p>RFQ: <span className="font-semibold text-shell-950">{proof.rfqId}</span></p>
                <p className="mt-1">Instrument: <span className="font-semibold text-shell-950">{proof.instrument}</span></p>
                <p className="mt-1">Quantity: <span className="font-semibold text-shell-950">{proof.quantity}</span></p>
                <p className="mt-1">Reserve: <span className="font-semibold text-shell-950">{proof.reservePrice}</span></p>
                <p className="mt-1">Qualified bids: <span className="font-semibold text-shell-950">{proof.qualifiedBids}</span></p>
                <p className="mt-1">Disqualified bids: <span className="font-semibold text-shell-950">{proof.disqualifiedBids}</span></p>
                <p className="mt-1">Settled at: <span className="font-semibold text-shell-950">{formatLocal(proof.settledAt)}</span></p>
                <p className="mt-2">Proof hash:</p>
                <code className="mt-1 block break-all font-mono text-shell-950">{proof.proofHash}</code>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  className="rounded-xl border border-shell-700 bg-white px-3 py-2 text-sm font-semibold text-shell-950"
                  onClick={() => void copyProofHash()}
                >
                  Copy Proof Hash
                </button>
                <button
                  className="rounded-xl border border-shell-700 bg-white px-3 py-2 text-sm font-semibold text-shell-950"
                  onClick={exportProof}
                >
                  Download Proof JSON
                </button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-signal-slate">Settlement proof appears automatically once reveal phase completes.</p>
          )}
        </article>
      </div>

      <article className="rounded-2xl border border-shell-700 bg-white p-5">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-signal-slate">Audit Timeline</p>
        <div className="mt-3 space-y-2">
          {events.map((entry) => (
            <div key={entry.id} className="rounded-lg border border-shell-700/70 bg-white/80 px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium text-shell-950">{entry.action} · {entry.actor}</p>
                <span className="text-xs text-signal-slate">{formatLocal(entry.at)}</span>
              </div>
              <p className="text-signal-slate">{entry.detail}</p>
            </div>
          ))}
          {events.length === 0 ? <p className="text-sm text-signal-slate">No events yet.</p> : null}
        </div>
      </article>
    </section>
  );
}
