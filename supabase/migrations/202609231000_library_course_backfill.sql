-- =============================================================================
-- KASU SPMS - Complete library course mapping
-- Run after 202609141100_identity_doi_qr_hardening.sql.
--
-- The original seed created only the Computer Science course. Library
-- verification requires a course, so older projects in the other seeded
-- departments could never pass the metadata checklist.
-- =============================================================================

INSERT INTO public.courses (institution_id, department_id, code, name, level)
SELECT i.id, d.id, c.code, c.name, c.level
FROM public.institutions i
CROSS JOIN (VALUES
  ('CSC-BSC', 'Computer Science', 'Undergraduate', 'Computer Science'),
  ('MCB-BSC', 'Microbiology', 'Undergraduate', 'Microbiology'),
  ('MAC-BSC', 'Mass Communication', 'Undergraduate', 'Mass Communication'),
  ('ACC-BSC', 'Accounting', 'Undergraduate', 'Accounting')
) AS c(code, name, level, department_name)
JOIN public.departments d
  ON d.institution_id = i.id
 AND d.name = c.department_name
WHERE i.slug = 'kasu'
ON CONFLICT (institution_id, code) DO UPDATE SET
  department_id = EXCLUDED.department_id,
  name = EXCLUDED.name,
  level = EXCLUDED.level;

-- Backfill academic mappings for existing identities and projects. Existing
-- values are preserved so institution-managed custom mappings are untouched.
UPDATE public.profiles p
SET course_id = c.id,
    updated_at = NOW()
FROM public.courses c
WHERE p.course_id IS NULL
  AND p.department_id = c.department_id
  AND p.institution_id = c.institution_id;

UPDATE public.students_registry sr
SET course_id = c.id
FROM public.courses c
WHERE sr.course_id IS NULL
  AND sr.department_id = c.department_id
  AND sr.institution_id = c.institution_id;

UPDATE public.projects p
SET course_id = source.course_id,
    updated_at = NOW()
FROM (
  SELECT p2.id AS project_id, COALESCE(p2.course_id, student.course_id, registry.course_id) AS course_id
  FROM public.projects p2
  LEFT JOIN public.profiles student ON student.id = p2.student_id
  LEFT JOIN public.students_registry registry ON registry.matric = student.matric
) AS source
WHERE p.id = source.project_id
  AND p.course_id IS NULL
  AND source.course_id IS NOT NULL;

UPDATE public.public_catalog catalog
SET course_id = project.course_id,
    course_name = course.name,
    updated_at = NOW()
FROM public.projects project
LEFT JOIN public.courses course ON course.id = project.course_id
WHERE catalog.project_id = project.id
  AND catalog.course_id IS NULL
  AND project.course_id IS NOT NULL;
