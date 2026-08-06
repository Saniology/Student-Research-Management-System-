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
    'docs/local-development-setup.md',
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
  assertContains('supabase/spms-core.sql', /CREATE OR REPLACE VIEW admin_overview/, 'admin overview view exists');

  assertContains('supabase/functions/verify-paystack/index.ts', /initialize_clearance/, 'clearance payments initialize server-side');
  assertContains('supabase/functions/repository-access/index.ts', /initialize_download/, 'repository payments initialize server-side');
  assertContains('supabase/functions/repository-access/index.ts', /watermarkPdf/, 'repository downloads are watermarked');
  assertContains('supabase/functions/project-workflow/index.ts', /notifyUsers/, 'workflow notifications are emitted');
  assertContains('supabase/functions/verification-lookup/index.ts', /clearance_receipts/, 'public receipt verification exists');
  assertContains('supabase/functions/verification-lookup/index.ts', /public_catalog/, 'public project verification exists');
  assertContains('supabase/functions/verification-lookup/index.ts', /qr_svg/, 'server-rendered QR SVG endpoint exists');
  assertContains('supabase/functions/verification-lookup/index.ts', /qrcode-generator@2\.0\.4/, 'server QR generator dependency is pinned');

  assertContains('index.html', /resumePaystackCheckout/, 'frontend resumes backend-initialized Paystack checkout');
  assertContains('index.html', /type: 'qr_svg'/, 'frontend requests server-rendered QR SVG assets');
  assertNotContains('index.html', /PaystackPop\.setup|openIframe\(/, 'frontend no longer creates Paystack transactions directly');
  assertContains('index.html', /exportFinancialReport/, 'admin financial reports exist');
  assertContains('index.html', /exportProjectReport/, 'admin project lifecycle export exists');
}

function checkDeployConfig() {
  const requiredFunctions = [
    'verify-paystack',
    'project-workflow',
    'repository-access',
    'verification-lookup',
  ];

  const deployScript = read('supabase/deploy-verify-paystack.sh');
  requiredFunctions.forEach((functionName) => {
    if (deployScript.includes(functionName)) {
      pass(`deploy script includes ${functionName}`);
    } else {
      fail(`deploy script missing ${functionName}`);
    }
  });

  run('bash', ['-n', 'supabase/deploy-verify-paystack.sh'], 'deploy script syntax is valid');
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
checkDenoFunctions();
checkLocalServer();
