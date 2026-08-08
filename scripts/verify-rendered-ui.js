#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const required = process.argv.includes('--required');
const url = process.env.SPMS_RENDER_URL || 'http://127.0.0.1:5510/';
const outputDir = process.env.SPMS_RENDER_OUTPUT_DIR || path.join(os.tmpdir(), 'spms-render-checks');
const failures = [];
const warnings = [];

const viewports = [
  { name: 'desktop', width: 1440, height: 1100, minBytes: 100000 },
  { name: 'mobile', width: 390, height: 900, minBytes: 50000 },
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

function checkServerOnce() {
  return new Promise((resolve) => {
    const target = new URL(url);
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
  if (signature !== '89504e470d0a1a0a') {
    throw new Error('not a PNG file');
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bytes: buffer.length,
  };
}

function renderViewport(chrome, viewport) {
  fs.mkdirSync(outputDir, { recursive: true });
  const screenshotPath = path.join(outputDir, `spms-${viewport.name}.png`);
  const profileDir = path.join(os.tmpdir(), `spms-chrome-${process.pid}-${viewport.name}`);
  const result = spawnSync(chrome, [
    '--headless',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    `--user-data-dir=${profileDir}`,
    '--hide-scrollbars',
    '--virtual-time-budget=4000',
    `--window-size=${viewport.width},${viewport.height}`,
    `--screenshot=${screenshotPath}`,
    url,
  ], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0) {
    fail(`${viewport.name} render failed${result.stderr ? `: ${result.stderr.trim()}` : ''}`);
    return;
  }

  try {
    const dimensions = pngDimensions(screenshotPath);
    const matchesSize = dimensions.width === viewport.width && dimensions.height === viewport.height;
    const hasContent = dimensions.bytes >= viewport.minBytes;
    if (!matchesSize) {
      fail(`${viewport.name} screenshot has unexpected size ${dimensions.width}x${dimensions.height}`);
      return;
    }
    if (!hasContent) {
      fail(`${viewport.name} screenshot is suspiciously small (${dimensions.bytes} bytes)`);
      return;
    }
    pass(`${viewport.name} rendered ${dimensions.width}x${dimensions.height} (${dimensions.bytes} bytes)`);
  } catch (error) {
    fail(`${viewport.name} screenshot validation failed: ${error.message}`);
  }
}

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    const message = 'Chrome or Chromium was not found; install Google Chrome/Chromium to run rendered UI checks';
    if (required) fail(message);
    else warn(message);
    finish();
    return;
  }

  const serverOk = await checkServer();
  if (!serverOk) {
    const message = `local app is not reachable at ${url}; start it with npm run dev -- --host 127.0.0.1 --port 5510`;
    if (required) fail(message);
    else warn(message);
    finish();
    return;
  }

  viewports.forEach((viewport) => renderViewport(chrome, viewport));
  finish();
}

function finish() {
  console.log('');
  console.log(`Rendered UI verification complete: ${failures.length} failure(s), ${warnings.length} warning(s).`);
  process.exit(failures.length ? 1 : 0);
}

main();
