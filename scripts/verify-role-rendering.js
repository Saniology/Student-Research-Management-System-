#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const required = process.argv.includes('--required');
const baseUrl = process.env.SPMS_RENDER_URL || 'http://127.0.0.1:5500/';
const outputDir = process.env.SPMS_ROLE_RENDER_OUTPUT_DIR || path.join(os.tmpdir(), 'spms-role-render-checks');
const failures = [];
const warnings = [];

const roles = [
  {
    name: 'student',
    checks: ['data-role-preview="student"', 'Musa Abdullahi', 'Digital Clearance Receipt', 'Web-Based E-Voting System'],
    viewport: { width: 1280, height: 920, minBytes: 60000 },
  },
  {
    name: 'teacher',
    checks: ['data-role-preview="teacher"', 'Supervisor Dashboard', 'Preview queue loaded', 'Review'],
    viewport: { width: 1280, height: 920, minBytes: 60000 },
  },
  {
    name: 'library',
    checks: ['data-role-preview="library"', 'Library Catalog &amp; Verification', 'Verification Queue', 'Decentralized E-Voting System'],
    viewport: { width: 1280, height: 920, minBytes: 70000 },
  },
  {
    name: 'admin',
    checks: ['data-role-preview="admin"', 'Analytics Hub', 'Preview analytics loaded', 'Institution share'],
    viewport: { width: 1366, height: 960, minBytes: 70000 },
  },
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

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    'google-chrome',
    'chromium-browser',
    'chromium',
  ].filter(Boolean);

  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (result.status === 0) return candidate;
  }
  return null;
}

function roleUrl(role) {
  const url = new URL(baseUrl);
  url.searchParams.set('preview_role', role);
  return url.toString();
}

function checkServerOnce() {
  return new Promise((resolve) => {
    const target = new URL(baseUrl);
    const req = http.request({
      method: 'HEAD',
      hostname: target.hostname,
      port: target.port || 80,
      path: target.pathname || '/',
      timeout: 1500,
    }, (res) => {
      res.resume();
      resolve(Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 400));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

async function checkServer(attempts = 10) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (await checkServerOnce()) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

function pngDimensions(filePath) {
  const buffer = fs.readFileSync(filePath);
  const signature = buffer.subarray(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a') throw new Error('not a PNG file');
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bytes: buffer.length,
  };
}

function dumpRoleDom(chrome, role) {
  const profileDir = path.join(os.tmpdir(), `spms-role-dom-${process.pid}-${role.name}`);
  const result = spawnSync(chrome, [
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    `--user-data-dir=${profileDir}`,
    '--virtual-time-budget=5000',
    '--dump-dom',
    roleUrl(role.name),
  ], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0) {
    fail(`${role.name} DOM render failed${result.stderr ? `: ${result.stderr.trim()}` : ''}`);
    return;
  }

  role.checks.forEach((text) => {
    if (result.stdout.includes(text)) pass(`${role.name} DOM contains ${text}`);
    else fail(`${role.name} DOM is missing ${text}`);
  });
}

function captureRoleScreenshot(chrome, role) {
  fs.mkdirSync(outputDir, { recursive: true });
  const screenshotPath = path.join(outputDir, `spms-role-${role.name}.png`);
  const profileDir = path.join(os.tmpdir(), `spms-role-shot-${process.pid}-${role.name}`);
  const { width, height, minBytes } = role.viewport;
  const result = spawnSync(chrome, [
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    `--user-data-dir=${profileDir}`,
    '--hide-scrollbars',
    '--virtual-time-budget=5000',
    `--window-size=${width},${height}`,
    `--screenshot=${screenshotPath}`,
    roleUrl(role.name),
  ], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0) {
    fail(`${role.name} screenshot failed${result.stderr ? `: ${result.stderr.trim()}` : ''}`);
    return;
  }

  try {
    const dimensions = pngDimensions(screenshotPath);
    if (dimensions.width !== width || dimensions.height !== height) {
      fail(`${role.name} screenshot has unexpected size ${dimensions.width}x${dimensions.height}`);
      return;
    }
    if (dimensions.bytes < minBytes) {
      fail(`${role.name} screenshot is suspiciously small (${dimensions.bytes} bytes)`);
      return;
    }
    pass(`${role.name} screenshot rendered ${dimensions.width}x${dimensions.height} (${dimensions.bytes} bytes)`);
  } catch (error) {
    fail(`${role.name} screenshot validation failed: ${error.message}`);
  }
}

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    const message = 'Chrome or Chromium was not found; install Google Chrome/Chromium to run role rendering checks';
    if (required) fail(message);
    else warn(message);
    finish();
    return;
  }

  const serverOk = await checkServer();
  if (!serverOk) {
    const message = `local app is not reachable at ${baseUrl}; start it with python3 -m http.server 5500 --bind 0.0.0.0`;
    if (required) fail(message);
    else warn(message);
    finish();
    return;
  }

  roles.forEach((role) => {
    dumpRoleDom(chrome, role);
    captureRoleScreenshot(chrome, role);
  });
  finish();
}

function finish() {
  console.log('');
  console.log(`Role rendering verification complete: ${failures.length} failure(s), ${warnings.length} warning(s).`);
  if (failures.length) process.exit(1);
}

main();
