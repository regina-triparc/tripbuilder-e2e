import type { Reporter, TestCase, TestResult, TestStep, FullResult } from '@playwright/test/reporter';
import {
  authenticate,
  fileAsEvidence,
  importExecution,
  readXrayConfig,
  textAsEvidence,
  type XrayConfig,
  type XrayEvidence,
  type XrayStatus,
  type XrayStepResult,
  type XrayTestResult,
} from '../utils/xray-client';

/**
 * Playwright reporter that pushes this run's results — with failure evidence
 * (screenshot / video / trace / assertion dump / reproduction curl) — into a
 * single Xray Cloud Test Execution.
 *
 * Design notes:
 *
 * - **Batched, not per-test.** Results accumulate in `onTestEnd` and upload
 *   once in `onEnd`. One authenticate + one import per run, so adding rows to
 *   a dataset CSV costs no extra Xray round trips.
 *
 * - **Skips cleanly when unconfigured.** No XRAY_* credentials means a
 *   warning and a no-op, matching how globalSetup treats a missing
 *   PIM_MONGODB_URI — a developer without Xray access still gets a full run.
 *
 * - **Never fails the run.** An Xray outage produces a loud warning, not a
 *   red suite. The test results are the product; the upload is reporting.
 *
 * - **Mapping.** A test is uploaded only if it declares an Xray issue key,
 *   either via `annotateXray()` (see helpers/report.ts, fed from the
 *   `xrayKey` column in the dataset CSVs) or a `@KEY-123` tag in its title.
 *   Unmapped tests are counted and listed at the end so the gap is visible
 *   rather than silent.
 *
 * - **Step alignment caveat.** Xray matches the `steps` array *positionally*
 *   against the manual steps defined on the Test issue. These specs don't use
 *   `test.step()` yet, so each test currently reports a single synthesized
 *   step. Wrap spec phases in `test.step()` (one per manual step, same order)
 *   to get true per-step pass/fail, or set XRAY_STEP_RESULTS=false to send
 *   test-level evidence only and sidestep alignment entirely.
 */

interface PendingResult {
  testResult: XrayTestResult;
  titlePath: string;
}

const STEP_RESULTS_ENABLED = process.env.XRAY_STEP_RESULTS !== 'false';

/** `@TBA-123` anywhere in the title path — the no-CSV-change escape hatch. */
const TITLE_TAG_PATTERN = /@([A-Z][A-Z0-9_]+-\d+)\b/;

export default class XrayReporter implements Reporter {
  private config: XrayConfig | null = null;
  private startedAt = '';
  private results: PendingResult[] = [];
  private unmapped: string[] = [];

  printsToStdio(): boolean {
    return false;
  }

  onBegin(): void {
    this.startedAt = new Date().toISOString();
    this.config = readXrayConfig();
    if (!this.config) {
      console.warn('[xray] XRAY_CLIENT_ID / XRAY_CLIENT_SECRET / XRAY_PROJECT_KEY not set — results will not be uploaded (see .env.example)');
    }
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (!this.config) return;

    const titlePath = test.titlePath().filter(Boolean).join(' › ');
    const testKey = resolveTestKey(test);
    if (!testKey) {
      this.unmapped.push(titlePath);
      return;
    }

    const status = toXrayStatus(result.status);
    const evidence = collectEvidence(result);
    const comment = buildComment(result, titlePath);

    const testResult: XrayTestResult = {
      testKey,
      status,
      start: result.startTime.toISOString(),
      finish: new Date(result.startTime.getTime() + result.duration).toISOString(),
      comment,
    };

    if (STEP_RESULTS_ENABLED) {
      testResult.steps = buildStepResults(result, status, evidence, comment);
    } else {
      testResult.evidence = evidence;
    }

    this.results.push({ testResult, titlePath });
  }

