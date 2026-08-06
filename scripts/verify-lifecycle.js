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

function assertFile(relativePath) {
  if (fs.existsSync(path.join(root, relativePath))) {
    pass(`${relativePath} exists`);
  } else {
    fail(`${relativePath} is missing`);
  }
}

function assertContains(relativePath, pattern, label) {
  const content = read(relativePath);
  if (pattern.test(content)) {
    pass(label);
  } else {
    fail(label);
  }
}

function assertNotContains(relativePath, pattern, label) {
  const content = read(relativePath);
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
    'supabase/functions/verification-lookup/index.ts',
    'supabase/functions/scheduled-reports/index.ts',
    'supabase/functions/health-check/index.ts',
    'scripts/provision-cloudflare-domain.js',
    'scripts/verify-accessibility.js',
    'scripts/verify-release-readiness.js',
    'scripts/verify-security.js',
    'scripts/verify-ui-smoke.js',
    'docs/local-development-setup.md',
    'docs/production-deployment-runbook.md',
    'docs/release-checklist.md',
    'docs/spms-implementation-roadmap.md',
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
  assertContains('supabase/spms-core.sql', /allowed_domains/, 'tenant domain mapping exists');
  assertContains('supabase/spms-core.sql', /CREATE TABLE IF NOT EXISTS report_schedules/, 'scheduled report schema exists');
  assertContains('supabase/spms-core.sql', /CREATE TABLE IF NOT EXISTS generated_reports/, 'generated report archive schema exists');
  assertContains('supabase/spms-core.sql', /CREATE OR REPLACE VIEW admin_overview/, 'admin overview view exists');
  assertNotContains('supabase/spms-core.sql', /JOIN\s+departments[^\n]+(p|sr)\.department/, 'tenant department backfill avoids invalid UPDATE join aliases');

  assertContains('supabase/functions/verify-paystack/index.ts', /initialize_clearance/, 'clearance payments initialize server-side');
  assertContains('supabase/functions/repository-access/index.ts', /initialize_download/, 'repository payments initialize server-side');
  assertContains('supabase/functions/repository-access/index.ts', /watermarkPdf/, 'repository downloads are watermarked');
  assertContains('supabase/functions/project-workflow/index.ts', /notifyUsers/, 'workflow notifications are emitted');
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

  assertContains('index.html', /resumePaystackCheckout/, 'frontend resumes backend-initialized Paystack checkout');
  assertContains('index.html', /type: 'qr_svg'/, 'frontend requests server-rendered QR SVG assets');
  assertNotContains('index.html', /PaystackPop\.setup|openIframe\(/, 'frontend no longer creates Paystack transactions directly');
  assertContains('index.html', /exportFinancialReport/, 'admin financial reports exist');
  assertContains('index.html', /exportProjectReport/, 'admin project lifecycle export exists');
  assertContains('index.html', /createReportSchedule/, 'admin scheduled report controls exist');
  assertContains('index.html', /reportRecipientList/, 'admin report schedules accept email recipients');
  assertContains('index.html', /downloadGeneratedReport/, 'admin generated report downloads exist');
  assertContains('index.html', /profiles!payments_student_id_fkey/, 'frontend payment reports use explicit payment profile join');
  assertContains('index.html', /loadAdminAnalytics/, 'admin analytics charts load live data');
  assertContains('index.html', /analytics-workflow-chart/, 'admin workflow funnel chart exists');
  assertContains('index.html', /analytics-monthly-chart/, 'admin monthly revenue chart exists');
  assertContains('index.html', /loadTenantContext/, 'frontend resolves tenant context');
  assertContains('index.html', /allowed_domains/, 'frontend manages tenant domains');
  assertContains('index.html', /validateAppConfig/, 'frontend validates browser configuration');
  assertContains('index.html', /app-config-error/, 'frontend exposes configuration errors');
  assertContains('index.html', /portal-hero/, 'frontend has polished portal home shell');
  assertContains('index.html', /unsplash\.com\/photo-1497366754035-f200968a6e72/, 'frontend hero uses a real visual asset');
  assertContains('index.html', /\.rounded-lg,\s*\.rounded-xl,\s*\.rounded-2xl/, 'frontend enforces restrained card radius standard');
  assertContains('index.html', /focus-visible/, 'frontend preserves keyboard focus styling');

  assertContains('package.json', /"dns:cloudflare"/, 'Cloudflare DNS provisioning command exists');
  assertContains('package.json', /"verify:a11y"/, 'accessibility verification command exists');
  assertContains('package.json', /"verify:release"/, 'release readiness verification command exists');
  assertContains('package.json', /"verify:security"/, 'security verification command exists');
  assertContains('package.json', /"verify:ui"/, 'UI smoke verification command exists');
  assertContains('scripts/provision-cloudflare-domain.js', /CLOUDFLARE_API_TOKEN/, 'DNS provisioning uses Cloudflare API token');
  assertContains('scripts/provision-cloudflare-domain.js', /--dry-run/, 'DNS provisioning supports dry runs');
  assertContains('scripts/provision-cloudflare-domain.js', /allowed_domains/, 'DNS provisioning prints Supabase tenant mapping guidance');
  assertContains('docs/production-deployment-runbook.md', /Tenant Domains/, 'production runbook documents tenant domains');
  assertContains('docs/production-deployment-runbook.md', /npm run dns:cloudflare/, 'production runbook documents DNS automation');
  assertContains('docs/production-deployment-runbook.md', /health-check/, 'production runbook documents health checks');
  assertContains('docs/release-checklist.md', /Payments/, 'release checklist documents payment gate');
  assertContains('docs/release-checklist.md', /health-check/, 'release checklist documents health check gate');
  assertContains('scripts/verify-release-readiness.js', /PAYSTACK_SECRET_KEY/, 'release verifier checks required secrets template');
  assertContains('scripts/verify-release-readiness.js', /no obvious private secrets/, 'release verifier checks secret hygiene');
  assertContains('SECURITY.md', /Secret Handling/, 'security policy documents secret handling');
  assertContains('scripts/verify-security.js', /Payment Safety|checkPaymentSafety/, 'security verifier checks payment safety');
  assertContains('scripts/verify-security.js', /ENABLE ROW LEVEL SECURITY/, 'security verifier checks RLS coverage');
  assertContains('scripts/verify-accessibility.js', /form controls have accessible labels/, 'accessibility verifier checks form labels');
  assertContains('scripts/verify-accessibility.js', /buttons have accessible names/, 'accessibility verifier checks button names');
  assertContains('scripts/verify-ui-smoke.js', /inline onclick handlers resolve/, 'UI smoke verifier checks inline handlers');
  assertContains('scripts/verify-ui-smoke.js', /role views exist/, 'UI smoke verifier checks role surfaces');
  assertContains('scripts/verify-ui-smoke.js', /portal home shell exists/, 'UI smoke verifier checks portal shell standard');
}

function checkDeployConfig() {
  const requiredFunctions = [
    'verify-paystack',
    'project-workflow',
    'repository-access',
    'verification-lookup',
    'scheduled-reports',
    'health-check',
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

  run('bash', ['-n', 'supabase/deploy-verify-paystack.sh'], 'deploy script syntax is valid');
}

function checkUiSmoke() {
  run('node', ['scripts/verify-ui-smoke.js'], 'UI smoke verification passes');
}

function checkAccessibility() {
  run('node', ['scripts/verify-accessibility.js'], 'accessibility verification passes');
}

function checkReleaseReadiness() {
  run('node', ['scripts/verify-release-readiness.js'], 'release readiness verification passes');
}

function checkSecurity() {
  run('node', ['scripts/verify-security.js'], 'security verification passes');
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
      port: 5500,
      path: '/',
      timeout: 1500,
    },
    (response) => {
      if (response.statusCode && response.statusCode >= 200 && response.statusCode < 400) {
        pass(`local server responds on http://127.0.0.1:5500/ (${response.statusCode})`);
      } else {
        warn(`local server responded with HTTP ${response.statusCode}`);
      }
      finish();
    },
  );

  request.on('timeout', () => {
    request.destroy();
    warn('local server check timed out; start it with python3 -m http.server 5500 --bind 0.0.0.0');
    finish();
  });

  request.on('error', () => {
    warn('local server is not running; start it with python3 -m http.server 5500 --bind 0.0.0.0');
    finish();
  });

  request.end();
}

function finish() {
  console.log('');
  console.log(`Verification complete: ${failures.length} failure(s), ${warnings.length} warning(s).`);
  if (failures.length) process.exit(1);
}

checkRequiredFiles();
checkHtmlScripts();
checkProductCapabilities();
checkDeployConfig();
checkAccessibility();
checkUiSmoke();
checkSecurity();
checkReleaseReadiness();
checkDenoFunctions();
checkLocalServer();
