import type { Page } from '@playwright/test';

/** /srp?q=<brief> — curated itinerary results for a submitted search brief. */
export class SearchResultsPage {
  constructor(private readonly page: Page) {}

  async gotoWithQuery(query: string): Promise<void> {
    await this.page.goto(`/srp?q=${encodeURIComponent(query)}`);
  }

  get editSearchBriefInput() {
    return this.page.getByRole('textbox', { name: 'Edit search brief' });
  }

  resultCard(title: string) {
    return this.page.getByRole('button', { name: title });
  }

  get resultsSummary() {
    return this.page.getByText(/curated itineraries found|No itineraries found/i);
  }

  async expectResultVisible(title: string): Promise<void> {
    await this.resultCard(title).waitFor({ state: 'visible' });
  }

  async openEditSearchBrief(): Promise<void> {
    await this.editSearchBriefInput.click();
  }
}
