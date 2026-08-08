#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const failures = [];

function pass(message) {
  console.log(`PASS   ${message}`);
}

function fail(message) {
  failures.push(message);
  console.log(`FAIL   ${message}`);
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function frontendSource() {
  return ['index.html', 'src/App.jsx', 'src/lib/contracts.js', 'src/lib/supabase.js'].map(read).join('\n');
}

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function assert(condition, message) {
  if (condition) pass(message);
  else fail(message);
}

function assertContains(file, pattern, message) {
  assert(pattern.test(read(file)), message);
}

function checkRunbook() {
  const file = 'docs/production-monitoring-runbook.md';
  assert(exists(file), 'production monitoring runbook exists');
  assertContains(file, /99\.5% monthly availability/, 'runbook defines uptime target');
  assertContains(file, /15 minutes/, 'runbook defines alert acknowledgement target');
  assertContains(file, /30 minutes/, 'runbook defines payment incident response target');
  assertContains(file, /Public portal uptime/i, 'runbook covers portal uptime monitor');
  assertContains(file, /npm run verify:deploy/, 'runbook covers live deployment smoke monitor');
  assertContains(file, /health-check/, 'runbook covers health-check monitor');
  assertContains(file, /x-health-secret/, 'runbook covers detailed health secret');
  assertContains(file, /thesis-pdfs/, 'runbook covers thesis storage monitoring');
  assertContains(file, /repository-downloads/, 'runbook covers repository storage monitoring');
  assertContains(file, /reports/, 'runbook covers reports storage monitoring');
  assertContains(file, /scheduled-reports/, 'runbook covers scheduled report cron monitoring');
  assertContains(file, /REPORT_CRON_SECRET/, 'runbook covers report cron secret');
  assertContains(file, /Paystack verification/i, 'runbook covers payment verification monitoring');
  assertContains(file, /bounces, complaints, suppression list/i, 'runbook covers email deliverability monitoring');
  assertContains(file, /Alert Routing/, 'runbook defines alert routing');
  assertContains(file, /Incident Evidence/, 'runbook defines incident evidence');
  assertContains(file, /Handover Evidence/, 'runbook defines monitoring handover evidence');
}

function checkSystemSupport() {
  const health = read('supabase/functions/health-check/index.ts');
  assert(/status/.test(health), 'health-check reports status');
  assert(/checked_at/.test(health), 'health-check reports timestamp');
  assert(/storage\/v1\/bucket/.test(health), 'health-check validates storage buckets');
  assert(/x-health-secret/.test(health), 'health-check supports detailed secret header');
  assert(/HEALTH_CHECK_SECRET/.test(read('.env.production.example')), 'env template includes HEALTH_CHECK_SECRET');
  assert(/REPORT_CRON_SECRET/.test(read('.env.production.example')), 'env template includes REPORT_CRON_SECRET');
  assert(/run_due/.test(read('supabase/functions/scheduled-reports/index.ts')), 'scheduled reports support run_due');
  assert(/retryPaymentVerification/.test(frontendSource()), 'frontend supports payment verification retry');
}

function checkDocsAndAutomation() {
  assertContains('package.json', /"verify:monitor"/, 'package exposes monitoring verifier');
  assertContains('.github/workflows/verify.yml', /npm run verify:monitor/, 'GitHub Actions runs monitoring verifier');
  assertContains('docs/release-checklist.md', /production-monitoring-runbook\.md/, 'release checklist links monitoring runbook');
  assertContains('docs/release-checklist.md', /npm run verify:monitor/, 'release checklist includes monitoring verifier');
  assertContains('docs/production-deployment-runbook.md', /production-monitoring-runbook\.md/, 'production runbook links monitoring runbook');
  assertContains('docs/production-deployment-runbook.md', /npm run verify:monitor/, 'production runbook includes monitoring verifier');
  assertContains('docs/local-development-setup.md', /npm run verify:monitor/, 'local setup includes monitoring verifier');
  assertContains('docs/spms-implementation-roadmap.md', /verify:monitor/, 'roadmap documents monitoring verifier');
  assertContains('scripts/verify-lifecycle.js', /verify-monitoring/, 'lifecycle verifier executes monitoring verifier');
  assertContains('scripts/verify-release-readiness.js', /verify-monitoring/, 'release verifier requires monitoring verifier');
}

checkRunbook();
checkSystemSupport();
checkDocsAndAutomation();

console.log('');
console.log(`Monitoring verification complete: ${failures.length} failure(s).`);
if (failures.length) process.exit(1);
