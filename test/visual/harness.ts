/**
 * The `test` every visual spec but `mock-api.spec.ts` imports. Its auto fixture fails a case after the fact when `mock-api` recorded any refusal — a GET
 * with no fixture, a write, an off-origin request — so a case cannot pass while the page rendered an error or loading state.
 */
import { test as base, expect } from '@playwright/test';

import { mockApiFailures } from './mock-api.js';

export const test = base.extend<{ refusalGuard: void }>({
  refusalGuard: [
    async ({ page }, use) => {
      await use();
      const failures = mockApiFailures(page);
      if (failures.length > 0) {
        throw new Error(`mock-api refused ${failures.length} request(s):\n  ${failures.join('\n  ')}`);
      }
    },
    { auto: true }
  ]
});

export { expect };
