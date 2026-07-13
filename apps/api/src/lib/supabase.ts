import { createClient } from '@supabase/supabase-js';
import { config } from '../config/index.js';

/**
 * Server-side Supabase admin client (service role key). Used for Storage
 * (product images, adjustment/waste proof photos) and any admin-only
 * operation that bypasses Row Level Security. Never expose this client or
 * its key to the frontend.
 */
export const supabaseAdmin = createClient(config.supabase.url, config.supabase.serviceRoleKey);
