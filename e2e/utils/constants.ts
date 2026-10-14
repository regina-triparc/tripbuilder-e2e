import path from 'node:path';

/**
 * Single source of truth for the deployed-portal origin and the shared
 * auth storageState path — imported by playwright.config.ts (project
 * baseURLs), auth.setup.ts (where the state file is written), and the API
 * specs (to reconstruct a reproducible curl command; see helpers/curl.ts).
 * Keeping these in one place means the curl the report shows can't drift
 * from the URL/path the test actually used.
 */

// UI project navigates page routes (/landing, /slp, /srp) off the portal origin.
export const UI_BASE_URL = 'https://tripbuilder-portal-gmguhndwguh2fxh6.a03.azurefd.net/';
// API project posts to BFF endpoints relative to /bff/api/ (trailing slash
// matters — Playwright resolves relative request URLs like a browser would,
// so a leading "/" in a request path would drop this prefix entirely).
export const API_BASE_URL = 'https://tripbuilder-portal-gmguhndwguh2fxh6.a03.azurefd.net/bff/api/';

export const AUTH_STATE_PATH = path.join(__dirname, '..', '.auth', 'state.json');
