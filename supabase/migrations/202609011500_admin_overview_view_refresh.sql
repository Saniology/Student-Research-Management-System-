-- Recreate the admin analytics view so its column order matches spms-core.sql.
DROP VIEW IF EXISTS public.admin_overview;

CREATE VIEW public.admin_overview AS
SELECT
  (SELECT COUNT(*) FROM public.profiles WHERE role = 'student' AND institution_id = public.current_institution_id()) AS total_students,
  (SELECT COUNT(*) FROM public.profiles WHERE role = 'teacher' AND institution_id = public.current_institution_id()) AS total_supervisors,
  (SELECT COUNT(*) FROM public.courses WHERE institution_id = public.current_institution_id()) AS total_courses,
  (SELECT COUNT(*) FROM public.projects WHERE institution_id = public.current_institution_id()) AS total_projects,
  (SELECT COUNT(*) FROM public.projects WHERE institution_id = public.current_institution_id() AND status IN ('submitted', 'supervisor_review')) AS pending_supervisor_review,
  (SELECT COUNT(*) FROM public.projects WHERE institution_id = public.current_institution_id() AND status IN ('supervisor_approved', 'library_review')) AS pending_library_review,
  (SELECT COUNT(*) FROM public.public_catalog WHERE institution_id = public.current_institution_id()) AS published_projects,
  (SELECT COALESCE(SUM(public.payments.amount), 0)
   FROM public.payments
   JOIN public.profiles p ON p.id = public.payments.student_id
   WHERE public.payments.status = 'success'
     AND p.institution_id = public.current_institution_id()) AS total_revenue_kobo;

GRANT SELECT ON public.admin_overview TO authenticated;
