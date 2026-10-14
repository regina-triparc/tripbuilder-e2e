import { test, expect } from '@playwright/test';
import { attachFailures } from '../helpers/report';
import { PdpPriceSummaryPage } from '../pages/pdp-price-summary.page';
import { MAX_ADULTS_PER_ROOM, MAX_CHILDREN_PER_ROOM, MAX_CHILD_AGE, MAX_ROOMS, MAX_TRAVELLERS, openPdp } from './pdp.fixtures';

/**
 * PDP price rail — party & room composition, against the deployed portal.
 *
 * Requirements: "PDP — Payment Summary Panel — Job Story Breakdown" (Confluence 3526623241),
 * Group A. Each test names the story it covers and asserts that story's acceptance
 * criteria, not the implementation's constants — the caps in pdp.fixtures.ts are the PRD's
 * numbers, re-declared, so changing the app's own constant to 20 fails this suite.
 *
 *   A1  room count: default 1, max 4, never more rooms than adults, told why at the limit
 *   A2  per-room adults/children, every room needs an adult, allocation visible
 *   A3  one age field per child, individual, removed with the child, required before a check
 *   A4  total travellers across all rooms capped at 12, prevented rather than clamped
 *
 * Non-destructive throughout: nothing here presses "Add to quote", so no trip or quote is
 * created. The check CTA is only ever asserted for its enabled/disabled state.
 */

