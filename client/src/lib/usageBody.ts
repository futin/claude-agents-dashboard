import type { UsageProfileResponse, UsageRatesResponse } from '../../../shared/types';

/**
 * Both usage routes fail open to a 200 whose body looks like "recording off". These gate on the body's `error` marker first, so a failed read shows as
 * "could not be read" rather than as a statement about the account (#593).
 */

/** The rates body when it can be drawn, else null: no `models` array, or the fit itself threw. */
export function usableRates(body: UsageRatesResponse | null | undefined): UsageRatesResponse | null {
  return body != null && Array.isArray(body.models) && !body.error ? body : null;
}

/** The profile body when it can be drawn, else null: a short grid would render a torn week, and an `error` body is a failed read. */
export function usableProfile(body: UsageProfileResponse | null | undefined): UsageProfileResponse | null {
  return body != null && Array.isArray(body.cells) && body.cells.length === 168 && !body.error ? body : null;
}
