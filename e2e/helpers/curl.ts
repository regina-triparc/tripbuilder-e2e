import { readFileSync } from 'node:fs';

export interface CurlRequestSpec {
  method: string;
  url: string;
  headers: Record<string, string | undefined>;
  body?: unknown;
}

/**
 * Renders a reproducible curl command for a request — attached to every
 * data-driven test (see pim-itinerary-search-{positive,negative}.spec.ts)
 * so a row can be replayed outside the Playwright run, e.g. to hand a
 * failing case to someone on the BFF/agent side without them needing to
 * check out this repo.
 */
export function buildCurlCommand({ method, url, headers, body }: CurlRequestSpec): string {
  const lines = [`curl -X ${method} '${url}'`];
  for (const [key, value] of Object.entries(headers)) {
    if (!value) continue;
    lines.push(`  -H '${key}: ${escapeSingleQuotes(value)}'`);
  }
  if (body !== undefined) {
    lines.push(`  --data-raw '${escapeSingleQuotes(JSON.stringify(body))}'`);
  }
  return lines.join(' \\\n');
}

function escapeSingleQuotes(value: string): string {
  return value.replace(/'/g, `'\\''`);
}

/**
 * Cookie header value for a given URL's host, read straight from a
 * Playwright storageState file. The `api` project's APIRequestContext
 * manages its own cookie jar internally with no way to introspect what it
 * actually sent on a given call, so this reconstructs the same Cookie
 * header from the same source (AUTH_STATE_PATH) the request context itself
 * was seeded from — close enough for curl reproduction, since both read
 * the identical file.
 */
export function cookieHeaderFromStorageState(storageStatePath: string, url: string): string {
  const state = JSON.parse(readFileSync(storageStatePath, 'utf-8')) as {
    cookies: Array<{ name: string; value: string; domain: string }>;
  };
  const host = new URL(url).hostname;
  return state.cookies
    .filter((c) => host === c.domain || host.endsWith(c.domain.replace(/^\./, '')))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}
