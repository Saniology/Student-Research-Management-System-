-- =============================================================================
-- KASU SPMS - Supervisor assignment payment gate
-- A student must complete the clearance payment before supervisor assignment.
-- Run after spms-core.sql and 202609011200_supervisor_management.sql.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.student_has_paid_clearance_fee(student_uuid UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.payments
    WHERE student_id = student_uuid
      AND status = 'success'
      AND transaction_type = 'clearance_fee'
  );
$$;

REVOKE ALL ON FUNCTION public.student_has_paid_clearance_fee(UUID) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.prevent_unpaid_supervisor_assignment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.role = 'student'
    AND NEW.supervisor_id IS DISTINCT FROM OLD.supervisor_id
    AND NEW.supervisor_id IS NOT NULL
    AND NOT public.student_has_paid_clearance_fee(NEW.id)
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Supervisor assignment requires a successful clearance payment';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_paid_supervisor_assignment_guard ON public.profiles;
CREATE TRIGGER profiles_paid_supervisor_assignment_guard
  BEFORE UPDATE OF supervisor_id ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.prevent_unpaid_supervisor_assignment();
