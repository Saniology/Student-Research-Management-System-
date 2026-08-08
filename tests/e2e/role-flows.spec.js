const { test, expect } = require('@playwright/test');

function previewUrl(role, action = '') {
  const params = new URLSearchParams({ preview_role: role });
  if (action) params.set('preview_action', action);
  return `/?${params.toString()}`;
}

async function openPreview(page, role, action = '') {
  await page.goto(previewUrl(role, action), { waitUntil: 'domcontentloaded' });
  await expect(page.locator(`html[data-role-preview="${role}"]`)).toBeAttached();
}

test.describe('SPMS role workflows', () => {
  test('student can reach the clearance receipt state', async ({ page }) => {
    await openPreview(page, 'student', 'show_receipt');
    await expect(page.getByText('Digital Clearance Receipt', { exact: true })).toBeVisible();
    await expect(page.getByText('Reference: SPMS-PREVIEW-STUDENT', { exact: true })).toBeVisible();
    await expect(page.locator('#receipt-section')).toBeVisible();
  });

  test('student can reach the no-fee revision resubmission state', async ({ page }) => {
    await openPreview(page, 'student', 'show_revision');
    await expect(page.getByText('Revision Required', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Upload Revision & Resubmit' })).toBeEnabled();
    await expect(page.getByText('without paying the clearance fee again.', { exact: false })).toBeVisible();
  });

  test('supervisor can open a project review workspace', async ({ page }) => {
    await openPreview(page, 'teacher', 'open_review');
    await expect(page.locator('#student-modal')).toBeVisible();
    await expect(page.locator('#modal-review-comment')).toHaveValue('Preview approval note for automated supervisor interaction coverage.');
    await expect(page.getByRole('button', { name: 'Approve Project' })).toBeVisible();
  });

  test('library staff can open catalog verification details', async ({ page }) => {
    await openPreview(page, 'library', 'open_catalog_record');
    await expect(page.locator('#library-modal')).toBeVisible();
    await expect(page.locator('#lib-comment-input')).toHaveValue('Preview catalog note for automated library interaction coverage.');
    await expect(page.getByRole('button', { name: /Verify & Publish/ })).toBeVisible();
  });

  test('admin can open scheduled reporting controls', async ({ page }) => {
    await openPreview(page, 'admin', 'open_reports');
    await expect(page.locator('#admin-reports')).toBeVisible();
    await expect(page.getByText('Preview reports loaded for workflow export, scheduled delivery, and generated report checks.', { exact: true })).toBeVisible();
    await expect(page.getByText('project-lifecycle-preview.csv', { exact: true })).toBeVisible();
  });

  test('admin can open the supervisor assignment queue', async ({ page }) => {
    await openPreview(page, 'admin', 'open_assignments');
    await expect(page.locator('#admin-supervisors')).toBeVisible();
    await expect(page.getByText('Unassigned Review Queue', { exact: true })).toBeVisible();
    await expect(page.getByText('Web-Based E-Voting System', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Assign/ })).toBeVisible();
  });
});

const seededRoles = [
  ['student', 'SPMS_E2E_STUDENT_EMAIL'],
  ['teacher', 'SPMS_E2E_TEACHER_EMAIL'],
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
      await page.locator('#login-email').fill(email);
      await page.locator('#login-password').fill(password);
      await page.locator('#login-btn').click();
      await expect(page.locator(`#${role === 'teacher' ? 'teacher' : role}.active-view`)).toBeVisible({ timeout: 30_000 });
    });
  }
});
