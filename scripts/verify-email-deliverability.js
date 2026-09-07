#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const failures = [];

function log(status, message) {
  console.log(`${status.padEnd(6, ' ')} ${message}`);
}

function pass(message) {
  log('PASS', message);
}

function fail(message) {
  failures.push(message);
  log('FAIL', message);
}

function assert(condition, message) {
  if (condition) pass(message);
  else fail(message);
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function assertFile(relativePath) {
  assert(fs.existsSync(path.join(root, relativePath)), `${relativePath} exists`);
}

function assertContains(relativePath, pattern, message) {
  assert(pattern.test(read(relativePath)), message);
}

function checkRunbook() {
  assertFile('docs/production-email-deliverability.md');
  [
    [/SPF/i, 'email runbook documents SPF'],
    [/DKIM/i, 'email runbook documents DKIM'],
    [/DMARC/i, 'email runbook documents DMARC'],
    [/From domain aligns/i, 'email runbook documents sender alignment'],
    [/bounces/i, 'email runbook documents bounce monitoring'],
    [/complaints/i, 'email runbook documents complaint monitoring'],
    [/suppression list/i, 'email runbook documents suppression monitoring'],
    [/DMARC aggregate reports/i, 'email runbook documents DMARC report monitoring'],
    [/REPORT_FROM_EMAIL/i, 'email runbook documents sender secret'],
    [/RESEND_API_KEY/i, 'email runbook documents provider secret'],
    [/REPORT_LINK_TTL_SECONDS/i, 'email runbook documents signed link TTL'],
    [/email_provider_not_configured/i, 'email runbook documents safe email rollback'],
    [/npm run verify:email/i, 'email runbook documents verifier command'],
  ].forEach(([pattern, message]) => assertContains('docs/production-email-deliverability.md', pattern, message));
}

function checkScheduledReportsFunction() {
  const file = 'supabase/functions/scheduled-reports/index.ts';
  assertContains(file, /RESEND_API_KEY/, 'scheduled reports reads Resend API key server-side');
  assertContains(file, /REPORT_FROM_EMAIL/, 'scheduled reports reads report sender server-side');
  assertContains(file, /REPORT_DELIVERY_EMAILS/, 'scheduled reports supports fallback recipients');
  assertContains(file, /REPORT_LINK_TTL_SECONDS/, 'scheduled reports supports signed link TTL');
  assertContains(file, /createSignedReportUrl/, 'scheduled reports sends private signed links');
  assertContains(file, /email_provider_not_configured/, 'scheduled reports safely skips email when provider is absent');
  assertContains(file, /provider:\s*"resend"/, 'scheduled reports records Resend delivery provider');
  assertContains(file, /https:\/\/api\.resend\.com\/emails/, 'scheduled reports uses Resend email API endpoint');
}

function checkReleaseDocs() {
  assertContains('docs/release-checklist.md', /production-email-deliverability\.md/, 'release checklist links email deliverability runbook');
  assertContains('docs/release-checklist.md', /npm run verify:email/, 'release checklist includes email verifier');
  assertContains('docs/production-deployment-runbook.md', /production-email-deliverability\.md/, 'production runbook links email deliverability runbook');
  assertContains('docs/local-development-setup.md', /npm run verify:email/, 'local setup includes email verifier');
  assertContains('docs/spms-implementation-roadmap.md', /verify:email/, 'roadmap documents email verifier');
}

function checkSecretHygiene() {
  const scanFiles = [
    '.env.production.example',
    'docs/production-email-deliverability.md',
    'docs/production-deployment-runbook.md',
    'docs/local-development-setup.md',
    'docs/release-checklist.md',
    'supabase/functions/scheduled-reports/index.ts',
  ];
  const leaks = [];
  scanFiles.forEach((relativePath) => {
    const content = read(relativePath);
    if (/re_[A-Za-z0-9]{12,}/.test(content) && !content.includes('re_xxxxx')) {
      leaks.push(`${relativePath}: possible Resend key`);
    }
  });
  assert(leaks.length === 0, `no real Resend API keys in email surfaces${leaks.length ? `: ${leaks.join(', ')}` : ''}`);
}

checkRunbook();
checkScheduledReportsFunction();
checkReleaseDocs();
checkSecretHygiene();

console.log('');
console.log(`Email deliverability verification complete: ${failures.length} failure(s).`);
if (failures.length) process.exit(1);
