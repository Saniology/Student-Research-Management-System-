-- =============================================================================
-- SPMS Core Workflow Upgrade
-- Run after schema.sql and payments.sql.
--
-- Adds the production workflow model from the SPMS blueprint:
-- academic hierarchy, project lifecycle, supervisor review, library cataloging,
-- public anonymized catalog, repository unlocks, receipt verification, and audit.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE project_status AS ENUM (
    'draft',
    'submitted',
    'supervisor_review',
    'revision_requested',
    'supervisor_approved',
    'library_review',
    'published',
    'cleared',
    'rejected'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE review_action AS ENUM (
    'submitted',
    'approved',
    'revision_requested',
    'metadata_verified',
    'published',
    'cleared',
    'rejected'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE transaction_type AS ENUM (
    'clearance_fee',
    'repository_download'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Helper predicates for RLS
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.has_role(required_role user_role)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = auth.uid()
      AND role = required_role
  );
$$;

GRANT EXECUTE ON FUNCTION public.has_role(user_role) TO authenticated;

CREATE OR REPLACE FUNCTION public.is_staff()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = auth.uid()
      AND role IN ('teacher', 'library', 'admin')
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_staff() TO authenticated;

-- ---------------------------------------------------------------------------
-- Institution, academic hierarchy, and configurable rules
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS institutions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  short_name TEXT NOT NULL,
  primary_color TEXT NOT NULL DEFAULT '#065F46',
  accent_color TEXT NOT NULL DEFAULT '#F59E0B',
  logo_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS system_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  clearance_fee_kobo INTEGER NOT NULL DEFAULT 200000,
  download_fee_kobo INTEGER NOT NULL DEFAULT 50000,
  max_pdf_size_bytes BIGINT NOT NULL DEFAULT 104857600,
  allowed_mime_types TEXT[] NOT NULL DEFAULT ARRAY['application/pdf'],
  currency TEXT NOT NULL DEFAULT 'NGN',
  receipt_prefix TEXT NOT NULL DEFAULT 'KASU-SPMS',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (institution_id)
);

CREATE TABLE IF NOT EXISTS faculties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (institution_id, name)
);

CREATE TABLE IF NOT EXISTS departments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  faculty_id UUID REFERENCES faculties(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (institution_id, name)
);

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS institution_id UUID REFERENCES institutions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES departments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS supervisor_id UUID REFERENCES profiles(id) ON DELETE SET NULL;

ALTER TABLE students_registry
  ADD COLUMN IF NOT EXISTS institution_id UUID REFERENCES institutions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES departments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS supervisor_email TEXT,
  ADD COLUMN IF NOT EXISTS degree TEXT,
  ADD COLUMN IF NOT EXISTS project_topic TEXT;

-- ---------------------------------------------------------------------------
-- Project lifecycle
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID REFERENCES institutions(id) ON DELETE SET NULL,
  student_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  supervisor_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  department_id UUID REFERENCES departments(id) ON DELETE SET NULL,
  submission_id UUID REFERENCES submissions(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  abstract TEXT,
  degree TEXT,
  keywords TEXT[] NOT NULL DEFAULT '{}',
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_size_bytes BIGINT,
  mime_type TEXT NOT NULL DEFAULT 'application/pdf',
  status project_status NOT NULL DEFAULT 'submitted',
  revision_note TEXT,
  shelf_number TEXT,
  qr_payload TEXT,
  doi TEXT,
  metadata_verified_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  cleared_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT projects_pdf_only CHECK (mime_type = 'application/pdf')
);

CREATE INDEX IF NOT EXISTS idx_projects_student ON projects(student_id);
CREATE INDEX IF NOT EXISTS idx_projects_supervisor ON projects(supervisor_id);
CREATE INDEX IF NOT EXISTS idx_projects_department ON projects(department_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

CREATE TABLE IF NOT EXISTS project_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  actor_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  action review_action NOT NULL,
  comment TEXT,
  from_status project_status,
  to_status project_status,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_reviews_project ON project_reviews(project_id);

CREATE TABLE IF NOT EXISTS public_catalog (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  institution_id UUID REFERENCES institutions(id) ON DELETE SET NULL,
  department_id UUID REFERENCES departments(id) ON DELETE SET NULL,
  department_name TEXT NOT NULL,
  title TEXT NOT NULL,
  abstract TEXT,
  degree TEXT,
  keywords TEXT[] NOT NULL DEFAULT '{}',
  shelf_number TEXT,
  doi TEXT,
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_public_catalog_department ON public_catalog(department_id);
CREATE INDEX IF NOT EXISTS idx_public_catalog_search
  ON public_catalog USING GIN (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(abstract, '')));

CREATE TABLE IF NOT EXISTS repository_unlocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  payment_id UUID REFERENCES payments(id) ON DELETE SET NULL,
  watermark_identity TEXT NOT NULL,
  unlocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, project_id)
);

