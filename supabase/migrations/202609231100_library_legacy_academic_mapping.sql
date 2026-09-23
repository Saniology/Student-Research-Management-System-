-- =============================================================================
-- KASU SPMS - Normalize legacy academic mappings for library verification
-- Run after 202609231000_library_course_backfill.sql.
-- =============================================================================

-- Older signups stored the department name but not its foreign-key mapping.
-- Match names case-insensitively so those students can reach the library desk.
UPDATE public.profiles p
SET department_id = d.id,
    updated_at = NOW()
FROM public.departments d
WHERE p.department_id IS NULL
  AND p.institution_id = d.institution_id
  AND lower(trim(p.department)) = lower(trim(d.name));

UPDATE public.students_registry sr
SET department_id = d.id
FROM public.departments d
WHERE sr.department_id IS NULL
  AND sr.institution_id = d.institution_id
  AND lower(trim(sr.department)) = lower(trim(d.name));

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

-- Projects created before the academic foreign keys were introduced inherit
-- the mapping from their student. Existing institution-managed values remain.
UPDATE public.projects p
SET department_id = COALESCE(p.department_id, student.department_id, registry.department_id),
    course_id = COALESCE(p.course_id, student.course_id, registry.course_id),
    updated_at = NOW()
FROM public.profiles student
LEFT JOIN public.students_registry registry ON registry.matric = student.matric
WHERE p.student_id = student.id
  AND (p.department_id IS NULL OR p.course_id IS NULL);

UPDATE public.public_catalog catalog
SET department_id = COALESCE(catalog.department_id, project.department_id),
    course_id = COALESCE(catalog.course_id, project.course_id),
    course_name = COALESCE(catalog.course_name, course.name),
    updated_at = NOW()
FROM public.projects project
LEFT JOIN public.courses course ON course.id = project.course_id
WHERE catalog.project_id = project.id
  AND (catalog.department_id IS NULL OR catalog.course_id IS NULL);

