import { createClient } from '@supabase/supabase-js'
import { library } from './supabase/functions/_shared/library'

export const supabaseClient = createClient(library.supabase.url, library.supabase.publishableKey)
