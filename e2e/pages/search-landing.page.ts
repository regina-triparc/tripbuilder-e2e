import type { Page } from '@playwright/test';

/**
 * /slp — the search landing page where a client brief is typed and
 * submitted. Submitting navigates to /srp?q=<brief> and fires the
 * POST /bff/api/tripagents/chat/pim-itinerary-search call handled by
 * SearchResultsPage / the search-interception util.
 */
export class SearchLandingPage {
  constructor(private readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto('/slp');
  }

  get briefInput() {
    return this.page.getByRole('textbox', { name: 'Client brief' });
  }

  get submitButton() {
    return this.page.getByRole('button', { name: 'Submit' });
  }

  async fillBrief(query: string): Promise<void> {
    await this.briefInput.click();
    await this.briefInput.pressSequentially(query, {delay : 300});
  }

  async submit(): Promise<void> {
    await this.submitButton.click();
  }
}
