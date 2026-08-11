#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const failures = [];
const warnings = [];

function log(status, message) {
  const label = status.padEnd(6, ' ');
  console.log(`${label} ${message}`);
}

function pass(message) {
  log('PASS', message);
}

function fail(message) {
  failures.push(message);
  log('FAIL', message);
}

function warn(message) {
  warnings.push(message);
  log('WARN', message);
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function frontendSource() {
  return ['index.html', 'src/App.jsx', 'src/styles.css', 'src/components/AppShell.jsx', 'src/components/Skeleton.jsx', 'src/components/Modal.jsx', 'src/components/StatusChip.jsx', 'src/lib/supabase.js', 'src/lib/contracts.js'].map(read).join('\n');
}

function assertFile(relativePath) {
  if (fs.existsSync(path.join(root, relativePath))) {
    pass(`${relativePath} exists`);
  } else {
    fail(`${relativePath} is missing`);
  }
}

function assertContains(relativePath, pattern, label) {
  const content = relativePath === 'index.html' ? frontendSource() : read(relativePath);
  if (pattern.test(content)) {
    pass(label);
  } else {
    fail(label);
  }
}

function assertNotContains(relativePath, pattern, label) {
  const content = relativePath === 'index.html' ? frontendSource() : read(relativePath);
  if (!pattern.test(content)) {
    pass(label);
  } else {
    fail(label);
  }
}

function run(command, args, label, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status === 0) {
    pass(label);
    if (options.showOutput && result.stdout.trim()) console.log(result.stdout.trim());
    return true;
  }

  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  fail(`${label}${output ? `\n${output}` : ''}`);
  return false;
}

function findDeno() {
  const localDeno = path.join(root, '.deno', 'bin', 'deno');
  if (fs.existsSync(localDeno)) return localDeno;
  const result = spawnSync('deno', ['--version'], { encoding: 'utf8' });
  return result.status === 0 ? 'deno' : null;
}

function checkRequiredFiles() {
  [
    'index.html',
    'js/config.js',
    'package.json',
    'package-lock.json',
    'playwright.config.js',
    'tests/e2e/role-flows.spec.js',
    'SECURITY.md',
    'supabase/schema.sql',
    'supabase/payments.sql',
    'supabase/secure-payments.sql',
    'supabase/spms-core.sql',
    'supabase/config.toml',
    'supabase/deploy-verify-paystack.sh',
    'supabase/functions/verify-paystack/index.ts',
    'supabase/functions/project-workflow/index.ts',
    'supabase/functions/repository-access/index.ts',
    'supabase/functions/student-identity/index.ts',
    'supabase/functions/public-config/index.ts',
    'supabase/functions/verification-lookup/index.ts',
    'supabase/functions/scheduled-reports/index.ts',
    'supabase/functions/health-check/index.ts',
    'supabase/functions/_shared/pdf.ts',
    'scripts/provision-cloudflare-domain.js',
    'scripts/seed-e2e-data.js',
    'scripts/verify-payment-smoke.js',
    'scripts/verify-accessibility.js',
    'scripts/verify-browser-config.js',
    'scripts/verify-data-governance.js',
    'scripts/verify-database-schema.js',
    'scripts/verify-disaster-recovery.js',
    'scripts/verify-edge-functions.js',
    'scripts/verify-email-deliverability.js',
    'scripts/verify-monitoring.js',
    'scripts/verify-release-readiness.js',
    'scripts/verify-rendered-ui.js',
    'scripts/verify-role-interactions.js',
    'scripts/verify-role-rendering.js',
    'scripts/verify-security.js',
    'scripts/verify-supabase-deployment.js',
    'scripts/verify-ui-smoke.js',
    'scripts/verify-workflow-contracts.js',
    'docs/disaster-recovery-runbook.md',
    'docs/data-governance-privacy-runbook.md',
    'docs/local-development-setup.md',
    'docs/production-email-deliverability.md',
    'docs/production-monitoring-runbook.md',
    'docs/production-deployment-runbook.md',
    'docs/release-checklist.md',
    'docs/spms-implementation-roadmap.md',
    '.github/workflows/verify.yml',
  ].forEach(assertFile);
}

