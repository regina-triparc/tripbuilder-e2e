import { expect, type Locator, type Page, type Response } from '@playwright/test';
import { InfoFormPage } from './info-form.page';
import { InfoSheetPage } from './info-sheet.page';

/**
 * Page object for the TSP trip's Itinerary tab (`/tsp/:tripId/itinerary`), which
 * is where hotel and other travel services are listed, modified and deleted.
 *
 * LAYOUT (observed 1 Nov 2026): the itinerary is now a content tree
 * (`[data-test="content-tree"]`) with a details panel beside it
 * (`[data-test="tree-panel"]`, region "Details"). The old `.itin__day-card` /
 * `.itin__svc-row` list, the per-row Modify button and the "Services" view toggle
 * are gone:
 *
 *     button "Add service"                       [data-test="tree-add-service"]  (toolbar)
 *     button "Day 1 Sat, Nov 28, 2026"           [data-test="tree-day-select"]
 *     region "Day 1 Sat, Nov 28, 2026"           one per day (expansion panel body)
 *       button "<title> <type> [meta] [alert]"   [data-test="tree-service-card"]
 *         button "Remove <title>"                [data-test="tree-card-delete"]
 *       button "Add service"                     [data-test="tree-day-add-service"]
 *
 * Clicking a card opens its detail sheet (`sds-*`) INSIDE the panel, together with
 * its status tag (`itin-line-status-tag`: "Info only", "Needs recheck", ...), which
 * used to be part of the row's own name. Still **no `travelServiceId` in the DOM**:
 *
 *   - cards are addressed by their visible title (`.card__title`)
 *   - Delete is the card's "Remove <title>" button plus a confirm alertdialog
 *   - the service id is recovered from the WRITE REQUEST the UI makes, exactly
 *     as the traveller suite recovers the offer id
 *
 * That last point is the important constraint: a test cannot pick a service
 * "by id" up front, because the id is not on the page. It picks by name, acts,
 * and learns the id from the URL the app calls. See `deleteServiceByName`.
 *
 * WHAT EACH ACTION ACTUALLY DOES (apps/tsp itinerary-view.component.ts):
 *   Add Service   publishes requestOpenShopping({mode:'add'}) — opens the nested
 *                 SHOPPING remote, so an add test crosses an MFE boundary and is
 *                 really a shopping test wearing an itinerary hat.
 *   Modify        was the same shopping picker in mode:'replace'. It is no longer
 *                 rendered on the cards or in the detail panel (observed 1 Nov 2026),
 *                 so `openModifyByName` fails with that message rather than guessing
 *                 at a replacement entry point.
 *   Delete        "Remove <title>" -> alertdialog "Remove service?" -> Remove, then
 *                 DELETE {shopping-management}/trips/{tripId}/services/{id}?expectedVersion=N
 *                 — a direct write, no MFE hop. This is the deterministic one.
 *   Card click    opens the read-only detail sheet (sds-*) in the Details panel.
 */

const SHOPPING_WRITE = /\/bff\/api\/shopping-management\/trips\/[0-9a-f-]{36}\//i;

export interface ServiceWriteCall {
  url: string;
  method: string;
  status: number;
  tripId: string;
  /** Recovered from the request path — the only place it is exposed. */
  serviceId?: string;
  expectedVersion?: string;
}

export interface ItineraryServiceRow {
  name: string;
  /** The card's type label: "Hotel", "Info", "Activity", "Transfer", ... */
  type: string;
  dayTitle?: string;
  modifyEnabled: boolean;
  deleteEnabled: boolean;
}

/** Service types on the Add Service picker, as their tiles are labelled. */
export type ShoppingTile = 'Hotel' | 'Flight' | 'Activity' | 'Ground transfer' | 'Cruise' | 'Info';

/** End of an Info card's accessible name; a selected card also names its revealed Remove button. */
const INFO_CARD_NAME_TAIL = ' Info(?: Remove .*)?$';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The trip QA specs work on when they add, edit and delete their own items: TB_QA_TRIP
 * (a trip name, matched as a case-insensitive pattern) or, unset, the dashboard's first trip.
 * Specs never name a trip: trips come and go on the shared account.
 */
