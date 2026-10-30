import fs from 'fs';
import path from 'path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { library } from './supabase/functions/_shared/library';
import { DEFAULT_SETTINGS } from './services/settings';

// Pages outside the React app. Builds copy them into the site as they are.
const STANDALONE_PAGES = ['login.html', 'analytics.html', 'resources.html', 'settings.html', 'set-password.html'];

// What the {{placeholders}} in the HTML pages stand for, from the library settings.
const PAGE_DETAILS: Record<string, string> = {
  supabaseUrl: library.supabase.url,
  supabaseKey: library.supabase.publishableKey,
  // supabase-js keeps the session under sb-<project>-auth-token.
  supabaseProject: new URL(library.supabase.url).hostname.split('.')[0],
  council: library.council,
  emailDomain: library.emailDomain,
  firstBranch: library.branches[0].name,
  // The usual settings the Settings page starts from, as JSON in a data block.
  defaultSettings: JSON.stringify(DEFAULT_SETTINGS).replace(/</g, '\\u003c'),
};

function fillDetails(html: string, page: string): string {
  return html.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    if (!(name in PAGE_DETAILS)) throw new Error(`${page} uses {{${name}}}, which isn't in PAGE_DETAILS`);
    return PAGE_DETAILS[name];
  });
}

// The dev server fills in every page it serves. Builds fill in index.html and
// write out the standalone pages.
function libraryDetails(): Plugin {
  return {
    name: 'library-details',
    transformIndexHtml: { order: 'pre', handler: (html, { path: page }) => fillDetails(html, page) },
    generateBundle() {
      for (const page of STANDALONE_PAGES) {
        const html = fs.readFileSync(path.resolve(__dirname, page), 'utf8');
        this.emitFile({ type: 'asset', fileName: page, source: fillDetails(html, page) });
      }
    },
  };
}

export default defineConfig(() => {
  return {
    // Relative paths, so the site works from any GitHub Pages address or repo name.
    base: './',
    server: {
      port: 3000,
      host: '0.0.0.0',
    },
    plugins: [react(), libraryDetails()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
  };
});
