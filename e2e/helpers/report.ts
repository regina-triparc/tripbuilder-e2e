import type { TestInfo } from '@playwright/test';

/**
 * Attaches the full assertion-failure list to the report as its own
 * artifact, separate from the `expect()` failure message — so the complete
 * list stays visible in the HTML report's attachments tab (and the JSON
 * reporter's `attachments` array) even when it's long enough that an
 * inline message would be hard to scan. Attached on every run, not just
 * failing ones — an empty body confirms the checks actually executed
 * rather than having been skipped or never reached.
 */
export async function attachFailures(testInfo: TestInfo, failures: string[]): Promise<void> {
  await testInfo.attach('assertion-failures', {
    body: failures.length > 0 ? failures.join('\n') : '(none)',
    contentType: 'text/plain',
  });
}

/**
 * Declares which Xray Test issue this run's result belongs to, read by
 * reporters/xray-reporter.ts. Fed from the `xrayKey` column in the dataset
 * CSVs, so the mapping lives next to the test data rather than in code — a
 * new row gets an Xray key by filling in a cell.
 *
 * A blank/absent key is a no-op: the reporter then lists the test as unmapped
 * instead of guessing, which keeps "not yet in Xray" visible rather than
 * silently dropping the result.
 */
export function annotateXray(testInfo: TestInfo, xrayKey: string | undefined): void {
  const key = xrayKey?.trim();
  if (!key) return;
  testInfo.annotations.push({ type: 'xray', description: key });
}

/**
 * Runs an async DB ground-truth check and converts a thrown error (Mongo
 * connectivity blip, malformed doc, etc.) into a failure string instead of
 * letting it abort the test — a raw exception here would otherwise prevent
 * the final `expect()` from ever running, silently discarding whatever
 * API-level failures were already collected earlier in the same test.
 */
export async function safeDbCheck(label: string, check: () => Promise<string[]>): Promise<string[]> {
  try {
    return await check();
  } catch (err) {
    return [`${label} threw: ${err instanceof Error ? err.message : String(err)}`];
  }
}
