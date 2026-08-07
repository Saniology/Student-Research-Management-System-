#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
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

function ids() {
  return [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
}

function scripts() {
  return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1])
    .filter((script) => script.trim());
}

function functionNames() {
  const source = scripts().join('\n');
  return new Set([...source.matchAll(/\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map((match) => match[1]));
}

function onclickCalls() {
  const globals = new Set(['encodeURIComponent', 'stopPropagation']);
  return [...html.matchAll(/\bonclick="([^"]+)"/g)]
    .flatMap((match) => [...match[1].matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map((call) => call[1]))
    .filter((name) => !['if', 'for', 'while', 'switch'].includes(name))
    .filter((name) => !globals.has(name));
}

function assertUniqueIds() {
  const seen = new Set();
  const duplicates = new Set();
  ids().forEach((id) => {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  });
  assert(duplicates.size === 0, `HTML ids are unique${duplicates.size ? `: ${[...duplicates].join(', ')}` : ''}`);
}

function assertRequiredIds(requiredIds, label) {
  const present = new Set(ids());
  const missing = requiredIds.filter((id) => !present.has(id));
  assert(missing.length === 0, `${label}${missing.length ? ` missing: ${missing.join(', ')}` : ''}`);
}

function assertOnclickHandlersExist() {
  const declared = functionNames();
  const missing = [...new Set(onclickCalls().filter((name) => !declared.has(name)))];
  assert(missing.length === 0, `inline onclick handlers resolve${missing.length ? ` missing: ${missing.join(', ')}` : ''}`);
}

function assertRoleSurfaces() {
  assertRequiredIds(['landing', 'student', 'teacher', 'library', 'admin'], 'role views exist');
  assertRequiredIds(['app-config-error'], 'configuration error surface exists');
  assertRequiredIds([
    'project-title-input',
    'project-abstract-input',
    'project-degree-input',
    'thesis-pdf-input',
    'payment-status',
    'student-dashboard-content',
  ], 'student workflow controls exist');
  assertRequiredIds(['student-table-body', 'teacher-workflow-status'], 'supervisor workflow controls exist');
  assertRequiredIds(['library-grid', 'lib-search', 'lib-dept', 'lib-degree'], 'library workflow controls exist');
  assertRequiredIds([
    'metric-total-students',
    'metric-total-revenue',
    'admin-payments-body',
    'reports-output',
    'report-schedule-type',
    'report-schedule-frequency',
    'report-schedule-recipients',
    'generated-reports-list',
    'settings-tenant-slug',
    'settings-allowed-domains',
  ], 'admin operations controls exist');
}

function assertAdminNavigation() {
  const sections = ['dashboard', 'students', 'supervisors', 'departments', 'uploads', 'payments', 'reports', 'settings'];
  sections.forEach((section) => {
    assert(html.includes(`id="admin-${section}"`), `admin section exists: ${section}`);
    assert(
      new RegExp(`showAdminSection\\('${section}',\\s*this\\)`).test(html),
      `admin sidebar passes active link for ${section}`,
    );
  });
  assert(!/event\.target\.closest/.test(html), 'admin sidebar does not rely on implicit browser event');
}

function assertUiRegressionGuards() {
  assert(!/TEXT CHANGED HERE/.test(html), 'development-only UI comments are absent');
  assert(!/Loading payments\.\.\.<\/td><\/tr>/.test(html) || /colspan="6"[^>]*>Loading payments/.test(html), 'payments table loading row spans all columns');
  assert(/<meta name="viewport"/.test(html), 'responsive viewport meta exists');
  assert(/cdn\.tailwindcss\.com/.test(html), 'Tailwind CDN is loaded for current static build');
  assert(/@supabase\/supabase-js@2/.test(html), 'Supabase JS v2 is loaded');
  assert(/js\/config\.js/.test(html), 'browser configuration file is loaded');
  assert(/validateAppConfig/.test(html), 'browser config is validated before connected actions');
  assert(/ensureAppConfigured/.test(html), 'connected actions have a configuration guard');
  assert(/portal-hero/.test(html), 'portal home shell exists');
  assert(/portal-operations-board/.test(html), 'portal operations board exists');
  assert(/portal-trust-band/.test(html), 'portal trust band exists');
  assert(/smart-card/.test(html), 'smart card UI system exists');
  assert(/smart-token/.test(html), 'smart token UI system exists');
  assert(/skeleton-page/.test(html), 'page skeleton UI exists');
  assert(/skeletonShimmer/.test(html), 'skeleton loaders are animated');
  assert(/skeletonViewTemplate/.test(html), 'page-specific skeleton templates exist');
  assert(/showPageSkeleton\('student'\)/.test(html), 'student page uses shaped skeleton loader');
  assert(/showPageSkeleton\('teacher'\)/.test(html), 'supervisor page uses shaped skeleton loader');
  assert(/showPageSkeleton\('library'\)/.test(html), 'library page uses shaped skeleton loader');
  assert(/showAdminSectionSkeleton\('dashboard'\)/.test(html), 'admin dashboard uses shaped skeleton loader');
  assert(/showAdminSectionSkeleton\(id\)/.test(html), 'admin section navigation uses shaped skeleton loader');
  assert(/unsplash\.com\/photo-1497366754035-f200968a6e72/.test(html), 'portal hero uses a real visual asset');
  assert(/\.rounded-lg,\s*\.rounded-xl,\s*\.rounded-2xl/.test(html), 'card radius standard is enforced');
  assert(/focus-visible/.test(html), 'keyboard focus styling exists');
}

assertUniqueIds();
assertOnclickHandlersExist();
assertRoleSurfaces();
assertAdminNavigation();
assertUiRegressionGuards();

console.log('');
console.log(`UI smoke verification complete: ${failures.length} failure(s).`);
if (failures.length) process.exit(1);
