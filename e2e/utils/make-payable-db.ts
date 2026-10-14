import fs from 'node:fs';
import path from 'node:path';
import { Pool, type QueryResultRow } from 'pg';

/**
 * Direct READ access to make-payable's Marten store — used to assert that a
 * traveler action in the UI actually produced the outbound integration event
 * it is contracted to produce, rather than only that the HTTP call returned
 * 202. Mirrors utils/pim-db.ts: a configured-guard, a lazily created pool,
 * a close hook for globalTeardown, and assertion helpers that return a
 * failures[] list instead of throwing.
 *
 * Two schemas matter:
 *   integration_schema.mt_events            outbound audit appends; the header
 *                                           integration-direction = Outgoing
 *                                           distinguishes them from inbound
 *   inquiry_schema.mt_doc_clientreadmodel   the synced ACAVE client, with
 *                                           companions nested in companions[]
 *
 * Only reachable over the corporate VPN — the server sits behind a private
 * endpoint (a private DNS zone, no public A record), so every consumer must
 * check isMakePayableDbConfigured() first and skip gracefully when unset.
 * That keeps the suite runnable in CI/off-VPN, exactly like the PIM checks.
 *
 * SAFETY: the connection string in dev is the APPLICATION's own account and
 * has write rights, so every connection is put into
 * `default_transaction_read_only = on` before the caller sees it. A QA suite
 * must not be one typo away from mutating the environment it is verifying.
 */

const SQL_DIR = path.join(__dirname, '..', 'traveler', 'sql');

let pool: Pool | undefined;

export function isMakePayableDbConfigured(): boolean {
  return Boolean(process.env.MAKE_PAYABLE_POSTGRES_URI);
}

/**
 * Accepts either a libpq URI (postgresql://user:pass@host:5432/db) or a .NET
 * keyword string (Server=…;Database=…;User Id=…;Password=…;Ssl Mode=Require).
 * The keyword form matters: that is verbatim how the value is stored in Azure
 * Key Vault (TripArcMakePayable--ConnectionStrings--Default), so it can be
 * pasted into .env without hand-converting it — and hand-converting is how
 * passwords containing `@` get mangled.
 */
export function parseConnectionString(raw: string): {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: { rejectUnauthorized: boolean } | undefined;
} {
  const value = raw.trim();

  if (value.includes('://')) {
    const url = new URL(value);
    return {
      host: url.hostname,
      port: Number(url.port || 5432),
      database: url.pathname.replace(/^\//, ''),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      ssl: url.searchParams.get('sslmode') === 'disable' ? undefined : { rejectUnauthorized: false },
    };
  }

  const pairs = new Map<string, string>();
  for (const part of value.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    pairs.set(part.slice(0, index).trim().toLowerCase().replace(/\s+/g, ''), part.slice(index + 1).trim());
  }

  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const found = pairs.get(key);
      if (found) return found;
    }
    return '';
  };

  const sslMode = pick('sslmode').toLowerCase();

  return {
    host: pick('server', 'host', 'datasource'),
    port: Number(pick('port') || 5432),
    database: pick('database', 'initialcatalog'),
    user: pick('userid', 'user', 'username', 'uid'),
    password: pick('password', 'pwd'),
    // Azure requires TLS. rejectUnauthorized:false because the server presents
    // a chain the Node trust store does not carry by default; the alternative
    // is shipping a CA bundle with the suite for no security gain against an
    // endpoint that is already private-network-only.
    ssl: sslMode === 'disable' ? undefined : { rejectUnauthorized: false },
  };
}

