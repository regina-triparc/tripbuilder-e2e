import { expect, type Locator, type Page, type Request, type Response } from '@playwright/test';

/**
 * Page object for the Travellers tab, which exists in TWO apps with the same
 * sheets but different routes and different page-level triggers:
 *
 *   tsp   /tsp/:tripId/travellers   (apps/tsp)   <- where the dashboard sends you
 *   trip  /trips/:tripId/travelers  (apps/trip)
 *
 * Note the spelling: the TSP route is "travellers" with two Ls, the trip route
 * is "travelers" with one. Both are real; getting them crossed renders a blank
 * page with no error, which is how this was found — the trip list at /trips
 * navigates to /tsp/:tripId, so `tsp` is the default here because it is the
 * variant a real advisor actually reaches.
 *
 * The sheet and roster hooks are IDENTICAL between the two apps (verified
 * against both templates), so only the page-level selectors are parameterised.
 *
 * Selectors are the app's own `data-test` attributes — note `data-test`, NOT
 * `data-testid`; the traveller components use the former throughout and only
 * the generate-offer wizard uses the latter.
 *
 * Do NOT read checkbox state from the accessibility tree: both checkboxes here
 * expose `value="on"` regardless of whether they are ticked, so a snapshot
 * reads `checkbox "on"` for an unchecked box. Use isChecked() / the DOM
 * `.checked` property, as assertCompanionBoxUnchecked() below does.
 *
 * WHERE EACH FLOW ACTUALLY COMMITS — this trips people up, because both
 * sheets are two-step and the obvious-looking button is not the one that
 * writes:
 *
 *   Attach client:  header `trip-tabs-header-attach-client` opens the sheet ->
 *                   search -> pick a result -> `acs-attach-and-assign` only
 *                   ADVANCES to the service-picking step -> `acs-done` is the
 *                   sole commit point (add-client-sheet.component.ts onDone()).
 *   Add traveller:  `travelers-view-add-traveller` (disabled until a client
 *                   exists) -> companion row or `ats-add-new` -> `ats-submit-manual`
 *                   / `ats-attach-assign` advance -> `ats-done` commits.
 *
 * "Is travelling" defaults to TRUE (travelers-roster.store.ts:
 * clientIsTravelling = signal(true)), so the negative case has to actively
 * uncheck it before committing.
 *
 * Every write method returns the captured HTTP call, because the offerId in
 * that URL is the only reliable key for the database assertions that follow —
 * reading it off the screen is not possible, and guessing from the trip id is
 * wrong (a trip can carry several offers).
 */

const MAKE_PAYABLE_WRITE = /\/bff\/api\/make-payable-(orchestration|management)\/offers\/[0-9a-f-]{36}\//i;

export interface TravelerWriteCall {
  /** Full request URL, so a test can assert WHICH endpoint the UI chose. */
  url: string;
  /** Extracted from the URL path — the key for every make-payable DB assertion. */
  offerId: string;
  method: string;
  status: number;
  requestBody: unknown;
  responseBody: unknown;
}

export type TravellersApp = 'tsp' | 'trip';

/** The only selectors that differ between the two apps. */
const APP_SELECTORS: Record<TravellersApp, { path: (tripId: string) => string; attachClient: string; addTraveller: string }> = {
  tsp: {
    path: (tripId) => `/tsp/${tripId}/travellers`,
    attachClient: '[data-test="travellers-attach-client"]',
    addTraveller: '[data-test="travellers-add-traveller"]',
  },
  trip: {
    path: (tripId) => `/trips/${tripId}/travelers`,
    attachClient: '[data-test="trip-tabs-header-attach-client"]',
    addTraveller: '[data-test="travelers-view-add-traveller"]',
  },
};

export class TripTravelersPage {
  private readonly selectors: (typeof APP_SELECTORS)[TravellersApp];

  constructor(private readonly page: Page, app: TravellersApp = 'tsp') {
    this.selectors = APP_SELECTORS[app];
  }

  // ── Page-level ─────────────────────────────────────────────────────────────

  private readonly rosterRows = () => this.page.locator('[data-test="roster-row"]');

