import path from 'node:path';
import dotenv from 'dotenv';

/**
 * Single source of truth for the deployed-portal origin and the shared
 * auth storageState path — imported by playwright.config.ts (project
 * baseURLs), auth.setup.ts (where the state file is written), and the API
 * specs (to reconstruct a reproducible curl command; see helpers/curl.ts).
 * Keeping these in one place means the curl the report shows can't drift
 * from the URL/path the test actually used.
 */

// This module is imported before playwright.config.ts calls dotenv.config(),
// so load .env here to make BASE_URL / API_BASE_URL visible at import time.
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

// Trailing slash matters for both bases — Playwright resolves relative URLs
// like a browser would, so a missing one drops the last path segment.
const withTrailingSlash = (url: string) => (url.endsWith('/') ? url : `${url}/`);

// UI project navigates page routes (/landing, /slp, /srp) off the portal origin.
// Set BASE_URL in .env to point at another environment.
export const UI_BASE_URL = withTrailingSlash(
  process.env.BASE_URL?.trim() || 'https://tripbuilder.dev.triparcdev.com/',
);
// API project posts to BFF endpoints relative to /bff/api/ (a leading "/" in a
// request path would drop this prefix entirely). Defaults to /bff/api/ on the
// UI origin — resolved from the origin, not the full BASE_URL, so a path
// prefix such as /slp doesn't leak into it. Override with API_BASE_URL in .env
// if the BFF lives elsewhere.
export const API_BASE_URL = withTrailingSlash(
  process.env.API_BASE_URL?.trim() || new URL('/bff/api/', UI_BASE_URL).toString(),
);

export const AUTH_STATE_PATH = path.join(__dirname, '..', '.auth', 'state.json');
