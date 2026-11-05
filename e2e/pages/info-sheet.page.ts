import { expect, type Locator, type Page } from '@playwright/test';

/**
 * The read-only detail sheet of one service (`sds-*`), opened by clicking a card's title.
 *
 * It is no longer a modal dialog: it renders inline in the itinerary's Details panel
 * (observed 1 Nov 2026), as an <aside role="region"> labelled by its title:
 *
 *     section "Details"                       [data-test="tree-panel"]
 *       "Info only"                           [data-test="itin-line-status-tag"]
 *       region "<service title>"
 *         button "Close"                      [data-test="sds-close"]
 *         tablist
 *           tab "Details" [selected]
 *           tab "Travellers"                  (a Hotel sheet also has Presentation, Booking, T&Cs)
 *         [data-test="sds-schedule"]          "Date Dec 3, 2026 Start 6:30 PM End 8:00 PM" - 12-hour here,
 *                                             although the form's pickers take 24-hour "18:30"
 *         [data-test="sds-info-description"]  only rendered when the Info has a description
 *         button "Back"
 *
 * The trip page has its own tablist (Overview, Itinerary, Travellers, Payment,
 * Documents) outside the sheet, so tabs are always read from inside it. The name
 * `dialog` is kept for the sheet's root so existing specs read unchanged.
 */
export class InfoSheetPage {
  readonly dialog: Locator;

  constructor(
    private readonly page: Page,
    readonly serviceTitle: string,
  ) {
    this.dialog = page
      .locator('[data-test="tree-panel"]')
      .getByRole('region', { name: serviceTitle, exact: true });
  }

  get tabs(): Locator {
    return this.dialog.getByRole('tab');
  }

  tab(name: string): Locator {
    return this.dialog.getByRole('tab', { name, exact: true });
  }

  get schedule(): Locator {
    return this.dialog.locator('[data-test="sds-schedule"]');
  }

  get description(): Locator {
    return this.dialog.locator('[data-test="sds-info-description"]');
  }

  async waitOpen(): Promise<void> {
    await expect(this.dialog).toBeVisible({ timeout: 30_000 });
  }

  async close(): Promise<void> {
    await this.dialog.locator('[data-test="sds-close"]').click();
    await expect(this.dialog).toBeHidden({ timeout: 15_000 });
  }
}
