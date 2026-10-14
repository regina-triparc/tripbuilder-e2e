import { expect, type Page } from '@playwright/test';

/**
 * The PDP's "Price summary" rail on the deployed portal — party composition (rooms,
 * per-room adults/children, per-child ages), the start date, and the two CTAs.
 *
 * Covers PRD stories A1-A4 and B1 of "PDP — Payment Summary Panel — Job Story Breakdown"
 * (Confluence 3526623241).
 *
 * SELECTORS — read from apps/tripbuilder-host's `pdp-room-occupancy` and
 * `pdp-price-summary` templates, not guessed. The component's own doc comment states the
 * `data-testid` hooks are a fixed test contract (2026-09-13 plan, Task 14), so they are
 * safe to depend on:
 *
 *   room blocks   `[data-testid="room"]`, `room-<n>-remove`
 *   adults        `room-<n>-adults`, `room-<n>-adults-plus`, `room-<n>-adults-minus`
 *   children      `room-<n>-children`, `room-<n>-children-plus`, `room-<n>-children-minus`
 *   child ages    `room-<n>-child-age` (one per child, positional)
 *   rooms footer  `add-room`, `traveller-count` ("3 of 12 travellers")
 *   messages      `cap-message` (a cap was hit), `occupancy-error` (allocation incomplete)
 *   derived end   `pdp-derived-end` ("Ends MM/DD/YYYY · N nights")
 *
 * Rooms are addressed 1-BASED, matching the visible "Room 1" heading and the testid
 * suffixes, so a failure message lines up with what the tester sees on screen.
 *
 * The steppers and the add/remove controls are plain native buttons on purpose (the
 * component records why: a `<nex-button>` has no native `.disabled` IDL property, and the
 * test contract reads it), so `toBeDisabled()` is reliable on them. The two CTAs ARE
 * `nex-button`s, so they are addressed by role+name, which resolves the inner native
 * button.
 */

export interface RoomAllocation {
  adults: number;
  children: number;
  /** One entry per child age field, in render order. Empty string = not yet filled. */
  childAges: string[];
}

export class PdpPriceSummaryPage {
  constructor(private readonly page: Page) {}

  private readonly rooms = () => this.page.getByTestId('room');