CREATE TABLE IF NOT EXISTS clearance_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  verification_code TEXT NOT NULL UNIQUE,
  qr_payload TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS transaction_type transaction_type NOT NULL DEFAULT 'clearance_fee',
  ADD COLUMN IF NOT EXISTS payer_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS provider_share_kobo INTEGER,
  ADD COLUMN IF NOT EXISTS institution_share_kobo INTEGER,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_payments_project ON payments(project_id);
CREATE INDEX IF NOT EXISTS idx_payments_type ON payments(transaction_type);

-- ---------------------------------------------------------------------------
-- Seed KASU tenant and map demo data
-- ---------------------------------------------------------------------------

INSERT INTO institutions (slug, name, short_name, primary_color, accent_color)
VALUES ('kasu', 'Kaduna State University', 'KASU', '#065F46', '#F59E0B')
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  short_name = EXCLUDED.short_name,
  primary_color = EXCLUDED.primary_color,
  accent_color = EXCLUDED.accent_color,
  updated_at = NOW();

INSERT INTO system_configs (institution_id)
SELECT id FROM institutions WHERE slug = 'kasu'
ON CONFLICT (institution_id) DO NOTHING;

INSERT INTO faculties (institution_id, name)
SELECT i.id, f.name
FROM institutions i
CROSS JOIN (VALUES
  ('Faculty of Computing'),
  ('Faculty of Science'),
  ('Faculty of Social Sciences'),
  ('Faculty of Management Sciences')
) AS f(name)
WHERE i.slug = 'kasu'
ON CONFLICT (institution_id, name) DO NOTHING;

INSERT INTO departments (institution_id, faculty_id, name, code)
SELECT i.id, f.id, d.name, d.code
FROM institutions i
JOIN faculties f ON f.institution_id = i.id AND f.name = 'Faculty of Computing'
CROSS JOIN (VALUES ('Computer Science', 'CSC')) AS d(name, code)
WHERE i.slug = 'kasu'
ON CONFLICT (institution_id, name) DO NOTHING;

INSERT INTO departments (institution_id, faculty_id, name, code)
SELECT i.id, f.id, d.name, d.code
FROM institutions i
JOIN faculties f ON f.institution_id = i.id AND f.name = 'Faculty of Science'
CROSS JOIN (VALUES ('Microbiology', 'MCB')) AS d(name, code)
WHERE i.slug = 'kasu'
ON CONFLICT (institution_id, name) DO NOTHING;

INSERT INTO departments (institution_id, faculty_id, name, code)
SELECT i.id, f.id, d.name, d.code
FROM institutions i
JOIN faculties f ON f.institution_id = i.id AND f.name = 'Faculty of Social Sciences'
CROSS JOIN (VALUES ('Mass Communication', 'MAC')) AS d(name, code)
WHERE i.slug = 'kasu'
ON CONFLICT (institution_id, name) DO NOTHING;

INSERT INTO departments (institution_id, faculty_id, name, code)
SELECT i.id, f.id, d.name, d.code
FROM institutions i
JOIN faculties f ON f.institution_id = i.id AND f.name = 'Faculty of Management Sciences'
CROSS JOIN (VALUES ('Accounting', 'ACC')) AS d(name, code)
WHERE i.slug = 'kasu'
ON CONFLICT (institution_id, name) DO NOTHING;

UPDATE profiles p
SET institution_id = i.id,
    department_id = d.id
FROM institutions i
LEFT JOIN departments d ON d.institution_id = i.id AND d.name = p.department
WHERE i.slug = 'kasu'
  AND p.institution_id IS NULL;

UPDATE profiles s
SET supervisor_id = t.id
FROM profiles t
WHERE s.role = 'student'
  AND t.role = 'teacher'
  AND s.department = t.department
  AND s.supervisor_id IS NULL;

UPDATE students_registry sr
SET institution_id = i.id,
    department_id = d.id,
    supervisor_email = COALESCE(sr.supervisor_email, 'teacher@kasu.edu.ng'),
    degree = COALESCE(sr.degree, 'BSc')
FROM institutions i
LEFT JOIN departments d ON d.institution_id = i.id AND d.name = sr.department
WHERE i.slug = 'kasu'
  AND sr.institution_id IS NULL;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

ALTER TABLE institutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE faculties ENABLE ROW LEVEL SECURITY;
ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE repository_unlocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE clearance_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read institutions" ON institutions;
CREATE POLICY "Public read institutions"
  ON institutions FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "Public read configs" ON system_configs;
CREATE POLICY "Public read configs"
  ON system_configs FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "Public read faculties" ON faculties;
CREATE POLICY "Public read faculties"
  ON faculties FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "Public read departments" ON departments;
