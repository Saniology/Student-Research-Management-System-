#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const root = path.resolve(__dirname, '..');
const isCleanup = process.argv.includes('--cleanup');

function loadEnvFile(relativePath) {
  const filePath = path.join(root, relativePath);
  if (!fs.existsSync(filePath)) return;
  const contents = fs.readFileSync(filePath, 'utf8');
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}

loadEnvFile('.env.production.local');
loadEnvFile('.env.local');

const tenantSlug = process.env.SPMS_E2E_TENANT || 'kasu';
const fixturePrefix = process.env.SPMS_E2E_FIXTURE_PREFIX || 'SPMS E2E Fixture';

function fail(message) {
  console.error(`\nE2E fixture seed blocked: ${message}`);
  process.exitCode = 1;
}

function stableUuid(label) {
  const bytes = crypto.createHash('sha256').update(`${tenantSlug}:${fixturePrefix}:${label}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function fixtureIds() {
  return {
    projects: ['review', 'library', 'published'].map((key) => stableUuid(`project:${key}`)),
    submissions: ['review', 'library', 'published'].map((key) => stableUuid(`submission:${key}`)),
    reviews: ['review', 'library', 'published'].map((key) => stableUuid(`review:${key}`)),
    notifications: ['student', 'teacher', 'library', 'admin'].map((role) => stableUuid(`notification:${role}`)),
    catalog: stableUuid('catalog:published'),
  };
}

function escapePdfText(value) {
  return String(value).replace(/[\\()]/g, '\\$&').replace(/[^\x20-\x7e]/g, ' ');
}

function createFixturePdf(title) {
  const stream = `BT /F1 18 Tf 72 720 Td (${escapePdfText(title)}) Tj 0 -32 Td /F1 11 Tf (SPMS end-to-end workflow fixture) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}

async function requiredQuery(query, label) {
  const result = await query;
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

async function uploadFixturePdf(client, bucket, filePath, title) {
  const data = createFixturePdf(title);
  const result = await client.storage.from(bucket).upload(filePath, data, {
    contentType: 'application/pdf',
    cacheControl: '3600',
    upsert: true,
  });
  if (result.error) throw new Error(`Storage upload failed for ${filePath}: ${result.error.message}`);
  return data.length;
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

async function cleanup(client, ids, studentId) {
  const projectDelete = await client.from('projects').delete().in('id', ids.projects);
  if (projectDelete.error) throw new Error(`Project fixture cleanup failed: ${projectDelete.error.message}`);
  const submissionDelete = await client.from('submissions').delete().in('id', ids.submissions);
  if (submissionDelete.error) throw new Error(`Submission fixture cleanup failed: ${submissionDelete.error.message}`);
  const paths = ['review', 'library', 'published'].map((key) => `${studentId}/${fixturePrefix.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${key}.pdf`);
  const storageDelete = await client.storage.from('thesis-pdfs').remove(paths);
  if (storageDelete.error) throw new Error(`Storage fixture cleanup failed: ${storageDelete.error.message}`);
  console.log(`Removed ${ids.projects.length} project fixtures for ${fixturePrefix}.`);
}

async function seed(client, institution, student, teacher, library, admin, department, course) {
  const ids = fixtureIds();
  const now = new Date();
  const safePrefix = fixturePrefix.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const records = [
    { key: 'review', id: ids.projects[0], submissionId: ids.submissions[0], title: `${fixturePrefix} Supervisor Review`, status: 'supervisor_review', createdAt: addDays(now, 0), shelf: null },
    { key: 'library', id: ids.projects[1], submissionId: ids.submissions[1], title: `${fixturePrefix} Library Record`, status: 'supervisor_approved', createdAt: addDays(now, -1), shelf: null },
    { key: 'published', id: ids.projects[2], submissionId: ids.submissions[2], title: `${fixturePrefix} Public Repository Record`, status: 'published', createdAt: addDays(now, -2), shelf: `${tenantSlug.toUpperCase()}-E2E-001` },
  ];

  for (const record of records) {
    record.filePath = `${student.id}/${safePrefix}-${record.key}.pdf`;
    record.fileSizeBytes = await uploadFixturePdf(client, 'thesis-pdfs', record.filePath, record.title);
  }

  const submissions = records.map((record) => ({
    id: record.submissionId,
    student_id: student.id,
    file_name: `${safePrefix}-${record.key}.pdf`,
    file_path: record.filePath,
    status: 'pending',
    created_at: record.createdAt,
    updated_at: now.toISOString(),
  }));
  await requiredQuery(client.from('submissions').upsert(submissions, { onConflict: 'id' }), 'Submission fixture upsert');

  const projects = records.map((record) => ({
    id: record.id,
    institution_id: institution.id,
    student_id: student.id,
    supervisor_id: teacher.id,
    department_id: department?.id || null,
    course_id: course?.id || null,
    submission_id: record.submissionId,
    title: record.title,
    abstract: `This ${fixturePrefix.toLowerCase()} demonstrates the ${record.status.replaceAll('_', ' ')} workflow state for browser verification. It is synthetic test data and contains no real student research or payment history.`,
    degree: 'BSc',
    keywords: ['e2e', 'fixture', 'spms'],
    file_name: `${safePrefix}-${record.key}.pdf`,
    file_path: record.filePath,
    file_size_bytes: record.fileSizeBytes,
    mime_type: 'application/pdf',
    status: record.status,
    shelf_number: record.shelf,
    qr_payload: record.status === 'published' ? JSON.stringify({ type: 'spms-project', project_id: record.id, fixture: true }) : null,
    doi: record.status === 'published' ? `${tenantSlug}.e2e.${record.key}` : null,
    metadata_verified_at: record.status === 'published' ? record.createdAt : null,
    published_at: record.status === 'published' ? record.createdAt : null,
    created_at: record.createdAt,
    updated_at: now.toISOString(),
  }));
  await requiredQuery(client.from('projects').upsert(projects, { onConflict: 'id' }), 'Project fixture upsert');

  const reviews = [
    { id: ids.reviews[0], project_id: ids.projects[0], actor_id: admin.id, action: 'submitted', comment: 'Fixture routed to supervisor review.', from_status: 'submitted', to_status: 'supervisor_review' },
    { id: ids.reviews[1], project_id: ids.projects[1], actor_id: teacher.id, action: 'approved', comment: 'Fixture approved for library verification.', from_status: 'supervisor_review', to_status: 'supervisor_approved' },
    { id: ids.reviews[2], project_id: ids.projects[2], actor_id: library.id, action: 'published', comment: 'Fixture metadata verified and published.', from_status: 'supervisor_approved', to_status: 'published' },
  ];
  await requiredQuery(client.from('project_reviews').upsert(reviews, { onConflict: 'id' }), 'Project review fixture upsert');

  const catalog = {
    id: ids.catalog,
    project_id: ids.projects[2],
    institution_id: institution.id,
    department_id: department?.id || null,
    course_id: course?.id || null,
    department_name: department?.name || 'Computer Science',
    course_name: course?.name || null,
    title: records[2].title,
    abstract: projects[2].abstract,
    degree: 'BSc',
    keywords: ['e2e', 'fixture', 'spms'],
    shelf_number: records[2].shelf,
    doi: projects[2].doi,
    published_at: records[2].createdAt,
    updated_at: now.toISOString(),
  };
  await requiredQuery(client.from('public_catalog').upsert(catalog, { onConflict: 'id' }), 'Public catalog fixture upsert');

  const notifications = [
    { id: ids.notifications[0], recipient_id: student.id, actor_id: teacher.id, project_id: ids.projects[0], title: 'E2E fixture ready for review', message: `${records[0].title} is ready for supervisor review.` },
    { id: ids.notifications[1], recipient_id: teacher.id, actor_id: admin.id, project_id: ids.projects[0], title: 'E2E fixture assigned', message: `${records[0].title} is assigned to you.` },
    { id: ids.notifications[2], recipient_id: library.id, actor_id: teacher.id, project_id: ids.projects[1], title: 'E2E fixture ready for library', message: `${records[1].title} is ready for metadata verification.` },
    { id: ids.notifications[3], recipient_id: admin.id, actor_id: admin.id, project_id: ids.projects[0], title: 'E2E fixture seeded', message: `Synthetic ${fixturePrefix} records were seeded for browser verification.` },
  ].map((item) => ({ ...item, institution_id: institution.id, category: 'test_fixture', metadata: { fixture: true, prefix: fixturePrefix }, read_at: null, created_at: now.toISOString() }));
  await requiredQuery(client.from('notifications').upsert(notifications, { onConflict: 'id' }), 'Notification fixture upsert');

  console.log(`Seeded ${fixturePrefix} for ${institution.short_name || institution.name}.`);
  console.log(`Student review record: ${records[0].title}`);
  console.log(`Library queue record: ${records[1].title}`);
  console.log(`Public catalog record: ${records[2].title}`);
  console.log('No payment rows were created; this fixture is not financial evidence.');
  console.log(`Run with --cleanup and the same SPMS_E2E_FIXTURE_PREFIX to remove it.`);
}

async function main() {
  const mode = process.env.SPMS_E2E_MODE;
  const fixtures = process.env.SPMS_E2E_FIXTURES;
  const confirmation = process.env.SPMS_E2E_FIXTURE_CONFIRM;
  if (mode !== 'seeded' || fixtures !== '1' || confirmation !== (isCleanup ? 'cleanup' : 'seed')) {
    fail(`requires SPMS_E2E_MODE=seeded SPMS_E2E_FIXTURES=1 SPMS_E2E_FIXTURE_CONFIRM=${isCleanup ? 'cleanup' : 'seed'}`);
    return;
  }
  if (!/e2e/i.test(fixturePrefix)) {
    fail('SPMS_E2E_FIXTURE_PREFIX must contain "E2E" so synthetic records are unmistakable');
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL || '';
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!/^https?:\/\//.test(supabaseUrl) || !serviceRoleKey) {
    fail('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be provided through the owner-only environment');
    return;
  }
  const isLocal = /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(supabaseUrl.replace(/^https?:\/\//, '').replace(/\/$/, ''));
  if (!isLocal && process.env.SPMS_E2E_ALLOW_REMOTE !== 'true') {
    fail('remote mutation requires SPMS_E2E_ALLOW_REMOTE=true; use a dedicated test project, never production');
    return;
  }

  const client = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const institution = await requiredQuery(client.from('institutions').select('id,slug,name,short_name').eq('slug', tenantSlug).maybeSingle(), 'KASU tenant lookup');
  if (!institution) throw new Error(`Tenant ${tenantSlug} was not found. Apply spms-core.sql first.`);
  const emails = {
    student: process.env.SPMS_E2E_STUDENT_EMAIL || 'student@kasu.edu.ng',
    teacher: process.env.SPMS_E2E_TEACHER_EMAIL || 'teacher@kasu.edu.ng',
    library: process.env.SPMS_E2E_LIBRARY_EMAIL || 'library@kasu.edu.ng',
    admin: process.env.SPMS_E2E_ADMIN_EMAIL || 'admin@kasu.edu.ng',
  };
  const profiles = {};
  for (const [role, email] of Object.entries(emails)) {
    profiles[role] = await requiredQuery(client.from('profiles').select('id,email,role,full_name,matric,institution_id').eq('email', email).maybeSingle(), `${role} profile lookup`);
    if (!profiles[role]) throw new Error(`Profile ${email} was not found. Seed the documented demo accounts first.`);
    if (profiles[role].role !== role) throw new Error(`${email} has role ${profiles[role].role}, expected ${role}`);
    if (profiles[role].institution_id && profiles[role].institution_id !== institution.id) throw new Error(`${email} belongs to another institution`);
  }
  const department = await requiredQuery(client.from('departments').select('id,name').eq('institution_id', institution.id).eq('name', 'Computer Science').maybeSingle(), 'Computer Science department lookup');
  const course = await requiredQuery(client.from('courses').select('id,name,code,level').eq('institution_id', institution.id).eq('code', 'CSC-BSC').maybeSingle(), 'Computer Science course lookup');
  if (isCleanup) await cleanup(client, fixtureIds(), profiles.student.id);
  else await seed(client, institution, profiles.student, profiles.teacher, profiles.library, profiles.admin, department, course);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