function getPool(): Pool {
  if (!pool) {
    const raw = process.env.MAKE_PAYABLE_POSTGRES_URI;
    if (!raw) {
      throw new Error(
        'MAKE_PAYABLE_POSTGRES_URI is not set — call isMakePayableDbConfigured() before using this helper.',
      );
    }
    pool = new Pool({
      ...parseConnectionString(raw),
      // Read-only as a STARTUP parameter, not a `SET` issued on the 'connect'
      // event. The event-handler version fires the SET without awaiting it, so
      // it races the caller's first query — pg even warns about the overlap —
      // and a lost race means an unprotected connection. As a startup option
      // the server applies it before the connection is usable, for every
      // connection the pool ever creates.
      options: '-c default_transaction_read_only=on',
      // The default 15s is not enough for the first handoff through the private
      // endpoint: a valid password otherwise fails with a timeout that reads
      // like a firewall block.
      connectionTimeoutMillis: 30_000,
      max: 4,
    });
  }
  return pool;
}

// ── Query trace ──────────────────────────────────────────────────────────────
// Every query this helper runs is recorded, so a failing test can attach the
// exact SQL, parameters, row counts and timings it saw. Without this, a DB
// assertion failure reads "expected an event, found none" and the next step is
// guesswork about which query ran against which offer.

export interface TracedQuery {
  label: string;
  sql: string;
  params: unknown[];
  rowCount: number;
  durationMs: number;
  error?: string;
}

let queryLog: TracedQuery[] = [];

export function resetQueryLog(): void {
  queryLog = [];
}

export function getQueryLog(): TracedQuery[] {
  return [...queryLog];
}

/** Human-readable trace for a Playwright attachment. */
export function formatQueryLog(): string {
  if (queryLog.length === 0) return '(no database queries ran)';

  return queryLog
    .map((entry, index) => {
      const head = `── [${index + 1}] ${entry.label} — ${entry.rowCount} row(s) in ${entry.durationMs}ms`;
      const params = entry.params.length > 0 ? `\nparams: ${JSON.stringify(entry.params)}` : '';
      const error = entry.error ? `\nERROR: ${entry.error}` : '';
      return `${head}${params}${error}\n${entry.sql.trim()}`;
    })
    .join('\n\n');
}

