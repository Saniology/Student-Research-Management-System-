#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const failures = [];

const requiredFiles = [
  '.env.production.example',
  'docs/local-development-setup.md',
  'docs/production-deployment-runbook.md',
  'docs/release-checklist.md',
  'SECURITY.md',
  'scripts/verify-lifecycle.js',
  'scripts/verify-security.js',
  'scripts/verify-ui-smoke.js',
];

const requiredEnvNames = [
  'SUPABASE_PROJECT_REF',
  'SUPABASE_URL',
  'PAYSTACK_SECRET_KEY',
  'REPORT_CRON_SECRET',
  'HEALTH_CHECK_SECRET',
  'RESEND_API_KEY',
  'REPORT_FROM_EMAIL',
  'REPORT_DELIVERY_EMAILS',
  'REPORT_LINK_TTL_SECONDS',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ZONE_ID',
  'SPMS_DNS_TARGET',
];

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

function assert(condition, message) {
  if (condition) pass(message);
  else fail(message);
}

function assertFile(relativePath) {
  assert(fs.existsSync(path.join(root, relativePath)), `${relativePath} exists`);
}

function assertContains(relativePath, pattern, message) {
  assert(pattern.test(read(relativePath)), message);
}

function checkRequiredFiles() {
  requiredFiles.forEach(assertFile);
}

function checkEnvTemplate() {
  const env = read('.env.production.example');
  requiredEnvNames.forEach((name) => {
    assert(new RegExp(`^${name}=`, 'm').test(env), `.env production template includes ${name}`);
  });
  assert(!/sk_(test|live)_[A-Za-z0-9]{12,}/.test(env), '.env production template does not contain a real Paystack secret');
  assert(!/service_role/i.test(env), '.env production template does not include service role key material');
}

function checkReleaseDocs() {
  assertContains('docs/release-checklist.md', /Code And Config/, 'release checklist includes code/config gate');
  assertContains('docs/release-checklist.md', /Database/, 'release checklist includes database gate');
  assertContains('docs/release-checklist.md', /Edge Functions/, 'release checklist includes function gate');
  assertContains('docs/release-checklist.md', /Payments/, 'release checklist includes payment gate');
  assertContains('docs/release-checklist.md', /Roles/, 'release checklist includes role gate');
  assertContains('docs/release-checklist.md', /Tenant Domain/, 'release checklist includes tenant domain gate');
  assertContains('docs/release-checklist.md', /health-check/, 'release checklist includes health check gate');
  assertContains('docs/release-checklist.md', /npm run verify:security/, 'release checklist includes security gate');
  assertContains('docs/production-deployment-runbook.md', /docs\/release-checklist\.md/, 'production runbook links release checklist');
  assertContains('docs/production-deployment-runbook.md', /npm run verify:security/, 'production runbook includes security verifier');
  assertContains('docs/production-deployment-runbook.md', /health-check/, 'production runbook includes health check endpoint');
  assertContains('docs/local-development-setup.md', /\.env\.production\.example/, 'local setup references env production template');
  assertContains('SECURITY.md', /Payment Safety/, 'security policy documents payment safety');
}

function checkSecretHygiene() {
  const scanFiles = [
    'index.html',
    'js/config.js',
    'docs/local-development-setup.md',
    'docs/production-deployment-runbook.md',
    'docs/release-checklist.md',
    'supabase/deploy-verify-paystack.sh',
  ];
  const leaks = [];
  scanFiles.forEach((relativePath) => {
    const content = read(relativePath);
    if (/sk_(test|live)_[A-Za-z0-9]{12,}/.test(content)) leaks.push(`${relativePath}: Paystack secret pattern`);
    if (/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(content) && /service_role/i.test(content)) {
      leaks.push(`${relativePath}: possible service role JWT`);
    }
  });
  assert(leaks.length === 0, `no obvious private secrets in release surfaces${leaks.length ? `: ${leaks.join(', ')}` : ''}`);
}

checkRequiredFiles();
checkEnvTemplate();
checkReleaseDocs();
checkSecretHygiene();

console.log('');
console.log(`Release readiness verification complete: ${failures.length} failure(s).`);
if (failures.length) process.exit(1);
