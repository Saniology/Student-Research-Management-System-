#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const failures = [];

const contracts = [
  {
    name: 'verify-paystack',
    methods: ['POST', 'OPTIONS'],
    actions: ['initialize_clearance'],
    errors: ['Missing authorization header', 'Paystack secret key is not configured', 'Missing payment reference or file name'],
    env: ['PAYSTACK_SECRET_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'],
    auth: true,
  },
  {
    name: 'project-workflow',
    methods: ['POST', 'OPTIONS'],
    actions: ['supervisor_decision', 'student_resubmit', 'assign_supervisor', 'library_verify', 'library_publish', 'issue_receipt'],
    errors: ['Unknown workflow action', 'Missing authorization header', 'Only students can resubmit a revision', 'Only library staff or admins can publish projects', 'Project belongs to another institution'],
    env: ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'],
    auth: true,
  },
  {
    name: 'repository-access',
    methods: ['POST', 'OPTIONS'],
    actions: ['get_download_url', 'initialize_download', 'verify_download'],
    errors: ['Unknown repository access action', 'Paystack secret key is not configured', 'Published project not found', 'Repository record belongs to another institution'],
    env: ['PAYSTACK_SECRET_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'],
    auth: true,
    pins: ['pdf-lib@1.17.1'],
  },
  {
    name: 'student-identity',
    methods: ['POST', 'OPTIONS'],
    actions: ['students/lookup', 'students_registry', 'SIS_API_URL'],
    errors: ['Method not allowed', 'That matric number is not in the student registry'],
    env: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
    auth: false,
  },
  {
    name: 'public-config',
    methods: ['POST', 'OPTIONS'],
    actions: ['clearance_fee_kobo', 'download_fee_kobo', 'max_pdf_size_bytes'],
    errors: ['Method not allowed', 'Public configuration service is not configured'],
    env: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
    auth: false,
  },
  {
    name: 'verification-lookup',
    methods: ['POST', 'OPTIONS'],
    actions: ['qr_svg', 'receipt', 'project'],
    errors: ['Unknown verification type', 'Receipt verification code was not found', 'Published project was not found'],
    env: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
    auth: false,
    pins: ['qrcode-generator@2.0.4'],
  },
  {
    name: 'scheduled-reports',
    methods: ['POST', 'OPTIONS'],
    actions: ['run_once', 'run_due'],
    errors: ['Unknown scheduled report action', 'Missing authorization header', 'Only admins can run reports'],
    env: ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'REPORT_CRON_SECRET'],
    auth: true,
    headers: ['x-cron-secret'],
  },
  {
    name: 'health-check',
    methods: ['GET', 'POST', 'OPTIONS'],
    actions: [],
    errors: ['Method not allowed', 'Provide x-health-secret for detailed checks.'],
    env: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'HEALTH_CHECK_SECRET'],
    auth: false,
    headers: ['x-health-secret'],
  },
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

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function assert(condition, message) {
  if (condition) pass(message);
  else fail(message);
}

function contains(content, literal) {
  return content.includes(literal);
}

function checkCommonFunctionContract(contract) {
  const file = `supabase/functions/${contract.name}/index.ts`;
  assert(exists(file), `${contract.name} function file exists`);
  if (!exists(file)) return;

  const content = read(file);
  assert(/const\s+corsHeaders\s*=/.test(content), `${contract.name} defines reusable CORS headers`);
  assert(contains(content, '"Access-Control-Allow-Origin": "*"'), `${contract.name} allows browser origins for preflight`);
  assert(/"Access-Control-Allow-Headers"[\s\S]*content-type/.test(content), `${contract.name} allows content-type header`);
  assert(/Access-Control-Max-Age/.test(content), `${contract.name} caches successful preflight`);
  assert(/Deno\.serve/.test(content), `${contract.name} registers a Supabase Edge handler`);
  assert(/req\.method\s*===\s*"OPTIONS"[\s\S]+status:\s*204[\s\S]+corsHeaders/.test(content), `${contract.name} returns 204 for OPTIONS preflight`);
  assert(/Method not allowed/.test(content), `${contract.name} rejects unsupported methods`);
  assert(/function\s+jsonResponse/.test(content), `${contract.name} centralizes JSON responses`);
  assert(/headers:\s*\{\s*\.\.\.corsHeaders,[\s\S]*"Content-Type":\s*"application\/json"/.test(content), `${contract.name} applies CORS headers to JSON responses`);

  contract.methods.forEach((method) => {
    assert(contains(content, method), `${contract.name} declares ${method} method support`);
  });

  contract.actions.forEach((action) => {
    assert(contains(content, action), `${contract.name} supports ${action}`);
  });

  contract.errors.forEach((message) => {
    assert(contains(content, message), `${contract.name} has ${message} error contract`);
  });

  contract.env.forEach((name) => {
    assert(contains(content, name), `${contract.name} reads ${name}`);
  });

  (contract.headers || []).forEach((header) => {
    assert(contains(content, header), `${contract.name} supports ${header} header`);
  });

  (contract.pins || []).forEach((pin) => {
    assert(contains(content, pin), `${contract.name} pins dependency ${pin}`);
  });

  if (contract.auth) {
    assert(/getAuthenticatedUser/.test(content), `${contract.name} validates authenticated users inside handler`);
  }
}

function checkSupabaseConfig() {
  const config = read('supabase/config.toml');
  contracts.forEach((contract) => {
    const pattern = new RegExp(`\\[functions\\.${contract.name}\\][\\s\\S]*?verify_jwt\\s*=\\s*false`);
    assert(pattern.test(config), `${contract.name} disables gateway JWT so OPTIONS preflight can reach the function`);
  });
}

function checkDeployScript() {
  const deploy = read('supabase/deploy-verify-paystack.sh');
  contracts.forEach((contract) => {
    assert(contains(deploy, contract.name), `deploy script includes ${contract.name}`);
  });
  assert(/--no-verify-jwt/.test(deploy), 'deploy script deploys functions with no gateway JWT verification');
  assert(/--use-api/.test(deploy), 'deploy script uses API deployment mode');
}

function checkLiveSmokeVerifier() {
  const smoke = read('scripts/verify-supabase-deployment.js');
  contracts.forEach((contract) => {
    assert(contains(smoke, contract.name), `deployment smoke verifier checks ${contract.name}`);
  });
  assert(/NOT_FOUND/.test(smoke), 'deployment smoke verifier detects missing function deployments');
  assert(/access-control-allow-origin/.test(smoke), 'deployment smoke verifier validates CORS response headers');
}

contracts.forEach(checkCommonFunctionContract);
const scheduledReports = read('supabase/functions/scheduled-reports/index.ts');
assert(/"Content-Type":\s*"text\/csv"/.test(scheduledReports), 'scheduled reports upload uses the allowed CSV MIME type');
assert(!/text\/csv;\s*charset/i.test(scheduledReports), 'scheduled reports upload does not append an unsupported CSV charset');
checkSupabaseConfig();
checkDeployScript();
checkLiveSmokeVerifier();

console.log('');
console.log(`Edge Function contract verification complete: ${failures.length} failure(s).`);
if (failures.length) process.exit(1);
