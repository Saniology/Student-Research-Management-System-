-- =============================================================================
-- KASU SPMS - Identity sync, DOI provenance, and independent QR generation
-- Run after 202609141000_library_workflow_hardening.sql.
-- =============================================================================

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS doi_provider TEXT,
  ADD COLUMN IF NOT EXISTS doi_provider_response JSONB,
  ADD COLUMN IF NOT EXISTS doi_issued_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS doi_issued_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS qr_generated_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS qr_generated_at TIMESTAMPTZ;

DO $$ BEGIN
  ALTER TYPE public.review_action ADD VALUE IF NOT EXISTS 'qr_generated';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE public.review_action ADD VALUE IF NOT EXISTS 'doi_issued';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_institution_doi
  ON public.projects(institution_id, lower(trim(doi)))
  WHERE doi IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_projects_doi
  ON public.projects(institution_id, doi)
  WHERE doi IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_projects_qr_generated
  ON public.projects(institution_id, qr_generated_at DESC)
  WHERE qr_payload IS NOT NULL;

COMMENT ON COLUMN public.projects.doi_provider IS
  'The DOI issuer: datacite, manual, or another approved institutional provider.';
COMMENT ON COLUMN public.projects.doi_provider_response IS
  'Restricted provider response retained for internal audit; never exposed through public_catalog.';
