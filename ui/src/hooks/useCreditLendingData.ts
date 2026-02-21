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

export function useCreditLendingData(): CreditLendingState {
  const [authStatus, setAuthStatus] = useState<AuthStatus>("checking");
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

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      const reachable = await isBackendReachable();
      if (cancelled) return;

      if (!reachable) {
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
  }, []);

  useEffect(() => {
    if (authStatus !== "authenticated") {
      return;
    }
    void loadRealData();
  }, [authStatus, loadRealData]);

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
    const user = await loginSharedSecret(username, password);
    if (!user) {
      return false;
    }
    setCurrentUser(user);
    setWalletUrl(user.walletUrl);
    setAuthStatus("authenticated");
    return true;
  }, []);

  const logout = useCallback(async () => {
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
  }, []);

  const refresh = useCallback(async () => {
    if (authStatus === "authenticated") {
      await loadRealData();
    }
  }, [authStatus, loadRealData]);

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
      await guardedAction("Withdraw loan request", async () => {
        await withdrawLoanRequest(contractId);
      });
    },

    createLoanOffer: async (payload) => {
      await guardedAction("Create loan offer", async () => {
        await createLoanOffer(payload);
      });
    },

    fundLoan: async (offerContractId, creditProfileId) => {
      await guardedAction("Fund loan", async () => {
        await fundLoan(offerContractId, creditProfileId);
      });
    },

    acceptOfferWithToken: async (offerContractId, creditProfileId) => {
      await guardedAction("Accept offer with token", async () => {
        await acceptOfferWithToken(offerContractId, creditProfileId);
      });
    },

    repayLoan: async (loanContractId) => {
      await guardedAction("Repay loan", async () => {
        await repayLoan(loanContractId);
      });
    },

    requestRepayment: async (loanContractId) => {
      await guardedAction("Request repayment", async () => {
        await requestRepayment(loanContractId);
      });
    },

    completeRepayment: async (repaymentRequestId, allocationContractId) => {
      await guardedAction("Complete repayment", async () => {
        await completeLoanRepayment(repaymentRequestId, allocationContractId);
      });
    },

    markLoanDefault: async (loanContractId) => {
      await guardedAction("Mark loan default", async () => {
        await markLoanDefault(loanContractId);
      });
    },

    createLenderBid: async (payload) => {
      await guardedAction("Create lender bid", async () => {
        await createLenderBid(payload);
      }, 3, 2000);
    },

    cancelLenderBid: async (contractId) => {
      await guardedAction("Cancel lender bid", async () => {
        await cancelLenderBid(contractId);
      });
    },

    createBorrowerAsk: async (payload) => {
      await guardedAction("Create borrower ask", async () => {
        await createBorrowerAsk(payload);
      }, 3, 2000);
    },

    cancelBorrowerAsk: async (contractId) => {
      await guardedAction("Cancel borrower ask", async () => {
        await cancelBorrowerAsk(contractId);
      });
    },

    acceptProposal: async (contractId) => {
      await guardedAction("Accept matched proposal", async () => {
        await acceptMatchedProposal(contractId);
      }, 3, 2000);
    },

    rejectProposal: async (contractId) => {
      await guardedAction("Reject matched proposal", async () => {
        await rejectMatchedProposal(contractId);
      });
    },

    confirmFundingIntent: async (intentContractId) => {
      await guardedAction("Confirm funding intent", async () => {
        await confirmFundingIntent(intentContractId);
      });
    },

    completeFunding: async (principalRequestId, allocationContractId) => {
      await guardedAction("Complete funding", async () => {
        await completeLoanFunding(principalRequestId, allocationContractId);
      });
    },
  };
}