  /**
   * The offer id, learned from the page's own inquiry calls during goto().
   *
   * It is not rendered anywhere in the UI, and having each test depend on an
   * earlier test to discover it made the later cases un-runnable on their own —
   * `npx playwright test -g "case 6"` skipped rather than ran, which is a
   * property of the harness, not of the product. Reading it off the traffic the
   * page makes anyway keeps every case independent.
   */
  offerId(): string | undefined {
    return this.discoveredOfferId;
  }

  private discoveredOfferId?: string;

  async goto(tripId: string): Promise<void> {
    // Attach before navigating: the inquiry calls fire during initial render.
    const capture = (url: string): void => {
      const match = /make-payable-[a-z]+\/offers\/([0-9a-f-]{36})\//i.exec(url);
      if (match) this.discoveredOfferId ??= match[1];
    };
    this.page.on('response', (response) => capture(response.url()));

    await this.page.goto(this.selectors.path(tripId));

    await this.waitForRosterToSettle();
  }

  /**
   * Waits for the roster to STOP CHANGING, not merely for something to appear.
   *
   * The first version of this accepted whichever of `roster-row`,
   * `roster-empty` or `travellers-no-client` showed up first — and the TSP view
   * renders `travellers-no-client` transiently while the client is still
   * loading. So it returned "ready" on a trip with four travellers, the caller
   * read zero rows, and the test skipped itself with "no removable traveller".
   * A green-or-skipped suite that silently misreads the page is worse than a
   * failing one, because nobody investigates a skip.
   *
   * Settled means: the row count is the same across two samples ~800ms apart,
   * AND either there is at least one row or a stable empty/no-client marker.
   */
  private async waitForRosterToSettle(timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let previous = -1;

    while (Date.now() < deadline) {
      const rows = await this.rosterRows().count();
      const emptyMarkers = await this.page
        .locator('[data-test="roster-empty"], [data-test="travellers-no-client"]')
        .count();

      if (rows > 0 && rows === previous) return;
      if (rows === 0 && previous === 0 && emptyMarkers > 0) return;

      previous = rows;
      await this.page.waitForTimeout(800);
    }

    throw new Error(
      `Roster never settled within ${timeoutMs}ms (last row count ${previous}). ` +
        'Check the failure screenshot: a "Sign In" page here means the saved session expired — ' +
        'run `npm run e2e:auth-manual`.',
    );
  }

  /** Roster travelerIds, read off each row's data-traveler-id. */
  async rosterTravelerIds(): Promise<string[]> {
    const ids = await this.rosterRows().evaluateAll((rows) =>
      rows.map((row) => row.getAttribute('data-traveler-id') ?? ''),
    );
    return ids.filter((id) => id.length > 0);
  }

  async rosterCount(): Promise<number> {
    return this.rosterRows().count();
  }

  hasClient(): Promise<boolean> {
    return this.page.locator(this.selectors.addTraveller).isEnabled().catch(() => false);
  }

  // ── Capture ────────────────────────────────────────────────────────────────

  /**
   * Runs `action` while watching for the make-payable write it triggers.
   *
   * Waits on the RESPONSE, not the request: these endpoints return 202 with a
   * body the UI needs (the resolved version / traveller id), and a test that
   * only saw the request could not tell an accepted call from a 500.
   */
  private async captureWrite(
    action: () => Promise<void>,
    pathSuffix: RegExp,
    // Removal is a DELETE, not a POST — matching only POST silently never
    // captured it, and the test hung until timeout with no clue why.
    methods: string[] = ['POST'],
  ): Promise<TravelerWriteCall> {
    const responsePromise = this.page.waitForResponse(
      (response: Response) =>
        methods.includes(response.request().method()) &&
        MAKE_PAYABLE_WRITE.test(response.url()) &&
        pathSuffix.test(response.url()),
      { timeout: 60_000 },
    );

    await action();
    const response = await responsePromise;
    const request: Request = response.request();

    const offerId = /offers\/([0-9a-f-]{36})\//i.exec(response.url())?.[1];
    if (!offerId) throw new Error(`Could not extract offerId from ${response.url()}`);

    return {
      url: response.url(),
      offerId,
      method: request.method(),
      status: response.status(),
      requestBody: safeJson(request.postData()),
      responseBody: await response.json().catch(() => null),
    };
  }

  // ── Flow 1: attach an existing ACAVE client ───────────────────────────────

