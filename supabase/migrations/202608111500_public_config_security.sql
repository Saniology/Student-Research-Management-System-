-- Keep server-only payment routing settings out of PostgREST browser reads.
-- The public-config Edge Function exposes only safe fee/upload settings.
DROP POLICY IF EXISTS "Public read configs" ON public.system_configs;
