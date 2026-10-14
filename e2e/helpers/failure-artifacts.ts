import { existsSync } from 'node:fs';
import type { TestInfo } from '@playwright/test';
import { buildCurlCommand, cookieHeaderFromStorageState } from './curl';
import { formatQueryLog, getQueryLog } from '../utils/make-payable-db';
import { AUTH_STATE_PATH } from '../utils/constants';

/**
 * Failure evidence for the traveler suites.
 *
 * Playwright already retains a video, a screenshot and a trace for the UI
 * project (configured in playwright.config.ts) — but those only capture the
 * browser. Half of what these tests assert happens in Postgres and on Service
 * Bus, where a trace viewer shows nothing at all. So on failure we also attach:
 *
 *   sql-trace.txt   every query the test ran, with params, row counts, timings
 *   repro.sh        the make-payable HTTP call as a runnable curl
 *   rerun.txt       the tb-271-verify CLI commands to inspect the same offer
 *
 * The aim is that a failure can be handed to someone on the make-payable side
 * who has neither this repo nor Playwright installed, and they can still see
 * which call was made and which query came back empty.
 *
 * Attached ONLY on failure. On a passing run these would be noise, and the
 * specs already attach the meaningful positive evidence (the audit event, the
 * HTTP call) unconditionally.
 */

export interface FailureContext {
  /** The captured make-payable write, when the test got that far. */
  call?: { method: string; url: string; requestBody?: unknown; status?: number };
  /** Offer under test, for the CLI re-run hints. */
  offerId?: string;
  /** Extra lines worth putting in front of whoever reads the failure. */
  notes?: string[];
}

export function isFailure(testInfo: TestInfo): boolean {
  return testInfo.status !== testInfo.expectedStatus;
}

export async function attachFailureArtifacts(testInfo: TestInfo, context: FailureContext = {}): Promise<void> {
  if (!isFailure(testInfo)) return;

  await testInfo.attach('sql-trace.txt', {
    body: formatQueryLog(),
    contentType: 'text/plain',
  });

  if (context.call) {
    await testInfo.attach('repro.sh', {
      body: buildCurlRepro(context.call),
      contentType: 'text/plain',
    });
  }

  // Falls back to the query log: the DB-only spec has no HTTP call and its hook
  // has no offerId in scope, but whichever offer it queried is right there in
  // the bound parameters. Without this, the most useful part of a DB failure —
  // "here is how to inspect that exact offer" — would be missing precisely
  // where there is no video to fall back on.
  const offerId = context.offerId ?? offerIdFromUrl(context.call?.url) ?? offerIdFromQueryLog();
  if (offerId) {
    await testInfo.attach('rerun.txt', {
      body: rerunHints(offerId),
      contentType: 'text/plain',
    });
  }

  if (context.notes?.length) {
    await testInfo.attach('notes.txt', { body: context.notes.join('\n'), contentType: 'text/plain' });
  }

  // Summarise which Playwright-native artifacts this run produced, so the HTML
  // report's attachment list says plainly whether a video/trace exists rather
  // than leaving the reader to wonder if it was lost or never configured.
  await testInfo.attach('artifacts-index.txt', {
    body: describeAttachments(testInfo),
    contentType: 'text/plain',
  });
}

function buildCurlRepro(call: NonNullable<FailureContext['call']>): string {
  // The suite drives a browser, so the cookie actually sent is Chromium's.
  // Reconstruct it from the same storageState the context was seeded with —
  // the identical approach the api specs use (see helpers/curl.ts).
  let cookie: string | undefined;
  try {
    cookie = existsSync(AUTH_STATE_PATH) ? cookieHeaderFromStorageState(AUTH_STATE_PATH, call.url) : undefined;
  } catch {
    cookie = undefined;
  }

  const header = [
    '# Reproduce the make-payable call this test made.',
    '# The session cookie expires — re-run `npm run e2e:auth` if this 401s.',
    call.status !== undefined ? `# The test observed HTTP ${call.status}.` : '',
    '',
  ]
    .filter(Boolean)
    .join('\n');

  return `${header}${buildCurlCommand({
    method: call.method,
    url: call.url,
    headers: {
      'Content-Type': call.requestBody ? 'application/json' : undefined,
      'X-Csrf': '1', // the BFF rejects calls without it ("Missing X-Csrf header.")
      Cookie: cookie,
    },
    body: call.requestBody ?? undefined,
  })}\n`;
}