  /**
   * @param isTravelling pass false for the negative case — the client is linked
   *   to the offer (ClientAssignedToOffer fires) but must NOT join the traveller
   *   pool, so no traveler-info event should be published.
   */
  async attachExistingClient(searchTerm: string, options: { isTravelling: boolean }): Promise<TravelerWriteCall> {
    await this.page.locator(this.selectors.attachClient).click();

    const search = this.page.locator('[data-test="acs-search-input"] input, [data-test="acs-search-input"]').first();
    await search.fill(searchTerm);

    const firstResult = this.page.locator('[data-test="acs-result-row"]').first();
    await expect(firstResult).toBeVisible({ timeout: 30_000 });
    await firstResult.click();

    await expect(this.page.locator('[data-test="acs-profile-card"]')).toBeVisible();

    // Checkbox defaults to checked, so only touch it for the negative case.
    if (!options.isTravelling) {
      await this.page.locator('[data-test="acs-travelling-card"] input[type="checkbox"]').click();
    }

    await this.page.locator('[data-test="acs-attach-and-assign"]').click();

    // acs-done is the commit — this is the click that produces the POST.
    return this.captureWrite(
      async () => { await this.page.locator('[data-test="acs-done"]').click(); },
      /\/client\/(existing|new)$/i,
    );
  }

  // ── Flow 2: add a companion from the client's saved contacts ──────────────

  /** Returns null when the client has no saved companions — the caller should skip, not fail. */
  async addFirstSavedCompanion(): Promise<TravelerWriteCall | null> {
    await this.openAddTravellerSheet();

    const companionRow = this.page.locator('[data-test="ats-companion-row"]').first();
    if ((await this.page.locator('[data-test="ats-no-companions"]').count()) > 0) {
      await this.page.locator('[data-test="ats-close"]').click();
      return null;
    }
    await expect(companionRow).toBeVisible({ timeout: 30_000 });
    await companionRow.click();

    await this.page.locator('[data-test="ats-attach-assign"]').click();
    return this.captureWrite(
      async () => { await this.page.locator('[data-test="ats-done"]').click(); },
      /\/(companions\/existing|travellers\/new-companion)$/i,
    );
  }

  // ── Flow 3: add an ad-hoc traveller (no ACAVE persona) ────────────────────

  /**
   * @param traveller.assignAllServices ticks every service in step 2 before
   *   committing. Worth doing when the test needs a traveller who HAS
   *   assignments: a traveller with none produces only `TravelerRemoved` on
   *   removal, never the service-level events, so a service-removal test would
   *   have nothing to remove.
   */
  async addAdhocTraveller(traveller: {
    firstName: string;
    lastName: string;
    phone?: string;
    assignAllServices?: boolean;
  }): Promise<TravelerWriteCall> {
    await this.openAddTravellerSheet();
    await this.page.locator('[data-test="ats-add-new"]').click();

    await this.fillSheetField('ats-first-name', traveller.firstName);
    await this.fillSheetField('ats-last-name', traveller.lastName);
    if (traveller.phone) await this.fillSheetField('ats-phone', traveller.phone);

    // The "save as a companion of …" box must stay UNCHECKED: ticking it creates
    // an ACAVE companion persona instead, and the event would carry
    // travelerType=Companion. It defaults to unchecked (verified against dev),
    // but assert rather than assume — if a future default flipped, this test
    // would otherwise quietly start testing the Companion path while still
    // claiming to cover ad-hoc.
    await this.assertCompanionBoxUnchecked();

    // `ats-submit-manual` (labelled "Review") only advances to service picking.
    await this.page.locator('[data-test="ats-submit-manual"]').click();

    if (traveller.assignAllServices) {
      // Wait for the service list to render BEFORE looking for "Assign all".
      // The original code was `if (await assignAll.isVisible()) click()`, which
      // silently did nothing when the cards had not painted yet — the traveller
      // was created with no assignments and the service-removal case then
      // skipped itself with "no services assigned", pointing the finger at the
      // fixture instead of at this line.
      const cards = this.page.locator('[data-test="ats-service-card"]');
      const noServices = this.page.locator('[data-test="ats-no-services"]');
      await expect(cards.first().or(noServices)).toBeVisible({ timeout: 30_000 });

      if ((await noServices.count()) === 0) {
        const assignAll = this.page.locator('[data-test="ats-assign-all"]');
        await expect(assignAll, 'service cards rendered but "Assign all" is missing').toBeVisible();
        await assignAll.click();
      }
    }

    // `ats-done` commits BOTH the create and the service assignment: the HAR of
    // a real session shows POST /travellers/new and POST
    // /travellers/{id}/services fired from this one click, and the audit stream
    // records TravelerInfo and TravelerAssignedToServices in the same second.
    // captureWrite therefore returns the create call; the assignment lands too.
    return this.captureWrite(
      async () => { await this.page.locator('[data-test="ats-done"]').click(); },
      /\/travellers\/new$/i,
    );
  }

