import { test, expect } from '@playwright/test';

test.describe('TB-601: Info services', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByRole('row', { name: /Best Of Bangkok/ }).first().click();
    await expect(page.getByText(/Loading trip/i)).toBeHidden({ timeout: 180000 });
  });

  test('[TC-001] an Info row shows the Info only badge with Modify and Delete', async ({ page }) => {
    const infoRow = page.getByRole('button', { name: /Info only/ }).first();
    await expect(infoRow).toBeVisible();
    await expect(infoRow).not.toHaveAccessibleName(/Live price|Needs recheck|Check failed/);
    await expect(infoRow.getByRole('button', { name: 'Modify' })).toBeVisible();
    await expect(infoRow.getByRole('button', { name: 'Delete' })).toBeVisible();
  });
});