  async onEnd(_result: FullResult): Promise<void> {
    if (!this.config) return;

    if (this.unmapped.length > 0) {
      console.warn(
        `[xray] ${this.unmapped.length} test(s) had no Xray key and were not uploaded:\n` +
          this.unmapped.map((t) => `  - ${t}`).join('\n') +
          '\n  Add an `xrayKey` value to the dataset row, or a @KEY-123 tag to the title.',
      );
    }

    if (this.results.length === 0) {
      console.warn('[xray] nothing to upload — no test declared an Xray key');
      return;
    }

    // A single retained result per test: the same testKey appearing twice
    // (retries, or the same row wired into both the ui and api project) would
    // otherwise import as duplicate run entries. Last write wins, matching
    // Playwright's own "final attempt is the verdict" semantics.
    const deduped = new Map<string, XrayTestResult>();
    for (const { testResult } of this.results) deduped.set(testResult.testKey, testResult);

    try {
      const token = await authenticate(this.config);
      const executionKey = await importExecution(token, {
        testExecutionKey: this.config.testExecutionKey,
        info: {
          project: this.config.projectKey,
          summary: `tripbuilder-e2e automated run — ${this.startedAt}`,
          description:
            'Imported by tripbuilder-e2e/e2e/reporters/xray-reporter.ts. ' +
            'Evidence per test: failure screenshot/video/trace where captured, the assertion-failure dump, and a ready-to-run curl reproduction.',
          startDate: this.startedAt,
          finishDate: new Date().toISOString(),
          testPlanKey: this.config.testPlanKey,
          testEnvironments: this.config.testEnvironment ? [this.config.testEnvironment] : undefined,
        },
        tests: [...deduped.values()],
      });
      console.log(`[xray] uploaded ${deduped.size} result(s) to Test Execution ${executionKey}`);
    } catch (err) {
      // Reporting failure must not mask the test outcome — warn loudly, exit clean.
      console.warn(`[xray] upload failed (test results unaffected): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Annotation first (CSV-driven), then a `@KEY-123` title tag as fallback. */
function resolveTestKey(test: TestCase): string | null {
  const annotated = test.annotations.find((a) => a.type === 'xray')?.description?.trim();
  if (annotated) return annotated;

  const tagged = test.titlePath().join(' ').match(TITLE_TAG_PATTERN);
  return tagged ? tagged[1] : null;
}

function toXrayStatus(status: TestResult['status']): XrayStatus {
  switch (status) {
    case 'passed':
      return 'PASSED';
    case 'skipped':
      return 'TODO';
    case 'interrupted':
      return 'ABORTED';
    default:
      return 'FAILED';
  }
}

/**
 * Turns Playwright's artifacts into Xray evidence. Path-backed attachments
 * (screenshot, video, trace) are read off disk; body-backed ones (this
 * suite's `curl` and `assertion-failures` text attachments) are inlined
 * directly. Oversized files are dropped by fileAsEvidence rather than
 * bloating the payload past Jira's attachment ceiling.
 */
function collectEvidence(result: TestResult): XrayEvidence[] {
  const evidence: XrayEvidence[] = [];

  for (const attachment of result.attachments) {
    if (attachment.path) {
      const file = fileAsEvidence(attachment.path, attachment.contentType, attachment.name);
      if (file) evidence.push(file);
      continue;
    }
    if (attachment.body) {
      evidence.push(textAsEvidence(`${attachment.name}.txt`, attachment.body.toString('utf-8')));
    }
  }

  if (result.error?.stack) {
    evidence.push(textAsEvidence('error-stack.txt', result.error.stack));
  }

  return evidence;
}

function buildComment(result: TestResult, titlePath: string): string {
  const lines = [titlePath, `status: ${result.status}`, `duration: ${Math.round(result.duration)}ms`];

  const failingStep = findFailingStep(result.steps);
  if (failingStep) lines.push(`failing step: ${failingStep.title}`);

  const message = result.error?.message?.trim();
  if (message) lines.push('', stripAnsi(message));

  for (const annotation of result.annotations ?? []) {
    if (annotation.type === 'note' && annotation.description) lines.push('', `note: ${annotation.description}`);
  }

  return lines.join('\n');
}

/**
 * Maps Playwright's step tree onto Xray step results, attaching all evidence
 * to the step that actually failed — the whole point of step-level reporting.
 *
 * Only `test.step()` calls are considered; Playwright's internal steps
 * (expect/hooks/fixtures) are noise against a manual test's step list. When a
 * spec declares none, a single synthesized step carries the test's verdict so
 * evidence still lands somewhere rather than being dropped.
 */
function buildStepResults(
  result: TestResult,
  testStatus: XrayStatus,
  evidence: XrayEvidence[],
  comment: string,
): XrayStepResult[] {
  const declared = result.steps.filter((s) => s.category === 'test.step');

  if (declared.length === 0) {
    return [{ status: testStatus, comment, evidence }];
  }

  const firstFailedIndex = declared.findIndex((s) => Boolean(s.error));

  return declared.map((step, index) => {
    const failed = index === firstFailedIndex;
    // Steps after the failure never ran to completion — TODO is Xray's
    // "not executed", which reads more honestly than PASSED or FAILED.
    const status: XrayStatus =
      firstFailedIndex === -1 ? 'PASSED' : failed ? 'FAILED' : index < firstFailedIndex ? 'PASSED' : 'TODO';

    return {
      status,
      comment: failed ? `${step.title}\n\n${stripAnsi(step.error?.message ?? '')}`.trim() : step.title,
      // Evidence rides on the failing step only; duplicating a video onto
      // every step would multiply the payload by the step count.
      evidence: failed ? evidence : undefined,
    };
  });
}

function findFailingStep(steps: TestStep[]): TestStep | null {
  for (const step of steps) {
    if (step.error) return findFailingStep(step.steps) ?? step;
  }
  return null;
}

/** Playwright colourises assertion diffs; raw escape codes are unreadable in Jira. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;]*m/g, '');
}