  // ── Flow 6: remove ONE service from a traveller (assignment matrix) ───────

  /**
   * Unticks a single cell in the Assignment matrix, which fires
   * `DELETE {management}/offers/{offerId}/services/{serviceId}/travellers/{travelerId}`
   * and should produce `TravelerRemovedFromServiceIntegrationEvent` — the
   * singular event, and the only one that carries a populated `serviceId`.
   *
   * Distinct from removing the traveller outright: that fires the batched
   * `TravelerRemovedFromServices` (plural, `serviceId` null) alongside
   * `TravelerRemoved`. Both shapes were seen in one real session's HAR.
   *
   * The matrix cells carry no `data-test`, so this targets the checkbox's
   * aria-label — `"{firstName} assigned to {serviceLabel}"` — which is stable
   * app-authored text and, being user-visible semantics, arguably a better
   * anchor than a bolted-on hook.
   */
  async removeServiceFromTraveller(travellerFirstName: string, serviceLabel: string): Promise<TravelerWriteCall> {
    await this.openAssignmentTab();

    const cell = this.page.getByLabel(`${travellerFirstName} assigned to ${serviceLabel}`);
    await expect(cell, `no matrix cell for "${travellerFirstName}" × "${serviceLabel}"`).toBeVisible({
      timeout: 30_000,
    });
    await expect(cell, 'cell is already unassigned — nothing to remove').toBeChecked();

    return this.captureWrite(
      async () => { await cell.click(); },
      /\/services\/[0-9a-f-]{36}\/travellers\/[0-9a-f-]{36}$/i,
      ['DELETE'],
    );
  }

  /** Service labels currently assigned to a traveller, read from the matrix. */
  async assignedServiceLabels(travellerFirstName: string): Promise<string[]> {
    await this.openAssignmentTab();
    const prefix = `${travellerFirstName} assigned to `;
    const boxes = this.page.locator(`[aria-label^="${prefix}"]`);
    const labels: string[] = [];

    for (let index = 0; index < (await boxes.count()); index++) {
      const box = boxes.nth(index);
      if (await box.isChecked().catch(() => false)) {
        const label = (await box.getAttribute('aria-label')) ?? '';
        labels.push(label.slice(prefix.length));
      }
    }
    return labels;
  }

  /**
   * Every assignment-matrix cell's aria-label. Diagnostic: when a service-level
   * test finds nothing assigned, this distinguishes "the matrix has no cells at
   * all" from "the cells are there but this traveller's are unchecked" — which
   * point at a fixture problem and a product/POM problem respectively.
   */
  async matrixCellLabels(): Promise<string[]> {
    await this.openAssignmentTab();
    return this.page
      .locator('[data-test="assignment-matrix"] input[type="checkbox"]')
      .evaluateAll((boxes) =>
        boxes.map((box) => {
          const label = box.getAttribute('aria-label')
            ?? box.closest('[aria-label]')?.getAttribute('aria-label')
            ?? '(no aria-label)';
          return `${label} [${(box as HTMLInputElement).checked ? 'checked' : 'unchecked'}]`;
        }),
      );
  }

  private async openAssignmentTab(): Promise<void> {
    // The sub-tab buttons carry no data-test in either app, so go by role+name.
    const tab = this.page.getByRole('button', { name: 'Assignment', exact: true });
    if (await tab.isVisible().catch(() => false)) await tab.click();
    await expect(this.page.locator('[data-test="assignment-matrix"]')).toBeVisible({ timeout: 30_000 });
  }

  // ── Flow 4: turn "Is travelling" off for an already-attached client ───────

