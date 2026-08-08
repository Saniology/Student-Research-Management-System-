#!/usr/bin/env node

const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const required = process.argv.includes('--required');
const baseUrl = process.env.SPMS_RENDER_URL || 'http://127.0.0.1:5510/';
const failures = [];
const warnings = [];

const scenarios = [
  {
    name: 'student receipt workflow',
    role: 'student',
    action: 'show_receipt',
    checks: [
      'data-role-preview="student"',
      'data-role-preview-action="show_receipt"',
      'Digital Clearance Receipt',
      'SPMS-PREVIEW-STUDENT',
    ],
  },
  {
    name: 'student revision resubmission workflow',
    role: 'student',
    action: 'show_revision',
    checks: [
      'data-role-preview="student"',
      'data-role-preview-action="show_revision"',
      'Revision Required',
      'Upload Revision &amp; Resubmit',
      'without paying the clearance fee again.',
    ],
  },
  {
    name: 'supervisor review modal',
    role: 'teacher',
    action: 'open_review',
    checks: [
      'data-role-preview="teacher"',
      'data-role-preview-action="open_review"',
      'role="dialog" aria-modal="true"',
      'Preview approval note for automated supervisor interaction coverage.',
      'Approve Project',
    ],
  },
  {
    name: 'library catalog modal',
    role: 'library',
    action: 'open_catalog_record',
    checks: [
      'data-role-preview="library"',
      'data-role-preview-action="open_catalog_record"',
      'role="dialog" aria-modal="true"',
      'Preview catalog note for automated library interaction coverage.',
      'Verify &amp; Publish',
    ],
  },
  {
    name: 'admin reports section',
    role: 'admin',
    action: 'open_reports',
    checks: [
      'data-role-preview="admin"',
      'data-role-preview-action="open_reports"',
      'id="admin-reports"',
      'Scheduled reporting controls',
      'project-lifecycle-preview.csv',
    ],
  },
  {
    name: 'admin supervisor assignment queue',
    role: 'admin',
    action: 'open_assignments',
    checks: [
      'data-role-preview="admin"',
      'data-role-preview-action="open_assignments"',
      'id="admin-supervisors"',
      'Unassigned Review Queue',
      'Web-Based E-Voting System',
      '>Assign<',
    ],
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

function scenarioUrl(scenario) {
  const url = new URL(baseUrl);
  url.searchParams.set('preview_role', scenario.role);
  url.searchParams.set('preview_action', scenario.action);
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

function dumpScenarioDom(chrome, scenario) {
  const profileDir = path.join('/tmp', `spms-role-interaction-${process.pid}-${scenario.role}-${scenario.action}`);
  const result = spawnSync(chrome, [
    '--headless',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    `--user-data-dir=${profileDir}`,
    '--virtual-time-budget=5000',
    '--dump-dom',
    scenarioUrl(scenario),
  ], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0) {
    fail(`${scenario.name} failed to render${result.stderr ? `: ${result.stderr.trim()}` : ''}`);
    return;
  }

  scenario.checks.forEach((text) => {
    if (result.stdout.includes(text)) pass(`${scenario.name} contains ${text}`);
    else fail(`${scenario.name} is missing ${text}`);
  });
}

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    const message = 'Chrome or Chromium was not found; install Google Chrome/Chromium to run role interaction checks';
    if (required) fail(message);
    else warn(message);
    finish();
    return;
  }

  const serverOk = await checkServer();
  if (!serverOk) {
    const message = `local app is not reachable at ${baseUrl}; start it with npm run dev -- --host 127.0.0.1 --port 5510`;
    if (required) fail(message);
    else warn(message);
    finish();
    return;
  }

  scenarios.forEach((scenario) => dumpScenarioDom(chrome, scenario));
  finish();
}

function finish() {
  console.log('');
  console.log(`Role interaction verification complete: ${failures.length} failure(s), ${warnings.length} warning(s).`);
  process.exit(failures.length ? 1 : 0);
}

main();
