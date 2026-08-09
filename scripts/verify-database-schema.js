#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const failures = [];

const sqlFiles = [
  'supabase/schema.sql',
  'supabase/payments.sql',
  'supabase/secure-payments.sql',
  'supabase/spms-core.sql',
];

const rlsTables = [
  'profiles',
  'students_registry',
  'submissions',
  'payments',
  'institutions',
  'system_configs',
  'colleges',
  'faculties',
  'departments',
  'projects',
  'project_reviews',
  'public_catalog',
  'repository_unlocks',
  'guest_download_orders',
  'clearance_receipts',
  'audit_logs',
  'notifications',
  'report_schedules',
  'generated_reports',
];

const requiredIndexes = [
  'idx_payments_student',
  'idx_payments_reference',
  'idx_submissions_student',
  'idx_projects_student',
  'idx_projects_supervisor',
  'idx_projects_department',
  'idx_projects_status',
  'idx_project_reviews_project',
  'idx_public_catalog_department',
  'idx_public_catalog_search',
  'idx_audit_logs_actor',
  'idx_audit_logs_entity',
  'idx_notifications_recipient_created',
  'idx_notifications_unread',
  'idx_notifications_project',
  'idx_report_schedules_due',
  'idx_report_schedules_institution',
  'idx_generated_reports_institution',
  'idx_generated_reports_schedule',
  'idx_payments_project',
  'idx_payments_type',
  'idx_guest_download_orders_institution',
  'idx_guest_download_orders_project',
];