  /**
   * Removes a traveller from the pool via the roster toggle. A client with
   * service assignments raises a confirmation dialog first; accept it when it
   * appears rather than assuming either way, since it depends on trip state.
   */
  async turnOffIsTravelling(travelerId: string): Promise<TravelerWriteCall> {
    const row = this.page.locator(`[data-test="roster-row"][data-traveler-id="${travelerId}"]`);
    await expect(row).toBeVisible();

    return this.captureWrite(
      async () => {
        await row.locator('[data-test="roster-is-travelling"] input[type="checkbox"]').click();
        const accept = this.page.locator('[data-test="roster-travelling-confirm-accept"]');
        if (await accept.isVisible({ timeout: 3_000 }).catch(() => false)) {
          await accept.click();
        }
      },
      /\/travellers\//i,
      ['POST', 'DELETE', 'PUT', 'PATCH'],
    );
  }

  // ── Flow 5: remove a traveller from the offer entirely ────────────────────

  /**
   * The roster's Remove button — a DELETE to
   * `{management}/offers/{offerId}/travellers/{travelerId}`, with no
   * confirmation dialog (unlike the "Is travelling" toggle, which can raise
   * one). This is a DIFFERENT removal path from turnOffIsTravelling: Remove is
   * **disabled for the client row** (`item.role === 'client'`), so it only ever
   * applies to companions and ad-hoc travellers, while the client leaves the
   * pool via the toggle. Both paths need covering; neither substitutes for the
   * other.
   *
   * Expect `TravelerRemovedIntegrationEvent` and, when the traveller had
   * service assignments, also `TravelerRemovedFromService(s)`. A traveller with
   * no assignments produces only the former — verified in dev.
   */
  async removeTraveller(travelerId: string): Promise<TravelerWriteCall> {
    const row = this.page.locator(`[data-test="roster-row"][data-traveler-id="${travelerId}"]`);
    await expect(row).toBeVisible();

    const button = row.locator('[data-test="roster-remove"]');
    await expect(
      button,
      'Remove is disabled for this row — it is disabled for the client (use turnOffIsTravelling) and for non-removable travellers',
    ).toBeEnabled();

    return this.captureWrite(
      async () => { await button.click(); },
      /\/travellers\/[0-9a-f-]{36}$/i,
      ['DELETE'],
    );
  }

  /**
   * Roster rows whose Remove button is actually enabled (i.e. not the client).
   *
   * Reads the INNER `<button>`'s `disabled` property. `data-test="roster-remove"`
   * sits on the `nex-button` host, and Playwright's isEnabled() on a custom
   * element reports enabled regardless of the real control inside it — so
   * checking the host would have called the client row removable, and the client
   * row is exactly the one that is not.
   */
  async removableTravelerIds(): Promise<string[]> {
    return this.page.locator('[data-test="roster-row"]').evaluateAll((rows) =>
      rows
        .filter((row) => {
          const button = row.querySelector('[data-test="roster-remove"] button')
            ?? row.querySelector('[data-test="roster-remove"]');
          return button instanceof HTMLButtonElement ? !button.disabled : false;
        })
        .map((row) => row.getAttribute('data-traveler-id') ?? '')
        .filter((id) => id.length > 0),
    );
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Reads the real DOM `.checked` property, not the a11y snapshot — the box
   * reports value="on" whether ticked or not.
   */
  private async assertCompanionBoxUnchecked(): Promise<void> {
    const box = this.page.locator('[data-test="ats-companion-card"] input[type="checkbox"]');
    if ((await box.count()) === 0) return; // no client on the offer -> no companion option
    await expect(
      box.first(),
      'the "save as a companion" box is checked, so this would create a Companion, not an ad-hoc traveller',
    ).not.toBeChecked();
  }

  private async openAddTravellerSheet(): Promise<void> {
    const button = this.page.locator(this.selectors.addTraveller);
    // Disabled until a client is attached ("Add a client first") — surface that
    // as a clear message instead of a generic click timeout.
    await expect(button, 'Add traveller is disabled — attach a client to the offer first').toBeEnabled({
      timeout: 30_000,
    });
    await button.click();
  }

  /** nex-input renders its own inner <input>, so target that when present. */
  private async fillSheetField(testId: string, value: string): Promise<void> {
    const host: Locator = this.page.locator(`[data-test="${testId}"]`);
    const inner = host.locator('input');
    const target = (await inner.count()) > 0 ? inner.first() : host;
    await target.fill(value);
  }
}

function safeJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
