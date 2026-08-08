import { createClient } from '@supabase/supabase-js';

const env = import.meta.env;
const url = env.VITE_SUPABASE_URL || window.SUPABASE_URL || '';
const anonKey = env.VITE_SUPABASE_ANON_KEY || window.SUPABASE_ANON_KEY || '';
const paystackKey = env.VITE_PAYSTACK_PUBLIC_KEY || window.PAYSTACK_PUBLIC_KEY || '';

export const config = { url, anonKey, paystackKey, valid: Boolean(url && anonKey && !url.includes('replace')) };
export const supabase = config.valid ? createClient(url, anonKey) : null;
export const fallbackTenant = { slug: 'kasu', name: 'Kaduna State University', short_name: 'KASU', primary_color: '#065F46', accent_color: '#F59E0B', logo_url: '/assets/kasu-logo.jpeg' };

export async function invoke(functionName, body) {
  if (!supabase) throw new Error('Supabase is not configured. Add browser credentials in js/config.js.');
  const { data, error } = await supabase.functions.invoke(functionName, { body });
  if (error || data?.error) throw new Error(data?.error || error?.message || 'Request failed');
  return data;
}

export async function loadTenant(slug = 'kasu') {
  if (!supabase) return fallbackTenant;
  try {
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

export async function signedPdfUrl(path, ttl = 300) {
  if (!supabase || !path) return '';
  const { data, error } = await supabase.storage.from('thesis-pdfs').createSignedUrl(path, ttl);
  if (error) throw error;
  return data?.signedUrl || '';
}
