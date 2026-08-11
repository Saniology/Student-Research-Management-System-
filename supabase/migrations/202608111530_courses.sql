-- Add tenant-scoped course records to the academic hierarchy.
CREATE TABLE IF NOT EXISTS public.courses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  department_id UUID REFERENCES public.departments(id) ON DELETE SET NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  level TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (institution_id, code)
);

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS course_id UUID REFERENCES public.courses(id) ON DELETE SET NULL;

ALTER TABLE public.students_registry
  ADD COLUMN IF NOT EXISTS course_id UUID REFERENCES public.courses(id) ON DELETE SET NULL;

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS course_id UUID REFERENCES public.courses(id) ON DELETE SET NULL;

ALTER TABLE public.public_catalog
  ADD COLUMN IF NOT EXISTS course_id UUID REFERENCES public.courses(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS course_name TEXT;

CREATE INDEX IF NOT EXISTS idx_courses_institution ON public.courses(institution_id);
CREATE INDEX IF NOT EXISTS idx_courses_department ON public.courses(department_id);
CREATE INDEX IF NOT EXISTS idx_projects_course ON public.projects(course_id);
CREATE INDEX IF NOT EXISTS idx_public_catalog_course ON public.public_catalog(course_id);

ALTER TABLE public.courses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read courses" ON public.courses;
CREATE POLICY "Public read courses"
  ON public.courses FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "Admins manage courses" ON public.courses;
CREATE POLICY "Admins manage courses"
  ON public.courses FOR ALL
  USING (public.is_admin() AND institution_id = public.current_institution_id())
  WITH CHECK (public.is_admin() AND institution_id = public.current_institution_id());

INSERT INTO public.courses (institution_id, department_id, code, name, level)
SELECT i.id, d.id, 'CSC-BSC', 'Computer Science', 'Undergraduate'
FROM public.institutions i
JOIN public.departments d
  ON d.institution_id = i.id
 AND d.name = 'Computer Science'
WHERE i.slug = 'kasu'
ON CONFLICT (institution_id, code) DO UPDATE SET
  department_id = EXCLUDED.department_id,
  name = EXCLUDED.name,
  level = EXCLUDED.level;

WITH registry_course_backfill AS (
  SELECT sr.matric, c.id AS course_id
  FROM public.students_registry sr
  JOIN public.institutions i ON i.id = sr.institution_id AND i.slug = 'kasu'
  JOIN public.departments d ON d.id = sr.department_id AND d.name = 'Computer Science'
  JOIN public.courses c ON c.institution_id = i.id
    AND c.department_id = d.id
    AND c.code = 'CSC-BSC'
)
UPDATE public.students_registry sr
SET course_id = COALESCE(sr.course_id, backfill.course_id)
FROM registry_course_backfill backfill
WHERE sr.matric = backfill.matric;
