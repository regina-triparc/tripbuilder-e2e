import type { Page } from '@playwright/test';

/**
 * Landing page + Auth0 universal-login sign-in flow.
 *
 * UAT serves a plain email/password form at auth.uat.triparcservices.com —
 * no MFA step — so the whole flow is automated end to end and `auth.setup.ts`
 * runs unattended.
 */
export class LandingPage {
  constructor(private readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto('/landing');
  }

  /**
   * DEV's portal renders the email field itself (observed 14 Oct 2026): an
   * "Email address" textbox with a **Sign in** button that stays `disabled`
   * until the field is non-empty. The older order — click "Sign In" first and
   * let Auth0 ask for the email — waits forever on a button that can never
   * enable, which is how this setup failed on 14 Oct.
   *
   * The shell is an MFE bundle, so the form can take well past 15s to paint on
   * a cold DEV. The waits here are deliberately long, so a slow render reads as
   * slow rather than as a broken selector.
   */
  async startSignIn(email: string): Promise<void> {
    const portalEmail = this.page.getByRole('textbox', { name: /email/i });
    const submit = this.page.getByRole('button', { name: /^sign ?in$/i });

    await portalEmail.waitFor({ state: 'visible', timeout: 60_000 });
    await portalEmail.fill(email);
    await submit.click({ timeout: 30_000 });
  }

  /**
   * Completes the Auth0 password leg. `input[type="password"]` has no
   * implicit ARIA role, so getByRole can't reach it — match Auth0's field
   * by name instead. Submitting redirects straight back to the portal;
   * the caller owns the wait for that landing URL.
   */
  async completeSignIn(password: string): Promise<void> {
    const passwordField = this.page.locator('input[name="password"]');
    await passwordField.waitFor({ state: 'visible', timeout: 30_000 });
    await passwordField.fill(password);
    await passwordField.press('Enter');
  }
}
