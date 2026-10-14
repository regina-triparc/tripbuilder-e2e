import { expect, type Page, type Response } from '@playwright/test';

/**
 * Page object for the TSP trip's Itinerary tab (`/tsp/:tripId/itinerary`), which
 * is where hotel and other travel services are listed, modified and deleted.
 *
 * SELECTOR SITUATION — worse than the Travellers tab, and worth knowing before
 * reading the locators below. The service rows carry **no `data-test`
 * attributes at all**: no row hook, no Modify/Delete hooks, no "Add Service"
 * hook, and crucially **no `travelServiceId` anywhere in the DOM**. Only the
 * read-only detail side-sheet is instrumented (`sds-*`). So:
 *
 *   - rows are addressed by their visible name, via the `.itin__svc-row` class
 *   - Modify / Delete are addressed by accessible name within a row
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
 *   Modify        the same shopping picker in mode:'replace', carrying the
 *                 serviceId and type. Disabled for service types with no
 *                 shoppable equivalent (Dining), via canReplace().
 *   Delete        DELETE {shopping-management}/trips/{tripId}/services/{id}?expectedVersion=N
 *                 — a direct write, no MFE hop. This is the deterministic one.
 *   Row click     opens the read-only detail sheet (sds-*). Modify/Delete stop
 *                 propagation so the sheet does not open underneath them.
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
  dayTitle?: string;
  modifyEnabled: boolean;
  deleteEnabled: boolean;
}

export class TripItineraryPage {
  constructor(private readonly page: Page) {}

  private readonly rows = () => this.page.locator('.itin__svc-row');

  async goto(tripId: string): Promise<void> {
    await this.page.goto(`/tsp/${tripId}/itinerary`);
    await this.waitForItineraryToSettle();
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
        const buttonState = (label: string): boolean => {
          const host = Array.from(row.querySelectorAll('nex-button, button')).find((element) =>
            (element.textContent ?? '').trim().toLowerCase().startsWith(label),
          );
          const button = host?.querySelector('button') ?? host;
          return button instanceof HTMLButtonElement ? !button.disabled : false;
        };
        return {
          name: (row.querySelector('.itin__svc-name')?.textContent ?? '').trim(),
          dayTitle: (row.closest('.itin__day-card')?.querySelector('.itin__day-title')?.textContent ?? '').trim(),
          modifyEnabled: buttonState('modify'),
          deleteEnabled: buttonState('delete'),
        };
      }),
    );
  }

  /** Switches the segmented control between the day view and the flat services view. */
  async showServicesView(): Promise<void> {
    await this.page.getByRole('button', { name: 'Services', exact: true }).click();
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

    const deleteButton = row.getByRole('button', { name: /^Delete/ });
    await expect(deleteButton, 'Delete is disabled for this row').toBeEnabled();

    return this.captureWrite(
      async () => { await deleteButton.click(); },
      /\/services\/[0-9a-f-]{36}/i,
      ['DELETE'],
    );
  }

  /** Opens the read-only detail sheet by clicking the row itself (not its buttons). */
  async openServiceDetail(nameFragment: string): Promise<void> {
    const row = this.rowByName(nameFragment);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.locator('.itin__svc-name').click();
    await expect(this.page.locator('[data-test="sds-close"]')).toBeVisible({ timeout: 30_000 });
  }

  /**
   * Hotel-specific fields from the detail sheet. Returns undefined for a field
   * the sheet did not render — for a hotel, `hotelPhone` is the marker that the
   * hotel branch rendered at all rather than the ground/activity/air one.
   */
  async serviceDetailFields(): Promise<{ hotelPhone?: string; notes?: string }> {
    const read = async (testId: string): Promise<string | undefined> => {
      const locator = this.page.locator(`[data-test="${testId}"]`);
      if ((await locator.count()) === 0) return undefined;
      const input = locator.locator('input, textarea');
      const target = (await input.count()) > 0 ? input.first() : locator.first();
      return ((await target.inputValue().catch(() => target.textContent())) ?? undefined) || undefined;
    };

    return { hotelPhone: await read('sds-hotel-phone'), notes: await read('sds-notes') };
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
      `Modify is disabled for "${nameFragment}" — canReplace() is false for service types with ` +
        'no shoppable equivalent (e.g. Dining)',
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