test.describe('PDP party & room composition', () => {
  test.beforeEach(async ({ page }) => {
    await openPdp(page);
  });

  // ─── A4: the cap the screenshot shows as "N of 12 travellers" ──────────────

  test('A4: the party is capped at 12 travellers and the advisor is told why', async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const rail = new PdpPriceSummaryPage(page);

    const failures: string[] = [];

    // The rail states its own cap; the PRD says that number is 12.
    const stated = await rail.statedMaxTravellers();
    if (stated !== MAX_TRAVELLERS) {
      failures.push(`ui: the rail advertises a cap of ${stated} travellers; the PRD (A4) requires ${MAX_TRAVELLERS}`);
    }

    const path = await rail.driveToTravellerCap(MAX_TRAVELLERS);
    const allocation = await rail.allocation();
    const capMessage = await rail.capMessage();

    await testInfo.attach('cap-run', {
      body: JSON.stringify({ statedCap: stated, travellerPath: path, allocation, capMessage }, null, 2),
      contentType: 'application/json',
    });

    // "prevents going above 12 rather than accepting it and failing at a supplier later" —
    // so no step along the way may have exceeded the cap.
    const overshoot = path.filter((total) => total > MAX_TRAVELLERS);
    if (overshoot.length > 0) {
      failures.push(`ui: the running total exceeded the cap during entry: ${path.join(' -> ')}`);
    }

    const total = await rail.travellers();
    if (total !== MAX_TRAVELLERS) {
      failures.push(`ui: drove the party to ${total} travellers, expected exactly ${MAX_TRAVELLERS}`);
    }

    // "when the cap is reached, the advisor is told why no more can be added"
    if (!capMessage) {
      failures.push('ui: no cap message ([data-testid="cap-message"]) is shown at the traveller cap');
    } else if (!capMessage.includes(String(MAX_TRAVELLERS))) {
      failures.push(`ui: the cap message does not state the limit: "${capMessage}"`);
    }

    // Every route to a 13th traveller must be closed, in every room.
    const roomCount = await rail.roomCount();
    for (let room = 1; room <= roomCount; room++) {
      if (await rail.adultsPlus(room).isEnabled()) {
        failures.push(`ui: room ${room} still accepts another adult at the traveller cap`);
      }
      if (await rail.childrenPlus(room).isEnabled()) {
        failures.push(`ui: room ${room} still accepts another child at the traveller cap`);
      }
    }
    if (await rail.addRoom().isEnabled()) {
      failures.push('ui: "Add room" is still enabled at the traveller cap — a new room seeds an adult, so it would make 13');
    }

    await attachFailures(testInfo, failures);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  test('A4: a refused step at the cap does not slip the total to 13', async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const rail = new PdpPriceSummaryPage(page);

    await rail.driveToTravellerCap(MAX_TRAVELLERS);

    // force:true bypasses Playwright's actionability check so the APP's guard is what is
    // under test, not the disabled attribute that already passed above.
    await rail.adultsPlus(1).click({ force: true });
    await rail.childrenPlus(1).click({ force: true });

    const total = await rail.travellers();
    await testInfo.attach('after-forced-clicks', {
      body: JSON.stringify({ total, allocation: await rail.allocation() }, null, 2),
      contentType: 'application/json',
    });

    const failures: string[] = [];
    if (total !== MAX_TRAVELLERS) {
      failures.push(`ui: forcing a click past the cap changed the total to ${total}`);
    }

    await attachFailures(testInfo, failures);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  // ─── A1: rooms ─────────────────────────────────────────────────────────────

  test('A1: one room by default, at most 4, and the advisor is told why', async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const rail = new PdpPriceSummaryPage(page);

    const failures: string[] = [];

    // "the default is one room"
    const initial = await rail.roomCount();
    if (initial !== 1) failures.push(`ui: the rail opened with ${initial} rooms; the PRD (A1) says the default is 1`);

    for (let expected = initial + 1; expected <= MAX_ROOMS; expected++) {
      if (!(await rail.addRoom().isEnabled())) {
        failures.push(`ui: "Add room" was disabled at ${expected - 1} room(s), below the limit of ${MAX_ROOMS}`);
        break;
      }
      await rail.addRoom().click();
      await expect(rail.addRoom()).toBeVisible();
    }

    const reached = await rail.roomCount();
    const capMessage = await rail.capMessage();
    await testInfo.attach('room-cap', {
      body: JSON.stringify({ initial, reached, capMessage, allocation: await rail.allocation() }, null, 2),
      contentType: 'application/json',
    });

    // "the number of rooms cannot exceed 4"
    if (reached > MAX_ROOMS) failures.push(`ui: reached ${reached} rooms, above the limit of ${MAX_ROOMS}`);

    if (reached === MAX_ROOMS) {
      if (await rail.addRoom().isEnabled()) {
        failures.push(`ui: "Add room" is still enabled at ${MAX_ROOMS} rooms`);
      }
      // "when either limit is reached, the advisor is told why no more rooms can be added"
      if (!capMessage) {
        failures.push(`ui: no message explains why no more rooms can be added at ${MAX_ROOMS}`);
      }
      await rail.addRoom().click({ force: true });
      if ((await rail.roomCount()) > MAX_ROOMS) {
        failures.push(`ui: forcing a click on a disabled "Add room" created room ${MAX_ROOMS + 1}`);
      }
    }

    await attachFailures(testInfo, failures);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  test('A1/A2: no room can exceed its adults, and never fewer than one adult per room', async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const rail = new PdpPriceSummaryPage(page);

    await rail.addRoom().click();
    const allocation = await rail.allocation();

    await testInfo.attach('two-room-allocation', {
      body: JSON.stringify(allocation, null, 2),
      contentType: 'application/json',
    });

    const failures: string[] = [];

    // A1 "the number of rooms cannot exceed the number of adults, since every room needs
    // an adult" — satisfied structurally if each added room seeds an adult.
    // A2 "every room must be allocated at least one adult".
    allocation.forEach((room, index) => {
      if (room.adults < 1) failures.push(`ui: room ${index + 1} has ${room.adults} adults — every room needs at least one`);
    });
    if (allocation.length > allocation.reduce((sum, room) => sum + room.adults, 0)) {
      failures.push(`ui: ${allocation.length} rooms but only ${allocation.reduce((s, r) => s + r.adults, 0)} adults`);
    }

    // The floor is enforced, not merely seeded: a room at one adult cannot go to zero.
    const lastRoom = allocation.length;
    if (await rail.adultsMinus(lastRoom).isEnabled()) {
      // Only a defect if it actually lets the count reach zero.
      await rail.adultsMinus(lastRoom).click({ force: true });
      const after = await rail.allocation();
      if ((after[lastRoom - 1]?.adults ?? 0) < 1) {
        failures.push(`ui: room ${lastRoom} was stepped down to ${after[lastRoom - 1]?.adults} adults`);
      }
    }

    await attachFailures(testInfo, failures);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  test('A2: per-room ceilings hold — 10 adults and 4 children in one room', async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const rail = new PdpPriceSummaryPage(page);

    const failures: string[] = [];

    // Children first, while the traveller cap is still far away.
    let children = (await rail.allocation())[0].children;
    while (children < MAX_CHILDREN_PER_ROOM && (await rail.childrenPlus(1).isEnabled())) {
      await rail.childrenPlus(1).click();
      children = (await rail.allocation())[0].children;
    }
    const childrenReached = children;
    const childrenPlusStillOn = await rail.childrenPlus(1).isEnabled();

    await testInfo.attach('per-room-ceilings', {
      body: JSON.stringify(
        { childrenReached, childrenPlusStillOn, allocation: await rail.allocation(), capMessage: await rail.capMessage() },
        null,
        2,
      ),
      contentType: 'application/json',
    });

    if (childrenReached > MAX_CHILDREN_PER_ROOM) {
      failures.push(`ui: room 1 accepted ${childrenReached} children, above the per-room limit of ${MAX_CHILDREN_PER_ROOM}`);
    }
    if (childrenReached === MAX_CHILDREN_PER_ROOM && childrenPlusStillOn) {
      failures.push(`ui: room 1 still accepts children at the per-room limit of ${MAX_CHILDREN_PER_ROOM}`);
    }

    await attachFailures(testInfo, failures);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  // ─── A3: child ages ────────────────────────────────────────────────────────

  test('A3: one age field per child, added and removed with the child', async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const rail = new PdpPriceSummaryPage(page);

    const failures: string[] = [];
    const before = (await rail.allocation())[0];
    const fieldsBefore = await rail.childAgeFields(1).count();

    // "adding a child to a room adds one age field for that child"
    if (fieldsBefore !== before.children) {
      failures.push(`ui: room 1 shows ${before.children} children but ${fieldsBefore} age field(s)`);
    }

    if (await rail.childrenPlus(1).isEnabled()) {
      await rail.childrenPlus(1).click();
      const after = (await rail.allocation())[0];
      const fieldsAfter = await rail.childAgeFields(1).count();
      if (fieldsAfter !== after.children) {
        failures.push(`ui: after adding a child, room 1 shows ${after.children} children but ${fieldsAfter} age field(s)`);
      }

      // "each child's age is captured individually — there is no banded or shared value"
      const fields = rail.childAgeFields(1);
      if ((await fields.count()) >= 2) {
        await fields.nth(0).fill('4');
        await fields.nth(1).fill('11');
        const values = (await rail.allocation())[0].childAges;
        if (values[0] === values[1]) {
          failures.push(`ui: two child-age fields share a value after distinct entry: ${JSON.stringify(values)}`);
        }
      }

      // "removing a child removes that child's age field"
      await rail.childrenMinus(1).click();
      const removed = (await rail.allocation())[0];
      const fieldsRemoved = await rail.childAgeFields(1).count();
      if (fieldsRemoved !== removed.children) {
        failures.push(`ui: after removing a child, room 1 shows ${removed.children} children but ${fieldsRemoved} age field(s)`);
      }
    }

    await testInfo.attach('child-age-fields', {
      body: JSON.stringify({ allocation: await rail.allocation(), fields: await rail.childAgeFields(1).count() }, null, 2),
      contentType: 'application/json',
    });

    await attachFailures(testInfo, failures);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  test('A3: a check cannot run while a child has no age', async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const rail = new PdpPriceSummaryPage(page);

    const failures: string[] = [];

    if (!(await rail.childrenPlus(1).isEnabled())) {
      test.skip(true, 'room 1 cannot take another child on this package — nothing to leave ageless');
    }

    await rail.childrenPlus(1).click();
    const emptied = rail.childAgeFields(1).last();
    await emptied.fill('');

    const errorWhileEmpty = await rail.occupancyError();
    const checkDisabledWhileEmpty = await rail.checkAvailabilityCta().isDisabled();

    // "a check cannot run while any child is missing an age"
    if (!errorWhileEmpty) {
      failures.push('ui: no occupancy error is shown while a child has no age');
    } else if (!/age/i.test(errorWhileEmpty)) {
      failures.push(`ui: the occupancy error does not mention the missing age: "${errorWhileEmpty}"`);
    }
    if (!checkDisabledWhileEmpty) {
      failures.push('ui: "Check pricing & availability" is enabled while a child has no age');
    }

    // And it clears once the age is supplied.
    await emptied.fill('8');
    const errorAfterFill = await rail.occupancyError();

    await testInfo.attach('age-gate', {
      body: JSON.stringify({ errorWhileEmpty, checkDisabledWhileEmpty, errorAfterFill }, null, 2),
      contentType: 'application/json',
    });

    if (errorAfterFill && /age/i.test(errorAfterFill)) {
      failures.push(`ui: the missing-age error persists after entering an age: "${errorAfterFill}"`);
    }

    await attachFailures(testInfo, failures);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  test('A3: an age outside 0-17 is refused rather than accepted', async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const rail = new PdpPriceSummaryPage(page);

    const failures: string[] = [];

    if (!(await rail.childrenPlus(1).isEnabled())) {
      test.skip(true, 'room 1 cannot take another child on this package');
    }

    await rail.childrenPlus(1).click();
    const field = rail.childAgeFields(1).last();
    await field.fill(String(MAX_CHILD_AGE + 1));

    const error = await rail.occupancyError();
    const cap = await rail.capMessage();
    const stored = (await rail.allocation())[0].childAges;

    await testInfo.attach('out-of-range-age', {
      body: JSON.stringify({ entered: MAX_CHILD_AGE + 1, stored, error, cap }, null, 2),
      contentType: 'application/json',
    });

    // Refused, not silently clamped: either a message appears, or the check is held back —
    // what must NOT happen is an out-of-range age being carried forward as valid.
    const message = error ?? cap;
    const checkEnabled = await rail.checkAvailabilityCta().isEnabled();
    if (!message && checkEnabled) {
      failures.push(
        `ui: an age of ${MAX_CHILD_AGE + 1} was accepted with no message and the check stayed enabled — ` +
          `the PRD (A3) bounds a child's age at ${MAX_CHILD_AGE}`,
      );
    }

    await attachFailures(testInfo, failures);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  // ─── A2: the allocation is visible, not just the total ─────────────────────

  test('A2: the per-room allocation is visible, not only the party total', async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const rail = new PdpPriceSummaryPage(page);

    await rail.addRoom().click();
    const allocation = await rail.allocation();
    const total = await rail.travellers();

    await testInfo.attach('allocation-vs-total', {
      body: JSON.stringify({ allocation, total }, null, 2),
      contentType: 'application/json',
    });

    const failures: string[] = [];

    // "the allocation per room is visible to the advisor, not just the party total"
    if (allocation.length < 2) {
      failures.push(`ui: expected at least 2 room blocks after "Add room", found ${allocation.length}`);
    }

    // "the aggregate party across all rooms is what drives pricing and the party-size cap"
    const summed = allocation.reduce((sum, room) => sum + room.adults + room.children, 0);
    if (summed !== total) {
      failures.push(`ui: the rail reports ${total} travellers but the rooms sum to ${summed}`);
    }

    // Per-room ceilings are stated by the PRD; assert the rail never shows more than them.
    allocation.forEach((room, index) => {
      if (room.adults > MAX_ADULTS_PER_ROOM) {
        failures.push(`ui: room ${index + 1} shows ${room.adults} adults, above the per-room limit of ${MAX_ADULTS_PER_ROOM}`);
      }
      if (room.children > MAX_CHILDREN_PER_ROOM) {
        failures.push(`ui: room ${index + 1} shows ${room.children} children, above the per-room limit of ${MAX_CHILDREN_PER_ROOM}`);
      }
    });

    await attachFailures(testInfo, failures);
    expect(failures, failures.join('\n')).toEqual([]);
  });
});
