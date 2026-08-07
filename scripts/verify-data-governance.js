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

function extractCreateTable(sql, tableName) {
  const match = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${tableName} \\(([\\s\\S]*?)\\n\\);`, 'i'));
  return match ? match[1] : '';
}

function checkRunbook() {
  const file = 'docs/data-governance-privacy-runbook.md';
  assert(exists(file), 'data governance and privacy runbook exists');
  assertContains(file, /Governance Owners/, 'runbook names governance owners');
  assertContains(file, /Data Classification/, 'runbook defines data classification');
  assertContains(file, /Public[\s\S]*Internal[\s\S]*Restricted[\s\S]*Secret/, 'runbook covers public, internal, restricted, and secret data');
  assertContains(file, /Public And Private Boundary/, 'runbook defines public/private data boundary');
  assertContains(file, /verification-lookup/, 'runbook covers public verification endpoint');
  assertContains(file, /must not return private file paths, storage paths, signed URLs/i, 'runbook forbids public private-path exposure');
  assertContains(file, /Storage Privacy/, 'runbook covers storage privacy');
  assertContains(file, /thesis-pdfs/, 'runbook covers thesis uploads bucket');
  assertContains(file, /repository-downloads/, 'runbook covers repository downloads bucket');
  assertContains(file, /reports/, 'runbook covers reports bucket');
  assertContains(file, /Retention Schedule/, 'runbook defines retention schedule');
  assertContains(file, /Generated reports[\s\S]*expire or delete/i, 'runbook covers generated report retention');
  assertContains(file, /Watermarked repository copies[\s\S]*short retention/i, 'runbook covers watermarked copy retention');
  assertContains(file, /Data Subject Requests/, 'runbook covers data subject requests');
  assertContains(file, /correction, access, restriction, export, or deletion/i, 'runbook covers request types');
  assertContains(file, /Access Reviews/, 'runbook covers periodic access reviews');
  assertContains(file, /once per term/i, 'runbook defines access review cadence');
  assertContains(file, /Privacy Incident Response/, 'runbook covers privacy incident response');
  assertContains(file, /rotate exposed secrets/i, 'runbook covers secret rotation after privacy incident');
  assertContains(file, /Handover Evidence/, 'runbook defines governance handover evidence');
  assertContains(file, /NDPA\/NDPR|local privacy law/i, 'runbook references applicable privacy law review');
}

function checkSchemaBoundary() {
  const sql = read('supabase/spms-core.sql');
  const deployedSql = [
    'supabase/schema.sql',
    'supabase/payments.sql',
    'supabase/secure-payments.sql',
    'supabase/spms-core.sql',
  ].map(read).join('\n\n');
  const publicCatalog = extractCreateTable(sql, 'public_catalog');

  assert(/CREATE TABLE IF NOT EXISTS public_catalog/.test(sql), 'public catalog table exists');
  assert(/CREATE TABLE IF NOT EXISTS clearance_receipts/.test(sql), 'clearance receipt table exists');
  assert(/CREATE TABLE IF NOT EXISTS audit_logs/.test(sql), 'audit log table exists');
  assert(publicCatalog.length > 0, 'public catalog schema can be inspected');
  assert(!/file_path|storage_path|signed_url|signedUrl|payment|matric|email|student_id/i.test(publicCatalog), 'public catalog schema excludes private paths, payment fields, and direct student identifiers');

  ['thesis-pdfs', 'repository-downloads', 'reports'].forEach((bucket) => {
    assert(new RegExp(`'${bucket}'[\\s\\S]{0,120}false`, 'i').test(deployedSql), `${bucket} bucket is declared private`);
  });

  assert(/ALTER TABLE public_catalog ENABLE ROW LEVEL SECURITY/.test(sql), 'public catalog has RLS enabled');
  assert(/ALTER TABLE clearance_receipts ENABLE ROW LEVEL SECURITY/.test(sql), 'clearance receipts have RLS enabled');
  assert(/ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY/.test(sql), 'audit logs have RLS enabled');
  assert(/Public read anonymized catalog/.test(sql), 'public catalog policy is explicitly anonymized');
  assert(/Admins read audit logs/.test(sql), 'audit logs are restricted to admins');
}

function checkPublicVerificationBoundary() {
  const edge = read('supabase/functions/verification-lookup/index.ts');
  assert(/clearance_receipts/.test(edge), 'verification endpoint verifies clearance receipts');
  assert(/public_catalog/.test(edge), 'verification endpoint verifies published catalog records');
  assert(!/file_path|storage_path|signedUrl|signedURL|signed_url|reports|audit_logs|payment_metadata/i.test(edge), 'verification endpoint does not expose private paths, signed URLs, reports, audit logs, or payment metadata');
  assert(/select=project_id,title,abstract,degree,department_name,shelf_number,doi,published_at/.test(edge), 'project verification selects only public catalog fields');
}

function checkDocsAndAutomation() {
  assertContains('package.json', /"verify:governance"/, 'package exposes governance verifier');
  assertContains('.github/workflows/verify.yml', /npm run verify:governance/, 'GitHub Actions runs governance verifier');
  assertContains('docs/release-checklist.md', /data-governance-privacy-runbook\.md/, 'release checklist links governance runbook');
  assertContains('docs/release-checklist.md', /npm run verify:governance/, 'release checklist includes governance verifier');
  assertContains('docs/production-deployment-runbook.md', /data-governance-privacy-runbook\.md/, 'production runbook links governance runbook');
  assertContains('docs/production-deployment-runbook.md', /npm run verify:governance/, 'production runbook includes governance verifier');
  assertContains('docs/local-development-setup.md', /npm run verify:governance/, 'local setup includes governance verifier');
  assertContains('docs/spms-implementation-roadmap.md', /verify:governance/, 'roadmap documents governance verifier');
  assertContains('scripts/verify-lifecycle.js', /verify-data-governance/, 'lifecycle verifier executes governance verifier');
  assertContains('scripts/verify-release-readiness.js', /verify-data-governance/, 'release verifier requires governance verifier');
  assertContains('SECURITY.md', /data-governance-privacy-runbook\.md/, 'security policy links governance runbook');
}

checkRunbook();
checkSchemaBoundary();
checkPublicVerificationBoundary();
checkDocsAndAutomation();

console.log('');
console.log(`Data governance verification complete: ${failures.length} failure(s).`);
if (failures.length) process.exit(1);
