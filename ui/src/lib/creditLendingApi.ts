import type {
  ActiveLoan,
  ApiBorrowerAsk,
  ApiCreditProfile,
  ApiFundingIntent,
  ApiLenderBid,
  ApiLoan,
  ApiLoanOffer,
  ApiLoanRequest,
  ApiMatchedProposal,
  ApiOrderBookResponse,
  ApiPrincipalRequest,
  ApiRepaymentRequest,
  ApiUser,
  BorrowerAsk,
  CreditProfile,
  LenderBid,
  LoanOffer,
  LoanRequest,
} from "../types/creditLending";

const API_BASE = import.meta.env.VITE_CREDIT_LENDING_API_URL ?? "/api";
const AUTH_BASE = import.meta.env.VITE_CREDIT_LENDING_AUTH_BASE ?? "";

function daysToMonths(days: number): number {
  return Math.round(days / 30) || 1;
}

function monthsToDays(months: number): number {
  return months * 30;
}

function commandId(): string {
  return `credit-lending-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function authPath(path: string): string {
  return `${AUTH_BASE}${path}`;
}

function mapLoanRequest(row: ApiLoanRequest, offersCount = 0): LoanRequest {
  const requestId = row.underlyingRequestContractId || row.contractId;
  return {
    id: requestId,
    contractId: row.contractId,
    borrower: row.borrower,
    amount: row.amount,
    interestRate: row.interestRate,
    duration: daysToMonths(row.durationDays),
    purpose: row.purpose,
    status: "open",
    createdAt: row.createdAt,
    offersCount,
  };
}

function mapLoanOffer(row: ApiLoanOffer): LoanOffer {
  return {
    id: row.contractId,
    contractId: row.contractId,
    lender: row.lender,
    loanRequestId: row.loanRequestId || "",
    amount: row.amount,
    interestRate: row.interestRate,
    duration: row.durationDays != null ? daysToMonths(row.durationDays) : 0,
    status: "pending",
    createdAt: row.createdAt,
  };
}

function mapLoan(row: ApiLoan): ActiveLoan {
  const status = row.status === "Active" ? "active" : row.status === "Repaid" ? "repaid" : "defaulted";
  return {
    id: row.contractId,
    contractId: row.contractId,
    borrower: row.borrower,
    lender: row.lender,
    amount: row.principal,
    interestRate: row.interestRate,
    duration: row.durationDays ? daysToMonths(row.durationDays) : 0,
    purpose: row.purpose || "",
    status,
    fundedAt: row.fundedAt || row.dueDate,
    dueDate: row.dueDate,
  };
}

function mapCreditProfile(row: ApiCreditProfile): CreditProfile {
  return {
    contractId: row.contractId,
    score: row.creditScore,
    totalLoans: row.totalLoans,
    successfulRepayments: row.successfulLoans,
    defaults: row.defaultedLoans,
    lastUpdated: row.createdAt || new Date().toISOString(),
  };
}

function mapLenderBid(row: ApiLenderBid): LenderBid {
  return {
    id: row.contractId,
    contractId: row.contractId,
    lender: row.lender,
    amount: row.amount,
    remainingAmount: row.remainingAmount,
    minInterestRate: row.minInterestRate,
    maxDuration: daysToMonths(row.maxDuration),
    status: row.remainingAmount <= 0 ? "filled" : row.remainingAmount < row.amount ? "partial" : "active",
    createdAt: row.createdAt,
  };
}

function mapBorrowerAsk(row: ApiBorrowerAsk): BorrowerAsk {
  return {
    id: row.contractId,
    contractId: row.contractId,
    borrower: row.borrower,
    amount: row.amount,
    maxInterestRate: row.maxInterestRate,
    duration: daysToMonths(row.duration),
    status: "active",
    createdAt: row.createdAt,
  };
}

async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`API ${path}: ${response.status} ${message}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

async function postApi<T>(path: string, body?: object): Promise<T> {
  return fetchApi<T>(path, {
    method: "POST",
    body: body ? JSON.stringify(body) : undefined,
  });
}

export async function isBackendReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/user`, {
      credentials: "include",
      method: "GET",
    });
    return response.status === 200 || response.status === 401;
  } catch {
    return false;
  }
}

export async function getUser(): Promise<ApiUser | null> {
  try {
    const response = await fetch(`${API_BASE}/user`, { credentials: "include" });
    if (response.status === 401 || response.status === 403) {
      return null;
    }
    if (!response.ok) {
      return null;
    }
    return response.json() as Promise<ApiUser>;
  } catch {
    return null;
  }
}

export async function loginSharedSecret(username: string, password = ""): Promise<ApiUser | null> {
  const body = new URLSearchParams({ username, password });
  try {
    await fetch(authPath("/login/shared-secret"), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      redirect: "manual",
    });
    return getUser();
  } catch {
    return null;
  }
}

export async function logoutUser(): Promise<void> {
  try {
    await fetch(authPath("/logout"), {
      method: "POST",
      credentials: "include",
      redirect: "manual",
    });
  } catch {
    // no-op
  }
}

export async function listLoanRequests(): Promise<LoanRequest[]> {
  const requests = await fetchApi<ApiLoanRequest[]>("/loan-requests");
  const offers = await listLoanOffers();

  const offersByRequest = new Map<string, number>();
  for (const offer of offers) {
    const key = offer.loanRequestId || "";
    offersByRequest.set(key, (offersByRequest.get(key) || 0) + 1);
  }

  return (requests || []).map((row) => {
    const count = offersByRequest.get(row.contractId)
      || offersByRequest.get(row.underlyingRequestContractId || "")
      || 0;
    return mapLoanRequest(row, count);
  });
}

export async function listLoanOffers(): Promise<LoanOffer[]> {
  const rows = await fetchApi<ApiLoanOffer[]>("/loan-offers");
  return (rows || []).map(mapLoanOffer);
}

export async function listLoans(): Promise<ActiveLoan[]> {
  const rows = await fetchApi<ApiLoan[]>("/loans");
  return (rows || []).map(mapLoan);
}

export async function getCreditProfile(): Promise<CreditProfile | null> {
  try {
    const row = await fetchApi<ApiCreditProfile>("/credit-profile");
    return mapCreditProfile(row);
  } catch (reason) {
    if (reason instanceof Error && (reason.message.includes("404") || reason.message.includes("NotFound"))) {
      return null;
    }
    throw reason;
  }
}

export async function listLenderBids(): Promise<LenderBid[]> {
  try {
    const rows = await fetchApi<ApiLenderBid[]>("/market/lender-bids");
    return (rows || []).map(mapLenderBid);
  } catch {
    return [];
  }
}

export async function listBorrowerAsks(): Promise<BorrowerAsk[]> {
  try {
    const rows = await fetchApi<ApiBorrowerAsk[]>("/market/borrower-asks");
    return (rows || []).map(mapBorrowerAsk);
  } catch {
    return [];
  }
}

export async function getOrderBook(): Promise<ApiOrderBookResponse | null> {
  try {
    return await fetchApi<ApiOrderBookResponse>("/orderbook");
  } catch {
    return null;
  }
}

export async function listFundingIntents(): Promise<ApiFundingIntent[]> {
  try {
    return await fetchApi<ApiFundingIntent[]>("/loans/funding-intents");
  } catch {
    return [];
  }
}

export async function listPrincipalRequests(): Promise<ApiPrincipalRequest[]> {
  try {
    return await fetchApi<ApiPrincipalRequest[]>("/loans/principal-requests");
  } catch {
    return [];
  }
}

export async function listRepaymentRequests(): Promise<ApiRepaymentRequest[]> {
  try {
    return await fetchApi<ApiRepaymentRequest[]>("/loans/repayment-requests");
  } catch {
    return [];
  }
}

export async function listMatchedProposals(): Promise<ApiMatchedProposal[]> {
  try {
    return await fetchApi<ApiMatchedProposal[]>("/market/matched-proposals");
  } catch {
    return [];
  }
}

export async function createLoanRequest(payload: {
  amount: number;
  interestRate: number;
  duration: number;
  purpose: string;
}): Promise<LoanRequest> {
  const body = {
    amount: payload.amount,
    interestRate: payload.interestRate,
    durationDays: monthsToDays(payload.duration),
    purpose: payload.purpose,
  };

  const row = await postApi<ApiLoanRequest>(`/loans/request?commandId=${encodeURIComponent(commandId())}`, body);
  return mapLoanRequest(row, 0);
}

export async function withdrawLoanRequest(contractId: string): Promise<void> {
  await fetchApi(`/loans/requests/${encodeURIComponent(contractId)}?commandId=${encodeURIComponent(commandId())}`, {
    method: "DELETE",
  });
}

export async function createLoanOffer(payload: {
  loanRequestId: string;
  amount: number;
  interestRate: number;
  duration: number;
}): Promise<LoanOffer> {
  const body = {
    loanRequestId: payload.loanRequestId,
    amount: payload.amount,
    interestRate: payload.interestRate,
    durationDays: monthsToDays(payload.duration),
  };

  const row = await postApi<ApiLoanOffer>(`/loans/offer?commandId=${encodeURIComponent(commandId())}`, body);
  return mapLoanOffer(row);
}

export async function fundLoan(offerContractId: string, creditProfileId: string): Promise<{ loanId: string }> {
  return postApi<{ loanId: string }>(
    `/loans/offers/${encodeURIComponent(offerContractId)}/fund?commandId=${encodeURIComponent(commandId())}`,
    { creditProfileId },
  );
}

export async function acceptOfferWithToken(
  offerContractId: string,
  creditProfileId: string,
): Promise<{ fundingIntentId: string }> {
  return postApi<{ fundingIntentId: string }>(
    `/loans/offer/${encodeURIComponent(offerContractId)}:accept-with-token?commandId=${encodeURIComponent(commandId())}`,
    { creditProfileId },
  );
}

export async function confirmFundingIntent(intentContractId: string): Promise<{ principalRequestId: string }> {
  return postApi<{ principalRequestId: string }>(
    `/loans/funding-intent/${encodeURIComponent(intentContractId)}:confirm?commandId=${encodeURIComponent(commandId())}`,
  );
}

export async function completeLoanFunding(
  principalRequestId: string,
  allocationContractId: string,
): Promise<{ loanId: string }> {
  return postApi<{ loanId: string }>(
    `/loans/principal-requests/${encodeURIComponent(principalRequestId)}:complete-funding?commandId=${encodeURIComponent(commandId())}`,
    { allocationContractId },
  );
}

export async function repayLoan(loanContractId: string): Promise<void> {
  await postApi(`/loans/${encodeURIComponent(loanContractId)}/repay?commandId=${encodeURIComponent(commandId())}`);
}

export async function requestRepayment(loanContractId: string): Promise<{ repaymentRequestId: string }> {
  return postApi<{ repaymentRequestId: string }>(
    `/loans/${encodeURIComponent(loanContractId)}:request-repayment?commandId=${encodeURIComponent(commandId())}`,
    {},
  );
}

export async function completeLoanRepayment(
  repaymentRequestId: string,
  allocationContractId: string,
): Promise<{ creditProfileId: string }> {
  return postApi<{ creditProfileId: string }>(
    `/loans/repayment-requests/${encodeURIComponent(repaymentRequestId)}:complete-repayment?commandId=${encodeURIComponent(commandId())}`,
    { allocationContractId },
  );
}

export async function markLoanDefault(loanContractId: string): Promise<void> {
  await postApi(`/loans/${encodeURIComponent(loanContractId)}:mark-default?commandId=${encodeURIComponent(commandId())}`);
}

export async function createLenderBid(payload: {
  amount: number;
  minInterestRate: number;
  maxDuration: number;
}): Promise<LenderBid> {
  const body = {
    amount: payload.amount,
    minInterestRate: payload.minInterestRate,
    maxDuration: monthsToDays(payload.maxDuration),
  };
  const row = await postApi<ApiLenderBid>(`/market/lender-bids?commandId=${encodeURIComponent(commandId())}`, body);
  return mapLenderBid(row);
}

export async function cancelLenderBid(contractId: string): Promise<void> {
  await fetchApi(`/market/lender-bids/${encodeURIComponent(contractId)}?commandId=${encodeURIComponent(commandId())}`, {
    method: "DELETE",
  });
}

export async function createBorrowerAsk(payload: {
  amount: number;
  maxInterestRate: number;
  duration: number;
  creditProfileId: string;
}): Promise<BorrowerAsk> {
  const body = {
    amount: payload.amount,
    maxInterestRate: payload.maxInterestRate,
    duration: monthsToDays(payload.duration),
    creditProfileId: payload.creditProfileId,
  };
  const row = await postApi<ApiBorrowerAsk>(`/market/borrower-asks?commandId=${encodeURIComponent(commandId())}`, body);
  return mapBorrowerAsk(row);
}

export async function cancelBorrowerAsk(contractId: string): Promise<void> {
  await fetchApi(`/market/borrower-asks/${encodeURIComponent(contractId)}?commandId=${encodeURIComponent(commandId())}`, {
    method: "DELETE",
  });
}

export async function acceptMatchedProposal(contractId: string): Promise<{ loanId: string }> {
  return postApi<{ loanId: string }>(
    `/market/matched-proposals/${encodeURIComponent(contractId)}:accept?commandId=${encodeURIComponent(commandId())}`,
  );
}

export async function rejectMatchedProposal(contractId: string): Promise<void> {
  await postApi(
    `/market/matched-proposals/${encodeURIComponent(contractId)}:reject?commandId=${encodeURIComponent(commandId())}`,
  );
}
