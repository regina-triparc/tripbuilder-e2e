import { test, expect } from '@playwright/test';
import { attachFailures } from '../helpers/report';
import { openPdp } from './pdp.fixtures';

/**
 * PDP price rail — start date and derived end date.
 *
 * Requirements: "PDP — Payment Summary Panel — Job Story Breakdown" (Confluence 3526623241),
 * story B1:
 *
 *   - the advisor selects a START DATE ONLY
 *   - the end date is DERIVED from the template's itinerary length and DISPLAYED, not entered
 *   - changing the start date re-derives the end date
 *   - blackout dates cannot be selected
 *
 * Out of scope per the PRD, and so deliberately absent here: extra nights before/after the
 * package and the itinerary date cascade. Those moved to the quote page in V2.
 *
 * The rail renders one `nex-datepicker` (`nexName="startDate"`) plus a read-only
 * `[data-testid="pdp-derived-end"]` caption reading "Ends MM/DD/YYYY · N nights". The
 * caption, not a second field, is the whole point of B1 — so "how many date inputs exist"
 * is itself an assertion.
 */

/** MM/DD/YYYY, which is what the rail's field is formatted to accept. */
function formatDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${month}/${day}/${date.getFullYear()}`;
}

function daysFromNow(days: number): Date {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return date;
}

test.describe('PDP start date and derived end date', () => {
  test('B1: the advisor enters a start date only — the end date is displayed, not entered', async ({
    page,
  }, testInfo) => {
    test.setTimeout(240_000);
    const { rail } = await openPdp(page);

    const failures: string[] = [];

    // Before any date: no derived end, and neither CTA may run — a check needs a stay window.
    const endBefore = await rail.derivedEnd();
    if (endBefore) {
      failures.push(`ui: a derived end date is shown before any start date was chosen: "${endBefore}"`);
    }
    if (await rail.checkAvailabilityCta().isEnabled()) {
      failures.push('ui: "Check pricing & availability" is enabled with no start date selected');
    }
    if (await rail.addToQuoteCta().isEnabled()) {
      failures.push('ui: "Add to quote" is enabled with no start date selected');
    }

    // "the advisor selects a start date only" — exactly one date field in the rail.
    const dateInputs = page.locator('nex-datepicker input');
    const inputCount = await dateInputs.count();
    if (inputCount !== 1) {
      failures.push(
        `ui: the rail exposes ${inputCount} date input(s); B1 requires exactly one (start date), with ` +
          'the end date derived and displayed rather than entered',
      );
    }

    const start = daysFromNow(45);
    if (inputCount >= 1) {
      await dateInputs.first().fill(formatDate(start));
      await dateInputs.first().blur();
    }

    // "the end date is derived from the template's itinerary length and displayed"
    await expect(
      page.getByTestId('pdp-derived-end'),
      'no derived end date rendered after a start date was entered',
    ).toBeVisible({ timeout: 30_000 });
    const endAfter = await rail.derivedEnd();

    await testInfo.attach('start-and-derived-end', {
      body: JSON.stringify({ enteredStart: formatDate(start), endBefore, endAfter, dateInputs: inputCount }, null, 2),
      contentType: 'application/json',
    });

    if (!endAfter) {
      failures.push('ui: the derived-end caption rendered but is empty');
    } else {
      if (!/Ends\s+\d{2}\/\d{2}\/\d{4}/.test(endAfter)) {
        failures.push(`ui: the derived end does not read as "Ends MM/DD/YYYY": "${endAfter}"`);
      }
      // The package length is what derives it, so the caption must state nights and the
      // end must be AFTER the start — a same-day or earlier end is a derivation bug.
      const nights = /(\d+)\s+night/.exec(endAfter);
      if (!nights) {
        failures.push(`ui: the derived end does not state the number of nights: "${endAfter}"`);
      } else if (Number(nights[1]) < 1) {
        failures.push(`ui: the derived end claims ${nights[1]} nights`);
      }
      const endDate = /Ends\s+(\d{2}\/\d{2}\/\d{4})/.exec(endAfter)?.[1];
      if (endDate && new Date(endDate).getTime() <= start.getTime()) {
        failures.push(`ui: the derived end (${endDate}) is not after the start (${formatDate(start)})`);
      }
    }

    await attachFailures(testInfo, failures);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  test('B1: changing the start date re-derives the end date', async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const { rail } = await openPdp(page);

    const failures: string[] = [];
    const input = page.locator('nex-datepicker input').first();

    const firstStart = daysFromNow(45);
    await input.fill(formatDate(firstStart));
    await input.blur();
    await expect(page.getByTestId('pdp-derived-end')).toBeVisible({ timeout: 30_000 });
    const firstEnd = await rail.derivedEnd();

    // Move the start by a week; the package length is unchanged, so the end must move with it.
    const secondStart = daysFromNow(52);
    await input.fill(formatDate(secondStart));
    await input.blur();
    const secondEnd = await rail.derivedEnd();

    await testInfo.attach('re-derivation', {
      body: JSON.stringify(
        { firstStart: formatDate(firstStart), firstEnd, secondStart: formatDate(secondStart), secondEnd },
        null,
        2,
      ),
      contentType: 'application/json',
    });

    if (!secondEnd) {
      failures.push('ui: the derived end disappeared after the start date changed');
    } else if (secondEnd === firstEnd) {
      failures.push(
        `ui: the start date moved from ${formatDate(firstStart)} to ${formatDate(secondStart)} but the ` +
          `derived end stayed "${firstEnd}" — it is not re-derived on change`,
      );
    } else {
      // The nights count is a property of the package, so it must NOT change with the start.
      const nightsOf = (text: string): string | undefined => /(\d+)\s+night/.exec(text)?.[1];
      const before = firstEnd ? nightsOf(firstEnd) : undefined;
      const after = nightsOf(secondEnd);
      if (before && after && before !== after) {
        failures.push(
          `ui: the package length changed with the start date (${before} nights -> ${after} nights); ` +
            "the itinerary length is the template's, not the date's",
        );
      }
    }

    await attachFailures(testInfo, failures);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  /**
   * B1's blackout criterion needs a date known to be blacked out for an activity in the
   * package under test. There is no fixture for that, and inventing one would assert a
   * rule rather than test it — so this is gated and skips by default.
   *
   * Set TB_PDP_BLACKOUT_DATE to an MM/DD/YYYY date that IS a blackout date for the
   * configured package.
   */
  test('B1: a blackout date cannot be selected', async ({ page }, testInfo) => {
    const blackout = process.env.TB_PDP_BLACKOUT_DATE?.trim();
    test.skip(
      !blackout,
      'TB_PDP_BLACKOUT_DATE is not set — set it to a date blacked out for this package to exercise B1',
    );
    test.setTimeout(240_000);

    const { rail } = await openPdp(page);
    const failures: string[] = [];

    const input = page.locator('nex-datepicker input').first();
    await input.fill(blackout!);
    await input.blur();

    const derived = await rail.derivedEnd();
    const checkEnabled = await rail.checkAvailabilityCta().isEnabled();

    await testInfo.attach('blackout-attempt', {
      body: JSON.stringify({ blackout, derived, checkEnabled }, null, 2),
      contentType: 'application/json',
    });

    // The PRD's reason for blocking up front: "letting the advisor pick a date only to be
    // told it is unavailable is poor UX". So the date must not be accepted as a valid stay.
    if (derived && checkEnabled) {
      failures.push(
        `ui: blackout date ${blackout} was accepted — a stay was derived ("${derived}") and the check ` +
          'is enabled, so the advisor can price a date the package cannot be sold on',
      );
    }

    await attachFailures(testInfo, failures);
    expect(failures, failures.join('\n')).toEqual([]);
  });
});