/** Single funnel for every query, so nothing escapes the trace. */
async function traced<T extends QueryResultRow>(label: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const startedAt = Date.now();
  try {
    const result = await getPool().query<T>(sql, params);
    queryLog.push({ label, sql, params, rowCount: result.rowCount ?? result.rows.length, durationMs: Date.now() - startedAt });
    return result.rows;
  } catch (err) {
    queryLog.push({
      label,
      sql,
      params,
      rowCount: 0,
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/** Call once from Playwright globalTeardown so the process can exit cleanly. */
export async function closeMakePayableDbConnection(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

/**
 * Strips `--` comments (quote-aware, so a `--` inside a string literal
 * survives) and rewrites DBeaver's `:offer_id` named parameter into pg's
 * positional `$1`. This is what lets one .sql file be the single source of
 * truth for three consumers: this suite, DBeaver, and the standalone
 * tb-271-verify CLI. Divergent copies of a verification query are worse than
 * no query, because a passing stale copy looks like coverage.
 */
export function prepareSql(sql: string): { text: string; usesOfferId: boolean } {
  let out = '';
  let inString = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];

    if (inString) {
      out += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") { out += sql[++i]; continue; }
        inString = false;
      }
      continue;
    }
    if (ch === "'") { inString = true; out += ch; continue; }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    out += ch;
  }

  const text = out.replace(/;\s*$/, '').trim();
  return { text: text.replace(/:offer_id\b/g, '$1'), usesOfferId: /:offer_id\b/.test(text) };
}

/** Runs one of traveler/sql/*.sql and returns its rows. */
export async function runSqlFile<T extends QueryResultRow = QueryResultRow>(
  fileName: string,
  offerId?: string,
): Promise<T[]> {
  const filePath = path.join(SQL_DIR, fileName);
  const { text, usesOfferId } = prepareSql(fs.readFileSync(filePath, 'utf8'));

  if (usesOfferId && !offerId) {
    throw new Error(`${fileName} uses :offer_id — pass an offerId to runSqlFile().`);
  }

  return traced<T>(fileName, text, usesOfferId ? [offerId] : []);
}

// ── Row shapes ───────────────────────────────────────────────────────────────

export interface EventFiringRow { traveler_type: string; total: string; zero_trip_id: string }
export interface DuplicateRow {
  traveler_type: string; name: string; events: string;
  distinct_causations: string; distinct_correlations: string;
}
export interface HeaderRow { direction: string; rows: string }
export interface PayloadMatchRow { traveler_type: string; verdict: string; event_name: string; read_model_name: string | null }
export interface TimelineRow { event_type: string; direction: string | null; correlation_id: string | null; causation_id: string | null }

// ── Assertions (failures[] style, as in pim-db.ts) ───────────────────────────

/**
 * Guards the guard. `svc_tripbuilder` is the application's own account and can
 * write, so the suite's safety rests entirely on the read-only startup option
 * in getPool(). If a future refactor drops it, that failure would otherwise be
 * silent — a QA suite quietly gaining write access to the environment it
 * verifies. This asserts it out loud instead.
 */
export async function assertSessionIsReadOnly(): Promise<string[]> {
  const rows = await traced<{ default_transaction_read_only: string }>(
    'read-only guard',
    'SHOW default_transaction_read_only',
  );
  const value = rows[0]?.default_transaction_read_only;
  return value === 'on'
    ? []
    : [`db: session is NOT read-only (default_transaction_read_only = "${value}") — the pool's safety option is gone`];
}

/**
 * Every traveler type that has ever fired must have fired without leaking an
 * empty TripId. `AddExistingClientToOfferHandler` carries a TODO(TB-271):
 * attaching a client before Shopping's offer has initialised publishes
 * tripId = 00000000-… permanently, with no later correction. It has never
 * been observed in dev, so a non-zero count here is a regression that made
 * the path reachable — worth failing loudly for.
 */
export async function assertNoEmptyTripIds(): Promise<string[]> {
  const failures: string[] = [];
  const rows = await runSqlFile<EventFiringRow>('01-is-the-event-firing.sql');

  if (rows.length === 0) {
    failures.push('db: no TravelerInfoIntegrationEvent rows at all — event never fired, or wrong database');
    return failures;
  }
  for (const row of rows) {
    if (Number(row.zero_trip_id) > 0) {
      failures.push(
        `db: ${row.zero_trip_id} of ${row.total} ${row.traveler_type} events published ` +
          'tripId = 00000000-0000-0000-0000-000000000000 (TODO(TB-271) leak is now reachable)',
      );
    }
  }
  return failures;
}

/** Outbound audit contract: every appended event is stamped Outgoing. */
export async function assertOutgoingHeaderStamped(): Promise<string[]> {
  const failures: string[] = [];
  for (const row of await runSqlFile<HeaderRow>('07-audit-header-contract.sql')) {
    if (row.direction !== 'Outgoing') {
      failures.push(`db: ${row.rows} event(s) carry integration-direction = "${row.direction}" instead of "Outgoing"`);
    }
  }
  return failures;
}

/**
 * A repeat event per (offer, traveler) is legitimate — a traveler can be
 * attached, removed and re-attached. What is NOT legitimate is one command
 * publishing the same event more than once, which shows up as several events
 * sharing a single causation_id. correlation_id is deliberately NOT used here:
 * the handler preserves the aggregate's CorrelationId, so repeats share it by
 * design and it would produce false positives.
 */
export async function assertNoDuplicatePublishes(): Promise<string[]> {
  const failures: string[] = [];
  for (const row of await runSqlFile<DuplicateRow>('06-duplicates-real-or-not.sql')) {
    if (Number(row.distinct_causations) < Number(row.events)) {
      failures.push(
        `db: ${row.events} events for ${row.traveler_type} "${row.name}" share only ` +
          `${row.distinct_causations} causation id(s) — one command published more than once`,
      );
    }
  }
  return failures;
}

/** Event payload must agree with the client read model, not merely exist. */
export async function assertPayloadMatchesReadModel(offerId: string): Promise<string[]> {
  const failures: string[] = [];
  const rows = await runSqlFile<PayloadMatchRow>('05-payload-vs-read-model.sql', offerId);

  if (rows.length === 0) {
    failures.push(`db: no traveler-info events for offer ${offerId} to compare against the read model`);
    return failures;
  }
  for (const row of rows) {
    // An ad-hoc traveler has no ACAVE persona and so legitimately has no row.
    if (row.verdict === 'no read model row' && row.traveler_type === 'AdhocTraveller') continue;
    if (row.verdict !== 'match') {
      failures.push(
        `db: ${row.traveler_type} "${row.event_name}" — ${row.verdict} ` +
          `(read model has "${row.read_model_name ?? '(nothing)'}")`,
      );
    }
  }
  return failures;
}

/**
 * Asserts a specific traveler attachment produced an event on this offer.
 * Use after driving the UI, passing the offerId from the
 * POST /offers/{offerId}/… request.
 */
export async function assertEventFiredForOffer(offerId: string, expectedTypes: string[]): Promise<string[]> {
  const failures: string[] = [];
  const rows = await runSqlFile<PayloadMatchRow>('05-payload-vs-read-model.sql', offerId);
  const seen = new Set(rows.map((r) => r.traveler_type));

  for (const type of expectedTypes) {
    if (!seen.has(type)) {
      failures.push(
        `db: no TravelerInfoIntegrationEvent with travelerType="${type}" for offer ${offerId} ` +
          '(run 04-offer-timeline-diagnostic.sql: ClientAssignedToOffer present but this absent ' +
          'means Integration.Worker never consumed the trigger)',
      );
    }
  }
  return failures;
}

export interface TravelerInfoEvent {
  event_id: string;
  traveler_type: string;
  traveler_id: string;
  trip_id: string;
  first_name: string | null;
  last_name: string | null;
  direction: string | null;
  causation_id: string | null;
  correlation_id: string | null;
}

/** Every traveler-info event on one offer, newest last. */
export async function travelerInfoEventsForOffer(offerId: string): Promise<TravelerInfoEvent[]> {
  return traced<TravelerInfoEvent>(
    'travelerInfoEventsForOffer',
    `SELECT id::text                       AS event_id,
            data ->> 'travelerType'        AS traveler_type,
            COALESCE(data ->> 'travelerId', data ->> 'travellerId')          AS traveler_id,
            data ->> 'tripId'              AS trip_id,
            data ->> 'firstName'           AS first_name,
            data ->> 'lastName'            AS last_name,
            headers ->> 'integration-direction' AS direction,
            causation_id,
            correlation_id
       FROM integration_schema.mt_events
      WHERE mt_dotnet_type LIKE '%TravelerInfoIntegrationEvent%'
        AND data ->> 'offerId' = $1
      ORDER BY timestamp`,
    [offerId],
  );
}

/**
 * Polls until a traveler-info event of `travelerType` exists on the offer.
 *
 * Polling is not optional here. The UI's POST returns 202 the moment
 * Management has appended its domain event; the outbound trigger then travels
 * the internal Service Bus queue to Integration.Worker, which composes and
 * appends the integration event. A single query straight after the click would
 * fail intermittently and teach everyone to distrust the suite.
 */
export async function waitForTravelerInfoEvent(
  offerId: string,
  travelerType: string,
  timeoutMs = 45_000,
): Promise<TravelerInfoEvent | undefined> {
  const deadline = Date.now() + timeoutMs;
  let events: TravelerInfoEvent[] = [];

  while (Date.now() < deadline) {
    events = await travelerInfoEventsForOffer(offerId);
    const match = events.filter((event) => event.traveler_type === travelerType).at(-1);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return undefined;
}

export interface RemovalEvent {
  event_id: string;
  event_type: string;
  traveler_id: string | null;
  service_id: string | null;
  direction: string | null;
}

/**
 * Polls for the removal event a Remove / un-travel action should produce.
 *
 * Only `TravelerRemovedIntegrationEvent` is treated as required.
 * `TravelerRemovedFromService(s)` fires only when the traveller actually had
 * assignments to undo — a traveller with none produces just the former
 * (verified in dev on 2026-09-10), so requiring it would fail correct behaviour.
 */
export async function waitForRemovalEvent(
  offerId: string,
  travelerId: string,
  timeoutMs = 45_000,
): Promise<RemovalEvent[]> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const rows = await traced<RemovalEvent>(
      'waitForRemovalEvent',
      `SELECT id::text AS event_id,
              COALESCE(substring(mt_dotnet_type from '([^.,]+)(?:,|$)'), mt_dotnet_type) AS event_type,
              COALESCE(data ->> 'travelerId', data ->> 'travellerId') AS traveler_id,
              data ->> 'serviceId'  AS service_id,
              headers ->> 'integration-direction' AS direction
         FROM integration_schema.mt_events
        WHERE mt_dotnet_type LIKE '%TravelerRemoved%'
          AND data ->> 'offerId'    = $1
          AND COALESCE(data ->> 'travelerId', data ->> 'travellerId') = $2
        ORDER BY timestamp`,
      [offerId, travelerId],
    );
    if (rows.some((row) => row.event_type.startsWith('TravelerRemovedIntegrationEvent'))) {
      return rows;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return [];
}

/**
 * Polls for the SINGULAR service-removal event — the one with a populated
 * `serviceId`, produced by unticking one cell in the Assignment matrix.
 *
 * Deliberately requires `serviceId IS NOT NULL`: the batched
 * `TravelerRemovedFromServices` also matches a naive `%TravelerRemovedFromService%`
 * pattern, so accepting either would let a whole-traveller removal masquerade as
 * a single-service removal and the test would pass on the wrong event.
 */
export async function waitForServiceRemovalEvent(
  offerId: string,
  travelerId: string,
  serviceId?: string,
  timeoutMs = 45_000,
): Promise<RemovalEvent | undefined> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const rows = await traced<RemovalEvent>(
      'waitForServiceRemovalEvent',
      `SELECT id::text AS event_id,
              COALESCE(substring(mt_dotnet_type from '([^.,]+)(?:,|$)'), mt_dotnet_type) AS event_type,
              COALESCE(data ->> 'travelerId', data ->> 'travellerId') AS traveler_id,
              data ->> 'serviceId'  AS service_id,
              headers ->> 'integration-direction' AS direction
         FROM integration_schema.mt_events
        WHERE mt_dotnet_type LIKE '%TravelerRemovedFromServiceIntegrationEvent%'
          AND data ->> 'offerId'    = $1
          AND COALESCE(data ->> 'travelerId', data ->> 'travellerId') = $2
          AND data ->> 'serviceId' IS NOT NULL
          AND ($3::text IS NULL OR data ->> 'serviceId' = $3)
        ORDER BY timestamp DESC`,
      [offerId, travelerId, serviceId ?? null],
    );
    if (rows.length > 0) return rows[0];
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return undefined;
}

/**
 * The negative assertion: waits out the full window and requires that NO new
 * traveler-info event appeared.
 *
 * It cannot be "query once and expect nothing" — that would pass while the
 * event was still in flight, which is exactly the bug it exists to catch. The
 * wait has to be at least as long as the positive path's realistic latency, so
 * this deliberately burns the time rather than returning early.
 */
export async function expectNoNewTravelerInfoEvent(
  offerId: string,
  knownEventIds: string[],
  windowMs = 30_000,
): Promise<string[]> {
  const known = new Set(knownEventIds);
  await new Promise((resolve) => setTimeout(resolve, windowMs));

  const appeared = (await travelerInfoEventsForOffer(offerId)).filter((event) => !known.has(event.event_id));
  return appeared.map(
    (event) =>
      `db: a traveler-info event appeared when none should have — ${event.traveler_type} ` +
      `"${event.first_name} ${event.last_name}" (event ${event.event_id}, causation ${event.causation_id}). ` +
      'The trigger is over-firing: "Is travelling" off must link the client without pooling them.',
  );
}
