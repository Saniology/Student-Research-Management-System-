-- =============================================================================
-- KASU SPMS - Library workflow hardening
-- Run after spms-core.sql and the existing project workflow migrations.
-- =============================================================================

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS library_verified_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS library_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS published_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS receipt_issued_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS library_note TEXT;

DO $$ BEGIN
  ALTER TYPE public.review_action ADD VALUE IF NOT EXISTS 'metadata_updated';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_projects_library_status
  ON public.projects(institution_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_projects_library_shelf
  ON public.projects(institution_id, shelf_number)
  WHERE shelf_number IS NOT NULL;

-- A shelf label identifies one physical archive location within an institution.
-- The workflow function performs the friendly conflict check before this index
-- is relied on by concurrent requests.
CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_institution_shelf
  ON public.projects(institution_id, lower(trim(shelf_number)))
  WHERE shelf_number IS NOT NULL AND status IN ('published', 'cleared');

DROP POLICY IF EXISTS "Library read institution reviews" ON public.project_reviews;
CREATE POLICY "Library read institution reviews"
  ON public.project_reviews FOR SELECT
  USING (
    public.has_role('library')
    AND EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = project_reviews.project_id
        AND p.institution_id = public.current_institution_id()
    )
  );
