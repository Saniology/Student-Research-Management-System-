-- Hotfix: "infinite recursion detected in policy for relation profiles"
-- Run in Supabase Dashboard → SQL Editor if you already applied payments.sql.

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin'
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

DROP POLICY IF EXISTS "Admins read all profiles" ON profiles;
CREATE POLICY "Admins read all profiles"
  ON profiles FOR SELECT
  USING (public.is_admin());

DROP POLICY IF EXISTS "Admins read all submissions" ON submissions;
CREATE POLICY "Admins read all submissions"
  ON submissions FOR SELECT
  USING (public.is_admin());

DROP POLICY IF EXISTS "Admins read all payments" ON payments;
CREATE POLICY "Admins read all payments"
  ON payments FOR SELECT
  USING (public.is_admin());

DROP POLICY IF EXISTS "Admins read all thesis files" ON storage.objects;
CREATE POLICY "Admins read all thesis files"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'thesis-pdfs'
    AND public.is_admin()
  );
