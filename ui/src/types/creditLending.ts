export type AuthStatus = "checking" | "authenticated" | "unauthenticated" | "no-backend";

export interface ApiUser {
  name: string;
  party: string;
  roles: string[];
  isAdmin: boolean;
  walletUrl: string | null;
}

export interface LoanRequest {
  id: string;
  contractId: string;
  borrower: string;
  amount: number;
  interestRate: number;
  duration: number;
  purpose: string;
  status: "open" | "offered" | "funded" | "repaid" | "defaulted";
  createdAt: string;
  offersCount: number;
}

export interface LoanOffer {
  id: string;
  contractId: string;
  lender: string;
  loanRequestId: string;
  amount: number;
  interestRate: number;
  duration: number;
  status: "pending" | "accepted" | "rejected";
  createdAt: string;
}

export interface ActiveLoan {
  id: string;
  contractId: string;
  borrower: string;
  lender: string;
  amount: number;
  interestRate: number;
  duration: number;
  purpose: string;
  status: "active" | "repaid" | "defaulted";
  fundedAt: string;
  dueDate: string;
}

export interface CreditProfile {
  contractId?: string;
  score: number;
  totalLoans: number;
  successfulRepayments: number;
  defaults: number;
  lastUpdated: string;
}

export interface LenderBid {
  id: string;
  contractId: string;
  lender: string;
  amount: number;
  minInterestRate: number;
  maxDuration: number;
  status: "active" | "filled" | "partial" | "cancelled";
  createdAt: string;
  remainingAmount: number;
}

export interface BorrowerAsk {
  id: string;
  contractId: string;
  borrower: string;
  amount: number;
  maxInterestRate: number;
  duration: number;
  status: "active" | "filled" | "cancelled";
  createdAt: string;
}

export interface ApiLoanRequest {
  contractId: string;
  underlyingRequestContractId?: string;
  borrower: string;
  amount: number;
  interestRate: number;
  durationDays: number;
  purpose: string;
  createdAt: string;
}

export interface ApiLoanOffer {
  contractId: string;
  loanRequestId?: string;
  lender: string;
  borrower: string;
  amount: number;
  interestRate: number;
  durationDays?: number;
  createdAt: string;
}

export interface ApiLoan {
  contractId: string;
  lender: string;
  borrower: string;
  principal: number;
  interestRate: number;
  dueDate: string;
  status: "Active" | "Repaid" | "Defaulted";
  durationDays?: number;
  purpose?: string;
  fundedAt?: string;
}

export interface ApiCreditProfile {
  contractId: string;
  borrower: string;
  creditScore: number;
  totalLoans: number;
  successfulLoans: number;
  defaultedLoans: number;
  createdAt?: string;
}

export interface ApiLenderBid {
  contractId: string;
  lender: string;
  amount: number;
  remainingAmount: number;
  minInterestRate: number;
  maxDuration: number;
  createdAt: string;
}

export interface ApiBorrowerAsk {
  contractId: string;
  borrower: string;
  amount: number;
  maxInterestRate: number;
  duration: number;
  createdAt: string;
}

export interface ApiFundingIntent {
  contractId: string;
  requestId: string;
  lender: string;
  borrower: string;
  principal: number;
  interestRate: number;
  durationDays: number;
  prepareUntil: string;
  settleBefore: string;
  requestedAt: string;
  description?: string | null;
  loanRequestId: string;
  offerContractId: string;
  creditProfileId: string;
}

export interface ApiPrincipalRequest {
  contractId: string;
  requestId: string;
  lender: string;
  borrower: string;
  principal: number;
  interestRate: number;
  durationDays: number;
  prepareUntil: string;
  settleBefore: string;
  requestedAt: string;
  description?: string | null;
  loanRequestId: string;
  offerContractId: string;
  creditProfileId: string;
  allocationCid?: string | null;
  prepareDeadlinePassed: boolean;
  settleDeadlinePassed: boolean;
}

export interface ApiRepaymentRequest {
  contractId: string;
  requestId: string;
  lender: string;
  borrower: string;
  repaymentAmount: number;
  prepareUntil: string;
  settleBefore: string;
  requestedAt: string;
  description?: string | null;
  loanContractId: string;
  creditProfileId: string;
  allocationCid?: string | null;
  prepareDeadlinePassed: boolean;
  settleDeadlinePassed: boolean;
}

export interface ApiMatchedProposal {
  contractId: string;
  lender: string;
  borrower: string;
  principal: number;
  interestRate: number;
  durationDays: number;
  matchedAt: string;
}

export interface ApiOrderBookTier {
  interestRate: number;
  duration: number;
  totalAmount: number;
  orderCount: number;
}

export interface ApiOrderBookResponse {
  asks: ApiOrderBookTier[];
  bids: ApiOrderBookTier[];
  spread: number | null;
}

export const mockCreditProfile: CreditProfile = {
  score: 720,
  totalLoans: 8,
  successfulRepayments: 6,
  defaults: 1,
  lastUpdated: "2026-02-19T12:00:00Z",
};