const requiredForeignKeys = [
  /profiles\s*\(\s*id[\s\S]+REFERENCES\s+auth\.users\(id\)\s+ON\s+DELETE\s+CASCADE/i,
  /submissions[\s\S]+student_id\s+UUID\s+NOT\s+NULL\s+REFERENCES\s+profiles\(id\)\s+ON\s+DELETE\s+CASCADE/i,
  /payments[\s\S]+student_id\s+UUID\s+NOT\s+NULL\s+REFERENCES\s+profiles\(id\)\s+ON\s+DELETE\s+CASCADE/i,
  /projects[\s\S]+student_id\s+UUID\s+NOT\s+NULL\s+REFERENCES\s+profiles\(id\)\s+ON\s+DELETE\s+CASCADE/i,
  /projects[\s\S]+submission_id\s+UUID\s+REFERENCES\s+submissions\(id\)\s+ON\s+DELETE\s+SET\s+NULL/i,
  /project_reviews[\s\S]+project_id\s+UUID\s+NOT\s+NULL\s+REFERENCES\s+projects\(id\)\s+ON\s+DELETE\s+CASCADE/i,
  /public_catalog[\s\S]+project_id\s+UUID\s+NOT\s+NULL\s+UNIQUE\s+REFERENCES\s+projects\(id\)\s+ON\s+DELETE\s+CASCADE/i,
  /repository_unlocks[\s\S]+project_id\s+UUID\s+NOT\s+NULL\s+REFERENCES\s+projects\(id\)\s+ON\s+DELETE\s+CASCADE/i,
  /guest_download_orders[\s\S]+project_id\s+UUID\s+NOT\s+NULL\s+REFERENCES\s+projects\(id\)\s+ON\s+DELETE\s+CASCADE/i,
  /clearance_receipts[\s\S]+project_id\s+UUID\s+NOT\s+NULL\s+UNIQUE\s+REFERENCES\s+projects\(id\)\s+ON\s+DELETE\s+CASCADE/i,
  /notifications[\s\S]+recipient_id\s+UUID\s+NOT\s+NULL\s+REFERENCES\s+profiles\(id\)\s+ON\s+DELETE\s+CASCADE/i,
  /report_schedules[\s\S]+created_by\s+UUID\s+REFERENCES\s+profiles\(id\)\s+ON\s+DELETE\s+SET\s+NULL/i,
  /generated_reports[\s\S]+schedule_id\s+UUID\s+REFERENCES\s+report_schedules\(id\)\s+ON\s+DELETE\s+SET\s+NULL/i,
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

function assert(condition, message) {
  if (condition) pass(message);
  else fail(message);
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function combinedSql() {
  return sqlFiles.map(read).join('\n');
}

function checkRequiredFiles() {
  sqlFiles.forEach((file) => {
    assert(fs.existsSync(path.join(root, file)), `${file} exists`);
  });
}

function checkMigrationSafety(sql) {
  assert(!/\bDROP\s+(TABLE|SCHEMA|DATABASE|TYPE)\b/i.test(sql), 'SQL does not drop tables, schemas, databases, or types');
  assert(!/\bTRUNCATE\b/i.test(sql), 'SQL does not truncate data');
  assert(/ON\s+CONFLICT[\s\S]+DO\s+(NOTHING|UPDATE)/i.test(sql), 'seed data uses idempotent upsert patterns');
  assert(/duplicate_object\s+THEN\s+NULL/i.test(sql), 'enum creation is idempotent');
}

function checkTables(sql) {
  rlsTables.forEach((table) => {
    assert(new RegExp(`CREATE TABLE IF NOT EXISTS\\s+${table}\\s*\\([\\s\\S]+?\\);`, 'i').test(sql), `${table} table is declared idempotently`);
    assert(new RegExp(`CREATE TABLE IF NOT EXISTS\\s+${table}\\s*\\([\\s\\S]+PRIMARY KEY`, 'i').test(sql), `${table} declares a primary key`);
  });
}

function checkForeignKeys(sql) {
  requiredForeignKeys.forEach((pattern, index) => {
    assert(pattern.test(sql), `required foreign key contract ${index + 1} exists`);
  });
}

function checkIndexes(sql) {
  requiredIndexes.forEach((indexName) => {
    assert(new RegExp(`CREATE\\s+(UNIQUE\\s+)?INDEX IF NOT EXISTS\\s+${indexName}\\b`, 'i').test(sql), `${indexName} exists`);
  });
}

function checkConstraints(sql) {
  [
    /matric\s+TEXT\s+UNIQUE/i,
    /paystack_reference\s+TEXT\s+UNIQUE\s+NOT\s+NULL/i,
    /UNIQUE\s*\(\s*institution_id\s*,\s*name\s*\)/i,
    /UNIQUE\s*\(\s*user_id\s*,\s*project_id\s*\)/i,
    /verification_code\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i,
    /CONSTRAINT\s+projects_pdf_only\s+CHECK\s*\(\s*mime_type\s*=\s*'application\/pdf'\s*\)/i,
    /report_type\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*report_type\s+IN/i,
    /frequency\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'monthly'\s+CHECK\s*\(\s*frequency\s+IN/i,
    /guest_download_orders[\s\S]+paystack_reference\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i,
  ].forEach((pattern, index) => {
    assert(pattern.test(sql), `required data constraint ${index + 1} exists`);
  });
}

function checkRls(sql) {
  rlsTables.forEach((table) => {
    assert(new RegExp(`ALTER TABLE\\s+${table}\\s+ENABLE ROW LEVEL SECURITY`, 'i').test(sql), `RLS enabled on ${table}`);
    if (table === 'students_registry') {
      assert(/DROP POLICY IF EXISTS "Anyone can lookup matric" ON students_registry/i.test(sql), 'student registry public policy is revoked');
    } else {
      assert(new RegExp(`CREATE POLICY\\s+"[^"]+"\\s+ON\\s+${table}\\b`, 'i').test(sql), `${table} has at least one RLS policy`);
    }
  });
  assert(/DROP POLICY IF EXISTS "Students insert own payments" ON payments/i.test(sql), 'client payment insert policy is revoked');
  assert(/DROP POLICY IF EXISTS "Students insert own submissions" ON submissions/i.test(sql), 'client submission insert policy is revoked');
}

function checkStorage(sql) {
  [
    { bucket: 'thesis-pdfs', mime: 'application/pdf' },
    { bucket: 'repository-downloads', mime: 'application/pdf' },
    { bucket: 'reports', mime: 'text/csv' },
  ].forEach(({ bucket, mime }) => {
    assert(new RegExp(`'${bucket}'[\\s\\S]{0,120}false`, 'i').test(sql), `${bucket} bucket is private`);
    assert(new RegExp(`'${bucket}'[\\s\\S]{0,220}'${mime}'`, 'i').test(sql), `${bucket} bucket declares expected MIME type`);
    assert(new RegExp(`CREATE POLICY\\s+"[^"]+"\\s+ON\\s+storage\\.objects[\\s\\S]+bucket_id\\s*=\\s*'${bucket}'`, 'i').test(sql), `${bucket} has storage object policy`);
  });
}

function checkSecurityDefiner(sql) {
  const functions = [...sql.matchAll(/CREATE OR REPLACE FUNCTION\s+([\w.]+)\s*\([^)]*\)[\s\S]*?\$\$;/gi)];
  const definerFunctions = functions.filter((match) => /SECURITY DEFINER/i.test(match[0]));
  assert(definerFunctions.length > 0, 'SECURITY DEFINER helper functions exist');
  definerFunctions.forEach((match) => {
    const name = match[1];
    assert(/SET\s+search_path\s*=/i.test(match[0]), `${name} pins search_path`);
  });
  assert(/GRANT EXECUTE ON FUNCTION public\.is_admin\(\) TO authenticated/i.test(sql), 'is_admin execute grant exists');
  assert(/GRANT EXECUTE ON FUNCTION public\.has_role\(user_role\) TO authenticated/i.test(sql), 'has_role execute grant exists');
  assert(/GRANT EXECUTE ON FUNCTION public\.is_staff\(\) TO authenticated/i.test(sql), 'is_staff execute grant exists');
  assert(/GRANT EXECUTE ON FUNCTION public\.current_institution_id\(\) TO authenticated/i.test(sql), 'current institution execute grant exists');
}

function checkDocumentedRunOrder() {
  const release = read('docs/release-checklist.md');
  const local = read('docs/local-development-setup.md');
  const order = /schema\.sql[\s\S]+payments\.sql[\s\S]+secure-payments\.sql[\s\S]+spms-core\.sql/i;
  assert(order.test(release), 'release checklist documents SQL run order');
  assert(order.test(local), 'local setup documents SQL run order');
}

const sql = combinedSql();
checkRequiredFiles();
checkMigrationSafety(sql);
checkTables(sql);
checkForeignKeys(sql);
checkIndexes(sql);
checkConstraints(sql);
checkRls(sql);
checkStorage(sql);
checkSecurityDefiner(sql);
checkDocumentedRunOrder();

console.log('');
console.log(`Database schema verification complete: ${failures.length} failure(s).`);
if (failures.length) process.exit(1);
