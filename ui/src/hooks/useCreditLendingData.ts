import { useCallback, useEffect, useState } from "react";
import {
  acceptMatchedProposal,
  acceptOfferWithToken,
  cancelBorrowerAsk,
  cancelLenderBid,
  completeLoanFunding,
  completeLoanRepayment,
  confirmFundingIntent,
  createBorrowerAsk,
  createLenderBid,
  createLoanOffer,
  createLoanRequest,
  fundLoan,
  getCreditProfile,
  getOrderBook,
  getUser,
  isBackendReachable,
  listBorrowerAsks,
  listFundingIntents,
  listLenderBids,
  listLoanOffers,
  listLoanRequests,
  listLoans,
  listMatchedProposals,
  listPrincipalRequests,
  listRepaymentRequests,
  loginSharedSecret,
  logoutUser,
  markLoanDefault,
  rejectMatchedProposal,
  repayLoan,
  requestRepayment,
  withdrawLoanRequest,
} from "../lib/creditLendingApi";
import type {
  ActiveLoan,
  ApiFundingIntent,
  ApiMatchedProposal,
  ApiOrderBookResponse,
  ApiPrincipalRequest,
  ApiRepaymentRequest,
  ApiUser,
  AuthStatus,
  BorrowerAsk,
  CreditProfile,
  LenderBid,
  LoanOffer,
  LoanRequest,
} from "../types/creditLending";
import { mockCreditProfile } from "../types/creditLending";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function makeDemoId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function futureIso(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function computeDemoOrderBook(bids: LenderBid[], asks: BorrowerAsk[]): ApiOrderBookResponse {
  const asksMap = new Map<string, { interestRate: number; duration: number; totalAmount: number; orderCount: number }>();
  const bidsMap = new Map<string, { interestRate: number; duration: number; totalAmount: number; orderCount: number }>();

  for (const bid of bids) {
    const key = `${bid.minInterestRate}|${bid.maxDuration}`;
    const existing = asksMap.get(key);
    if (existing) {
      existing.totalAmount += bid.remainingAmount;
      existing.orderCount += 1;
    } else {
      asksMap.set(key, {
        interestRate: bid.minInterestRate,
        duration: bid.maxDuration,
        totalAmount: bid.remainingAmount,
        orderCount: 1,
      });
    }
  }

  for (const ask of asks) {
    const key = `${ask.maxInterestRate}|${ask.duration}`;
    const existing = bidsMap.get(key);
    if (existing) {
      existing.totalAmount += ask.amount;
      existing.orderCount += 1;
    } else {
      bidsMap.set(key, {
        interestRate: ask.maxInterestRate,
        duration: ask.duration,
        totalAmount: ask.amount,
        orderCount: 1,
      });
    }
  }

  const askRows = Array.from(asksMap.values()).sort((left, right) => right.interestRate - left.interestRate);
  const bidRows = Array.from(bidsMap.values()).sort((left, right) => right.interestRate - left.interestRate);

  const bestAsk = askRows.length ? Math.min(...askRows.map((row) => row.interestRate)) : null;
  const bestBid = bidRows.length ? Math.max(...bidRows.map((row) => row.interestRate)) : null;

  return {
    asks: askRows,
    bids: bidRows,
    spread: bestAsk !== null && bestBid !== null ? bestAsk - bestBid : null,
  };
}

interface DemoSeed {
  user: ApiUser;
  requests: LoanRequest[];
  offers: LoanOffer[];
  loans: ActiveLoan[];
  creditProfile: CreditProfile;
  bids: LenderBid[];
  asks: BorrowerAsk[];
  fundingIntents: ApiFundingIntent[];
  principalRequests: ApiPrincipalRequest[];
  repaymentRequests: ApiRepaymentRequest[];
  matchedProposals: ApiMatchedProposal[];
  orderBook: ApiOrderBookResponse;
}

function buildDemoSeed(party = "demo-user"): DemoSeed {
  const now = new Date().toISOString();

  const requests: LoanRequest[] = [
    {
      id: "demo-req-my",
      contractId: "demo-req-my",
      borrower: party,
      amount: 5000,
      interestRate: 8.5,
      duration: 12,
      purpose: "Working Capital",
      status: "open",
      createdAt: now,
      offersCount: 1,
    },
    {
      id: "demo-req-other",
      contractId: "demo-req-other",
      borrower: "borrower-corp",
      amount: 22000,
      interestRate: 7.6,
      duration: 18,
      purpose: "Equipment financing",
      status: "open",
      createdAt: now,
      offersCount: 1,
    },
  ];

  const offers: LoanOffer[] = [
    {
      id: "demo-offer-my",
      contractId: "demo-offer-my",
      lender: "lender-alpha",
      loanRequestId: "demo-req-my",
      amount: 4800,
      interestRate: 8.0,
      duration: 12,
      status: "pending",
      createdAt: now,
    },
    {
      id: "demo-offer-lender",
      contractId: "demo-offer-lender",
      lender: party,
      loanRequestId: "demo-req-other",
      amount: 15000,
      interestRate: 7.8,
      duration: 18,
      status: "pending",
      createdAt: now,
    },
  ];

  const loans: ActiveLoan[] = [
    {
      id: "demo-loan-my",
      contractId: "demo-loan-my",
      borrower: party,
      lender: "lender-alpha",
      amount: 12000,
      interestRate: 8.1,
      duration: 12,
      purpose: "Inventory bridge",
      status: "active",
      fundedAt: futureIso(-15),
      dueDate: futureIso(75),
    },
    {
      id: "demo-loan-lender",
      contractId: "demo-loan-lender",
      borrower: "borrower-corp",
      lender: party,
      amount: 9000,
      interestRate: 7.4,
      duration: 9,
      purpose: "Receivables finance",
      status: "active",
      fundedAt: futureIso(-10),
      dueDate: futureIso(60),
    },
  ];

  const bids: LenderBid[] = [
    {
      id: "demo-bid-my",
      contractId: "demo-bid-my",
      lender: party,
      amount: 20000,
      remainingAmount: 20000,
      minInterestRate: 6.5,
      maxDuration: 18,
      status: "active",
      createdAt: now,
    },
    {
      id: "demo-bid-market",
      contractId: "demo-bid-market",
      lender: "lender-beta",
      amount: 15000,
      remainingAmount: 9000,
      minInterestRate: 7.2,
      maxDuration: 12,
      status: "partial",
      createdAt: now,
    },
  ];

  const asks: BorrowerAsk[] = [
    {
      id: "demo-ask-my",
      contractId: "demo-ask-my",
      borrower: party,
      amount: 7000,
      maxInterestRate: 8.6,
      duration: 12,
      status: "active",
      createdAt: now,
    },
    {
      id: "demo-ask-market",
      contractId: "demo-ask-market",
      borrower: "borrower-corp",
      amount: 12000,
      maxInterestRate: 7.9,
      duration: 18,
      status: "active",
      createdAt: now,
    },
  ];

  const matchedProposals: ApiMatchedProposal[] = [
    {
      contractId: "demo-match-borrower",
      lender: "lender-beta",
      borrower: party,
      principal: 6000,
      interestRate: 8.2,
      durationDays: 360,
      matchedAt: now,
    },
    {
      contractId: "demo-match-lender",
      lender: party,
      borrower: "borrower-corp",
      principal: 4000,
      interestRate: 7.3,
      durationDays: 270,
      matchedAt: now,
    },
  ];

  const fundingIntents: ApiFundingIntent[] = [
    {
      contractId: "demo-fi-borrower",
      requestId: "req-fi-borrower",
      lender: "lender-beta",
      borrower: party,
      principal: 6000,
      interestRate: 8.2,
      durationDays: 360,
      prepareUntil: futureIso(1),
      settleBefore: futureIso(3),
      requestedAt: now,
      loanRequestId: "demo-req-my",
      offerContractId: "demo-offer-my",
      creditProfileId: `demo-credit-${party}`,
      description: "Demo funding intent",
    },
    {
      contractId: "demo-fi-lender",
      requestId: "req-fi-lender",
      lender: party,
      borrower: "borrower-corp",
      principal: 4000,
      interestRate: 7.3,
      durationDays: 270,
      prepareUntil: futureIso(1),
      settleBefore: futureIso(3),
      requestedAt: now,
      loanRequestId: "demo-req-other",
      offerContractId: "demo-offer-lender",
      creditProfileId: "demo-credit-borrower-corp",
      description: "Demo lender funding intent",
    },
  ];

  const principalRequests: ApiPrincipalRequest[] = [
    {
      contractId: "demo-pr-1",
      requestId: "req-pr-1",
      lender: party,
      borrower: "borrower-corp",
      principal: 4000,
      interestRate: 7.3,
      durationDays: 270,
      prepareUntil: futureIso(1),
      settleBefore: futureIso(3),
      requestedAt: now,
      description: "Demo principal request",
      loanRequestId: "demo-req-other",
      offerContractId: "demo-offer-lender",
      creditProfileId: "demo-credit-borrower-corp",
      allocationCid: null,
      prepareDeadlinePassed: false,
      settleDeadlinePassed: false,
    },
  ];

  const repaymentRequests: ApiRepaymentRequest[] = [
    {
      contractId: "demo-rr-borrower",
      requestId: "req-rr-borrower",
      lender: "lender-alpha",
      borrower: party,
      repaymentAmount: 1500,
      prepareUntil: futureIso(1),
      settleBefore: futureIso(3),
      requestedAt: now,
      description: "Demo borrower repayment",
      loanContractId: "demo-loan-my",
      creditProfileId: `demo-credit-${party}`,
      allocationCid: null,
      prepareDeadlinePassed: false,
      settleDeadlinePassed: false,
    },
    {
      contractId: "demo-rr-lender",
      requestId: "req-rr-lender",
      lender: party,
      borrower: "borrower-corp",
      repaymentAmount: 2000,
      prepareUntil: futureIso(1),
      settleBefore: futureIso(3),
      requestedAt: now,
      description: "Demo lender repayment",
      loanContractId: "demo-loan-lender",
      creditProfileId: "demo-credit-borrower-corp",
      allocationCid: null,
      prepareDeadlinePassed: false,
      settleDeadlinePassed: false,
    },
  ];

  const creditProfile: CreditProfile = {
    contractId: `demo-credit-${party}`,
    score: 724,
    totalLoans: 9,
    successfulRepayments: 7,
    defaults: 1,
    lastUpdated: now,
  };

  const user: ApiUser = {
    name: "Demo User",
    party,
    roles: ["borrower", "lender"],
    isAdmin: true,
    walletUrl: "https://wallet.demo.local",
  };

  return {
    user,
    requests,
    offers,
    loans,
    creditProfile,
    bids,
    asks,
    fundingIntents,
    principalRequests,
    repaymentRequests,
    matchedProposals,
    orderBook: computeDemoOrderBook(bids, asks),
  };
}

export interface CreditLendingState {
  authStatus: AuthStatus;
  currentUser: ApiUser | null;
  walletUrl: string | null;
  setWalletUrl: (value: string | null) => void;

  requests: LoanRequest[];
  offers: LoanOffer[];
  loans: ActiveLoan[];
  creditProfile: CreditProfile;
  bids: LenderBid[];
  asks: BorrowerAsk[];
  orderBook: ApiOrderBookResponse | null;
  fundingIntents: ApiFundingIntent[];
  principalRequests: ApiPrincipalRequest[];
  repaymentRequests: ApiRepaymentRequest[];
  matchedProposals: ApiMatchedProposal[];

  loading: boolean;
  error: string | null;
  clearError: () => void;
  refresh: () => Promise<void>;

  login: (username: string, password?: string) => Promise<boolean>;
  logout: () => Promise<void>;

  createLoanRequest: (payload: { amount: number; interestRate: number; duration: number; purpose: string }) => Promise<void>;
  withdrawLoanRequest: (contractId: string) => Promise<void>;
  createLoanOffer: (payload: { loanRequestId: string; amount: number; interestRate: number; duration: number }) => Promise<void>;
  fundLoan: (offerContractId: string, creditProfileId: string) => Promise<void>;
  acceptOfferWithToken: (offerContractId: string, creditProfileId: string) => Promise<void>;
  repayLoan: (loanContractId: string) => Promise<void>;
  requestRepayment: (loanContractId: string) => Promise<void>;
  completeRepayment: (repaymentRequestId: string, allocationContractId: string) => Promise<void>;
  markLoanDefault: (loanContractId: string) => Promise<void>;

  createLenderBid: (payload: { amount: number; minInterestRate: number; maxDuration: number }) => Promise<void>;
  cancelLenderBid: (contractId: string) => Promise<void>;
  createBorrowerAsk: (payload: { amount: number; maxInterestRate: number; duration: number; creditProfileId: string }) => Promise<void>;
  cancelBorrowerAsk: (contractId: string) => Promise<void>;

  acceptProposal: (contractId: string) => Promise<void>;
  rejectProposal: (contractId: string) => Promise<void>;
  confirmFundingIntent: (intentContractId: string) => Promise<void>;
  completeFunding: (principalRequestId: string, allocationContractId: string) => Promise<void>;
}

interface UseCreditLendingDataOptions {
  forceDemo?: boolean;
}

export function useCreditLendingData(options: UseCreditLendingDataOptions = {}): CreditLendingState {
  const forceDemo = options.forceDemo ?? false;
  const [authStatus, setAuthStatus] = useState<AuthStatus>(forceDemo ? "no-backend" : "checking");
  const [currentUser, setCurrentUser] = useState<ApiUser | null>(null);

  const [requests, setRequests] = useState<LoanRequest[]>([]);
  const [offers, setOffers] = useState<LoanOffer[]>([]);
  const [loans, setLoans] = useState<ActiveLoan[]>([]);
  const [creditProfile, setCreditProfile] = useState<CreditProfile>(mockCreditProfile);
  const [bids, setBids] = useState<LenderBid[]>([]);
  const [asks, setAsks] = useState<BorrowerAsk[]>([]);
  const [orderBook, setOrderBook] = useState<ApiOrderBookResponse | null>(null);
  const [fundingIntents, setFundingIntents] = useState<ApiFundingIntent[]>([]);
  const [principalRequests, setPrincipalRequests] = useState<ApiPrincipalRequest[]>([]);
  const [repaymentRequests, setRepaymentRequests] = useState<ApiRepaymentRequest[]>([]);
  const [matchedProposals, setMatchedProposals] = useState<ApiMatchedProposal[]>([]);

  const [walletUrl, setWalletUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadRealData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const [
        loadedRequests,
        loadedOffers,
        loadedLoans,
        loadedProfile,
        loadedBids,
        loadedAsks,
        loadedBook,
        loadedFundingIntents,
        loadedPrincipalRequests,
        loadedRepaymentRequests,
        loadedMatchedProposals,
      ] = await Promise.all([
        listLoanRequests(),
        listLoanOffers(),
        listLoans(),
        getCreditProfile(),
        listLenderBids(),
        listBorrowerAsks(),
        getOrderBook(),
        listFundingIntents(),
        listPrincipalRequests(),
        listRepaymentRequests(),
        listMatchedProposals(),
      ]);

      const requestsById = new Map(loadedRequests.map((row) => [row.id, row]));
      const enrichedOffers = loadedOffers.map((row) => {
        const request = requestsById.get(row.loanRequestId);
        if (!request) {
          return row;
        }
        return {
          ...row,
          duration: request.duration,
        };
      });

      setRequests(loadedRequests);
      setOffers(enrichedOffers);
      setLoans(loadedLoans);
      setCreditProfile(loadedProfile ?? mockCreditProfile);
      setBids(loadedBids);
      setAsks(loadedAsks);
      setOrderBook(loadedBook);
      setFundingIntents(loadedFundingIntents);
      setPrincipalRequests(loadedPrincipalRequests);
      setRepaymentRequests(loadedRepaymentRequests);
      setMatchedProposals(loadedMatchedProposals);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshWithRetry = useCallback(
    async (attempts = 3, delayMs = 1500) => {
      for (let index = 0; index < attempts; index += 1) {
        await wait(delayMs);
        await loadRealData();
      }
    },
    [loadRealData],
  );

  const seedDemoData = useCallback((party = "demo-user") => {
    const seed = buildDemoSeed(party);
    setCurrentUser(seed.user);
    setWalletUrl(seed.user.walletUrl);
    setRequests(seed.requests);
    setOffers(seed.offers);
    setLoans(seed.loans);
    setCreditProfile(seed.creditProfile);
    setBids(seed.bids);
    setAsks(seed.asks);
    setOrderBook(seed.orderBook);
    setFundingIntents(seed.fundingIntents);
    setPrincipalRequests(seed.principalRequests);
    setRepaymentRequests(seed.repaymentRequests);
    setMatchedProposals(seed.matchedProposals);
    setError(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      if (forceDemo) {
        seedDemoData();
        setAuthStatus("no-backend");
        return;
      }

      const reachable = await isBackendReachable();
      if (cancelled) return;

      if (!reachable) {
        seedDemoData();
        setAuthStatus("no-backend");
        return;
      }

      const user = await getUser();
      if (cancelled) return;

      if (user) {
        setCurrentUser(user);
        setWalletUrl(user.walletUrl);
        setAuthStatus("authenticated");
      } else {
        setAuthStatus("unauthenticated");
      }
    }

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, [forceDemo, seedDemoData]);

  useEffect(() => {
    if (authStatus !== "authenticated" || forceDemo) {
      return;
    }
    void loadRealData();
  }, [authStatus, forceDemo, loadRealData]);

  const guardedAction = useCallback(
    async (label: string, operation: () => Promise<void>, attempts = 2, delayMs = 1500) => {
      setError(null);
      try {
        await operation();
        await refreshWithRetry(attempts, delayMs);
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        setError(`${label} failed: ${message}`);
        throw reason;
      }
    },
    [refreshWithRetry],
  );

  const login = useCallback(async (username: string, password = ""): Promise<boolean> => {
    if (forceDemo || authStatus === "no-backend") {
      seedDemoData(username.trim() || "demo-user");
      setAuthStatus("no-backend");
      return true;
    }

    const user = await loginSharedSecret(username, password);
    if (!user) {
      return false;
    }
    setCurrentUser(user);
    setWalletUrl(user.walletUrl);
    setAuthStatus("authenticated");
    return true;
  }, [authStatus, forceDemo, seedDemoData]);

  const logout = useCallback(async () => {
    if (authStatus === "authenticated" && !forceDemo) {
      await logoutUser();
      setCurrentUser(null);
      setAuthStatus("unauthenticated");
      setRequests([]);
      setOffers([]);
      setLoans([]);
      setCreditProfile(mockCreditProfile);
      setBids([]);
      setAsks([]);
      setOrderBook(null);
      setFundingIntents([]);
      setPrincipalRequests([]);
      setRepaymentRequests([]);
      setMatchedProposals([]);
      setError(null);
      return;
    }

    seedDemoData(currentUser?.party ?? "demo-user");
    setAuthStatus("no-backend");
  }, [authStatus, currentUser?.party, forceDemo, seedDemoData]);

  const refresh = useCallback(async () => {
    if (authStatus === "authenticated" && !forceDemo) {
      await loadRealData();
      return;
    }
    setOrderBook(computeDemoOrderBook(bids, asks));
    setError(null);
  }, [asks, authStatus, bids, forceDemo, loadRealData]);

  const isDemo = forceDemo || authStatus !== "authenticated";
  const demoParty = currentUser?.party ?? "demo-user";

  return {
    authStatus,
    currentUser,
    walletUrl,
    setWalletUrl,

    requests,
    offers,
    loans,
    creditProfile,
    bids,
    asks,
    orderBook,
    fundingIntents,
    principalRequests,
    repaymentRequests,
    matchedProposals,

    loading,
    error,
    clearError: () => setError(null),
    refresh,

    login,
    logout,

    createLoanRequest: async (payload) => {
      if (isDemo) {
        const now = new Date().toISOString();
        const requestId = makeDemoId("demo-req");
        const newRequest: LoanRequest = {
          id: requestId,
          contractId: requestId,
          borrower: demoParty,
          amount: payload.amount,
          interestRate: payload.interestRate,
          duration: payload.duration,
          purpose: payload.purpose,
          status: "open",
          createdAt: now,
          offersCount: 0,
        };
        const askId = makeDemoId("demo-ask");
        const newAsk: BorrowerAsk = {
          id: askId,
          contractId: askId,
          borrower: demoParty,
          amount: payload.amount,
          maxInterestRate: payload.interestRate,
          duration: payload.duration,
          status: "active",
          createdAt: now,
        };
        const nextRequests = [newRequest, ...requests];
        const nextAsks = [newAsk, ...asks];
        setRequests(nextRequests);
        setAsks(nextAsks);
        setOrderBook(computeDemoOrderBook(bids, nextAsks));
        setCreditProfile((prev) => ({
          ...prev,
          contractId: prev.contractId ?? `demo-credit-${demoParty}`,
          lastUpdated: now,
        }));
        return;
      }

      await guardedAction("Create loan request", async () => {
        await createLoanRequest(payload);

        try {
          let profileId = creditProfile.contractId;
          if (!profileId) {
            const fresh = await getCreditProfile();
            profileId = fresh?.contractId;
          }

          if (profileId) {
            await createBorrowerAsk({
              amount: payload.amount,
              maxInterestRate: payload.interestRate,
              duration: payload.duration,
              creditProfileId: profileId,
            });
          }
        } catch {
          // Ignore secondary ask placement failures; request creation already succeeded.
        }
      }, 3, 2000);
    },

    withdrawLoanRequest: async (contractId) => {
      if (isDemo) {
        const matched = requests.find((row) => row.contractId === contractId || row.id === contractId);
        const targetRequestId = matched?.contractId ?? contractId;
        setRequests((prev) => prev.filter((row) => row.contractId !== targetRequestId && row.id !== targetRequestId));
        setOffers((prev) => prev.filter((row) => row.loanRequestId !== targetRequestId));
        return;
      }

      await guardedAction("Withdraw loan request", async () => {
        await withdrawLoanRequest(contractId);
      });
    },

    createLoanOffer: async (payload) => {
      if (isDemo) {
        const targetRequest = requests.find(
          (row) => row.contractId === payload.loanRequestId || row.id === payload.loanRequestId,
        );
        if (!targetRequest) {
          throw new Error("Loan request not found.");
        }
        const now = new Date().toISOString();
        const offerId = makeDemoId("demo-offer");
        const newOffer: LoanOffer = {
          id: offerId,
          contractId: offerId,
          lender: demoParty,
          loanRequestId: targetRequest.contractId,
          amount: payload.amount,
          interestRate: payload.interestRate,
          duration: payload.duration,
          status: "pending",
          createdAt: now,
        };
        setOffers((prev) => [newOffer, ...prev]);
        setRequests((prev) => prev.map((row) => (
          row.contractId === targetRequest.contractId
            ? { ...row, offersCount: row.offersCount + 1, status: "offered" }
            : row
        )));
        return;
      }

      await guardedAction("Create loan offer", async () => {
        await createLoanOffer(payload);
      });
    },

    fundLoan: async (offerContractId, creditProfileId) => {
      if (isDemo) {
        const offer = offers.find((row) => row.contractId === offerContractId);
        if (!offer) throw new Error("Offer not found.");
        const request = requests.find((row) => row.contractId === offer.loanRequestId || row.id === offer.loanRequestId);
        const now = new Date().toISOString();
        const loanId = makeDemoId("demo-loan");
        const dueDate = futureIso(Math.max(30, offer.duration * 30));

        const newLoan: ActiveLoan = {
          id: loanId,
          contractId: loanId,
          borrower: request?.borrower ?? demoParty,
          lender: offer.lender,
          amount: offer.amount,
          interestRate: offer.interestRate,
          duration: offer.duration,
          purpose: request?.purpose ?? "Funded Loan",
          status: "active",
          fundedAt: now,
          dueDate,
        };

        setOffers((prev) => prev.map((row) => (
          row.contractId === offerContractId ? { ...row, status: "accepted" } : row
        )));
        setRequests((prev) => prev.map((row) => (
          row.contractId === offer.loanRequestId ? { ...row, status: "funded" } : row
        )));
        setLoans((prev) => [newLoan, ...prev]);
        setCreditProfile((prev) => ({
          ...prev,
          contractId: creditProfileId || prev.contractId || `demo-credit-${demoParty}`,
          totalLoans: prev.totalLoans + 1,
          lastUpdated: now,
        }));
        return;
      }

      await guardedAction("Fund loan", async () => {
        await fundLoan(offerContractId, creditProfileId);
      });
    },

    acceptOfferWithToken: async (offerContractId, creditProfileId) => {
      if (isDemo) {
        const offer = offers.find((row) => row.contractId === offerContractId);
        if (!offer) throw new Error("Offer not found.");
        const request = requests.find((row) => row.contractId === offer.loanRequestId || row.id === offer.loanRequestId);
        const now = new Date().toISOString();
        const intent: ApiFundingIntent = {
          contractId: makeDemoId("demo-fi"),
          requestId: makeDemoId("req-fi"),
          lender: offer.lender,
          borrower: request?.borrower ?? demoParty,
          principal: offer.amount,
          interestRate: offer.interestRate,
          durationDays: Math.max(30, offer.duration * 30),
          prepareUntil: futureIso(1),
          settleBefore: futureIso(3),
          requestedAt: now,
          description: "Demo token funding intent",
          loanRequestId: offer.loanRequestId,
          offerContractId: offer.contractId,
          creditProfileId,
        };
        setFundingIntents((prev) => [intent, ...prev]);
        return;
      }

      await guardedAction("Accept offer with token", async () => {
        await acceptOfferWithToken(offerContractId, creditProfileId);
      });
    },

    repayLoan: async (loanContractId) => {
      if (isDemo) {
        const now = new Date().toISOString();
        setLoans((prev) => prev.map((row) => (
          row.contractId === loanContractId ? { ...row, status: "repaid" } : row
        )));
        setCreditProfile((prev) => ({
          ...prev,
          successfulRepayments: prev.successfulRepayments + 1,
          lastUpdated: now,
        }));
        return;
      }

      await guardedAction("Repay loan", async () => {
        await repayLoan(loanContractId);
      });
    },

    requestRepayment: async (loanContractId) => {
      if (isDemo) {
        const loan = loans.find((row) => row.contractId === loanContractId);
        if (!loan) throw new Error("Loan not found.");
        const now = new Date().toISOString();
        const requestAmount = Math.max(250, Math.round(loan.amount * 0.2));
        const repaymentRequest: ApiRepaymentRequest = {
          contractId: makeDemoId("demo-rr"),
          requestId: makeDemoId("req-rr"),
          lender: loan.lender,
          borrower: loan.borrower,
          repaymentAmount: requestAmount,
          prepareUntil: futureIso(1),
          settleBefore: futureIso(3),
          requestedAt: now,
          description: "Demo repayment request",
          loanContractId: loan.contractId,
          creditProfileId: creditProfile.contractId ?? `demo-credit-${loan.borrower}`,
          allocationCid: null,
          prepareDeadlinePassed: false,
          settleDeadlinePassed: false,
        };
        setRepaymentRequests((prev) => [repaymentRequest, ...prev]);
        return;
      }

      await guardedAction("Request repayment", async () => {
        await requestRepayment(loanContractId);
      });
    },

    completeRepayment: async (repaymentRequestId, allocationContractId) => {
      if (isDemo) {
        const target = repaymentRequests.find((row) => row.contractId === repaymentRequestId);
        if (!target) throw new Error("Repayment request not found.");
        const now = new Date().toISOString();
        setRepaymentRequests((prev) => prev.filter((row) => row.contractId !== repaymentRequestId));
        setLoans((prev) => prev.map((row) => (
          row.contractId === target.loanContractId ? { ...row, status: "repaid" } : row
        )));
        setCreditProfile((prev) => ({
          ...prev,
          successfulRepayments: prev.successfulRepayments + 1,
          lastUpdated: now,
        }));
        void allocationContractId;
        return;
      }

      await guardedAction("Complete repayment", async () => {
        await completeLoanRepayment(repaymentRequestId, allocationContractId);
      });
    },

    markLoanDefault: async (loanContractId) => {
      if (isDemo) {
        const now = new Date().toISOString();
        setLoans((prev) => prev.map((row) => (
          row.contractId === loanContractId ? { ...row, status: "defaulted" } : row
        )));
        setCreditProfile((prev) => ({
          ...prev,
          defaults: prev.defaults + 1,
          lastUpdated: now,
        }));
        return;
      }

      await guardedAction("Mark loan default", async () => {
        await markLoanDefault(loanContractId);
      });
    },

    createLenderBid: async (payload) => {
      if (isDemo) {
        const now = new Date().toISOString();
        const newBid: LenderBid = {
          id: makeDemoId("demo-bid"),
          contractId: makeDemoId("demo-bid"),
          lender: demoParty,
          amount: payload.amount,
          remainingAmount: payload.amount,
          minInterestRate: payload.minInterestRate,
          maxDuration: payload.maxDuration,
          status: "active",
          createdAt: now,
        };
        const nextBids = [newBid, ...bids];
        setBids(nextBids);
        setOrderBook(computeDemoOrderBook(nextBids, asks));
        return;
      }

      await guardedAction("Create lender bid", async () => {
        await createLenderBid(payload);
      }, 3, 2000);
    },

    cancelLenderBid: async (contractId) => {
      if (isDemo) {
        const nextBids = bids.filter((row) => row.contractId !== contractId);
        setBids(nextBids);
        setOrderBook(computeDemoOrderBook(nextBids, asks));
        return;
      }

      await guardedAction("Cancel lender bid", async () => {
        await cancelLenderBid(contractId);
      });
    },

    createBorrowerAsk: async (payload) => {
      if (isDemo) {
        const now = new Date().toISOString();
        const newAsk: BorrowerAsk = {
          id: makeDemoId("demo-ask"),
          contractId: makeDemoId("demo-ask"),
          borrower: demoParty,
          amount: payload.amount,
          maxInterestRate: payload.maxInterestRate,
          duration: payload.duration,
          status: "active",
          createdAt: now,
        };
        const nextAsks = [newAsk, ...asks];
        setAsks(nextAsks);
        setOrderBook(computeDemoOrderBook(bids, nextAsks));
        void payload.creditProfileId;
        return;
      }

      await guardedAction("Create borrower ask", async () => {
        await createBorrowerAsk(payload);
      }, 3, 2000);
    },

    cancelBorrowerAsk: async (contractId) => {
      if (isDemo) {
        const nextAsks = asks.filter((row) => row.contractId !== contractId);
        setAsks(nextAsks);
        setOrderBook(computeDemoOrderBook(bids, nextAsks));
        return;
      }

      await guardedAction("Cancel borrower ask", async () => {
        await cancelBorrowerAsk(contractId);
      });
    },

    acceptProposal: async (contractId) => {
      if (isDemo) {
        const proposal = matchedProposals.find((row) => row.contractId === contractId);
        if (!proposal) throw new Error("Matched proposal not found.");
        const now = new Date().toISOString();
        const loanId = makeDemoId("demo-loan");
        const durationMonths = Math.max(1, Math.round(proposal.durationDays / 30));
        const newLoan: ActiveLoan = {
          id: loanId,
          contractId: loanId,
          borrower: proposal.borrower,
          lender: proposal.lender,
          amount: proposal.principal,
          interestRate: proposal.interestRate,
          duration: durationMonths,
          purpose: "Matched proposal funding",
          status: "active",
          fundedAt: now,
          dueDate: futureIso(durationMonths * 30),
        };
        setMatchedProposals((prev) => prev.filter((row) => row.contractId !== contractId));
        setLoans((prev) => [newLoan, ...prev]);
        if (proposal.borrower === demoParty) {
          setCreditProfile((prev) => ({
            ...prev,
            totalLoans: prev.totalLoans + 1,
            lastUpdated: now,
          }));
        }
        return;
      }

      await guardedAction("Accept matched proposal", async () => {
        await acceptMatchedProposal(contractId);
      }, 3, 2000);
    },

    rejectProposal: async (contractId) => {
      if (isDemo) {
        setMatchedProposals((prev) => prev.filter((row) => row.contractId !== contractId));
        return;
      }

      await guardedAction("Reject matched proposal", async () => {
        await rejectMatchedProposal(contractId);
      });
    },

    confirmFundingIntent: async (intentContractId) => {
      if (isDemo) {
        const target = fundingIntents.find((row) => row.contractId === intentContractId);
        if (!target) throw new Error("Funding intent not found.");
        const principalRequest: ApiPrincipalRequest = {
          contractId: makeDemoId("demo-pr"),
          requestId: target.requestId,
          lender: target.lender,
          borrower: target.borrower,
          principal: target.principal,
          interestRate: target.interestRate,
          durationDays: target.durationDays,
          prepareUntil: target.prepareUntil,
          settleBefore: target.settleBefore,
          requestedAt: target.requestedAt,
          description: target.description,
          loanRequestId: target.loanRequestId,
          offerContractId: target.offerContractId,
          creditProfileId: target.creditProfileId,
          allocationCid: null,
          prepareDeadlinePassed: false,
          settleDeadlinePassed: false,
        };
        setFundingIntents((prev) => prev.filter((row) => row.contractId !== intentContractId));
        setPrincipalRequests((prev) => [principalRequest, ...prev]);
        return;
      }

      await guardedAction("Confirm funding intent", async () => {
        await confirmFundingIntent(intentContractId);
      });
    },

    completeFunding: async (principalRequestId, allocationContractId) => {
      if (isDemo) {
        const target = principalRequests.find((row) => row.contractId === principalRequestId);
        if (!target) throw new Error("Principal request not found.");
        const now = new Date().toISOString();
        const loanId = makeDemoId("demo-loan");
        const durationMonths = Math.max(1, Math.round(target.durationDays / 30));
        const newLoan: ActiveLoan = {
          id: loanId,
          contractId: loanId,
          borrower: target.borrower,
          lender: target.lender,
          amount: target.principal,
          interestRate: target.interestRate,
          duration: durationMonths,
          purpose: "Token-funded loan",
          status: "active",
          fundedAt: now,
          dueDate: futureIso(durationMonths * 30),
        };

        setPrincipalRequests((prev) => prev.filter((row) => row.contractId !== principalRequestId));
        setLoans((prev) => [newLoan, ...prev]);
        setRequests((prev) => prev.map((row) => (
          row.contractId === target.loanRequestId ? { ...row, status: "funded" } : row
        )));
        setOffers((prev) => prev.map((row) => (
          row.contractId === target.offerContractId ? { ...row, status: "accepted" } : row
        )));
        if (target.borrower === demoParty) {
          setCreditProfile((prev) => ({
            ...prev,
            totalLoans: prev.totalLoans + 1,
            lastUpdated: now,
          }));
        }
        void allocationContractId;
        return;
      }

      await guardedAction("Complete funding", async () => {
        await completeLoanFunding(principalRequestId, allocationContractId);
      });
    },
  };
}
