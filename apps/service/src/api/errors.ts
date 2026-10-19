export type ErrorCode = 'INVALID_MINT' | 'MINT_NOT_TRACKED' | 'NO_ELIGIBLE_SOURCES' | 'INVALID_QUERY' | 'HISTORY_UNAVAILABLE' | 'NOT_FOUND' | 'INTERNAL';

/** A typed API error mapped to `{ error: { code, message, requestId } }` (API-HTTP-005). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
