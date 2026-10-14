import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Reads and parses a fixture CSV in one call — path resolved relative to the caller's `__dirname`. */
export function loadCsvFixture<T>(callerDir: string, relativePath: string): T[] {
  return parseCsv(readFileSync(path.join(callerDir, relativePath), 'utf-8')) as unknown as T[];
}

/**
 * Buckets rows by a key, preserving first-seen order of both the buckets
 * and the rows within each — used to turn a flat CSV into
 * `test.describe(group, ...)` blocks that mirror how the fixture is
 * physically grouped on disk, without needing a hardcoded group order that
 * could drift from the CSV.
 */
export function groupBy<T>(rows: T[], keyFn: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyFn(row);
    const existing = groups.get(key);
    if (existing) {
      existing.push(row);
    } else {
      groups.set(key, [row]);
    }
  }
  return groups;
}

/**
 * Writes rows as a CSV fixture — path resolved relative to the caller's
 * `__dirname`. Column order follows `columns` rather than object key
 * insertion order, since callers build rows from Mongo documents whose key
 * order isn't guaranteed.
 */
export function writeCsvFixture(
  callerDir: string,
  relativePath: string,
  columns: string[],
  rows: Record<string, string | number | boolean | null | undefined>[],
): void {
  const lines = [columns.join(','), ...rows.map((row) => columns.map((col) => stringifyCell(row[col])).join(','))];
  writeFileSync(path.join(callerDir, relativePath), lines.join('\n') + '\n', 'utf-8');
}

function stringifyCell(value: string | number | boolean | null | undefined): string {
  const raw = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

/**
 * Minimal RFC4180-ish CSV reader — no dependency added just to parse a
 * handful of fixture rows. Supports quoted fields containing commas
 * (queries like "Paris 1 adult July 1st till August 1st budget 3000 CAD"
 * don't have commas, but destinations like "10 days, budget 3000 USD"
 * variants might, so quoting is honored).
 */
export function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];

  const header = parseLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = parseLine(line);
    const row: Record<string, string> = {};
    header.forEach((key, i) => {
      row[key] = (cells[i] ?? '').trim();
    });
    return row;
  });
}

function parseLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}