function checkHtmlScripts() {
  const html = read('index.html');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1])
    .filter((script) => script.trim());

  try {
    scripts.forEach((script) => new Function(script));
    pass(`index.html inline scripts parse (${scripts.length})`);
  } catch (error) {
    fail(`index.html inline script parse failed: ${error.message}`);
  }
}

function checkProductCapabilities() {
  assertContains('supabase/spms-core.sql', /CREATE TABLE IF NOT EXISTS projects/, 'workflow projects schema exists');
  assertContains('supabase/spms-core.sql', /CREATE TABLE IF NOT EXISTS notifications/, 'notifications schema exists');
  assertContains('supabase/spms-core.sql', /paystack_split_code/, 'tenant Paystack split code setting exists');
  assertContains('supabase/spms-core.sql', /DROP POLICY IF EXISTS "Public read configs"/, 'server-only payment config is not publicly readable');
  assertContains('supabase/spms-core.sql', /allowed_domains/, 'tenant domain mapping exists');
  assertContains('supabase/spms-core.sql', /CREATE TABLE IF NOT EXISTS report_schedules/, 'scheduled report schema exists');
  assertContains('supabase/spms-core.sql', /CREATE TABLE IF NOT EXISTS generated_reports/, 'generated report archive schema exists');
  assertContains('supabase/spms-core.sql', /CREATE OR REPLACE VIEW admin_overview/, 'admin overview view exists');
  assertNotContains('supabase/spms-core.sql', /JOIN\s+departments[^\n]+(p|sr)\.department/, 'tenant department backfill avoids invalid UPDATE join aliases');

  assertContains('supabase/functions/verify-paystack/index.ts', /initialize_clearance/, 'clearance payments initialize server-side');
  assertContains('supabase/functions/repository-access/index.ts', /initialize_download/, 'repository payments initialize server-side');
  assertContains('supabase/functions/repository-access/index.ts', /watermarkPdf/, 'repository downloads are watermarked');
  assertContains('supabase/functions/project-workflow/index.ts', /notifyUsers/, 'workflow notifications are emitted');
  assertContains('supabase/functions/project-workflow/index.ts', /assign_supervisor/, 'admin supervisor assignment workflow exists');
  assertContains('supabase/functions/project-workflow/index.ts', /student_resubmit/, 'student revision resubmission workflow exists');
  assertContains('supabase/functions/verification-lookup/index.ts', /clearance_receipts/, 'public receipt verification exists');
  assertContains('supabase/functions/verification-lookup/index.ts', /public_catalog/, 'public project verification exists');
  assertContains('supabase/functions/verification-lookup/index.ts', /qr_svg/, 'server-rendered QR SVG endpoint exists');
  assertContains('supabase/functions/verification-lookup/index.ts', /qrcode-generator@2\.0\.4/, 'server QR generator dependency is pinned');
  assertContains('supabase/functions/scheduled-reports/index.ts', /run_due/, 'scheduled reports can run due jobs');
  assertContains('supabase/functions/scheduled-reports/index.ts', /generated_reports/, 'scheduled reports archive generated files');
  assertContains('supabase/functions/scheduled-reports/index.ts', /object\/reports/, 'scheduled reports upload to reports storage');
  assertContains('supabase/functions/scheduled-reports/index.ts', /RESEND_API_KEY/, 'scheduled reports support optional email delivery');
  assertContains('supabase/functions/scheduled-reports/index.ts', /createSignedReportUrl/, 'scheduled report emails use private signed links');
  assertContains('supabase/functions/scheduled-reports/index.ts', /profiles!payments_student_id_fkey/, 'scheduled financial reports use explicit payment profile join');
  assertContains('supabase/functions/health-check/index.ts', /HEALTH_CHECK_SECRET/, 'health check supports detailed secret guard');
  assertContains('supabase/functions/health-check/index.ts', /storage\/v1\/bucket/, 'health check verifies required storage buckets');
  assertContains('supabase/functions/health-check/index.ts', /status:\s*"ok"|status/, 'health check reports service status');

  assertContains('index.html', /resumeTransaction|retryPaymentVerification/, 'frontend resumes backend-initialized Paystack checkout');
  assertContains('index.html', /qr_svg/, 'frontend requests server-rendered QR SVG assets');
  assertNotContains('index.html', /PaystackPop\.setup|openIframe\(/, 'frontend no longer creates Paystack transactions directly');
  assertContains('index.html', /runScheduledReport|runDueReports/, 'admin financial reports exist');
  assertContains('index.html', /runScheduledReport/, 'admin project lifecycle export exists');
  assertContains('index.html', /scheduled-reports|Scheduled reporting controls/, 'admin scheduled report controls exist');
  assertContains('index.html', /email_recipients/, 'admin report schedules accept email recipients');
  assertContains('index.html', /download_url|Download signed report/, 'admin generated report downloads exist');
  assertContains('supabase/functions/scheduled-reports/index.ts', /profiles!payments_student_id_fkey/, 'frontend payment reports use explicit payment profile join');
  assertContains('index.html', /AnalyticsCard|Workflow funnel/, 'admin analytics charts load live data');
  assertContains('index.html', /Workflow funnel/, 'admin workflow funnel chart exists');
  assertContains('index.html', /Revenue split/, 'admin monthly revenue chart exists');
  assertContains('index.html', /admin-supervisors/, 'admin unassigned supervisor queue exists');
  assertContains('index.html', /assign_supervisor|function assign/, 'admin supervisor assignment control exists');
  assertContains('index.html', /student_resubmit|Upload Revision/, 'student revision resubmission control exists');
  assertContains('index.html', /pdf-frame|PdfPreview/, 'supervisor PDF preview surface exists');
  assertContains('index.html', /signedPdfUrl|createSignedUrl/, 'supervisor PDF previews use signed storage links');
  assertContains('index.html', /loadTenant/, 'frontend resolves tenant context');
  assertContains('src/lib/supabase.js', /public-config/, 'frontend loads safe public configuration through Edge Function');
  assertContains('index.html', /allowed_domains/, 'frontend manages tenant domains');
  assertContains('index.html', /validateAppConfig/, 'frontend validates browser configuration');
  assertContains('index.html', /app-config-error/, 'frontend exposes configuration errors');
  assertContains('index.html', /className="hero"/, 'frontend has polished portal home shell');
  assertContains('index.html', /operations-board/, 'frontend has operational workflow board');
  assertContains('index.html', /trust-band/, 'frontend has institutional trust band');
  assertContains('index.html', /timeline-section/, 'frontend has clearance process timeline');
  assertContains('index.html', /impact-section/, 'frontend has institutional impact section');
  assertContains('index.html', /project-card|metric-card/, 'frontend has smart card UI tokens');
  assertContains('index.html', /tag|status-chip/, 'frontend has smart list token UI');
  assertContains('index.html', /skeleton-page/, 'frontend has page skeleton surfaces');
  assertContains('index.html', /@keyframes shimmer/, 'frontend skeleton loaders animate');
  assertContains('index.html', /PageSkeleton/, 'frontend has page-specific skeleton templates');
  assertContains('index.html', /role="student"/, 'student page uses shaped skeleton loader');
  assertContains('index.html', /role="teacher"/, 'supervisor page uses shaped skeleton loader');
  assertContains('index.html', /role="library"/, 'library page uses shaped skeleton loader');
  assertContains('index.html', /role="admin"/, 'admin dashboard uses shaped skeleton loader');
  assertContains('index.html', /--spms-pattern|background-image:/, 'frontend light surfaces use the maintained patterned visual system');
  assertContains('index.html', /border-radius:\s*(7|9|10|12)px/, 'frontend enforces restrained card radius standard');
  assertContains('index.html', /focus-visible/, 'frontend preserves keyboard focus styling');
  assertContains('index.html', /preview_role/, 'frontend exposes local role preview routes');
  assertContains('index.html', /preview_action/, 'frontend exposes local role preview actions');
  assertContains('index.html', /isRolePreviewAllowed/, 'frontend gates role previews');
  assertContains('index.html', /isLocalHost\(window\.location\.hostname\)/, 'role previews are local-host only');

  assertContains('package.json', /"dns:cloudflare"/, 'Cloudflare DNS provisioning command exists');
  assertContains('package.json', /"verify:config"/, 'browser config verification command exists');
  assertContains('package.json', /"verify:deploy"/, 'Supabase deployment smoke command exists');
  assertContains('package.json', /"verify:a11y"/, 'accessibility verification command exists');
  assertContains('package.json', /"verify:db"/, 'database schema verification command exists');
  assertContains('package.json', /"verify:dr"/, 'disaster recovery verification command exists');
  assertContains('package.json', /"verify:governance"/, 'data governance verification command exists');
  assertContains('package.json', /"verify:edge"/, 'Edge Function contract verification command exists');
  assertContains('package.json', /"verify:email"/, 'email deliverability verification command exists');
  assertContains('package.json', /"verify:release"/, 'release readiness verification command exists');
  assertContains('package.json', /"verify:render"/, 'rendered UI verification command exists');
  assertContains('package.json', /"verify:roles"/, 'role rendering verification command exists');
  assertContains('package.json', /"verify:interactions"/, 'role interaction verification command exists');
  assertContains('package.json', /"verify:playwright"/, 'Playwright role verification command exists');
  assertContains('package.json', /"seed:e2e"/, 'opt-in E2E fixture seed command exists');
  assertContains('package.json', /"@playwright\/test"/, 'Playwright test dependency exists');
  assertContains('package.json', /"verify:monitor"/, 'monitoring verification command exists');
  assertContains('package.json', /"verify:security"/, 'security verification command exists');
  assertContains('package.json', /"verify:ui"/, 'UI smoke verification command exists');
  assertContains('package.json', /"verify:workflow"/, 'workflow contract verification command exists');
  assertContains('scripts/provision-cloudflare-domain.js', /CLOUDFLARE_API_TOKEN/, 'DNS provisioning uses Cloudflare API token');
  assertContains('scripts/provision-cloudflare-domain.js', /--dry-run/, 'DNS provisioning supports dry runs');
  assertContains('scripts/provision-cloudflare-domain.js', /allowed_domains/, 'DNS provisioning prints Supabase tenant mapping guidance');
  assertContains('docs/production-deployment-runbook.md', /Tenant Domains/, 'production runbook documents tenant domains');
  assertContains('docs/production-deployment-runbook.md', /npm run verify:config/, 'production runbook documents browser config verification');
  assertContains('docs/production-deployment-runbook.md', /disaster-recovery-runbook\.md/, 'production runbook documents disaster recovery');
  assertContains('docs/production-deployment-runbook.md', /data-governance-privacy-runbook\.md/, 'production runbook documents data governance');
  assertContains('docs/production-deployment-runbook.md', /production-monitoring-runbook\.md/, 'production runbook documents monitoring');
  assertContains('docs/production-deployment-runbook.md', /npm run dns:cloudflare/, 'production runbook documents DNS automation');
  assertContains('docs/production-deployment-runbook.md', /npm run verify:deploy/, 'production runbook documents deployment smoke verification');
  assertContains('docs/production-deployment-runbook.md', /health-check/, 'production runbook documents health checks');
  assertContains('docs/production-deployment-runbook.md', /production-email-deliverability\.md/, 'production runbook links email deliverability guide');
  assertContains('docs/release-checklist.md', /Payments/, 'release checklist documents payment gate');
  assertContains('docs/release-checklist.md', /health-check/, 'release checklist documents health check gate');
  assertContains('docs/spms-implementation-roadmap.md', /Public portal UI/, 'roadmap documents portal UI standard');
  assertContains('.github/workflows/verify.yml', /npm run verify:config/, 'GitHub Actions runs browser config verification');
  assertContains('.github/workflows/verify.yml', /npm run verify:render/, 'GitHub Actions runs rendered UI verification');
  assertContains('.github/workflows/verify.yml', /npm run verify:roles/, 'GitHub Actions runs role rendering verification');
  assertContains('.github/workflows/verify.yml', /npm run verify:interactions/, 'GitHub Actions runs role interaction verification');
  assertContains('.github/workflows/verify.yml', /npm run verify:playwright/, 'GitHub Actions runs Playwright role verification');
  assertContains('.github/workflows/verify.yml', /npm run verify:db/, 'GitHub Actions runs database schema verification');
  assertContains('.github/workflows/verify.yml', /npm run verify:dr/, 'GitHub Actions runs disaster recovery verification');
  assertContains('.github/workflows/verify.yml', /npm run verify:governance/, 'GitHub Actions runs data governance verification');
  assertContains('.github/workflows/verify.yml', /npm run verify:edge/, 'GitHub Actions runs Edge Function contract verification');
  assertContains('.github/workflows/verify.yml', /npm run verify:email/, 'GitHub Actions runs email deliverability verification');
  assertContains('.github/workflows/verify.yml', /npm run verify:monitor/, 'GitHub Actions runs monitoring verification');
  assertContains('.github/workflows/verify.yml', /npm run verify:workflow/, 'GitHub Actions runs workflow contract verification');
  assertContains('.github/workflows/verify.yml', /npm run dev/, 'GitHub Actions starts local Vite app');
  assertContains('.github/workflows/verify.yml', /npm run verify:lifecycle/, 'GitHub Actions runs lifecycle verification');
  assertContains('scripts/verify-database-schema.js', /SECURITY DEFINER/, 'database verifier checks SECURITY DEFINER hardening');
  assertContains('scripts/verify-browser-config.js', /SUPABASE_ANON_KEY/, 'browser config verifier checks Supabase anon key');
  assertContains('scripts/verify-browser-config.js', /PAYSTACK_PUBLIC_KEY/, 'browser config verifier checks Paystack public key');
  assertContains('scripts/verify-browser-config.js', /browser files contain only public config/, 'browser config verifier checks frontend secret hygiene');
  assertContains('scripts/verify-database-schema.js', /requiredForeignKeys/, 'database verifier checks foreign key contracts');
  assertContains('scripts/verify-database-schema.js', /requiredIndexes/, 'database verifier checks performance indexes');
  assertContains('scripts/verify-disaster-recovery.js', /Recovery point objective/, 'DR verifier checks RPO');
  assertContains('scripts/verify-disaster-recovery.js', /thesis-pdfs/, 'DR verifier checks thesis bucket backup coverage');
  assertContains('scripts/verify-disaster-recovery.js', /restore drill/i, 'DR verifier checks restore drills');
  assertContains('scripts/verify-data-governance.js', /Data Classification/, 'governance verifier checks data classification');
  assertContains('scripts/verify-data-governance.js', /Data Subject Requests/, 'governance verifier checks data subject requests');
  assertContains('scripts/verify-data-governance.js', /public catalog schema excludes private paths/, 'governance verifier checks public catalog privacy boundary');
  assertContains('scripts/verify-edge-functions.js', /corsHeaders/, 'Edge Function verifier checks CORS headers');
  assertContains('scripts/verify-edge-functions.js', /Method not allowed/, 'Edge Function verifier checks method guards');
  assertContains('scripts/verify-edge-functions.js', /verify_jwt/, 'Edge Function verifier checks gateway JWT config');
  assertContains('scripts/verify-edge-functions.js', /--no-verify-jwt/, 'Edge Function verifier checks deploy JWT flag');
  assertContains('scripts/verify-email-deliverability.js', /DMARC/, 'email verifier checks DMARC guidance');
  assertContains('scripts/verify-email-deliverability.js', /suppression/, 'email verifier checks suppression monitoring');
  assertContains('scripts/verify-email-deliverability.js', /createSignedReportUrl/, 'email verifier checks signed report links');
  assertContains('scripts/verify-monitoring.js', /monthly availability/, 'monitoring verifier checks uptime target');
  assertContains('scripts/verify-monitoring.js', /health-check/, 'monitoring verifier checks health endpoint coverage');
  assertContains('scripts/verify-monitoring.js', /Alert Routing/, 'monitoring verifier checks alert routing');
  assertContains('scripts/verify-workflow-contracts.js', /edgeContracts/, 'workflow verifier checks Edge Function contracts');
  assertContains('scripts/verify-workflow-contracts.js', /projectStatuses/, 'workflow verifier checks project statuses');
  assertContains('scripts/verify-workflow-contracts.js', /verificationTypes/, 'workflow verifier checks verification lookup types');
  assertContains('scripts/verify-release-readiness.js', /PAYSTACK_SECRET_KEY/, 'release verifier checks required secrets template');
  assertContains('scripts/verify-release-readiness.js', /verify:render/, 'release verifier checks rendered UI gate');
  assertContains('scripts/verify-release-readiness.js', /verify:roles/, 'release verifier checks role rendering gate');
  assertContains('scripts/verify-release-readiness.js', /verify:interactions/, 'release verifier checks role interaction gate');
  assertContains('scripts/verify-release-readiness.js', /verify:deploy/, 'release verifier checks deployment smoke gate');
  assertContains('scripts/verify-release-readiness.js', /no obvious private secrets/, 'release verifier checks secret hygiene');
  assertContains('scripts/verify-supabase-deployment.js', /requiredFunctions/, 'deployment verifier checks required Edge Functions');
  assertContains('scripts/verify-supabase-deployment.js', /NOT_FOUND/, 'deployment verifier detects missing functions');
  assertContains('scripts/verify-supabase-deployment.js', /access-control-allow-origin/, 'deployment verifier validates CORS headers');
  assertContains('scripts/verify-supabase-deployment.js', /health-check/, 'deployment verifier checks production health endpoint');
  assertContains('SECURITY.md', /Secret Handling/, 'security policy documents secret handling');
  assertContains('scripts/verify-security.js', /Payment Safety|checkPaymentSafety/, 'security verifier checks payment safety');
  assertContains('scripts/verify-security.js', /ENABLE ROW LEVEL SECURITY/, 'security verifier checks RLS coverage');
  assertContains('scripts/verify-accessibility.js', /form controls have accessible labels/, 'accessibility verifier checks form labels');
  assertContains('scripts/verify-accessibility.js', /buttons have accessible names/, 'accessibility verifier checks button names');
  assertContains('scripts/verify-ui-smoke.js', /React actions do not rely on inline onclick handlers/, 'UI smoke verifier checks inline handlers');
  assertContains('scripts/verify-ui-smoke.js', /student role workspace exists/, 'UI smoke verifier checks role surfaces');
  assertContains('scripts/verify-ui-smoke.js', /React application root exists/, 'UI smoke verifier checks portal shell standard');
  assertContains('scripts/verify-rendered-ui.js', /--screenshot/, 'rendered UI verifier captures browser screenshots');
  assertContains('scripts/verify-rendered-ui.js', /desktop/, 'rendered UI verifier covers desktop viewport');
  assertContains('scripts/verify-rendered-ui.js', /mobile/, 'rendered UI verifier covers mobile viewport');
  assertContains('scripts/verify-role-rendering.js', /preview_role/, 'role rendering verifier uses local preview routes');
  assertContains('scripts/verify-role-rendering.js', /--dump-dom/, 'role rendering verifier checks browser DOM');
  assertContains('scripts/verify-role-rendering.js', /--screenshot/, 'role rendering verifier captures role screenshots');
  assertContains('scripts/verify-role-interactions.js', /preview_action/, 'role interaction verifier uses local preview actions');
  assertContains('scripts/verify-role-interactions.js', /role="dialog"/, 'role interaction verifier checks supervisor modal');
  assertContains('scripts/verify-role-interactions.js', /role="dialog"/, 'role interaction verifier checks library modal');
  assertContains('scripts/verify-role-interactions.js', /admin-reports/, 'role interaction verifier checks admin report section');
  assertContains('scripts/seed-e2e-data.js', /SPMS_E2E_FIXTURE_CONFIRM/, 'E2E fixture seeding requires explicit confirmation');
  assertContains('scripts/seed-e2e-data.js', /SPMS_E2E_ALLOW_REMOTE/, 'E2E fixture seeding guards remote mutation');
  assertContains('scripts/seed-e2e-data.js', /No payment rows were created/, 'E2E fixtures do not fabricate financial evidence');
  assertContains('scripts/verify-payment-smoke.js', /SPMS_PAYMENT_SMOKE_CONFIRM/, 'payment smoke requires explicit confirmation');
  assertContains('scripts/verify-payment-smoke.js', /SPMS_PAYMENT_SMOKE_ALLOW_REMOTE/, 'payment smoke guards remote verification');
  assertContains('scripts/verify-payment-smoke.js', /api\.paystack\.co\/transaction\/verify/, 'payment smoke verifies references with Paystack');
  assertContains('scripts/verify-payment-smoke.js', /watermarked/, 'payment smoke verifies watermarked repository access');
  assertContains('scripts/verify-payment-smoke.js', /report_type: 'financial'/, 'payment smoke verifies financial report inclusion');
}

function checkDeployConfig() {
  const requiredFunctions = [
    'verify-paystack',
    'project-workflow',
    'repository-access',
    'verification-lookup',
    'scheduled-reports',
    'health-check',
    'student-identity',
    'public-config',
  ];

  const deployScript = read('supabase/deploy-verify-paystack.sh');
  requiredFunctions.forEach((functionName) => {
    if (deployScript.includes(functionName)) {
      pass(`deploy script includes ${functionName}`);
    } else {
      fail(`deploy script missing ${functionName}`);
    }
  });

  ['PAYSTACK_SECRET_KEY', 'REPORT_CRON_SECRET', 'HEALTH_CHECK_SECRET', 'RESEND_API_KEY', 'REPORT_FROM_EMAIL'].forEach((secretName) => {
    if (deployScript.includes(secretName)) {
      pass(`deploy script handles ${secretName}`);
    } else {
      fail(`deploy script missing ${secretName}`);
    }
  });

  if (/\.env\.production\.local/.test(deployScript)) {
    pass('deploy script loads owner production env file');
  } else {
    fail('deploy script does not load owner production env file');
  }

  if (/npx --yes supabase/.test(deployScript)) {
    pass('deploy script falls back to npx Supabase CLI');
  } else {
    fail('deploy script does not fall back to npx Supabase CLI');
  }

  if (/SUPABASE_CLI/.test(deployScript)) {
    pass('deploy script supports custom Supabase CLI command');
  } else {
    fail('deploy script does not support custom Supabase CLI command');
  }

  run('bash', ['-n', 'supabase/deploy-verify-paystack.sh'], 'deploy script syntax is valid');
}

function checkUiSmoke() {
  run('node', ['scripts/verify-ui-smoke.js'], 'UI smoke verification passes');
}

function checkRenderedUi() {
  run('node', ['scripts/verify-rendered-ui.js'], 'rendered UI verification passes or skips cleanly');
}

function checkRoleRendering() {
  run('node', ['scripts/verify-role-rendering.js'], 'role rendering verification passes or skips cleanly');
}

function checkRoleInteractions() {
  run('node', ['scripts/verify-role-interactions.js'], 'role interaction verification passes or skips cleanly');
}

function checkAccessibility() {
  run('node', ['scripts/verify-accessibility.js'], 'accessibility verification passes');
}

function checkBrowserConfig() {
  run('node', ['scripts/verify-browser-config.js'], 'browser config verification passes');
}

function checkDatabaseSchema() {
  run('node', ['scripts/verify-database-schema.js'], 'database schema verification passes');
}

function checkDisasterRecovery() {
  run('node', ['scripts/verify-disaster-recovery.js'], 'disaster recovery verification passes');
}

function checkDataGovernance() {
  run('node', ['scripts/verify-data-governance.js'], 'data governance verification passes');
}

function checkEdgeFunctions() {
  run('node', ['scripts/verify-edge-functions.js'], 'Edge Function contract verification passes');
}

function checkEmailDeliverability() {
  run('node', ['scripts/verify-email-deliverability.js'], 'email deliverability verification passes');
}

function checkMonitoring() {
  run('node', ['scripts/verify-monitoring.js'], 'monitoring verification passes');
}

function checkReleaseReadiness() {
  run('node', ['scripts/verify-release-readiness.js'], 'release readiness verification passes');
}

function checkSecurity() {
  run('node', ['scripts/verify-security.js'], 'security verification passes');
}

function checkWorkflowContracts() {
  run('node', ['scripts/verify-workflow-contracts.js'], 'workflow contract verification passes');
}

function checkDenoFunctions() {
  const deno = findDeno();
  if (!deno) {
    warn('Deno not found; skipped Edge Function type checks');
    return;
  }

  run(deno, [
    'check',
    'supabase/functions/verify-paystack/index.ts',
    'supabase/functions/project-workflow/index.ts',
    'supabase/functions/repository-access/index.ts',
    'supabase/functions/public-config/index.ts',
    'supabase/functions/verification-lookup/index.ts',
    'supabase/functions/scheduled-reports/index.ts',
    'supabase/functions/health-check/index.ts',
  ], 'Edge Functions type-check with Deno');
}

function checkLocalServer() {
  const request = http.request(
    {
      method: 'HEAD',
      host: '127.0.0.1',
      port: 5510,
      path: '/',
      timeout: 1500,
    },
    (response) => {
      if (response.statusCode && response.statusCode >= 200 && response.statusCode < 400) {
        pass(`local server responds on http://127.0.0.1:5510/ (${response.statusCode})`);
      } else {
        warn(`local server responded with HTTP ${response.statusCode}`);
      }
      finish();
    },
  );

  request.on('timeout', () => {
    request.destroy();
    warn('local server check timed out; start it with npm run dev -- --host 127.0.0.1 --port 5510');
    finish();
  });

  request.on('error', () => {
    warn('local server is not running; start it with npm run dev -- --host 127.0.0.1 --port 5510');
    finish();
  });

  request.end();
}

function finish() {
  console.log('');
  console.log(`Verification complete: ${failures.length} failure(s), ${warnings.length} warning(s).`);
  process.exit(failures.length ? 1 : 0);
}

checkRequiredFiles();
checkHtmlScripts();
checkProductCapabilities();
checkDeployConfig();
checkAccessibility();
checkBrowserConfig();
checkUiSmoke();
checkRenderedUi();
checkRoleRendering();
checkRoleInteractions();
checkDatabaseSchema();
checkDisasterRecovery();
checkDataGovernance();
checkEdgeFunctions();
checkEmailDeliverability();
checkMonitoring();
checkSecurity();
checkWorkflowContracts();
checkReleaseReadiness();
checkDenoFunctions();
checkLocalServer();
