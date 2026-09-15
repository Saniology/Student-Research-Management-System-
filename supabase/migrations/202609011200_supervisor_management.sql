-- =============================================================================
-- Supervisor management and student assignment
-- Run after spms-core.sql.
-- =============================================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS phone TEXT;

CREATE INDEX IF NOT EXISTS idx_profiles_supervisor
  ON public.profiles(supervisor_id);

CREATE TABLE IF NOT EXISTS public.supervisor_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  supervisor_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  assigned_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  unassigned_at TIMESTAMPTZ,
  CONSTRAINT supervisor_assignment_student CHECK (student_id <> supervisor_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_active_supervisor_assignment
  ON public.supervisor_assignments(student_id)
  WHERE unassigned_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_supervisor_assignments_supervisor
  ON public.supervisor_assignments(supervisor_id, unassigned_at);

CREATE OR REPLACE FUNCTION public.current_supervisor_id()
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT supervisor_id
  FROM public.profiles
  WHERE id = auth.uid();
$$;

GRANT EXECUTE ON FUNCTION public.current_supervisor_id() TO authenticated;

-- Staff should only see contact records needed for their role. Admins retain
-- institution-wide access through the separate admin policy from spms-core.sql.
DROP POLICY IF EXISTS "Staff read institution profiles" ON public.profiles;
DROP POLICY IF EXISTS "Staff and assigned users read relevant profiles" ON public.profiles;
CREATE POLICY "Staff and assigned users read relevant profiles"
  ON public.profiles FOR SELECT
  USING (
    id = auth.uid()
    OR (
      role = 'student'
      AND supervisor_id = auth.uid()
    )
    OR (
      role = 'teacher'
      AND id = public.current_supervisor_id()
    )
  );

ALTER TABLE public.supervisor_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Assignment participants read assignments" ON public.supervisor_assignments;
CREATE POLICY "Assignment participants read assignments"
  ON public.supervisor_assignments FOR SELECT
  USING (
    student_id = auth.uid()
    OR supervisor_id = auth.uid()
    OR public.is_admin()
  );

DROP POLICY IF EXISTS "Admins manage assignments" ON public.supervisor_assignments;
CREATE POLICY "Admins manage assignments"
  ON public.supervisor_assignments FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- Keep the assignment history aligned with the profile assignment when this
-- column is changed by a trusted server workflow or an admin SQL operation.
CREATE OR REPLACE FUNCTION public.record_supervisor_assignment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.supervisor_id IS DISTINCT FROM OLD.supervisor_id THEN
    UPDATE public.supervisor_assignments
    SET unassigned_at = NOW()
    WHERE student_id = NEW.id AND unassigned_at IS NULL;

    IF NEW.supervisor_id IS NOT NULL THEN
      INSERT INTO public.supervisor_assignments (institution_id, student_id, supervisor_id)
      VALUES (NEW.institution_id, NEW.id, NEW.supervisor_id);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_supervisor_assignment_history ON public.profiles;
CREATE TRIGGER profiles_supervisor_assignment_history
  AFTER UPDATE OF supervisor_id ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.record_supervisor_assignment();

