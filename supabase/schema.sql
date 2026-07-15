-- =============================================================================
-- KASU SPMS — Supabase Schema
-- Run this entire file in: Supabase Dashboard → SQL Editor → New query → Run
--
-- After running:
-- 1. Set js/config.js with your Project URL and anon key
-- 2. In Auth → Providers → Email, disable "Confirm email" for easier dev signup
--    (optional — seeded demo accounts work without this)
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- Types & tables
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('student', 'teacher', 'library', 'admin');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  full_name TEXT,
  matric TEXT UNIQUE,
  department TEXT,
  role user_role NOT NULL DEFAULT 'student',
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS students_registry (
  matric TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  department TEXT NOT NULL,
  session TEXT
);

-- ---------------------------------------------------------------------------
-- Auto-create profile when a user signs up
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, role, full_name, matric, department)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE((NEW.raw_user_meta_data->>'role')::user_role, 'student'),
    NEW.raw_user_meta_data->>'full_name',
    NEW.raw_user_meta_data->>'matric',
    NEW.raw_user_meta_data->>'department'
  )
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    role = COALESCE(EXCLUDED.role, profiles.role),
    full_name = COALESCE(EXCLUDED.full_name, profiles.full_name),
    matric = COALESCE(EXCLUDED.matric, profiles.matric),
    department = COALESCE(EXCLUDED.department, profiles.department),
    updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER bypasses RLS so admin checks never recurse into profiles policies.
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

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE students_registry ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own profile" ON profiles;
CREATE POLICY "Users read own profile"
  ON profiles FOR SELECT
  USING (auth.uid() = id);

DROP POLICY IF EXISTS "Users update own profile" ON profiles;
CREATE POLICY "Users update own profile"
  ON profiles FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "Anyone can lookup matric" ON students_registry;
CREATE POLICY "Anyone can lookup matric"
  ON students_registry FOR SELECT
  USING (true);

-- ---------------------------------------------------------------------------
-- Demo user seeder (idempotent — safe to re-run)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_demo_user(
  user_id UUID,
  user_email TEXT,
  user_password TEXT,
  user_role user_role,
  user_name TEXT,
  user_matric TEXT DEFAULT NULL,
  user_department TEXT DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, extensions
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE email = user_email) THEN
    INSERT INTO auth.users (
      instance_id,
      id,
      aud,
      role,
      email,
      encrypted_password,
      email_confirmed_at,
      recovery_sent_at,
      last_sign_in_at,
      raw_app_meta_data,
      raw_user_meta_data,
      created_at,
      updated_at,
      confirmation_token,
      email_change,
      email_change_token_new,
      recovery_token
    ) VALUES (
      '00000000-0000-0000-0000-000000000000',
      user_id,
      'authenticated',
      'authenticated',
      user_email,
      crypt(user_password, gen_salt('bf')),
      NOW(),
      NOW(),
      NOW(),
      '{"provider":"email","providers":["email"]}',
      jsonb_build_object(
        'role', user_role::text,
        'full_name', user_name,
        'matric', user_matric,
        'department', user_department
      ),
      NOW(),
      NOW(),
      '',
      '',
      '',
      ''
    );

    INSERT INTO auth.identities (
      id,
      user_id,
      identity_data,
      provider,
      provider_id,
      last_sign_in_at,
      created_at,
      updated_at
    ) VALUES (
      user_id,
      user_id,
      jsonb_build_object('sub', user_id::text, 'email', user_email),
      'email',
      user_email,
      NOW(),
      NOW(),
      NOW()
    );
  END IF;

  INSERT INTO profiles (id, email, role, full_name, matric, department)
  VALUES (user_id, user_email, user_role, user_name, user_matric, user_department)
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    role = EXCLUDED.role,
    full_name = EXCLUDED.full_name,
    matric = EXCLUDED.matric,
    department = EXCLUDED.department,
    updated_at = NOW();
END;
$$;

-- Demo accounts (same credentials as the original prototype)
SELECT public.create_demo_user(
  'a0000000-0000-4000-8000-000000000001',
  'student@kasu.edu.ng',
  'password',
  'student',
  'Musa Abdullahi',
  'KASU/SCI/20/123',
  'Computer Science'
);

SELECT public.create_demo_user(
  'a0000000-0000-4000-8000-000000000002',
  'teacher@kasu.edu.ng',
  'password',
  'teacher',
  'Dr. Sani Musa',
  NULL,
  'Computer Science'
);

SELECT public.create_demo_user(
  'a0000000-0000-4000-8000-000000000003',
  'library@kasu.edu.ng',
  'password',
  'library',
  'Library Officer',
  NULL,
  'University Library'
);

SELECT public.create_demo_user(
  'a0000000-0000-4000-8000-000000000004',
  'admin@kasu.edu.ng',
  'password',
  'admin',
  'System Administrator',
  NULL,
  'ICT Directorate'
);

-- ---------------------------------------------------------------------------
-- Student registry (for signup matric lookup)
-- ---------------------------------------------------------------------------

INSERT INTO students_registry (matric, full_name, department, session) VALUES
  ('KASU/SCI/20/123', 'Musa Abdullahi', 'Computer Science', '2023/2024'),
  ('KASU/SCI/20/088', 'John Paul', 'Microbiology', '2023/2024'),
  ('KASU/SCI/20/012', 'Fatima Sani', 'Mass Communication', '2023/2024'),
  ('KASU/PG/21/045', 'Aisha Bello', 'Computer Science', '2022/2023'),
  ('KASU/SS/20/078', 'Sani Garba', 'Accounting', '2023/2024')
ON CONFLICT (matric) DO NOTHING;
