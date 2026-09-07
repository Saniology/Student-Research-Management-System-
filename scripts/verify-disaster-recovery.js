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
  const file = 'docs/disaster-recovery-runbook.md';
  assert(exists(file), 'disaster recovery runbook exists');
  assertContains(file, /Recovery point objective \(RPO\)/, 'runbook defines RPO');
  assertContains(file, /Recovery time objective \(RTO\)/, 'runbook defines RTO');
  assertContains(file, /Monthly restore drill/i, 'runbook requires restore drills');
  assertContains(file, /pg_dump/, 'runbook documents database logical backup');
  assertContains(file, /7 daily restore points/, 'runbook documents daily retention');
  assertContains(file, /4 weekly restore points/, 'runbook documents weekly retention');
  assertContains(file, /12 monthly restore points/, 'runbook documents monthly retention');
  assertContains(file, /thesis-pdfs/, 'runbook covers thesis-pdfs bucket');
  assertContains(file, /repository-downloads/, 'runbook covers repository-downloads bucket');
  assertContains(file, /reports/, 'runbook covers reports bucket');
  assertContains(file, /schema\.sql.*payments\.sql.*secure-payments\.sql.*spms-core\.sql/s, 'runbook documents SQL restore order');
  assertContains(file, /npm run verify:deploy/, 'runbook includes live deployment verification after restore');
  assertContains(file, /health-check/, 'runbook validates health-check after restore');
  assertContains(file, /RLS is enabled/, 'runbook validates RLS after restore');
  assertContains(file, /private buckets remain private/, 'runbook validates storage privacy after restore');
  assertContains(file, /receipt verification codes/i, 'runbook covers receipt verification evidence');
  assertContains(file, /Rotate secrets/, 'runbook covers credential rotation after incidents');
}

function checkReleaseAndProductionDocs() {
  assertContains('docs/release-checklist.md', /disaster-recovery-runbook\.md/, 'release checklist links disaster recovery runbook');
  assertContains('docs/release-checklist.md', /npm run verify:dr/, 'release checklist includes DR verifier');
  assertContains('docs/production-deployment-runbook.md', /disaster-recovery-runbook\.md/, 'production runbook links disaster recovery runbook');
  assertContains('docs/production-deployment-runbook.md', /npm run verify:dr/, 'production runbook includes DR verifier');
  assertContains('docs/local-development-setup.md', /npm run verify:dr/, 'local setup includes DR verifier');
  assertContains('docs/spms-implementation-roadmap.md', /verify:dr/, 'roadmap documents DR verifier');
}

function checkSystemCoverage() {
  const sql = [
    read('supabase/schema.sql'),
    read('supabase/payments.sql'),
    read('supabase/secure-payments.sql'),
    read('supabase/spms-core.sql'),
  ].join('\n');

  ['thesis-pdfs', 'repository-downloads', 'reports'].forEach((bucket) => {
    assert(new RegExp(`'${bucket}'[\\s\\S]{0,100}false`).test(sql), `${bucket} bucket is declared private in SQL`);
  });

  assert(/CREATE TABLE IF NOT EXISTS audit_logs/.test(sql), 'audit log table exists for incident review');
  assert(/CREATE TABLE IF NOT EXISTS clearance_receipts/.test(sql), 'clearance receipts exist for post-restore verification');
  assert(/CREATE TABLE IF NOT EXISTS public_catalog/.test(sql), 'public catalog exists for post-restore verification');
  assert(/CREATE TABLE IF NOT EXISTS generated_reports/.test(sql), 'generated reports exist for post-restore verification');
  assert(/health-check/.test(read('supabase/config.toml')), 'health-check function is configured');
  assert(/storage\/v1\/bucket/.test(read('supabase/functions/health-check/index.ts')), 'health-check validates storage buckets');
}

function checkAutomationWiring() {
  assertContains('package.json', /"verify:dr"/, 'package exposes DR verifier');
  assertContains('.github/workflows/verify.yml', /npm run verify:dr/, 'GitHub Actions runs DR verifier');
  assertContains('scripts/verify-lifecycle.js', /verify-disaster-recovery/, 'lifecycle verifier executes DR verifier');
  assertContains('scripts/verify-release-readiness.js', /verify-disaster-recovery/, 'release verifier requires DR verifier');
}

checkRunbook();
checkReleaseAndProductionDocs();
checkSystemCoverage();
checkAutomationWiring();

console.log('');
console.log(`Disaster recovery verification complete: ${failures.length} failure(s).`);
if (failures.length) process.exit(1);
