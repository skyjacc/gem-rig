export type CandidateStatus = 'fresh' | 'stale' | 'unknown';
export type CandidateEvidence = 'steam' | 'market' | 'text-only';

export interface Candidate {
  id: string;
  name: string;
  hero: string;
  market: string;
  gem: string;
  /** Fictional RUB price; never a live quote. */
  price: number;
  exitPrice: number | null;
  /** Fixture fee percentage; evaluateCandidate uses the explicit scenario override. */
  fee: number;
  extraction: number | null;
  ageMinutes: number;
  status: CandidateStatus;
  evidence: CandidateEvidence;
  description: string;
}

export interface SourceFixture {
  id: string;
  name: string;
  role: string;
  status: 'ok' | 'stale' | 'error';
  ageMinutes: number;
  coverage: string;
  detail: string;
}

export interface EvaluationOptions {
  feePercent: number;
  extractionCost: number;
}

export interface CandidateEvaluation {
  /** RUB, rounded to kopecks. Null when evidence or inputs fail validation. */
  net: number | null;
  /** Percentage return on purchase + extraction; null for invalid/zero basis. */
  roi: number | null;
  /** Positive simulation result only, never an instruction to trade. */
  eligible: boolean;
  label: string;
  reasons: string[];
}

export interface CandidateFilters {
  query?: string;
  market?: string;
  /** fresh: fresh status; attention: stale/unknown, unconfirmed, or missing exit. */
  state?: 'all' | 'fresh' | 'attention';
}

export type SanitizedValue = null | boolean | number | string | SanitizedValue[] | { [key: string]: SanitizedValue };

export const candidates: Candidate[];
export const sourceFixtures: SourceFixture[];
export function evaluateCandidate(item: Candidate, options: EvaluationOptions): CandidateEvaluation;
/** Returns a new array without changing items; query searches name, hero, gem, market and description. */
export function filterCandidates(items: readonly Candidate[], filters?: CandidateFilters): Candidate[];
/** JSON-safe copy; masks secret fields/strings, cycles and accessors without mutating input. */
export function redact(value: unknown): SanitizedValue;
/** Pretty sanitized JSON with fixed schemaVersion: 1 and mode: 'simulation'. */
export function exportReport(events: unknown, context: unknown): string;
