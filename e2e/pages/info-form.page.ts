import { expect, type Locator, type Page, type Response } from '@playwright/test';

/**
 * The Add / Edit Info form (TB-601), rendered by the shopping shell as a modal.
 *
 * Verified against UAT on 2026-10-21 with `ariaSnapshot()`:
 *
 *     dialog "Add Info"                     ("Edit Info" when opened from Modify)
 *       button "Close"
 *       textbox "Title"
 *       textbox "Date" [disabled]           "YYYY-MM-DD", taken from the day it was opened on
 *       combobox "Start" -> listbox "Start" -> option "00:00" ... "23:45"  (96, every 15 min)
 *       combobox "End"   -> listbox "End"   -> option "00:00" ... "23:45"
 *                                           the combobox is an <input placeholder="HH:mm">:
 *                                           assert it with toHaveValue('18:30'), not text
 *       .ql-editor                          the rich-text description (Quill, no accessible name);
 *                                           typed spaces are saved as &nbsp; in descriptionHtml
 *       button "Cancel"
 *       button "Add service"                ("Save changes" on the edit form)
 *
 * Writes (apps/shopping info-service.service.ts, PR #740) answer 202:
 *   add      POST /bff/api/shopping-orchestration/draft-trips/{tripId}/days/{day}/add-info-service
 *   replace  PUT  /bff/api/shopping-orchestration/draft-trips/{tripId}/services/{serviceId}/replace-info
 * with the body `{ title, descriptionHtml, startTime: "HH:mm:ss" | null, endTime, expectedVersion }`.
 */

export type InfoFormMode = 'add' | 'edit';

export interface InfoWriteCall {
  method: string;
  status: number;
  url: string;
  /** The JSON body the form sent: title, descriptionHtml, startTime, endTime, expectedVersion. */
  body: Record<string, unknown>;
}

/** A time option exactly as the dropdown lists it: 24-hour, 15-minute steps. */
const TIME_OPTION = /^([01]\d|2[0-3]):(00|15|30|45)$/;

export const INFO_WRITE_PATH = {
  add: /\/bff\/api\/shopping-orchestration\/draft-trips\/[^/]+\/days\/[^/]+\/add-info-service$/,
  edit: /\/bff\/api\/shopping-orchestration\/draft-trips\/[^/]+\/services\/[^/]+\/replace-info$/,
} as const;

export class InfoFormPage {
  readonly dialog: Locator;

  constructor(
    private readonly page: Page,
    readonly mode: InfoFormMode = 'add',
  ) {
    this.dialog = page.getByRole('dialog', { name: mode === 'add' ? 'Add Info' : 'Edit Info' });
  }

  get title(): Locator {
    return this.dialog.getByRole('textbox', { name: 'Title' });
  }

  get date(): Locator {
    return this.dialog.getByRole('textbox', { name: 'Date' });
  }

  get description(): Locator {
    return this.dialog.locator('.ql-editor');
  }

  /** The Start or End input; its value is the picked option, e.g. "18:30". */
  timeInput(which: 'Start' | 'End'): Locator {
    return this.dialog.getByRole('combobox', { name: which });
  }

  get submitButton(): Locator {
    return this.dialog.getByRole('button', { name: this.mode === 'add' ? 'Add service' : 'Save changes' });
  }

  async waitOpen(): Promise<void> {
    await expect(this.dialog).toBeVisible({ timeout: 30_000 });
  }

  /**
   * Picks `value` in the Start or End dropdown. Only the listed options exist, so a
   * value like "6:30 PM" fails here with a clear message instead of a 3-minute timeout.
   */
  async pickTime(which: 'Start' | 'End', value: string): Promise<void> {
    if (!TIME_OPTION.test(value)) {
      throw new Error(`"${value}" is not a ${which} option: the dropdown lists 24-hour "HH:mm" in 15-minute steps, e.g. "18:30".`);
    }
    await this.timeInput(which).click();
    await this.dialog.getByRole('listbox', { name: which }).getByRole('option', { name: value, exact: true }).click();
    await expect(this.timeInput(which)).toHaveValue(value);
  }

  /** Replaces the description with plain `text`. Use `description` + the keyboard for formatting. */
  async setDescription(text: string): Promise<void> {
    await this.description.click();
    await this.page.keyboard.press('ControlOrMeta+A');
    await this.page.keyboard.press('Delete');
    if (text) await this.description.pressSequentially(text);
  }

  /** Fills only the fields given; leaves the rest as they are. */
  async fill(fields: { title?: string; start?: string; end?: string; description?: string }): Promise<void> {
    if (fields.title !== undefined) await this.title.fill(fields.title);
    if (fields.start) await this.pickTime('Start', fields.start);
    if (fields.end) await this.pickTime('End', fields.end);
    if (fields.description !== undefined) await this.setDescription(fields.description);
  }

  /** Clicks submit and returns the write call once it is answered; the dialog then closes. */
  async submit(): Promise<InfoWriteCall> {
    const path = INFO_WRITE_PATH[this.mode];
    const method = this.mode === 'add' ? 'POST' : 'PUT';
    const responsePromise = this.page.waitForResponse(
      (response: Response) => response.request().method() === method && path.test(new URL(response.url()).pathname),
      { timeout: 60_000 },
    );
    await this.submitButton.click();
    const response = await responsePromise;
    await expect(this.dialog).toBeHidden({ timeout: 30_000 });
    return {
      method,
      status: response.status(),
      url: response.url(),
      body: (response.request().postDataJSON() ?? {}) as Record<string, unknown>,
    };
  }

  async cancel(): Promise<void> {
    await this.dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(this.dialog).toBeHidden();
  }
}
