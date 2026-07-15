-- =============================================================================
-- KASU SPMS — Payments & Submissions (run after schema.sql)
-- Supabase Dashboard → SQL Editor → Run
-- =============================================================================

DO $$ BEGIN
  CREATE TYPE payment_status AS ENUM ('pending', 'success', 'failed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE submission_status AS ENUM ('pending', 'approved', 'revision', 'cleared');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_path TEXT,
  status submission_status NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  submission_id UUID REFERENCES submissions(id) ON DELETE SET NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'NGN',
  paystack_reference TEXT UNIQUE NOT NULL,
  paystack_transaction_id TEXT,
  status payment_status NOT NULL DEFAULT 'pending',
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_student ON payments(student_id);
CREATE INDEX IF NOT EXISTS idx_payments_reference ON payments(paystack_reference);
CREATE INDEX IF NOT EXISTS idx_submissions_student ON submissions(student_id);

ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Students read own submissions" ON submissions;
CREATE POLICY "Students read own submissions"
  ON submissions FOR SELECT
  USING (auth.uid() = student_id);

DROP POLICY IF EXISTS "Students insert own submissions" ON submissions;
CREATE POLICY "Students insert own submissions"
  ON submissions FOR INSERT
  WITH CHECK (auth.uid() = student_id);

DROP POLICY IF EXISTS "Admins read all submissions" ON submissions;
CREATE POLICY "Admins read all submissions"
  ON submissions FOR SELECT
  USING (public.is_admin());

DROP POLICY IF EXISTS "Students read own payments" ON payments;
CREATE POLICY "Students read own payments"
  ON payments FOR SELECT
  USING (auth.uid() = student_id);

DROP POLICY IF EXISTS "Students insert own payments" ON payments;
CREATE POLICY "Students insert own payments"
  ON payments FOR INSERT
  WITH CHECK (auth.uid() = student_id);

DROP POLICY IF EXISTS "Admins read all payments" ON payments;
CREATE POLICY "Admins read all payments"
  ON payments FOR SELECT
  USING (public.is_admin());

DROP POLICY IF EXISTS "Admins read all profiles" ON profiles;
CREATE POLICY "Admins read all profiles"
  ON profiles FOR SELECT
  USING (public.is_admin());

-- Thesis PDF storage bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'thesis-pdfs',
  'thesis-pdfs',
  false,
  104857600,
  ARRAY['application/pdf']
)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Students upload own thesis" ON storage.objects;
CREATE POLICY "Students upload own thesis"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'thesis-pdfs'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

DROP POLICY IF EXISTS "Students read own thesis" ON storage.objects;
CREATE POLICY "Students read own thesis"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'thesis-pdfs'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

DROP POLICY IF EXISTS "Admins read all thesis files" ON storage.objects;
CREATE POLICY "Admins read all thesis files"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'thesis-pdfs'
    AND public.is_admin()
  );
