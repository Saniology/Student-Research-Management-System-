const fs = require('fs');
const { test, expect } = require('@playwright/test');

const fixturePrefix = process.env.SPMS_E2E_FIXTURE_PREFIX || 'SPMS E2E Fixture';

function previewUrl(role, action = '') {
  const params = new URLSearchParams({ preview_role: role });
  if (action) params.set('preview_action', action);
  return `/?${params.toString()}`;
}

async function openPreview(page, role, action = '') {
  await page.goto(previewUrl(role, action), { waitUntil: 'domcontentloaded' });
  await expect(page.locator(`html[data-role-preview="${role}"]`)).toBeAttached();
}

async function openPublicPreview(page) {
  await page.goto('/?preview_surface=public', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('html[data-public-preview="true"]')).toBeAttached();
}

test.describe('SPMS role workflows', () => {
  test('public reader must authenticate before repository checkout', async ({ page }) => {
    await page.route('**/rest/v1/public_catalog*', async route => {
      await new Promise(resolve => setTimeout(resolve, 500));
      await route.continue();
    });
    await openPublicPreview(page);
    await expect(page.getByLabel('Loading repository')).toBeVisible();
    await page.getByRole('button', { name: /Download/ }).first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('dialog')).toContainText('Sign in to download');
    await expect(page.getByRole('dialog')).toContainText('Account required');
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Create account' })).toBeVisible();
  });

  test('student can reach the clearance receipt state', async ({ page }) => {
    await openPreview(page, 'student', 'show_receipt');
    await expect(page.getByText('Digital Clearance Receipt', { exact: true })).toBeVisible();
    await expect(page.getByText('SPMS-PREVIEW-STUDENT', { exact: true })).toBeVisible();
    await expect(page.locator('#receipt-section')).toBeVisible();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download receipt PDF' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('SPMS-PREVIEW-RECEIPT.pdf');
    const downloadedPath = await download.path();
    expect(downloadedPath).toBeTruthy();
    expect(fs.readFileSync(downloadedPath).subarray(0, 8).toString()).toBe('%PDF-1.4');
  });

  test('student can reach the no-fee revision resubmission state', async ({ page }) => {
    await openPreview(page, 'student', 'show_revision');
    await expect(page.getByText(/Revision requested/).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Upload Revision & Resubmit' })).toBeEnabled();
    await expect(page.getByText(/no second payment/).first()).toBeVisible();
  });

  test('supervisor can open a project review workspace', async ({ page }) => {
    await openPreview(page, 'teacher', 'open_review');
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.locator('#modal-review-comment')).toHaveValue('Preview approval note for automated supervisor interaction coverage.');
    await expect(page.getByRole('button', { name: 'Approve Project' })).toBeVisible();
  });

  test('library staff can open catalog verification details', async ({ page }) => {
    await openPreview(page, 'library', 'open_catalog_record');
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.locator('#lib-comment-input')).toHaveValue('Preview catalog note for automated library interaction coverage.');
    await expect(page.getByRole('button', { name: /Generate QR & Publish/ })).toBeVisible();
  });

  test('admin can open scheduled reporting controls', async ({ page }) => {
    await openPreview(page, 'admin', 'open_reports');
    await expect(page.locator('#admin-reports')).toBeVisible();
    await expect(page.getByText('Scheduled reporting controls', { exact: true })).toBeVisible();
    await expect(page.getByText('project-lifecycle-preview.csv', { exact: true })).toBeVisible();
  });

  test('admin can open the supervisor assignment queue', async ({ page }) => {
    await openPreview(page, 'admin', 'open_assignments');
    await expect(page.locator('#admin-supervisors')).toBeVisible();
    await expect(page.getByText('Unassigned Review Queue', { exact: true })).toBeVisible();
    await expect(page.getByText('Web-Based E-Voting System', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Assign/ })).toBeVisible();
  });

  test('student sidebar navigates to submission controls', async ({ page }) => {
    await openPreview(page, 'student');
    await page.getByRole('button', { name: 'Submission', exact: true }).click();
    await expect(page.locator('#student-submission')).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Submission', exact: true })).toHaveClass(/active/);
  });

  test('student sidebar switches between focused workspace pages', async ({ page }) => {
    await openPreview(page, 'student');
    for (const [label, target] of [['Overview', '#student-overview'], ['Submission', '#student-submission'], ['Payments', '#student-payments'], ['Receipt', '#student-receipt'], ['Profile', '#student-profile']]) {
      const button = page.getByRole('button', { name: label, exact: true });
      await button.click();
      await expect(page.locator(target)).toBeVisible();
      await expect(button).toHaveClass(/active/);
    }
  });

  test('supervisor sidebar navigates to review history', async ({ page }) => {
    await openPreview(page, 'teacher');
    await page.getByRole('button', { name: 'Review history', exact: true }).click();
    await expect(page.locator('#teacher-history')).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Review history', exact: true })).toHaveClass(/active/);
  });

  test('supervisor sidebar switches between focused workspace pages', async ({ page }) => {
    await openPreview(page, 'teacher');
    for (const [label, target] of [['Overview', '#teacher-overview'], ['Assigned projects', '#teacher-projects'], ['Assigned students', '#teacher-students'], ['Review history', '#teacher-history'], ['Supervisor profile', '#teacher-profile']]) {
      const button = page.getByRole('button', { name: label, exact: true });
      await button.click();
      await expect(page.locator(target)).toBeVisible();
      await expect(button).toHaveClass(/active/);
    }
  });

  test('library sidebar navigates across each desk', async ({ page }) => {
    await openPreview(page, 'library');
    for (const [label, target] of [['Verification queue', '#library-queue'], ['Public catalogue', '#library-catalogue'], ['QR labels', '#library-qr'], ['Archive', '#library-archive']]) {
      const button = page.getByRole('button', { name: label, exact: true });
      await button.click();
      await expect(page.locator(target)).toBeInViewport();
      await expect(button).toHaveClass(/active/);
    }
  });
});

