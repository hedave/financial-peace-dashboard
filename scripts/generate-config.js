/**
 * Netlify build step: writes js/config.js from environment variables.
 * Set in Netlify: Site configuration → Environment variables
 */
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const url = process.env.SUPABASE_URL || '';
const key = process.env.SUPABASE_ANON_KEY || '';
const enabled = process.env.CLOUD_SYNC_ENABLED !== 'false' && !!url && !!key;

const content = `/** Auto-generated at deploy — do not edit on Netlify */
export const SUPABASE_URL = ${JSON.stringify(url)};
export const SUPABASE_ANON_KEY = ${JSON.stringify(key)};
export const CLOUD_SYNC_ENABLED = ${enabled};
`;

writeFileSync(join(root, 'js', 'config.js'), content, 'utf8');
console.log(enabled ? 'config.js written (cloud sync on)' : 'config.js written (cloud sync off — missing env vars)');