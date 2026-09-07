#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const root = path.resolve(__dirname, '..');
const failures = [];
const warnings = [];

function loadEnvFile(relativePath) {
  const filePath = path.join(root, relativePath);
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}

loadEnvFile('.env.production.local');
loadEnvFile('.env.local');
loadEnvFile('.env');

function log(status, message) {
  console.log(`${status.padEnd(5, ' ')} ${message}`);
}

function pass(message) { log('PASS', message); }
function warn(message) { warnings.push(message); log('WARN', message); }
function fail(message) { failures.push(message); log('FAIL', message); }

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function localUrl(url) {
  return /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(
    String(url).replace(/^https?:\/\//, '').replace(/\/$/, ''),
  );
}

function readBrowserConfig() {
  const config = fs.readFileSync(path.join(root, 'js/config.js'), 'utf8');
  const url = config.match(/SUPABASE_URL\s*=\s*['"]([^'"]+)/)?.[1] || '';
  const anonKey = config.match(/SUPABASE_ANON_KEY\s*=\s*['"]([^'"]+)/)?.[1] || '';
  return { url, anonKey };
}

async function assertQuery(query, label) {
  const result = await query;
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

async function verifyPaystack(reference, secret) {
  const response = await fetch(
    `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
    { headers: { Authorization: `Bearer ${secret}` } },
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.status || body.data?.status !== 'success') {
    throw new Error(`Paystack verification failed for ${reference}: ${body.message || body.data?.status || response.status}`);
  }
  return body.data;
}

function assertSplit(payment, label) {
  const institution = Number(payment.institution_share_kobo);
  const provider = Number(payment.provider_share_kobo);
  if (!Number.isFinite(institution) || !Number.isFinite(provider)) {
    throw new Error(`${label} is missing institution/provider split values`);
  }
  if (institution + provider !== Number(payment.amount)) {
    throw new Error(`${label} split values do not equal the recorded amount`);
  }
}

async function fetchPdfText(bytes) {
  const pdftotext = path.join(os.tmpdir(), `spms-payment-smoke-${process.pid}.pdf`);
  const textPath = `${pdftotext}.txt`;
  try {
    fs.writeFileSync(pdftotext, Buffer.from(bytes));
    const { spawnSync } = require('child_process');
    const result = spawnSync('pdftotext', [pdftotext, textPath], { encoding: 'utf8' });
    if (result.status !== 0) return null;
    return fs.readFileSync(textPath, 'utf8');
  } catch (_) {
    return null;
  } finally {
    fs.rmSync(pdftotext, { force: true });
    fs.rmSync(textPath, { force: true });
  }
}

async function main() {
  if (process.env.SPMS_PAYMENT_SMOKE_CONFIRM !== 'verify') {
    throw new Error('requires SPMS_PAYMENT_SMOKE_CONFIRM=verify; no payment or remote request was made');
  }

  const supabaseUrl = required('SUPABASE_URL');
  const serviceRoleKey = required('SUPABASE_SERVICE_ROLE_KEY');
  const paystackSecret = required('PAYSTACK_SECRET_KEY');
  const projectId = required('SPMS_PAYMENT_SMOKE_PROJECT_ID');
  const clearanceReference = required('SPMS_PAYMENT_SMOKE_CLEARANCE_REFERENCE');
  const repositoryReference = required('SPMS_PAYMENT_SMOKE_REPOSITORY_REFERENCE');
  const studentEmail = process.env.SPMS_PAYMENT_SMOKE_STUDENT_EMAIL || 'student@kasu.edu.ng';
  const studentPassword = required('SPMS_PAYMENT_SMOKE_STUDENT_PASSWORD');
  const adminEmail = process.env.SPMS_PAYMENT_SMOKE_ADMIN_EMAIL || 'admin@kasu.edu.ng';
  const adminPassword = required('SPMS_PAYMENT_SMOKE_ADMIN_PASSWORD');
  const browserConfig = readBrowserConfig();
  const anonKey = process.env.SUPABASE_ANON_KEY || browserConfig.anonKey;

  if (!/^https?:\/\//.test(supabaseUrl)) throw new Error('SUPABASE_URL must be an http(s) URL');
  if (!anonKey) throw new Error('SUPABASE_ANON_KEY or js/config.js browser anon key is required');
  if (!localUrl(supabaseUrl) && process.env.SPMS_PAYMENT_SMOKE_ALLOW_REMOTE !== 'true') {
    throw new Error('remote verification requires SPMS_PAYMENT_SMOKE_ALLOW_REMOTE=true');
  }
  if (browserConfig.url && browserConfig.url !== supabaseUrl) {
    warn('SUPABASE_URL differs from js/config.js; browser and owner verification target different projects');
  }

  const owner = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const browser = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const project = await assertQuery(
    owner.from('projects').select('id,institution_id,student_id,status,title').eq('id', projectId).maybeSingle(),
    'project lookup',
  );
  if (!project) throw new Error(`Project ${projectId} was not found`);
  if (!['cleared'].includes(project.status)) throw new Error(`Project must be cleared after the complete workflow; found ${project.status}`);
  pass(`cleared project found: ${project.title}`);

  const student = await assertQuery(
    owner.from('profiles').select('id,email,matric,institution_id').eq('id', project.student_id).maybeSingle(),
    'student profile lookup',
  );
  if (!student?.matric || !student?.institution_id) throw new Error('project student must have matric and institution identity');
  if (student.email.toLowerCase() !== studentEmail.toLowerCase()) throw new Error('student smoke email does not match project owner');
  pass(`registered student identity found: ${student.matric}`);

  const config = await assertQuery(
    owner.from('system_configs').select('clearance_fee_kobo,download_fee_kobo,currency').eq('institution_id', project.institution_id).maybeSingle(),
    'payment config lookup',
  );
  if (!config) throw new Error('payment configuration was not found for the project institution');

  const payments = await assertQuery(
    owner.from('payments').select('*').in('paystack_reference', [clearanceReference, repositoryReference]),
    'payment ledger lookup',
  );
  const clearance = payments.find((payment) => payment.paystack_reference === clearanceReference);
  const repository = payments.find((payment) => payment.paystack_reference === repositoryReference);
  if (!clearance || clearance.status !== 'success' || clearance.transaction_type !== 'clearance_fee') throw new Error('clearance payment ledger row is missing or invalid');
  if (clearance.project_id !== project.id || clearance.student_id !== student.id) throw new Error('clearance payment is linked to the wrong project or student');
  if (Number(clearance.amount) !== Number(config.clearance_fee_kobo)) throw new Error('clearance payment amount does not match institution configuration');
  assertSplit(clearance, 'clearance payment');
  pass(`clearance ledger verified: ${clearanceReference}`);
  if (!repository || repository.status !== 'success' || repository.transaction_type !== 'repository_download') throw new Error('repository payment ledger row is missing or invalid');
  if (repository.project_id !== project.id || repository.payer_id !== student.id) throw new Error('repository payment is linked to the wrong project or student');
  if (Number(repository.amount) !== Number(config.download_fee_kobo)) throw new Error('repository payment amount does not match institution configuration');
  assertSplit(repository, 'repository payment');
  pass(`repository ledger verified: ${repositoryReference}`);

  const [clearancePaystack, repositoryPaystack] = await Promise.all([
    verifyPaystack(clearanceReference, paystackSecret),
    verifyPaystack(repositoryReference, paystackSecret),
  ]);
  if (Number(clearancePaystack.amount) !== Number(clearance.amount)) throw new Error('Paystack clearance amount differs from ledger');
  if (Number(repositoryPaystack.amount) !== Number(repository.amount)) throw new Error('Paystack repository amount differs from ledger');
  if (clearancePaystack.customer?.email?.toLowerCase() !== student.email.toLowerCase()) throw new Error('Paystack clearance email does not match student');
  if (repositoryPaystack.customer?.email?.toLowerCase() !== student.email.toLowerCase()) throw new Error('Paystack repository email does not match student');
  pass('Paystack reports both transactions as successful with matching amounts and email');

  const unlock = await assertQuery(
    owner.from('repository_unlocks').select('id,watermark_identity,payment_id').eq('user_id', student.id).eq('project_id', project.id).maybeSingle(),
    'repository unlock lookup',
  );
  if (!unlock || unlock.payment_id !== repository.id || unlock.watermark_identity !== student.matric) throw new Error('permanent repository unlock or matric watermark identity is invalid');
  pass('permanent repository unlock and matric watermark identity verified');

  const receipt = await assertQuery(owner.from('clearance_receipts').select('verification_code,qr_payload').eq('project_id', project.id).maybeSingle(), 'clearance receipt lookup');
  if (!receipt?.verification_code || !receipt.qr_payload) throw new Error('clearance receipt QR evidence is missing');
  const catalog = await assertQuery(owner.from('public_catalog').select('project_id,shelf_number,doi').eq('project_id', project.id).maybeSingle(), 'public catalog lookup');
  if (!catalog) throw new Error('published public catalog record is missing');
  const reviews = await assertQuery(owner.from('project_reviews').select('action').eq('project_id', project.id), 'workflow review lookup');
  const actions = new Set((reviews || []).map((review) => review.action));
  for (const action of ['submitted', 'approved', 'published', 'cleared']) {
    if (!actions.has(action)) throw new Error(`workflow review evidence is missing action: ${action}`);
  }
  pass(`receipt, QR payload, public catalog, and workflow review history verified`);

  const studentAuth = await browser.auth.signInWithPassword({ email: studentEmail, password: studentPassword });
  if (studentAuth.error || !studentAuth.data.session) throw new Error(`student sign-in failed: ${studentAuth.error?.message || 'no session'}`);
  const download = await browser.functions.invoke('repository-access', { body: { action: 'get_download_url', project_id: project.id } });
  if (download.error || download.data?.error) throw new Error(`watermarked download request failed: ${download.data?.error || download.error?.message}`);
  if (!download.data?.success || !download.data?.watermarked || download.data.watermark_identity !== student.matric || !download.data.signed_url) throw new Error('repository Edge Function did not return a matric-watermarked signed URL');
  const pdfResponse = await fetch(download.data.signed_url);
  const pdfBytes = await pdfResponse.arrayBuffer();
  if (!pdfResponse.ok || Buffer.from(pdfBytes).subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('signed repository download is not a valid PDF');
  const pdfText = await fetchPdfText(pdfBytes);
  if (pdfText === null) warn('pdftotext is unavailable; PDF signature and Edge Function watermark response were verified, text watermark extraction was skipped');
  else if (!pdfText.includes(student.matric)) throw new Error('downloaded PDF text does not contain the matric watermark');
  pass('authenticated repository download returned a valid watermarked PDF');

  const adminAuth = await browser.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
  if (adminAuth.error || !adminAuth.data.session) throw new Error(`admin sign-in failed: ${adminAuth.error?.message || 'no session'}`);
  const report = await browser.functions.invoke('scheduled-reports', { body: { action: 'run_once', report_type: 'financial', institution_id: project.institution_id } });
  if (report.error || report.data?.error) throw new Error(`financial report generation failed: ${report.data?.error || report.error?.message}`);
  const generated = report.data?.generated?.[0];
  if (!generated?.file_path) throw new Error('financial report did not return a generated file');
  const reportUrl = await owner.storage.from('reports').createSignedUrl(generated.file_path, 300);
  if (reportUrl.error || !reportUrl.data?.signedUrl) throw new Error(`financial report signed URL failed: ${reportUrl.error?.message || 'missing URL'}`);
  const csvResponse = await fetch(reportUrl.data.signedUrl);
  const csv = await csvResponse.text();
  if (!csvResponse.ok || !csv.includes(clearanceReference) || !csv.includes(repositoryReference)) throw new Error('financial report does not include both payment references');
  pass('admin financial report includes clearance and repository transactions');
}

main().then(() => {
  if (warnings.length) console.log(`\nCompleted with ${warnings.length} warning(s).`);
  console.log('Payment smoke verification passed.');
}).catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
  console.error(`\nPayment smoke verification stopped with ${failures.length} failure(s).`);
  process.exitCode = 1;
});
