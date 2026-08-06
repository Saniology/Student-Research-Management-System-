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

function assert(condition, message) {
  if (condition) pass(message);
  else fail(message);
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function assignment(content, name) {
  const pattern = new RegExp(`window\\.${name}\\s*=\\s*['"]([^'"]*)['"]\\s*;`);
  const match = content.match(pattern);
  return match ? match[1].trim() : '';
}

function decodeJwtPayload(jwt) {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('JWT must have three sections');
  const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
}

function projectRefFromUrl(url) {
  const match = String(url).match(/^https:\/\/([a-z0-9-]+)\.supabase\.co$/i);
  return match ? match[1] : '';
}

function checkConfigShape() {
  const config = read('js/config.js');
  const supabaseUrl = assignment(config, 'SUPABASE_URL');
  const anonKey = assignment(config, 'SUPABASE_ANON_KEY');
  const paystackPublicKey = assignment(config, 'PAYSTACK_PUBLIC_KEY');
  const tenantSlug = assignment(config, 'SPMS_DEFAULT_TENANT_SLUG');

  assert(Boolean(supabaseUrl), 'SUPABASE_URL is declared in js/config.js');
  assert(/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(supabaseUrl), 'SUPABASE_URL uses a valid Supabase project URL');
  assert(Boolean(anonKey), 'SUPABASE_ANON_KEY is declared in js/config.js');
  assert(/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(anonKey), 'SUPABASE_ANON_KEY looks like a JWT');
  assert(/^pk_(test|live)_[A-Za-z0-9]+$/.test(paystackPublicKey), 'PAYSTACK_PUBLIC_KEY is a public Paystack key');
  assert(/^[a-z0-9-]+$/.test(tenantSlug), 'SPMS_DEFAULT_TENANT_SLUG is URL-safe');

  try {
    const payload = decodeJwtPayload(anonKey);
    const ref = projectRefFromUrl(supabaseUrl);
    assert(payload.role === 'anon', 'SUPABASE_ANON_KEY has anon role');
    assert(payload.ref === ref, 'SUPABASE_ANON_KEY project ref matches SUPABASE_URL');
    assert(typeof payload.exp === 'number' && payload.exp * 1000 > Date.now(), 'SUPABASE_ANON_KEY is not expired');
  } catch (error) {
    fail(`SUPABASE_ANON_KEY payload is readable: ${error.message}`);
  }
}

function checkBrowserSecretHygiene() {
  const browserFiles = ['index.html', 'js/config.js'];
  const leaks = [];

  browserFiles.forEach((file) => {
    const content = read(file);
    if (/sk_(test|live)_[A-Za-z0-9]{12,}/.test(content)) leaks.push(`${file}: Paystack secret key`);
    if (/service_role/i.test(content)) leaks.push(`${file}: service role reference`);
    if (/SUPABASE_SERVICE_ROLE_KEY/.test(content)) leaks.push(`${file}: service role env name`);
    if (/re_[A-Za-z0-9]{12,}/.test(content)) leaks.push(`${file}: email provider API key`);
    if (/CLOUDFLARE_API_TOKEN/.test(content)) leaks.push(`${file}: Cloudflare token name`);
  });

  assert(leaks.length === 0, `browser files contain only public config${leaks.length ? `: ${leaks.join(', ')}` : ''}`);
}

function checkRuntimeValidation() {
  const html = read('index.html');
  assert(/function validateAppConfig/.test(html), 'frontend validates browser configuration at runtime');
  assert(/showAppConfigError/.test(html), 'frontend shows configuration errors');
  assert(/YOUR_SUPABASE|anon_key_here|replace/i.test(html), 'frontend rejects placeholder config values');
  assert(/PAYSTACK_PUBLIC_KEY/.test(html) && /pk_test|pk_live/.test(html), 'frontend references Paystack public key format');
  assert(!/PaystackPop\.setup|openIframe\(/.test(html), 'frontend does not initialize Paystack directly with browser config');
}

function checkDocs() {
  const localSetup = read('docs/local-development-setup.md');
  const release = read('docs/release-checklist.md');
  assert(/js\/config\.js/.test(localSetup), 'local setup documents js/config.js');
  assert(/SUPABASE_ANON_KEY/.test(localSetup), 'local setup documents Supabase anon key');
  assert(/PAYSTACK_PUBLIC_KEY/.test(localSetup), 'local setup documents Paystack public key');
  assert(/npm run verify:config/.test(release), 'release checklist includes browser config verifier');
}

checkConfigShape();
checkBrowserSecretHygiene();
checkRuntimeValidation();
checkDocs();

console.log('');
console.log(`Browser config verification complete: ${failures.length} failure(s).`);
if (failures.length) process.exit(1);
