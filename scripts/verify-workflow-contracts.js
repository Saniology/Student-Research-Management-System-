#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const failures = [];

const files = {
  html: 'index.html',
  frontend: ['src/App.jsx', 'src/lib/supabase.js', 'src/lib/contracts.js', 'src/components/AppShell.jsx', 'src/components/Skeleton.jsx'],
  sql: 'supabase/spms-core.sql',
  release: 'docs/release-checklist.md',
  roadmap: 'docs/spms-implementation-roadmap.md',
  ci: '.github/workflows/verify.yml',
  verifyPaystack: 'supabase/functions/verify-paystack/index.ts',
  projectWorkflow: 'supabase/functions/project-workflow/index.ts',
  repositoryAccess: 'supabase/functions/repository-access/index.ts',
  verificationLookup: 'supabase/functions/verification-lookup/index.ts',
  scheduledReports: 'supabase/functions/scheduled-reports/index.ts',
};

const edgeContracts = [
  {
    functionName: 'verify-paystack',
    file: files.verifyPaystack,
    frontendActions: ['initialize_clearance'],
    handlerActions: ['initialize_clearance'],
    requiredFields: ['reference', 'file_name', 'file_path', 'title', 'abstract', 'degree', 'file_size_bytes'],
  },
  {
    functionName: 'project-workflow',
    file: files.projectWorkflow,
    frontendActions: ['supervisor_decision', 'student_resubmit', 'assign_supervisor', 'library_publish', 'issue_receipt'],
    handlerActions: ['supervisor_decision', 'student_resubmit', 'assign_supervisor', 'library_publish', 'issue_receipt'],
    requiredFields: ['project_id', 'decision', 'supervisor_id', 'file_path', 'file_name', 'shelf_number', 'verification_code'],
  },
  {
    functionName: 'repository-access',
    file: files.repositoryAccess,
    frontendActions: ['get_download_url', 'initialize_download', 'verify_download'],
    handlerActions: ['get_download_url', 'initialize_download', 'verify_download'],
    requiredFields: ['project_id', 'reference', 'signed_url', 'watermark_identity'],
  },
  {
    functionName: 'scheduled-reports',
    file: files.scheduledReports,
    frontendActions: ['run_due', 'run_once'],
    handlerActions: ['run_due', 'run_once'],
    requiredFields: ['report_type', 'email_recipients', 'generated_reports'],
  },
];

const verificationTypes = ['qr_svg', 'receipt', 'project'];
const projectStatuses = [
  'draft',
  'submitted',
  'supervisor_review',
  'revision_requested',
  'supervisor_approved',
  'library_review',
  'published',
  'cleared',
  'rejected',
];
const reviewActions = [
  'submitted',
  'approved',
  'revision_requested',
  'metadata_verified',
  'published',
  'cleared',
  'rejected',
];
const transactionTypes = ['clearance_fee', 'repository_download'];
const reportTypes = ['student_register', 'project_lifecycle', 'financial', 'archive'];
const roles = ['student', 'teacher', 'library', 'admin'];

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

