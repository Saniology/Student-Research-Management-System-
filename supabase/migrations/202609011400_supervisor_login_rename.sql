-- Keep existing registry mappings aligned with the public supervisor login.
UPDATE public.students_registry
SET supervisor_email = 'supervisor@kasu.edu.ng'
WHERE supervisor_email = 'teacher@kasu.edu.ng';
