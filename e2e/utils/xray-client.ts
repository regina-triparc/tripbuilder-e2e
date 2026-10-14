import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Thin Xray Cloud REST v2 client — auth + a single results import call.
 *
 * Deliberately dependency-free (global fetch, Node 18+) and deliberately
 * *not* a per-test uploader: the reporter batches the whole run into one
 * `/import/execution` POST, so a 60-row suite costs two HTTPS round trips
 * (authenticate + import) rather than 60.
 *
 * Xray Server/Data Center is a different API surface entirely
 * (/rest/raven/2.0/, Jira-native auth) — this file is Cloud-only.
 */

const XRAY_BASE_URL = process.env.XRAY_BASE_URL ?? 'https://xray.cloud.getxray.app';

/**
 * Jira caps individual attachments (10 MB on most tenants) and the import
 * payload carries evidence inline as base64, which inflates by ~33%. A
 * failed-run video can blow past that on its own, so oversized evidence is
 * dropped with a note in the step comment rather than failing the upload —
 * losing a video is annoying, losing the whole run's results is worse.
 */
const MAX_EVIDENCE_BYTES = 9 * 1024 * 1024;

export type XrayStatus = 'PASSED' | 'FAILED' | 'TODO' | 'ABORTED';

export interface XrayEvidence {
  data: string;
  filename: string;
  contentType: string;
}

export interface XrayStepResult {
  status: XrayStatus;
  comment?: string;
  evidence?: XrayEvidence[];
}

export interface XrayTestResult {
  testKey: string;
  status: XrayStatus;
  start?: string;
  finish?: string;
  comment?: string;
  evidence?: XrayEvidence[];
  steps?: XrayStepResult[];
}

export interface XrayImportPayload {
  testExecutionKey?: string;
  info?: {
    project?: string;
    summary?: string;
    description?: string;
    startDate?: string;
    finishDate?: string;
    testPlanKey?: string;
    testEnvironments?: string[];
  };
  tests: XrayTestResult[];
}

export interface XrayConfig {
  clientId: string;
  clientSecret: string;
  projectKey: string;
  testExecutionKey?: string;
  testPlanKey?: string;
  testEnvironment?: string;
}

/**
 * Reads Xray credentials from the environment, returning null when they're
 * absent. Mirrors the `isPimDbConfigured()` / globalSetup convention in this
 * suite: an unconfigured integration skips with a warning instead of failing
 * the run, so a developer without Xray credentials still gets a full local
 * test run.
 */
export function readXrayConfig(): XrayConfig | null {
  const clientId = process.env.XRAY_CLIENT_ID?.trim();
  const clientSecret = process.env.XRAY_CLIENT_SECRET?.trim();
  const projectKey = process.env.XRAY_PROJECT_KEY?.trim();

  if (!clientId || !clientSecret || !projectKey) return null;

  return {
    clientId,
    clientSecret,
    projectKey,
    testExecutionKey: process.env.XRAY_TEST_EXECUTION_KEY?.trim() || undefined,
    testPlanKey: process.env.XRAY_TEST_PLAN_KEY?.trim() || undefined,
    testEnvironment: process.env.XRAY_TEST_ENVIRONMENT?.trim() || undefined,
  };
}

/**
 * Exchanges the API key pair for a bearer token. Xray returns the JWT as a
 * JSON *string* (i.e. the body is a quoted token, not an object), hence the
 * JSON.parse rather than a `.token` property read.
 */
export async function authenticate(config: XrayConfig): Promise<string> {
  const response = await fetch(`${XRAY_BASE_URL}/api/v2/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret }),
  });

  if (!response.ok) {
    throw new Error(`Xray authenticate failed: ${response.status} ${await response.text()}`);
  }

  return JSON.parse(await response.text()) as string;
}

/**
 * Posts one batched execution payload. Returns the Test Execution issue key
 * Xray created or updated, so the reporter can print a clickable link.
 */
export async function importExecution(token: string, payload: XrayImportPayload): Promise<string> {
  const response = await fetch(`${XRAY_BASE_URL}/api/v2/import/execution`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`Xray import/execution failed: ${response.status} ${bodyText}`);
  }

  const body = JSON.parse(bodyText) as { key?: string };
  return body.key ?? '(unknown)';
}

/**
 * Reads a Playwright attachment off disk as Xray evidence, or returns null
 * when the file is missing or over the size cap. `label` prefixes the
 * filename so several artifacts from the same test stay distinguishable in
 * the Xray evidence list (screenshot vs trace vs video).
 */
export function fileAsEvidence(filePath: string, contentType: string, label?: string): XrayEvidence | null {
  try {
    if (statSync(filePath).size > MAX_EVIDENCE_BYTES) return null;
    const basename = path.basename(filePath);
    return {
      data: readFileSync(filePath).toString('base64'),
      filename: label ? `${label}-${basename}` : basename,
      contentType,
    };
  } catch {
    return null;
  }
}

/** Inline text (assertion dumps, curl commands) as an evidence attachment. */
export function textAsEvidence(filename: string, text: string): XrayEvidence {
  return { data: Buffer.from(text, 'utf-8').toString('base64'), filename, contentType: 'text/plain' };
}