function qaTripName(): RegExp | undefined {
  const name = process.env['TB_QA_TRIP']?.trim();
  return name ? new RegExp(name, 'i') : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class TripItineraryPage {
  constructor(private readonly page: Page) {}

  private readonly rows = () => this.page.locator('[data-test="tree-service-card"]');

  async goto(tripId: string): Promise<void> {
    await this.page.goto(`/tsp/${tripId}/itinerary`);
    await this.waitForItineraryToSettle();
  }

  /**
   * Opens a trip from the `/trips` dashboard by its row name (rows have no link) and
   * waits for the itinerary. A click that lands before the table's handlers are bound
   * leaves the page on the dashboard (seen in the 1 Nov 2026 run), so the click is
   * retried until the URL moves to `/tsp/:tripId`. The wait is then for the first day
   * header, which only renders with the days ("Loading trip…" precedes it).
   */
  async openTrip(tripName?: string | RegExp): Promise<void> {
    await this.page.goto('/');
    // No name: TB_QA_TRIP, else the first data row - the header is row 0.
    const name = tripName ?? qaTripName();
    const row = name ? this.page.getByRole('row', { name }).first() : this.page.getByRole('row').nth(1);
    await expect(row).toBeVisible({ timeout: 90_000 });
    await expect(async () => {
      if (!/\/tsp\//.test(this.page.url())) await row.click({ timeout: 10_000 });
      await this.page.waitForURL(/\/tsp\/[0-9a-f-]{36}/i, { timeout: 10_000 });
    }).toPass({ timeout: 60_000 });
    await this.waitForDays();
  }

  /** The current URL — `/tsp/:tripId/itinerary` once a trip is open. */
  url(): string {
    return this.page.url();
  }

  /** Waits for the first day header ("Loading trip…" precedes it), then for the rows to settle. */
  async waitForDays(timeoutMs = 120_000): Promise<void> {
    await expect(this.page.locator('[data-test="tree-day-header"]').first()).toBeVisible({ timeout: timeoutMs });
    await this.waitForItineraryToSettle();
  }

  /**
   * One day's region in the content tree, found by the start of its name:
   * `dayCard('Day 3')` matches region "Day 3 Mon, Nov 30, 2026" (not "Day 30 ...").
   * It holds that day's service cards and its own "Add service" button.
   */
  dayCard(dayLabel: string): Locator {
    return this.page.getByRole('region', { name: new RegExp(`^${escapeRegExp(dayLabel)}\\b`) });
  }

  /** The open trip's day labels in order: ["Day 1", "Day 2", ...]. Specs pick days from this, never by number. */
  async dayLabels(): Promise<string[]> {
    const labels = await this.page.locator('[data-test="tree-day-select"] .day__number').allInnerTexts();
    return labels.map((label) => label.trim()).filter(Boolean);
  }

  /** The day header text, e.g. "Day 3 Mon, Nov 30, 2026". */
  async dayTitle(dayLabel: string): Promise<string> {
    return (await this.dayHeader(dayLabel).innerText()).replace(/\s+/g, ' ').trim();
  }

  /** The day's date as the header shows it, without the weekday: "Nov 30, 2026". */
  async dayDate(dayLabel: string): Promise<string> {
    const text = (await this.dayHeader(dayLabel).locator('.day__date').innerText()).trim();
    return text.replace(/^[A-Za-z]{3},\s*/, '');
  }

  /** The day's date as the Info form's Date field holds it: "2026-11-30". */
  async dayIsoDate(dayLabel: string): Promise<string> {
    const date = await this.dayDate(dayLabel);
    const match = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/.exec(date);
    const month = match ? MONTHS.indexOf(match[1]) + 1 : 0;
    if (!match || month === 0) throw new Error(`unexpected day date "${date}" for ${dayLabel}`);
    return `${match[3]}-${String(month).padStart(2, '0')}-${match[2].padStart(2, '0')}`;
  }

  private dayHeader(dayLabel: string): Locator {
    return this.page
      .locator('[data-test="tree-day-select"]')
      .filter({ has: this.page.locator('.day__number', { hasText: new RegExp(`^${escapeRegExp(dayLabel)}$`) }) });
  }

  /** The "Add service" button inside a day, or the toolbar one when no day is given. */
  addServiceButton(dayLabel?: string): Locator {
    return dayLabel
      ? this.dayCard(dayLabel).locator('[data-test="tree-day-add-service"]')
      : this.page.locator('[data-test="tree-add-service"]');
  }

  /** A picker tile; tiles may carry an icon ligature before the label. */
  pickerTile(type: ShoppingTile): Locator {
    return this.page.getByRole('button', { name: new RegExp(`^(?:\\S+\\s+)?${escapeRegExp(type)}$`) });
  }

  /** The toolbar flow's first dialog: "Pick a day for the new service", one button per day. */
  get dayPicker(): Locator {
    return this.page.getByRole('dialog', { name: 'Pick a day for the new service' });
  }

  /** Opens the picker from the toolbar and, when `dayNumber` is given, picks that day ("Day 3 ·Lyon"). */
  async openToolbarAddService(dayNumber?: number): Promise<void> {
    await this.addServiceButton().click();
    await expect(this.dayPicker).toBeVisible({ timeout: 30_000 });
    if (dayNumber !== undefined) {
      await this.dayPicker.getByRole('button', { name: new RegExp(`^Day ${dayNumber} ·`) }).click();
    }
  }

  /** Day card -> Add Service -> Info tile; returns the open Add Info form. */
  async openAddInfo(dayLabel: string): Promise<InfoFormPage> {
    await this.addServiceButton(dayLabel).click();
    await this.pickerTile('Info').click();
    const form = new InfoFormPage(this.page, 'add');
    await form.waitOpen();
    return form;
  }

  /** Modify on an Info row; returns the open Edit Info form. */
  async openEditInfo(title: string): Promise<InfoFormPage> {
    await this.openModifyByName(title);
    const form = new InfoFormPage(this.page, 'edit');
    await form.waitOpen();
    return form;
  }

  /** Clicks an Info row's name and returns its detail sheet. */
  async openInfoSheet(title: string): Promise<InfoSheetPage> {
    await this.openServiceDetail(title);
    const sheet = new InfoSheetPage(this.page, title);
    await sheet.waitOpen();
    return sheet;
  }

  /**
   * An Info card. Its accessible name is "<title> Info", or "<title> Info Remove <title>"
   * while it is selected and its Remove button is revealed (observed 1 Nov 2026). The
   * "Info only" status is no longer part of the card name: read it from `statusTag`
   * once the card is open.
   */
  infoRow(title: string): Locator {
    return this.page.getByRole('button', { name: new RegExp(`^${escapeRegExp(title)}${INFO_CARD_NAME_TAIL}`) });
  }

  /**
   * A non-Info card whose title contains `nameFragment`. Its price status ("Live price",
   * "Needs recheck", ...) is shown by `statusTag` after `openServiceDetail`, not on the card.
   */
  pricedRow(nameFragment: string): Locator {
    return this.rows()
      .filter({ hasText: nameFragment })
      .filter({ hasNot: this.page.locator('.card__meta', { hasText: /^Info$/ }) })
      .first();
  }

  /** Every non-Info card in one day. */
  pricedRowsIn(dayLabel: string): Locator {
    return this.dayCard(dayLabel)
      .locator('[data-test="tree-service-card"]')
      .filter({ hasNot: this.page.locator('.card__meta', { hasText: /^Info$/ }) });
  }

  /** The open service's status tag in the Details panel: "Info only", "Needs recheck", ... */
  get statusTag(): Locator {
    return this.page.locator('[data-test="tree-panel"] [data-test="itin-line-status-tag"]');
  }

  /** The trip header's status group: "Price $80.55 ... Commission $14.50 ...", visible on every tab. */
  get tripStatus(): Locator {
    return this.page.getByRole('group', { name: 'Trip status' });
  }

  /** Price and commission as shown in the trip header, e.g. { price: '$80.55', commission: '$14.50' }. */
  async priceAndCommission(): Promise<{ price: string; commission: string }> {
    const text = (await this.tripStatus.innerText()).replace(/\s+/g, ' ');
    const price = /Price\s+(\S+)/.exec(text)?.[1];
    const commission = /Commission\s+(\S+)/.exec(text)?.[1];
    if (!price || !commission) throw new Error(`Trip status shows no price/commission: "${text}"`);
    return { price, commission };
  }

  /** Deletes every Info row whose title starts with `titlePrefix` - for afterEach cleanup. */
  async deleteInfosStartingWith(titlePrefix: string): Promise<number> {
    // A row added just before a failing assertion may not have rendered yet.
    await this.waitForItineraryToSettle();
    const rows = this.page.getByRole('button', {
      name: new RegExp(`^${escapeRegExp(titlePrefix)}.*?${INFO_CARD_NAME_TAIL}`),
    });
    let deleted = 0;
    while ((await rows.count()) > 0 && deleted < 20) {
      const name = (await rows.first().locator('.card__title').innerText()).trim();
      await this.deleteServiceByName(name);
      await expect(this.infoRow(name)).toHaveCount(0, { timeout: 30_000 });
      deleted += 1;
    }
    return deleted;
  }

  /**
   * Waits for the service list to stop changing rather than for the first thing
   * to appear — the same trap that made the traveller suite misread an empty
   * roster. "No services on this trip yet" and "No days on this trip yet" both
   * render transiently while the itinerary loads.
   */
  private async waitForItineraryToSettle(timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let previous = -1;

    while (Date.now() < deadline) {
      const count = await this.rows().count();
      const emptyText = await this.page.getByText(/No (services|days) on this trip yet/).count();

      if (count > 0 && count === previous) return;
      if (count === 0 && previous === 0 && emptyText > 0) return;

      previous = count;
      await this.page.waitForTimeout(800);
    }
    throw new Error(
      `Itinerary never settled within ${timeoutMs}ms (last row count ${previous}). A "Sign In" page ` +
        'here means the saved session expired — run `npm run e2e:auth-manual`.',
    );
  }

  /** Every service row with its visible name and which actions are available. */
  async services(): Promise<ItineraryServiceRow[]> {
    return this.rows().evaluateAll((rows) =>
      rows.map((row) => {
        const buttonState = (selector: string): boolean => {
          const button = row.querySelector(selector);
          return button instanceof HTMLButtonElement ? !button.disabled : false;
        };
        const header = row.closest('[role="region"]')?.getAttribute('aria-labelledby');
        return {
          name: (row.querySelector('.card__title')?.textContent ?? '').trim(),
          type: (row.querySelector('.card__meta > span')?.textContent ?? '').trim(),
          dayTitle: ((header && document.getElementById(header)?.textContent) || '').replace(/\s+/g, ' ').trim(),
          // Cards render no Modify control (observed 1 Nov 2026); this stays false until
          // one comes back, so a test that needs Modify fails visibly.
          modifyEnabled: buttonState('button[aria-label^="Modify"]'),
          deleteEnabled: buttonState('[data-test="tree-card-delete"] button'),
        };
      }),
    );
  }

  /**
   * Switches the segmented control between the day view and the flat services view.
   * The content tree has no such toggle (observed 1 Nov 2026), so this fails fast with
   * that message instead of waiting out the test timeout.
   */
  async showServicesView(): Promise<void> {
    const toggle = this.page.getByRole('button', { name: 'Services', exact: true });
    await expect(toggle, 'no "Services" view toggle on the itinerary; the content tree only groups by day').toBeVisible({
      timeout: 15_000,
    });
    await toggle.click();
    await this.waitForItineraryToSettle();
  }

  /**
   * Deletes the first service whose visible name contains `nameFragment`, and
   * returns the write call — which is where the `travelServiceId` comes from,
   * since the DOM never exposes it.
   */
  async deleteServiceByName(nameFragment: string): Promise<ServiceWriteCall> {
    const row = this.rowByName(nameFragment);
    await expect(row, `no itinerary row matching "${nameFragment}"`).toBeVisible({ timeout: 30_000 });

    // "Remove" is display:none until the card is hovered or selected; hover is lost when the
    // click scrolls, so select the card first (this also opens its detail sheet). Clicking an
    // already-selected card deselects it, hence the aria-pressed check.
    if ((await row.getAttribute('aria-pressed')) !== 'true') await row.locator('.card__title').click();
    await expect(row).toHaveAttribute('aria-pressed', 'true');
    const deleteButton = row.locator('[data-test="tree-card-delete"]').getByRole('button', { name: /^Remove / });
    await expect(deleteButton, 'Delete is disabled for this row').toBeEnabled();

    return this.captureWrite(
      async () => {
        await deleteButton.click();
        // alertdialog "Remove service?" -> Cancel / Remove.
        await this.page.locator('[data-test="tree-remove-service-confirm-accept"]').getByRole('button').click();
      },
      /\/services\/[0-9a-f-]{36}/i,
      ['DELETE'],
    );
  }

  /** Opens the read-only detail sheet (in the Details panel) by clicking the card's title. */
  async openServiceDetail(nameFragment: string): Promise<void> {
    const row = this.rowByName(nameFragment);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.locator('.card__title').click();
    await expect(this.page.locator('[data-test="sds-close"]')).toBeVisible({ timeout: 30_000 });
  }

  /**
   * Hotel-specific fields from the detail sheet. Returns undefined for a field
   * the sheet did not render — for a hotel, `hotelCheckIn` is the marker that the
   * hotel branch rendered at all rather than the ground/activity/air one. The old
   * marker, `sds-hotel-phone`, is gone: the sheet now says contact phone is managed
   * on the Travellers tab (observed 1 Nov 2026). Only the hotel branch has a
   * "Check-in" schedule row; activity and info show "Date", ground shows "Pickup".
   */
  async serviceDetailFields(): Promise<{ hotelCheckIn?: string; notes?: string }> {
    const read = async (testId: string): Promise<string | undefined> => {
      const locator = this.page.locator(`[data-test="${testId}"]`);
      if ((await locator.count()) === 0) return undefined;
      const input = locator.locator('input, textarea');
      const target = (await input.count()) > 0 ? input.first() : locator.first();
      return ((await target.inputValue().catch(() => target.textContent())) ?? undefined) || undefined;
    };

    const checkIn = this.page
      .locator('[data-test="sds-schedule"] .sds__schedule-row')
      .filter({ has: this.page.locator('.sds__schedule-label', { hasText: /^Check-in$/ }) })
      .locator('.sds__schedule-value');
    const hotelCheckIn = (await checkIn.count()) > 0 ? (await checkIn.first().innerText()).trim() : undefined;

    return { hotelCheckIn, notes: await read('sds-notes') };
  }

  async closeServiceDetail(): Promise<void> {
    await this.page.locator('[data-test="sds-close"]').click();
  }

  /**
   * Clicks "Modify" on the first row matching `nameFragment`, handing off to the nested
   * HOTEL remote in replace mode. Returns once the click has been issued — the picker is
   * a different remote, so waiting for it belongs to `HotelPickerPage.waitForRoomList()`
   * rather than here.
   *
   * Unlike `deleteServiceByName` there is no write to capture: Modify only publishes
   * `requestOpenShopping({ mode: 'replace' })` on the event bus. The write happens later,
   * inside the picker, as `replace-from-pick`.
   */
  async openModifyByName(nameFragment: string): Promise<void> {
    const row = this.rowByName(nameFragment);
    await expect(row, `no itinerary row matching "${nameFragment}"`).toBeVisible({ timeout: 30_000 });

    const modifyButton = row.getByRole('button', { name: /^Modify/ });
    await expect(
      modifyButton,
      `no enabled Modify on "${nameFragment}" — the content-tree cards render only "Remove" ` +
        '(observed 1 Nov 2026); for Dining, canReplace() is also false by design',
    ).toBeEnabled();

    await modifyButton.click();
  }

  /** True when "Modify" is available — false for types with no shoppable equivalent. */
  async canModify(nameFragment: string): Promise<boolean> {
    const services = await this.services();
    return services.find((service) => service.name.includes(nameFragment))?.modifyEnabled ?? false;
  }

  private rowByName(nameFragment: string) {
    return this.rows().filter({ hasText: nameFragment }).first();
  }

  private async captureWrite(
    action: () => Promise<void>,
    pathSuffix: RegExp,
    methods: string[],
  ): Promise<ServiceWriteCall> {
    const responsePromise = this.page.waitForResponse(
      (response: Response) =>
        methods.includes(response.request().method()) &&
        SHOPPING_WRITE.test(response.url()) &&
        pathSuffix.test(response.url()),
      { timeout: 60_000 },
    );

    await action();
    const response = await responsePromise;
    const url = new URL(response.url());

    return {
      url: response.url(),
      method: response.request().method(),
      status: response.status(),
      tripId: /\/trips\/([0-9a-f-]{36})\//i.exec(response.url())?.[1] ?? '',
      serviceId: /\/services\/([0-9a-f-]{36})/i.exec(response.url())?.[1],
      expectedVersion: url.searchParams.get('expectedVersion') ?? undefined,
    };
  }
}