const seededRoles = [
  ['student', 'SPMS_E2E_STUDENT_EMAIL'],
  ['supervisor', 'SPMS_E2E_SUPERVISOR_EMAIL'],
  ['library', 'SPMS_E2E_LIBRARY_EMAIL'],
  ['admin', 'SPMS_E2E_ADMIN_EMAIL'],
];

test.describe('SPMS seeded Supabase role smoke', () => {
  test.skip(process.env.SPMS_E2E_MODE !== 'seeded', 'Set SPMS_E2E_MODE=seeded to run against seeded Supabase accounts.');

  for (const [role, emailKey] of seededRoles) {
    test(`${role} account reaches its role workspace`, async ({ page }) => {
      const email = process.env[emailKey];
      const password = process.env[`${emailKey.replace('_EMAIL', '')}_PASSWORD`];
      test.skip(!email || !password, `Missing ${emailKey} and matching password environment variables.`);

      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: /Login/ }).first().click();
      await page.locator('#auth-email').fill(email);
      await page.locator('#auth-password').fill(password);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page.getByRole('heading', { name: role === 'supervisor' ? 'Supervisor review queue' : role === 'library' ? 'Library verification desk' : role === 'admin' ? 'Analytics hub' : 'Your clearance workspace' })).toBeVisible({ timeout: 30_000 });
      if (role === 'student') {
        await expect(page.locator('#project-title-input')).toHaveValue(`${fixturePrefix} Supervisor Review`, { timeout: 30_000 });
      }
      if (role === 'supervisor') {
        await expect(page.getByText(`${fixturePrefix} Supervisor Review`, { exact: true })).toBeVisible({ timeout: 30_000 });
        const reviewRow = page.locator('tr').filter({ hasText: `${fixturePrefix} Supervisor Review` });
        await reviewRow.getByRole('button', { name: 'Review' }).click();
        await expect(page.locator('iframe.pdf-frame')).toBeVisible({ timeout: 30_000 });
      }
      if (role === 'library') {
        await expect(page.getByText(`${fixturePrefix} Library Record`, { exact: true })).toBeVisible({ timeout: 30_000 });
        await page.getByRole('button', { name: 'Open record' }).first().click();
        await expect(page.getByRole('dialog')).toBeVisible();
      }
      if (role === 'admin') {
        await page.getByRole('button', { name: 'Uploads' }).click();
        await expect(page.getByText(`${fixturePrefix} Supervisor Review`, { exact: true })).toBeVisible({ timeout: 30_000 });
      }
    });
  }

  test('public repository exposes the seeded published record', async ({ page }) => {
    await page.goto('/#repository', { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(`${fixturePrefix} Public Repository Record`, { exact: true })).toBeVisible({ timeout: 30_000 });
  });
});
