import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js';

export function configReady() {
  return /^https:\/\/.+\.supabase\.co$/i.test(SUPABASE_URL)
    && SUPABASE_PUBLISHABLE_KEY
    && !SUPABASE_PUBLISHABLE_KEY.includes('YOUR_');
}

export function makeClient(role = 'player') {
  return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storageKey: `brand-quiz-${role}-auth`
    }
  });
}
