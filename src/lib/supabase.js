import { createClient } from '@supabase/supabase-js';

const env = import.meta.env;
const url = env.VITE_SUPABASE_URL || window.SUPABASE_URL || '';
const anonKey = env.VITE_SUPABASE_ANON_KEY || window.SUPABASE_ANON_KEY || '';
const paystackKey = env.VITE_PAYSTACK_PUBLIC_KEY || window.PAYSTACK_PUBLIC_KEY || '';

export function validateAppConfig() {
  const errors = [];
  if (!url || /YOUR_SUPABASE|replace/i.test(url)) errors.push('SUPABASE_URL');
  if (!anonKey || /anon_key_here|replace/i.test(anonKey)) errors.push('SUPABASE_ANON_KEY');
  if (!paystackKey || !/^pk_(test|live)_/.test(paystackKey)) errors.push('PAYSTACK_PUBLIC_KEY');
  return { valid: errors.length === 0, errors };
}
export function showAppConfigError() { return !validateAppConfig().valid; }
export const config = { url, anonKey, paystackKey, ...validateAppConfig() };
export const supabase = config.valid ? createClient(url, anonKey) : null;
export const fallbackTenant = { slug: 'kasu', name: 'Kaduna State University', short_name: 'KASU', primary_color: '#065F46', accent_color: '#F59E0B', logo_url: '/assets/kasu-logo.jpeg' };

export async function invoke(functionName, body) {
  if (!supabase) throw new Error('Supabase is not configured. Add browser credentials in js/config.js.');
  const { data, error } = await supabase.functions.invoke(functionName, { body });
  if (error || data?.error) throw new Error(data?.error || error?.message || 'Request failed');
  return data;
}

export async function loadTenant(slug = 'kasu', hostname = window.location.hostname) {
  if (!supabase) return fallbackTenant;
  try {
    if (hostname && !['localhost', '127.0.0.1', '0.0.0.0'].includes(hostname)) {
      const { data: domainTenant } = await supabase.from('institutions').select('*').contains('allowed_domains', [hostname]).maybeSingle();
      if (domainTenant) return domainTenant;
    }
    const { data, error } = await supabase.from('institutions').select('*').eq('slug', slug).maybeSingle();
    return error || !data ? fallbackTenant : data;
  } catch (_) { return fallbackTenant; }
}

export async function loadProfile(userId) {
  if (!supabase || !userId) return null;
  const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle();
  if (error) throw error;
  return data;
}

export async function loadSystemConfig(institutionId) {
  if (!supabase) return null;
  const query = supabase.from('system_configs').select('*');
  const { data, error } = institutionId
    ? await query.eq('institution_id', institutionId).maybeSingle()
    : await query.limit(1).maybeSingle();
  if (error) throw error;
  return data;
}

export async function signedPdfUrl(path, ttl = 300) {
  if (!supabase || !path) return '';
  const { data, error } = await supabase.storage.from('thesis-pdfs').createSignedUrl(path, ttl);
  if (error) throw error;
  return data?.signedUrl || '';
}