CREATE POLICY "Public read departments"
  ON departments FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "Admins manage institutions" ON institutions;
CREATE POLICY "Admins manage institutions"
  ON institutions FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Admins manage configs" ON system_configs;
CREATE POLICY "Admins manage configs"
  ON system_configs FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Admins manage faculties" ON faculties;
CREATE POLICY "Admins manage faculties"
  ON faculties FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Admins manage departments" ON departments;
CREATE POLICY "Admins manage departments"
  ON departments FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Students read own projects" ON projects;
CREATE POLICY "Students read own projects"
  ON projects FOR SELECT
  USING (auth.uid() = student_id);

DROP POLICY IF EXISTS "Supervisors read assigned projects" ON projects;
CREATE POLICY "Supervisors read assigned projects"
  ON projects FOR SELECT
  USING (auth.uid() = supervisor_id);

DROP POLICY IF EXISTS "Library read review queue" ON projects;
CREATE POLICY "Library read review queue"
  ON projects FOR SELECT
  USING (public.has_role('library') AND status IN ('supervisor_approved', 'library_review', 'published', 'cleared'));

DROP POLICY IF EXISTS "Admins read all projects" ON projects;
CREATE POLICY "Admins read all projects"
  ON projects FOR SELECT
  USING (public.is_admin());

DROP POLICY IF EXISTS "Students update revision projects" ON projects;
CREATE POLICY "Students update revision projects"
  ON projects FOR UPDATE
  USING (auth.uid() = student_id AND status IN ('draft', 'revision_requested'))
  WITH CHECK (auth.uid() = student_id);

DROP POLICY IF EXISTS "Project reviews visible to participants" ON project_reviews;
CREATE POLICY "Project reviews visible to participants"
  ON project_reviews FOR SELECT
  USING (
    public.is_admin()
    OR EXISTS (
      SELECT 1
      FROM projects p
      WHERE p.id = project_reviews.project_id
        AND (p.student_id = auth.uid() OR p.supervisor_id = auth.uid())
    )
    OR public.has_role('library')
  );

DROP POLICY IF EXISTS "Public read anonymized catalog" ON public_catalog;
CREATE POLICY "Public read anonymized catalog"
  ON public_catalog FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "Students read own unlocks" ON repository_unlocks;
CREATE POLICY "Students read own unlocks"
  ON repository_unlocks FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Admins read all unlocks" ON repository_unlocks;
CREATE POLICY "Admins read all unlocks"
  ON repository_unlocks FOR SELECT
  USING (public.is_admin());

DROP POLICY IF EXISTS "Students read own receipts" ON clearance_receipts;
CREATE POLICY "Students read own receipts"
  ON clearance_receipts FOR SELECT
  USING (auth.uid() = student_id);

DROP POLICY IF EXISTS "Staff read receipts" ON clearance_receipts;
CREATE POLICY "Staff read receipts"
  ON clearance_receipts FOR SELECT
  USING (public.is_staff());

DROP POLICY IF EXISTS "Admins read audit logs" ON audit_logs;
CREATE POLICY "Admins read audit logs"
  ON audit_logs FOR SELECT
  USING (public.is_admin());

-- Storage read access for reviewers. Students keep the existing own-folder policies.
DROP POLICY IF EXISTS "Supervisors read assigned thesis files" ON storage.objects;
CREATE POLICY "Supervisors read assigned thesis files"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'thesis-pdfs'
    AND EXISTS (
      SELECT 1
      FROM projects p
      WHERE p.file_path = storage.objects.name
        AND p.supervisor_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Library read approved thesis files" ON storage.objects;
CREATE POLICY "Library read approved thesis files"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'thesis-pdfs'
    AND public.has_role('library')
    AND EXISTS (
      SELECT 1
      FROM projects p
      WHERE p.file_path = storage.objects.name
        AND p.status IN ('supervisor_approved', 'library_review', 'published', 'cleared')
    )
  );

-- ---------------------------------------------------------------------------
-- Convenience analytics view for admin dashboard
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW admin_overview AS
SELECT
  (SELECT COUNT(*) FROM profiles WHERE role = 'student') AS total_students,
  (SELECT COUNT(*) FROM profiles WHERE role = 'teacher') AS total_supervisors,
  (SELECT COUNT(*) FROM projects) AS total_projects,
  (SELECT COUNT(*) FROM projects WHERE status IN ('submitted', 'supervisor_review')) AS pending_supervisor_review,
  (SELECT COUNT(*) FROM projects WHERE status IN ('supervisor_approved', 'library_review')) AS pending_library_review,
  (SELECT COUNT(*) FROM public_catalog) AS published_projects,
  (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status = 'success') AS total_revenue_kobo;

GRANT SELECT ON admin_overview TO authenticated;
