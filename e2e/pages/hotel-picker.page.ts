import { expect, type Page, type Response } from '@playwright/test';

/**
 * The nested HOTEL remote's picker (apps/hotel), as it appears over a trip when the
 * itinerary's **Modify** hands off via `requestOpenShopping({ mode: 'replace' })`.
 *
 * Why this is its own page object rather than more methods on TripItineraryPage: the
 * itinerary tab (apps/tsp) and the picker (apps/hotel) are separate federation remotes
 * with separate DOMs and separate owners. `hotel-service-lifecycle.spec.ts`'s closing
 * note asks for exactly this split, so a picker failure is never reported as an
 * itinerary failure.
 *
 * SELECTORS — read from apps/hotel source, not guessed:
 *
 *   results        `[data-hotel-card]` / `[data-hotel-name]` / `[data-hotel-price]`
 *                  (hotel-result-card.component.html)
 *   replace banner `[data-replacing-strip]` + `-name` / `-details` / `-price`
 *                  (hotel-replacing-strip.component) — only rendered in replace mode,
 *                  so it is the signal that Modify carried the serviceId through
 *   room list      `[data-pdp-section-rooms]`, `[data-room-row]`, `[data-room-name]`,
 *                  `[data-room-rate]`, `[data-rate-on-request]`
 *   one room       `[data-select-rate-<rateId>]` — stamped by SelectRateAttrDirective
 *                  because Angular cannot bind dynamic attribute NAMES
 *   summary        `[data-pdp-delta]`, `[data-pdp-price-amount]`, `[data-pdp-room-label]`,
 *                  `[data-pdp-summary-hint]`
 *   commit         `[data-pdp-commit]` (native <button>, so `.disabled` is readable),
 *                  `[data-pdp-back-to-results]`
 *
 * ROOM NAME vs RATE NAME is the distinction this suite exists to protect. `roomName` is
 * the room classification ("Classic", "Deluxe"); `rateName` is the rate plan ("Online
 * Rate"). The template comment records a prior bug where the rate plan was rendered as
 * the room name, and `roomName || rateName` is still the fallback — so a test that only
 * read one line could not tell a correct render from a regressed one.
 */

/** The SG write that commits a room change. */
const REPLACE_FROM_PICK = /\/draft-trips\/[0-9a-f-]{36}\/services\/[0-9a-f-]{36}\/replace-from-pick/i;

export interface PickedRoom {
  /** Room classification, e.g. "Deluxe King". Undefined when the card renders only a rate plan. */
  roomName?: string;
  /** Rate plan, e.g. "Online Rate". Rendered only when it differs from the room name. */
  rateName?: string;
  beddingOrBoard: string[];
  priceText: string;
  onRequest: boolean;
  selected: boolean;
}

export interface ReplaceWriteCall {
  url: string;
  method: string;
  status: number;
  tripId?: string;
  serviceId?: string;
  requestBody?: unknown;
}

export class HotelPickerPage {
  constructor(private readonly page: Page) {}

  private readonly rooms = () => this.page.locator('[data-room-row]');
  private readonly commit = () => this.page.locator('[data-pdp-commit]');