function assert(condition, message) {
  if (condition) pass(message);
  else fail(message);
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function frontendSource() {
  return [files.html, ...files.frontend].map(read).join('\n');
}

function includesValue(source, value) {
  return new RegExp(`['"]${escapeRegExp(value)}['"]`).test(source);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractInvokeBlocks(source, functionName) {
  const pattern = new RegExp(`(?:functions\\.invoke|invoke)\\(['"]${escapeRegExp(functionName)}['"],?[\\s\\S]*?\\}`, 'g');
  return source.match(pattern) || [];
}

function checkEdgeContracts() {
  const html = frontendSource();

  edgeContracts.forEach((contract) => {
    const edge = read(contract.file);
    const blocks = extractInvokeBlocks(html, contract.functionName);
    assert(blocks.length > 0, `frontend invokes ${contract.functionName}`);

    contract.frontendActions.forEach((action) => {
      const frontendHasAction = blocks.some((block) => includesValue(block, action)) || html.includes(action);
      assert(frontendHasAction, `frontend sends ${contract.functionName} action ${action}`);
    });

    contract.handlerActions.forEach((action) => {
      assert(new RegExp(`action\\s*(?:===|!==)\\s*["']${escapeRegExp(action)}["']`).test(edge), `${contract.functionName} handles action ${action}`);
    });

    contract.requiredFields.forEach((field) => {
      assert(edge.includes(field) || html.includes(field), `${contract.functionName} contract includes ${field}`);
    });
  });
}

function checkVerificationLookup() {
  const html = frontendSource();
  const edge = read(files.verificationLookup);

  assert(/\/functions\/v1\/verification-lookup/.test(html), 'frontend calls verification-lookup endpoint');
  verificationTypes.forEach((type) => {
    const frontendHasType = includesValue(html, type) || html.includes(`buildVerificationPayload('${type}'`);
    assert(frontendHasType, `frontend references verification type ${type}`);
    assert(new RegExp(`type\\s*===\\s*["']${escapeRegExp(type)}["']`).test(edge), `verification-lookup handles type ${type}`);
  });
  assert(/qrcode-generator@2\.0\.4/.test(edge), 'verification QR dependency is pinned');
  assert(!/file_path|storage_path|signedUrl|signedURL/.test(edge), 'public verification contract excludes private file paths');
}

function checkSqlEnumsAndStatusFlow() {
  const sql = read(files.sql);
  const html = frontendSource();
  const verifyPaystack = read(files.verifyPaystack);
  const projectWorkflow = read(files.projectWorkflow);
  const repositoryAccess = read(files.repositoryAccess);
  const scheduledReports = read(files.scheduledReports);

  projectStatuses.forEach((status) => {
    assert(inSqlEnum(sql, 'project_status', status), `SQL project_status includes ${status}`);
    assert(includesValue(html, status) || html.includes(status), `frontend knows project status ${status}`);
  });

  reviewActions.forEach((action) => {
    assert(inSqlEnum(sql, 'review_action', action), `SQL review_action includes ${action}`);
  });

  transactionTypes.forEach((type) => {
    assert(inSqlEnum(sql, 'transaction_type', type), `SQL transaction_type includes ${type}`);
    assert(verifyPaystack.includes(type) || repositoryAccess.includes(type) || html.includes(type), `payment flow references transaction type ${type}`);
  });

  reportTypes.forEach((type) => {
    assert(sql.includes(`'${type}'`), `SQL report_schedules permits ${type}`);
    assert(scheduledReports.includes(type) || html.includes(type), `report flow references ${type}`);
  });

  [
    ['student submission assigns a supervisor when available', verifyPaystack, /resolveSupervisor\(/],
    ['student submission routes assigned projects to supervisor_review', verifyPaystack, /workflowStatus\s*=\s*supervisorId\s*\?\s*"supervisor_review"\s*:\s*"submitted"/],
    ['unassigned submissions remain visible for admin assignment', verifyPaystack, /Supervisor assignment required/],
    ['supervisor approval moves to supervisor_approved', projectWorkflow, /toStatus\s*=\s*"supervisor_approved"/],
    ['revision requests move to revision_requested', projectWorkflow, /toStatus\s*=\s*"revision_requested"/],
    ['library publish moves to published', projectWorkflow, /status:\s*"published"/],
    ['receipt issue moves to cleared', projectWorkflow, /status:\s*"cleared"/],
  ].forEach(([label, source, pattern]) => {
    assert(pattern.test(source), label);
  });
}

function inSqlEnum(sql, enumName, value) {
  const match = sql.match(new RegExp(`CREATE TYPE\\s+${enumName}\\s+AS ENUM\\s*\\(([\\s\\S]*?)\\);`, 'i'));
  return Boolean(match && new RegExp(`'${escapeRegExp(value)}'`).test(match[1]));
}

function checkRoleSurfacesAndDocs() {
  const html = frontendSource();
  const release = read(files.release);
  roles.forEach((role) => {
    const workspaceName = role === 'teacher' ? 'TeacherWorkspace' : `${role.charAt(0).toUpperCase()}${role.slice(1)}Workspace`;
    assert(html.includes(workspaceName) || html.includes(`role="${role}"`), `frontend has ${role} role surface`);
    const label = role === 'teacher' ? 'Supervisor' : role.charAt(0).toUpperCase() + role.slice(1);
    assert(new RegExp(`${label}:`, 'i').test(release), `release checklist documents ${label} role smoke test`);
  });
  assert(/StudentWorkspace/.test(html), 'student dashboard loader exists');
  assert(/TeacherWorkspace/.test(html), 'supervisor dashboard loader exists');
  assert(/LibraryWorkspace/.test(html), 'library dashboard loader exists');
  assert(/AdminWorkspace/.test(html), 'admin dashboard loader exists');
}

function checkCiAndDocs() {
  const ci = read(files.ci);
  const roadmap = read(files.roadmap);
  assert(/npm run verify:workflow/.test(ci), 'GitHub Actions runs workflow contract verification');
  assert(/verify:workflow/.test(roadmap), 'roadmap documents workflow contract verification');
  assert(/verify:workflow/.test(read(files.release)), 'release checklist includes workflow contract verifier');
}

checkEdgeContracts();
checkVerificationLookup();
checkSqlEnumsAndStatusFlow();
checkRoleSurfacesAndDocs();
checkCiAndDocs();

console.log('');
console.log(`Workflow contract verification complete: ${failures.length} failure(s).`);
if (failures.length) process.exit(1);
