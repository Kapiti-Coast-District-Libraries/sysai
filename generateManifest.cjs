/*
// generateManifest.cjs
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT_DIR = __dirname;
const SOP_ROOT = path.join(ROOT_DIR, 'SOP');
const MANIFEST_FILE = path.join(ROOT_DIR, 'manifest.json');



/**
 * Recursively walk folder, convert PDFs, collect non-PDF files
 
function walkDir(dir, fileSet = new Set()) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      walkDir(fullPath, fileSet);
      continue;
    }

    let relativePath = path.relative(ROOT_DIR, fullPath).replace(/\\/g, '/');

    if (entry.name.toLowerCase().endsWith('.pdf')) {
      relativePath = relativePath.replace(/\.pdf$/i, '.txt');
    }

    fileSet.add(relativePath); // automatically ignores duplicates
  }

  return Array.from(fileSet);
}


/**
 * Auto-commit manifest.json
 */


/**
 * Main
 
function generateManifest() {
  const files = walkDir(SOP_ROOT); // will use default Set internally
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(files, null, 2), 'utf-8');
  console.log(`Manifest generated with ${files.length} files.`);
}


generateManifest();
*/