  /**
   * Waits for the rail's occupancy editor to mount, and fails with something actionable
   * when it does not. `add-room` is the marker: it renders only once the auth guard has
   * passed AND the template resolved through PIM, so one wait covers both.
   */
  async waitForRail(timeoutMs = 90_000): Promise<void> {
    const addRoom = this.page.getByTestId('add-room');
    const gone = this.page.getByRole('heading', { name: /no longer available/i });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await addRoom.count()) > 0) {
        await expect(addRoom).toBeVisible();
        return;
      }
      if ((await gone.count()) > 0) {
        throw new Error(
          'The PDP rendered "This package is no longer available" — the template did not resolve ' +
            'in this environment. Point TB_PDP_TEMPLATE_SLUG at a published package.',
        );
      }
      // A stale session redirects the deep link to the BFF login and lands on /slp with the
      // requested path discarded. Caught explicitly so it reads as an auth problem rather
      // than a mystery timeout — that mis-read cost a full 11-case run once already.
      const url = this.page.url();
      if (/\/bff\/login|auth\.uat\.triparcservices\.com|login\.microsoftonline\.com/.test(url)) {
        throw new Error(
          `The deep link was redirected to sign-in (${url}). The stored session is not valid, so ` +
            'the suite never reached the PDP. Re-run WITH the setup dependency (`npm run e2e:pdp`), ' +
            'or for an MFA tenant: `npm run e2e:auth-manual` then `npm run e2e:pdp-manual`.',
        );
      }
      await this.page.waitForTimeout(500);
    }
    throw new Error(
      `The price rail never mounted within ${timeoutMs}ms, ending on ${this.page.url()}. If that is ` +
        '/slp, the deep link lost its path to a sign-in redirect — see `npm run e2e:auth-manual`.',
    );
  }

  // ─── reading state ─────────────────────────────────────────────────────────

  async roomCount(): Promise<number> {
    return this.rooms().count();
  }

  /** The full allocation as the rail currently shows it. */
  async allocation(): Promise<RoomAllocation[]> {
    return this.rooms().evaluateAll((blocks) =>
      blocks.map((block) => {
        const number = (suffix: string): number => {
          const element = Array.from(block.querySelectorAll('[data-testid]')).find((candidate) =>
            (candidate.getAttribute('data-testid') ?? '').endsWith(suffix),
          );
          return Number((element?.textContent ?? '0').trim());
        };
        return {
          adults: number('-adults'),
          children: number('-children'),
          childAges: Array.from(
            block.querySelectorAll<HTMLInputElement>('[data-testid$="-child-age"]'),
          ).map((input) => input.value),
        };
      }),
    );
  }

  /** The integer from "N of 12 travellers". */
  async travellers(): Promise<number> {
    const text = (await this.page.getByTestId('traveller-count').textContent()) ?? '';
    const match = /(\d+)\s+of\s+(\d+)/.exec(text);
    if (!match) throw new Error(`Could not parse the traveller count from "${text}"`);
    return Number(match[1]);
  }

  /** The cap stated by the rail itself — asserted against the PRD's 12 rather than trusted. */
  async statedMaxTravellers(): Promise<number> {
    const text = (await this.page.getByTestId('traveller-count').textContent()) ?? '';
    const match = /(\d+)\s+of\s+(\d+)/.exec(text);
    if (!match) throw new Error(`Could not parse the traveller cap from "${text}"`);
    return Number(match[2]);
  }

  async capMessage(): Promise<string | undefined> {
    const locator = this.page.getByTestId('cap-message');
    if ((await locator.count()) === 0) return undefined;
    return ((await locator.first().textContent()) ?? '').trim() || undefined;
  }

  async occupancyError(): Promise<string | undefined> {
    const locator = this.page.getByTestId('occupancy-error');
    if ((await locator.count()) === 0) return undefined;
    return ((await locator.first().textContent()) ?? '').trim() || undefined;
  }

  /** "Ends MM/DD/YYYY · N nights", or undefined before a start date is chosen. */
  async derivedEnd(): Promise<string | undefined> {
    const locator = this.page.getByTestId('pdp-derived-end');
    if ((await locator.count()) === 0) return undefined;
    return ((await locator.first().textContent()) ?? '').trim() || undefined;
  }

  // ─── controls ──────────────────────────────────────────────────────────────

  adultsPlus(room: number) {
    return this.page.getByTestId(`room-${room}-adults-plus`);
  }
  adultsMinus(room: number) {
    return this.page.getByTestId(`room-${room}-adults-minus`);
  }
  childrenPlus(room: number) {
    return this.page.getByTestId(`room-${room}-children-plus`);
  }
  childrenMinus(room: number) {
    return this.page.getByTestId(`room-${room}-children-minus`);
  }
  addRoom() {
    return this.page.getByTestId('add-room');
  }
  removeRoom(room: number) {
    return this.page.getByTestId(`room-${room}-remove`);
  }
  childAgeFields(room: number) {
    return this.page.getByTestId(`room-${room}-child-age`);
  }

  // Methods, not getters, to match every other locator helper on this class
  // (`adultsPlus(room)`, `childAgeFields(room)`) — a mixed convention is how three tests
  // ended up calling `rail.checkAvailabilityCta()` against a getter and failing with
  // "is not a function".
  addToQuoteCta() {
    return this.page.getByRole('button', { name: /Add to quote|Adding…/ });
  }
  checkAvailabilityCta() {
    return this.page.getByRole('button', { name: /Check pricing & availability|Checking…/ });
  }

  /** Fills every child-age field in a room, so an incomplete age is never the reason a
   *  later assertion fails. */
  async fillChildAges(room: number, age = 8): Promise<void> {
    const fields = this.childAgeFields(room);
    const count = await fields.count();
    for (let index = 0; index < count; index++) {
      await fields.nth(index).fill(String(age));
    }
  }

  /**
   * Adds travellers until the rail reports the cap, opening a room whenever the current
   * one refuses more adults.
   *
   * Generic rather than a fixed number of clicks: the rail seeds its own party from the
   * search (the live page opens on 2 adults + 1 child), and a seed change must not
   * silently turn this into a test of the wrong total. Returns the sequence of totals so a
   * failure can show the path taken.
   */
  async driveToTravellerCap(cap: number): Promise<number[]> {
    const path: number[] = [];
    const maxSteps = cap * 2 + 10;

    for (let step = 0; step < maxSteps; step++) {
      const total = await this.travellers();
      path.push(total);
      if (total >= cap) return path;

      const lastRoom = await this.roomCount();
      if (await this.adultsPlus(lastRoom).isEnabled()) {
        await this.adultsPlus(lastRoom).click();
        continue;
      }
      if (await this.addRoom().isEnabled()) {
        await this.addRoom().click();
        continue;
      }
      throw new Error(
        `Stuck at ${total} traveller(s) across ${lastRoom} room(s): the adult stepper is disabled ` +
          `and no further room can be added. Path: ${path.join(' -> ')}`,
      );
    }

    throw new Error(`Did not reach ${cap} travellers within ${maxSteps} interactions. Path: ${path.join(' -> ')}`);
  }
}