  /**
   * Waits for the picker to reach the room list, taking the results detour when the
   * remote opens on search results rather than straight on the property.
   *
   * `hotelNameFragment` picks the right result card when it does. Passing the service's
   * own name keeps a replace on the same property; omit it to take the first card.
   */
  async waitForRoomList(hotelNameFragment?: string, timeoutMs = 90_000): Promise<void> {
    const roomsSection = this.page.locator('[data-pdp-section-rooms]');
    const cards = this.page.locator('[data-hotel-card]');

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await roomsSection.count()) > 0) {
        // The section renders before the rooms do — "Loading rooms…" sits inside it.
        await expect(this.page.locator('[data-pdp-loading]')).toHaveCount(0, { timeout: timeoutMs });
        return;
      }
      if ((await cards.count()) > 0) {
        const card = hotelNameFragment
          ? cards.filter({ hasText: hotelNameFragment }).first()
          : cards.first();
        // Fall back to the first card when the named property is not in this result set —
        // the room-type assertions do not depend on WHICH hotel, only on a room list.
        const target = (await card.count()) > 0 ? card : cards.first();
        await target.click();
        continue;
      }
      await this.page.waitForTimeout(800);
    }

    throw new Error(
      `The hotel picker never reached a room list within ${timeoutMs}ms. A "Sign In" page here ` +
        'means the saved session expired — run `npm run e2e:auth-manual`.',
    );
  }

  /** True when the replace-mode banner rendered, i.e. Modify carried a serviceId through. */
  async isReplaceMode(): Promise<boolean> {
    return (await this.page.locator('[data-replacing-strip]').count()) > 0;
  }

  /** What the replace banner says is being replaced. */
  async replacingSummary(): Promise<{ name?: string; details?: string; price?: string }> {
    const read = async (selector: string): Promise<string | undefined> => {
      const locator = this.page.locator(selector);
      if ((await locator.count()) === 0) return undefined;
      return ((await locator.first().textContent()) ?? '').trim() || undefined;
    };
    return {
      name: await read('[data-replacing-name]'),
      details: await read('[data-replacing-details]'),
      price: await read('[data-replacing-price]'),
    };
  }

  /** Every room card on offer, in render order. */
  async roomOptions(): Promise<PickedRoom[]> {
    return this.rooms().evaluateAll((rows) =>
      rows.map((row) => {
        const text = (selector: string): string | undefined => {
          const value = (row.querySelector(selector)?.textContent ?? '').trim();
          return value || undefined;
        };
        return {
          roomName: text('[data-room-name]'),
          rateName: text('[data-room-rate]'),
          beddingOrBoard: Array.from(row.querySelectorAll('.hotel-pdp__room-tags > *'))
            .map((tag) => (tag.textContent ?? '').trim())
            .filter(Boolean),
          priceText: (row.querySelector('.hotel-pdp__room-price')?.textContent ?? '').trim(),
          onRequest: row.querySelector('[data-rate-on-request]') !== null,
          // aria-pressed is the component's own selection state, not a class guess.
          selected: row.getAttribute('aria-pressed') === 'true',
        };
      }),
    );
  }

  /**
   * Selects a room card by its visible room name. Selection is LOCAL — it updates the
   * summary sidebar and nothing else; only `commitRoomChange()` writes to the trip.
   */
  async selectRoomByName(roomNameFragment: string): Promise<void> {
    const row = this.rooms().filter({ hasText: roomNameFragment }).first();
    await expect(row, `no room card matching "${roomNameFragment}"`).toBeVisible({ timeout: 30_000 });
    await row.click();
    await expect(row).toHaveAttribute('aria-pressed', 'true');
  }

  /** Selects by index — for "pick a different room than the one already selected". */
  async selectRoomAt(index: number): Promise<void> {
    const row = this.rooms().nth(index);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();
    await expect(row).toHaveAttribute('aria-pressed', 'true');
  }

  /** The summary sidebar's current state — what the advisor is about to commit. */
  async summary(): Promise<{ roomLabel?: string; price?: string; delta?: string; hint?: string }> {
    const read = async (selector: string): Promise<string | undefined> => {
      const locator = this.page.locator(selector);
      if ((await locator.count()) === 0) return undefined;
      return ((await locator.first().textContent()) ?? '').trim() || undefined;
    };
    return {
      roomLabel: await read('[data-pdp-room-label]'),
      price: await read('[data-pdp-price-amount]'),
      delta: await read('[data-pdp-delta]'),
      hint: await read('[data-pdp-summary-hint]'),
    };
  }

  async commitEnabled(): Promise<boolean> {
    const button = this.commit();
    if ((await button.count()) === 0) return false;
    return button.first().isEnabled();
  }

  async commitLabel(): Promise<string> {
    return ((await this.commit().first().textContent()) ?? '').trim();
  }

  /**
   * DESTRUCTIVE — commits the selected room and captures the `replace-from-pick` write.
   *
   * The request body is captured too: it carries the picked rate, which is the only place
   * the chosen room is visible on the wire (the DOM never exposes a travelServiceId, and
   * the response is a 202-style acknowledgement).
   */
  async commitRoomChange(): Promise<ReplaceWriteCall> {
    await expect(this.commit(), 'commit is disabled — no room is selected').toBeEnabled();

    const responsePromise = this.page.waitForResponse(
      (response: Response) => REPLACE_FROM_PICK.test(response.url()),
      { timeout: 120_000 },
    );

    await this.commit().click();
    const response = await responsePromise;

    let requestBody: unknown;
    try {
      requestBody = JSON.parse(response.request().postData() ?? 'null');
    } catch {
      requestBody = response.request().postData() ?? undefined;
    }

    return {
      url: response.url(),
      method: response.request().method(),
      status: response.status(),
      tripId: /\/draft-trips\/([0-9a-f-]{36})\//i.exec(response.url())?.[1],
      serviceId: /\/services\/([0-9a-f-]{36})\//i.exec(response.url())?.[1],
      requestBody,
    };
  }

  async backToResults(): Promise<void> {
    await this.page.locator('[data-pdp-back-to-results]').click();
  }
}