function offerIdFromUrl(url?: string): string | undefined {
  return url ? /offers\/([0-9a-f-]{36})\//i.exec(url)?.[1] : undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Last GUID bound as a query parameter — in these specs that is always an offer id. */
function offerIdFromQueryLog(): string | undefined {
  for (const entry of [...getQueryLog()].reverse()) {
    const candidate = entry.params.find((param): param is string => typeof param === 'string' && UUID.test(param));
    if (candidate) return candidate;
  }
  return undefined;
}

function rerunHints(offerId: string): string {
  return [
    `Offer under test: ${offerId}`,
    '',
    'Inspect the same offer without Playwright (needs the VPN):',
    '',
    '  cd C:\\Users\\r.abduraxmanova\\Documents\\tb-271-verify',
    `  dotnet run file dbeaver\\04-offer-timeline-diagnostic.sql ${offerId}   # what fired, in order`,
    `  dotnet run file dbeaver\\05-payload-vs-read-model.sql ${offerId}       # is the payload correct`,
    `  dotnet run file dbeaver\\11-removal-events.sql ${offerId}              # removal side`,
    '',
    'Or open the same .sql files in DBeaver (Projects -> General -> Scripts -> TB-271);',
    `they prompt for :offer_id — paste ${offerId}.`,
    '',
    'Reading the timeline: a ClientAssignedToOffer row with no TravelerInfo row means',
    'Management published the outbound trigger and Integration.Worker never consumed it.',
  ].join('\n');
}

function describeAttachments(testInfo: TestInfo): string {
  const byName = testInfo.attachments.map((attachment) => {
    const where = attachment.path ?? '(inline body)';
    return `${attachment.name.padEnd(28)} ${attachment.contentType.padEnd(24)} ${where}`;
  });

  // Report what the PROJECT asked for, not what is attached right now. Video and
  // trace are appended by Playwright after afterEach hooks finish, so listing
  // them as "missing" here would be wrong — and worse, would send someone
  // looking for a config bug that does not exist.
  const use = testInfo.project.use as {
    video?: unknown;
    screenshot?: unknown;
    trace?: unknown;
  };
  const mode = (value: unknown): string =>
    typeof value === 'string' ? value : typeof value === 'object' && value !== null && 'mode' in value
      ? String((value as { mode: unknown }).mode)
      : 'off (not set)';

  // Ordered so the useful part survives truncation: the `list` reporter prints
  // only the first few lines of an inline attachment in the terminal (the full
  // body is in the HTML and JSON reports).
  return [
    `artifacts: video=${mode(use.video)} screenshot=${mode(use.screenshot)} trace=${mode(use.trace)}` +
      ` · queries=${getQueryLog().length}`,
    `open trace: npx playwright show-trace ${testInfo.outputDir}\\trace.zip`,
    `project: ${testInfo.project.name} · status: ${testInfo.status} (expected ${testInfo.expectedStatus}) · retry: ${testInfo.retry}`,
    `test: ${testInfo.title}`,
    `output dir: ${testInfo.outputDir}`,
    '',
    'attachments at the time this index was written:',
    ...byName,
    '',
    'NOTE: video and trace are attached by Playwright AFTER afterEach hooks run,',
    'so they are not in the list above but will appear in the HTML report and in',
    'the output dir. The DB-only `traveler` project has all three off on purpose:',
    'it launches no browser, so those files would be empty.',
    '',
  ].join('\n');
}
