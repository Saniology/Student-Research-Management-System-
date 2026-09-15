-- =============================================================================
-- KASU SPMS - Immutable project versions and visual review notes
-- Run after spms-core.sql and the supervisor workflow migrations.
-- =============================================================================

ALTER TABLE public.project_reviews
  ADD COLUMN IF NOT EXISTS annotations JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS version_number INTEGER;

CREATE TABLE IF NOT EXISTS public.project_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  submitted_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_size_bytes BIGINT,
  mime_type TEXT NOT NULL DEFAULT 'application/pdf',
  title TEXT NOT NULL,
  abstract TEXT,
  degree TEXT,
  source TEXT NOT NULL DEFAULT 'initial' CHECK (source IN ('initial', 'resubmission')),
  change_summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, version_number),
  CONSTRAINT project_versions_pdf_only CHECK (mime_type = 'application/pdf')
);

CREATE INDEX IF NOT EXISTS idx_project_versions_project
  ON public.project_versions(project_id, version_number DESC);

-- Existing projects receive a baseline version. Future uploads are recorded by
-- the workflow function with the next number and can never overwrite this row.
INSERT INTO public.project_versions (
  project_id, version_number, submitted_by, file_name, file_path,
  file_size_bytes, mime_type, title, abstract, degree, source, change_summary
)
SELECT p.id, 1, p.student_id, p.file_name, p.file_path,
       p.file_size_bytes, p.mime_type, p.title, p.abstract, p.degree,
       'initial', 'Baseline captured when version history was enabled.'
FROM public.projects p
WHERE NOT EXISTS (
  SELECT 1 FROM public.project_versions v
  WHERE v.project_id = p.id AND v.version_number = 1
);

ALTER TABLE public.project_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Students read own project versions" ON public.project_versions;
CREATE POLICY "Students read own project versions"
  ON public.project_versions FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = project_versions.project_id AND p.student_id = auth.uid()
  ));

DROP POLICY IF EXISTS "Supervisors read assigned project versions" ON public.project_versions;
CREATE POLICY "Supervisors read assigned project versions"
  ON public.project_versions FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = project_versions.project_id AND p.supervisor_id = auth.uid()
  ));

DROP POLICY IF EXISTS "Staff read institution project versions" ON public.project_versions;
CREATE POLICY "Staff read institution project versions"
  ON public.project_versions FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = project_versions.project_id
      AND p.institution_id = public.current_institution_id()
      AND public.is_staff()
  ));

CREATE OR REPLACE FUNCTION public.prevent_project_version_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'Project versions are immutable; submit a new revision instead';
END;
$$;

DROP TRIGGER IF EXISTS project_versions_immutable ON public.project_versions;
CREATE TRIGGER project_versions_immutable
  BEFORE UPDATE OR DELETE ON public.project_versions
  FOR EACH ROW EXECUTE FUNCTION public.prevent_project_version_mutation();
