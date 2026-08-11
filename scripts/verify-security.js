#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const failures = [];

const edgeFunctions = [
  'verify-paystack',
  'project-workflow',
  'repository-access',
  'student-identity',
  'verification-lookup',
  'scheduled-reports',
  'health-check',
];

const rlsTables = [
  'profiles',
  'students_registry',
  'submissions',
  'payments',
  'institutions',
  'system_configs',
  'projects',
  'project_reviews',
  'public_catalog',
  'repository_unlocks',
  'guest_download_orders',
  'clearance_receipts',
  'audit_logs',
  'notifications',
  'report_schedules',
  'generated_reports',
];

function pass(message) {
  console.log(`PASS   ${message}`);
}

function fail(message) {
  failures.push(message);
  console.log(`FAIL   ${message}`);
}

function assert(condition, message) {
  if (condition) pass(message);
  else fail(message);
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

function combinedSql() {
  return [
    'supabase/schema.sql',
    'supabase/payments.sql',
    'supabase/secure-payments.sql',
    'supabase/spms-core.sql',
  ].map(read).join('\n');
}

function checkRequiredFiles() {
  ['SECURITY.md', '.gitignore', '.env.production.example', 'supabase/config.toml'].forEach((file) => {
    assert(exists(file), `${file} exists`);
  });
}

function checkSecretHygiene() {
  const scanFiles = [
    'index.html',
    'js/config.js',
    'package.json',
    'SECURITY.md',
    'docs/local-development-setup.md',
    'docs/production-deployment-runbook.md',
    'docs/release-checklist.md',
    'supabase/config.toml',
    'supabase/deploy-verify-paystack.sh',
  ];
  const leaks = [];
  scanFiles.forEach((file) => {
    const content = read(file);
    if (/sk_(test|live)_[A-Za-z0-9]{12,}/.test(content)) leaks.push(`${file}: Paystack secret`);
    if (/re_[A-Za-z0-9]{12,}/.test(content) && !content.includes('re_xxxxx')) leaks.push(`${file}: Resend key`);
    if (/CLOUDFLARE_API_TOKEN\s*=\s*[^.\n]/.test(content)) leaks.push(`${file}: Cloudflare token`);
    if (/service_role/i.test(content) && /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(content)) {
      leaks.push(`${file}: possible Supabase service role JWT`);
    }
  });

  assert(leaks.length === 0, `no obvious private secrets in tracked release files${leaks.length ? `: ${leaks.join(', ')}` : ''}`);
  assert(/\.env(\n|$)/.test(read('.gitignore')), '.env files are ignored');
  assert(/\.env\.\*\.local/.test(read('.gitignore')), 'local env variants are ignored');
}

function checkPaymentSafety() {
  const html = frontendSource();
  assert(!/PaystackPop\.setup|openIframe\(/.test(html), 'browser does not create Paystack transactions directly');
  assert(/resumeTransaction|retryPaymentVerification/.test(html), 'browser only resumes backend-initialized Paystack checkout');

  ['supabase/functions/verify-paystack/index.ts', 'supabase/functions/repository-access/index.ts'].forEach((file) => {
    const content = read(file);
    assert(/PAYSTACK_SECRET_KEY/.test(content), `${file} reads Paystack secret server-side`);
    assert(/https:\/\/api\.paystack\.co\/transaction\/verify/.test(content), `${file} verifies Paystack transactions server-side`);
  });

  const sql = combinedSql();
  assert(/DROP POLICY IF EXISTS "Students insert own payments"/.test(sql), 'client-side payment inserts are revoked');
  assert(/DROP POLICY IF EXISTS "Students insert own submissions"/.test(sql), 'client-side submission inserts are revoked');
}

function checkRls() {
  const sql = combinedSql();
  rlsTables.forEach((table) => {
    assert(new RegExp(`ALTER TABLE\\s+${table}\\s+ENABLE ROW LEVEL SECURITY`, 'i').test(sql), `RLS enabled on ${table}`);
  });

  [
    'Students read own payments',
    'Admins read all payments',
    'Students read own projects',
    'Supervisors read assigned projects',
    'Users read own notifications',
    'Admins manage report schedules',
  ].forEach((policy) => {
    assert(sql.includes(`CREATE POLICY "${policy}"`), `policy exists: ${policy}`);
  });
  assert(/current_institution_id\(\)/.test(sql), 'tenant-aware RLS helper exists');
  assert(/Admins read all projects[\s\S]+institution_id\s*=\s*public\.current_institution_id\(\)/i.test(sql), 'admin project policy is tenant scoped');
  assert(/Library read review queue[\s\S]+institution_id\s*=\s*public\.current_institution_id\(\)/i.test(sql), 'library queue policy is tenant scoped');
  assert(/Admins read guest download orders[\s\S]+institution_id\s*=\s*public\.current_institution_id\(\)/i.test(sql), 'guest download records are tenant scoped');
  const repositoryAccess = read('supabase/functions/repository-access/index.ts');
  assert(/initialize_guest_download|verify_guest_download/.test(repositoryAccess), 'guest repository actions are handled server-side');
  assert(/Repository downloads require an account with a matric number and institutional email/.test(repositoryAccess), 'unauthenticated repository downloads are rejected');
  assert(/requireEmail\(body\.email\)/.test(repositoryAccess), 'guest download requires a validated email address');
  assert(/transaction\.customer\.email\.toLowerCase\(\) !== email/.test(repositoryAccess), 'guest payment email is matched before issuing access');
  assert(/guest_download_orders\?select=\*/.test(repositoryAccess), 'successful guest download payments are persisted');
}

function checkStoragePrivacy() {
  const sql = combinedSql();
  ['thesis-pdfs', 'repository-downloads', 'reports'].forEach((bucket) => {
    assert(new RegExp(`'${bucket}'[\\s\\S]{0,80}false`).test(sql), `${bucket} bucket is private`);
  });
  assert(/createSignedUrl/.test(frontendSource()), 'frontend downloads generated reports through signed URLs');
  assert(/createSignedReportUrl/.test(read('supabase/functions/scheduled-reports/index.ts')), 'scheduled report email uses signed URLs');
  assert(/watermarkPdf/.test(read('supabase/functions/repository-access/index.ts')), 'repository downloads are watermarked');
}

function checkPdfValidation() {
  const sharedPdf = read('supabase/functions/_shared/pdf.ts');
  const paymentFunction = read('supabase/functions/verify-paystack/index.ts');
  const workflowFunction = read('supabase/functions/project-workflow/index.ts');
  assert(/PDF_SIGNATURE/.test(sharedPdf), 'server PDF validation checks the file signature');
  assert(/Range:\s*"bytes=0-4"/.test(sharedPdf), 'server PDF validation reads only the object header');
  assert(/assertPdfStorageObject/.test(paymentFunction), 'clearance verification validates stored PDF content');
  assert(/file_path\.startsWith\(`\$\{user\.id\}\/`\)/.test(paymentFunction), 'clearance verification scopes the file path to the authenticated student');
  assert(/assertPdfStorageObject/.test(workflowFunction), 'revision resubmission validates stored PDF content');
}

function checkEdgeFunctionAuthAndCors() {
  const config = read('supabase/config.toml');
  edgeFunctions.forEach((name) => {
    const file = `supabase/functions/${name}/index.ts`;
    const content = read(file);
    assert(new RegExp(`\\[functions\\.${name}\\][\\s\\S]*?verify_jwt\\s*=\\s*false`).test(config), `${name} CORS preflight is not blocked at gateway`);
    assert(/Access-Control-Allow-Origin/.test(content), `${name} returns CORS headers`);
    assert(/OPTIONS/.test(content), `${name} handles OPTIONS preflight`);
  });

  ['verify-paystack', 'project-workflow', 'repository-access', 'scheduled-reports', 'health-check'].forEach((name) => {
    const content = read(`supabase/functions/${name}/index.ts`);
    assert(/auth\/v1\/user|auth\.getUser|REPORT_CRON_SECRET|HEALTH_CHECK_SECRET/.test(content), `${name} validates auth or secret inside function`);
  });

  const publicVerification = read('supabase/functions/verification-lookup/index.ts');
  assert(!/file_path|storage_path|signedUrl|signedURL/.test(publicVerification), 'public verification function does not expose private file paths or signed URLs');
  const healthCheck = read('supabase/functions/health-check/index.ts');
  assert(/x-health-secret/.test(healthCheck), 'health-check requires x-health-secret for detailed output when configured');
  assert(!/serviceRoleKey[^;]*jsonResponse|SUPABASE_SERVICE_ROLE_KEY[^;]*jsonResponse/.test(healthCheck), 'health-check does not return service role key material');
}

function checkSecurityDocs() {
  const policy = read('SECURITY.md');
  assert(/Secret Handling/.test(policy), 'security policy documents secret handling');
  assert(/Payment Safety/.test(policy), 'security policy documents payment safety');
  assert(/Row Level Security/.test(policy), 'security policy documents RLS expectations');
  assert(/npm run verify:security/.test(policy), 'security policy documents security verifier');
  assert(/npm run verify:security/.test(read('docs/release-checklist.md')), 'release checklist includes security verifier');
}

checkRequiredFiles();
checkSecretHygiene();
checkPaymentSafety();
checkRls();
checkStoragePrivacy();
checkPdfValidation();
checkEdgeFunctionAuthAndCors();
checkSecurityDocs();

console.log('');
console.log(`Security verification complete: ${failures.length} failure(s).`);
if (failures.length) process.exit(1);
