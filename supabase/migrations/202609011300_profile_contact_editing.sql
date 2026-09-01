-- =============================================================================
-- KASU SPMS - Self-service contact details
-- Students and supervisors may update email and phone only.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.prevent_profile_identity_changes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- The browser can update a user's contact fields, but identity and academic
  -- mapping remain institution-managed. Service-role/admin operations remain
  -- available for approved administrative workflows.
  IF auth.uid() IS NOT NULL AND NOT public.is_admin() THEN
    IF NEW.full_name IS DISTINCT FROM OLD.full_name
      OR NEW.matric IS DISTINCT FROM OLD.matric
      OR NEW.role IS DISTINCT FROM OLD.role
      OR NEW.department IS DISTINCT FROM OLD.department
      OR NEW.department_id IS DISTINCT FROM OLD.department_id
      OR NEW.course_id IS DISTINCT FROM OLD.course_id
      OR NEW.institution_id IS DISTINCT FROM OLD.institution_id
    THEN
      RAISE EXCEPTION 'Profile identity fields are managed by the institution';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_identity_fields_guard ON public.profiles;
CREATE TRIGGER profiles_identity_fields_guard
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.prevent_profile_identity_changes();

