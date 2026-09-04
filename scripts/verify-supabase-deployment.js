#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const root = path.resolve(__dirname, '..');
const failures = [];
const warnings = [];

const requiredFunctions = [
  'verify-paystack',
  'project-workflow',
  'repository-access',
  'student-identity',
  'verification-lookup',
  'public-config',
  'scheduled-reports',
  'health-check',
];

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

function warn(message) {
  warnings.push(message);
  log('WARN', message);
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function loadEnvFile(relativePath) {
  const fullPath = path.join(root, relativePath);
  if (!fs.existsSync(fullPath)) return;

  fs.readFileSync(fullPath, 'utf8').split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]]) return;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  });
}

function configuredSupabaseUrl() {
  if (process.env.SUPABASE_URL) return process.env.SUPABASE_URL.trim();

  const config = read('js/config.js');
  const match = config.match(/window\.SUPABASE_URL\s*=\s*['"]([^'"]+)['"]/);
  return match ? match[1].trim() : '';
}

function normalizeSupabaseUrl(value) {
  const url = String(value || '').replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url)) {
    fail('SUPABASE_URL must be a valid https://<project-ref>.supabase.co URL');
    return '';
  }
  pass(`Supabase URL configured: ${url}`);
  return url;
}

function request(method, url, headers = {}) {
  return new Promise((resolve) => {
    const target = new URL(url);
    const client = target.protocol === 'http:' ? http : https;
    const req = client.request({
      method,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'http:' ? 80 : 443),
      path: target.pathname + target.search,
      headers,
      timeout: 10000,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({ ok: true, statusCode: res.statusCode || 0, headers: res.headers, body });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'request timed out' });
    });
    req.on('error', (error) => {
      resolve({ ok: false, error: error.message });
    });
    req.end();
  });
}

function functionUrl(baseUrl, functionName) {
  return `${baseUrl}/functions/v1/${functionName}`;
}

function hasCorsHeader(headers, name) {
  const header = headers[name.toLowerCase()];
  return Array.isArray(header) ? header.length > 0 : Boolean(header);
}

async function checkFunctionPreflight(baseUrl, functionName) {
  const result = await request('OPTIONS', functionUrl(baseUrl, functionName), {
    Origin: 'http://127.0.0.1:5500',
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'authorization, x-client-info, apikey, content-type',
  });

  if (!result.ok) {
    fail(`${functionName} preflight request failed: ${result.error}`);
    return;
  }

  const notFound = result.statusCode === 404 || /NOT_FOUND|Requested function was not found/i.test(result.body || '');
  if (notFound) {
    fail(`${functionName} is not deployed or is not reachable (HTTP ${result.statusCode})`);
    return;
  }

  if (![200, 204].includes(result.statusCode)) {
    fail(`${functionName} preflight returned HTTP ${result.statusCode}`);
    return;
  }

  if (!hasCorsHeader(result.headers, 'access-control-allow-origin')) {
    fail(`${functionName} preflight is missing access-control-allow-origin`);
    return;
  }

  pass(`${functionName} preflight is deployed and CORS-enabled`);
}

async function checkHealth(baseUrl) {
  const headers = {};
  if (process.env.HEALTH_CHECK_SECRET) headers['x-health-secret'] = process.env.HEALTH_CHECK_SECRET;
  const result = await request('GET', functionUrl(baseUrl, 'health-check'), headers);

  if (!result.ok) {
    fail(`health-check request failed: ${result.error}`);
    return;
  }

  if (result.statusCode === 404 || /NOT_FOUND|Requested function was not found/i.test(result.body || '')) {
    fail('health-check is not deployed or is not reachable');
    return;
  }

  if (result.statusCode >= 500) {
    fail(`health-check returned HTTP ${result.statusCode}: ${result.body.slice(0, 240)}`);
    return;
  }

  try {
    const payload = JSON.parse(result.body || '{}');
    if (payload.service !== 'spms') {
      fail('health-check response is not an SPMS health payload');
      return;
    }
    if (payload.status === 'ok') {
      pass('health-check reports status ok');
    } else if (payload.status === 'degraded') {
      warn('health-check reports degraded status; inspect database, storage buckets, and function secrets');
    } else {
      fail(`health-check reports status ${payload.status || 'unknown'}`);
    }
  } catch (error) {
    fail(`health-check did not return valid JSON: ${error.message}`);
  }
}

async function main() {
  loadEnvFile('.env.production.local');
  loadEnvFile('.env.local');
  loadEnvFile('.env');

  const baseUrl = normalizeSupabaseUrl(configuredSupabaseUrl());
  if (!baseUrl) return finish();

  for (const functionName of requiredFunctions) {
    await checkFunctionPreflight(baseUrl, functionName);
  }
  await checkHealth(baseUrl);
  finish();
}

function finish() {
  console.log('');
  console.log(`Supabase deployment verification complete: ${failures.length} failure(s), ${warnings.length} warning(s).`);
  if (failures.length) process.exit(1);
}

main();
