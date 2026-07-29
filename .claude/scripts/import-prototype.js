#!/usr/bin/env node
/**
 * import-prototype.js
 * Selectively imports artifacts from a prototyping tool repository into documentation/
 *
 * Expected source repository shape:
 *   genesis/genesis.md            → documentation/genesis.md
 *   genesis/source-manifest.md    → documentation/source-manifest.md
 *   input/*.yaml|*.json (OpenAPI) → documentation/
 *   input/*.md                    → documentation/
 *   designs/tokens.css            → documentation/tokens.css
 *   designs/project.pen           → documentation/project.pen
 *   prototype/src/                → documentation/prototype-src/
 *   prototype/.build-manifest.json→ documentation/build-manifest.json
 *   _bmad-output/implementation-artifacts/ → documentation/implementation-artifacts-index.md (summary)
 *
 * Usage:
 *   node .claude/scripts/import-prototype.js --from <path-to-prototype-repo>
 *   node .claude/scripts/import-prototype.js --help
 *
 * Source file filter (for prototype-src):
 *   Only copies: .jsx, .js, .ts, .tsx, .css, .json files
 *   Skips: node_modules/, dist/, .git/, .next/, __pycache__/, .cache/
 */

const fs = require('fs');
const path = require('path');

// Extensions to include when copying prototype source files
const SOURCE_EXTENSIONS = new Set(['.jsx', '.js', '.ts', '.tsx', '.css', '.json']);

// Directories to skip when copying prototype source
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.next', '__pycache__', '.cache']);

function showHelp() {
  console.log(`
import-prototype.js — Import artifacts from a prototyping tool repository

Usage:
  node .claude/scripts/import-prototype.js --from <path>

Options:
  --from <path>   Path to the prototype repository (required)
  --help          Show this help message

Example:
  node .claude/scripts/import-prototype.js --from "../my-prototype"
  node .claude/scripts/import-prototype.js --from "C:\\Git\\my-prototype"
`);
  process.exit(0);
}

function parseArgs() {
  const args = process.argv.slice(2);
  let fromPath = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h') {
      showHelp();
    } else if (args[i] === '--from' && args[i + 1]) {
      fromPath = args[i + 1];
      i++;
    }
  }

  return { fromPath };
}

function fail(message, suggestion) {
  console.log(JSON.stringify({
    status: 'error',
    message,
    suggestion: suggestion || null
  }, null, 2));
  process.exit(1);
}

/**
 * Recursively copy a directory, preserving structure.
 * For source files, applies extension filter.
 * Returns array of copied file paths (absolute).
 */
function copyDirRecursive(src, dest, { filterExtensions = null } = {}) {
  const copied = [];

  if (!fs.existsSync(src)) return copied;

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;

      fs.mkdirSync(destPath, { recursive: true });
      const subCopied = copyDirRecursive(srcPath, destPath, { filterExtensions });
      copied.push(...subCopied);
    } else if (entry.isFile()) {
      if (filterExtensions) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!filterExtensions.has(ext)) continue;
      }

      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(srcPath, destPath);
      copied.push(destPath);
    }
  }

  return copied;
}

/**
 * Copy a single file, creating parent directories as needed.
 */
function copyFile(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return true;
}

/**
 * Calculate total size of files in bytes
 */
function totalSize(filePaths) {
  let total = 0;
  for (const fp of filePaths) {
    try {
      total += fs.statSync(fp).size;
    } catch {
      // Skip files that can't be stat'd
    }
  }
  return total;
}

/**
 * Read the first N bytes of a file as a UTF-8 string.
 */
function readFileHead(filePath, bytes) {
  const buf = Buffer.allocUnsafe(bytes);
  const fd = fs.openSync(filePath, 'r');
  const bytesRead = fs.readSync(fd, buf, 0, bytes, 0);
  fs.closeSync(fd);
  return buf.toString('utf-8', 0, bytesRead);
}

/**
 * Check if a file contains OpenAPI/Swagger content by scanning the first 2 KB.
 */
function isOpenApiFile(filePath) {
  try {
    const head = readFileHead(filePath, 2048).toLowerCase();
    return head.includes('openapi:') || head.includes('swagger:') ||
           head.includes('"openapi"') || head.includes('"swagger"');
  } catch {
    return false;
  }
}

/**
 * Read implementation artifact files and produce a summary index.
 * Returns the number of stories indexed.
 */
function buildImplementationArtifactsIndex(artifactsDir, destPath, originalRepoPath) {
  if (!fs.existsSync(artifactsDir)) return 0;

  const files = fs.readdirSync(artifactsDir)
    .filter(f => f.endsWith('.md'))
    .sort();

  if (files.length === 0) return 0;

  const lines = [
    '# Implementation Artifacts Index',
    '',
    `> Source: ${originalRepoPath}`,
    `> Generated at import time — ${new Date().toISOString()}`,
    `> ${files.length} story/task documents`,
    '',
    '| # | File | Title |',
    '|---|------|-------|'
  ];

  for (let i = 0; i < files.length; i++) {
    const filePath = path.join(artifactsDir, files[i]);
    let title = files[i].replace(/\.md$/, '').replace(/[-_]/g, ' ');

    try {
      const head = readFileHead(filePath, 512);
      const headingMatch = head.match(/^#{1,2}\s+(.+)$/m);
      if (headingMatch) {
        title = headingMatch[1].trim();
      }
    } catch {
      // Use filename-derived title as fallback
    }

    lines.push(`| ${i + 1} | ${files[i]} | ${title} |`);
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, lines.join('\n') + '\n');
  return files.length;
}

/**
 * Extract screen names from build-manifest.json
 */
function extractScreensFromBuildManifest(manifestPath) {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    if (Array.isArray(manifest.screens)) {
      return manifest.screens.map(s => s.screen_name || s.route_path || 'unknown');
    }
  } catch {
    // Manifest missing or invalid
  }
  return [];
}

/**
 * Verify the source path looks like a prototype repository.
 * The marker file is genesis/genesis.md.
 */
function isPrototypeRepo(repoRoot) {
  return fs.existsSync(path.join(repoRoot, 'genesis', 'genesis.md'));
}

// ============================================================
// Import from a prototyping tool repository
// ============================================================
function importPrototype(repoRoot, destRoot) {
  const result = {
    genesis: { count: 0, files: [] },
    input: { count: 0, files: [] },
    apiSpecs: [],
    designs: { count: 0, files: [] },
    prototypeSrc: { count: 0, screens: [] },
    buildManifest: false,
    implementationArtifactsIndex: { storyCount: 0 }
  };
  const allCopied = [];

  // --- Step 1: Copy genesis/genesis.md → documentation/genesis.md ---
  const genesisSrc = path.join(repoRoot, 'genesis', 'genesis.md');
  const genesisDest = path.join(destRoot, 'genesis.md');
  if (copyFile(genesisSrc, genesisDest)) {
    result.genesis.count++;
    result.genesis.files.push('genesis.md');
    allCopied.push(genesisDest);
  }

  // --- Step 2: Copy genesis/source-manifest.md → documentation/source-manifest.md ---
  const manifestSrc = path.join(repoRoot, 'genesis', 'source-manifest.md');
  const manifestDest = path.join(destRoot, 'source-manifest.md');
  if (copyFile(manifestSrc, manifestDest)) {
    result.genesis.count++;
    result.genesis.files.push('source-manifest.md');
    allCopied.push(manifestDest);
  }

  // --- Steps 3+4: Copy input/ files → documentation/ (OpenAPI specs + markdown) ---
  const inputDir = path.join(repoRoot, 'input');
  if (fs.existsSync(inputDir)) {
    for (const file of fs.readdirSync(inputDir)) {
      const ext = path.extname(file).toLowerCase();
      const srcPath = path.join(inputDir, file);

      if ((ext === '.yaml' || ext === '.yml' || ext === '.json') && isOpenApiFile(srcPath)) {
        const destPath = path.join(destRoot, file);
        if (copyFile(srcPath, destPath)) {
          result.apiSpecs.push(file);
          result.input.count++;
          result.input.files.push(file);
          allCopied.push(destPath);
        }
      } else if (ext === '.md') {
        const destPath = path.join(destRoot, file);
        if (copyFile(srcPath, destPath)) {
          result.input.count++;
          result.input.files.push(file);
          allCopied.push(destPath);
        }
      }
    }
  }

  // --- Step 5: Copy designs/tokens.css → documentation/tokens.css ---
  const tokensSrc = path.join(repoRoot, 'designs', 'tokens.css');
  const tokensDest = path.join(destRoot, 'tokens.css');
  if (copyFile(tokensSrc, tokensDest)) {
    result.designs.count++;
    result.designs.files.push('tokens.css');
    allCopied.push(tokensDest);
  }

  // --- Step 6: Copy designs/project.pen → documentation/project.pen ---
  const penSrc = path.join(repoRoot, 'designs', 'project.pen');
  const penDest = path.join(destRoot, 'project.pen');
  if (copyFile(penSrc, penDest)) {
    result.designs.count++;
    result.designs.files.push('project.pen');
    allCopied.push(penDest);
  }

  // --- Step 7: Copy prototype/src/ → documentation/prototype-src/ ---
  const prototypeSrcDir = path.join(repoRoot, 'prototype', 'src');
  const prototypeSrcDest = path.join(destRoot, 'prototype-src');
  if (fs.existsSync(prototypeSrcDir)) {
    const srcCopied = copyDirRecursive(prototypeSrcDir, prototypeSrcDest, {
      filterExtensions: SOURCE_EXTENSIONS
    });
    result.prototypeSrc.count = srcCopied.length;
    allCopied.push(...srcCopied);
  }

  // --- Step 8: Copy prototype/.build-manifest.json → documentation/build-manifest.json ---
  const buildManifestSrc = path.join(repoRoot, 'prototype', '.build-manifest.json');
  const buildManifestDest = path.join(destRoot, 'build-manifest.json');
  if (copyFile(buildManifestSrc, buildManifestDest)) {
    result.buildManifest = true;
    result.prototypeSrc.screens = extractScreensFromBuildManifest(buildManifestDest);
    allCopied.push(buildManifestDest);
  }

  // --- Step 9: Build implementation artifacts index ---
  const artifactsDir = path.join(repoRoot, '_bmad-output', 'implementation-artifacts');
  const indexDest = path.join(destRoot, 'implementation-artifacts-index.md');
  result.implementationArtifactsIndex.storyCount = buildImplementationArtifactsIndex(
    artifactsDir, indexDest, repoRoot
  );
  if (result.implementationArtifactsIndex.storyCount > 0) {
    allCopied.push(indexDest);
  }

  return { result, allCopied };
}

// ============================================================
// Main
// ============================================================
function main() {
  const { fromPath } = parseArgs();

  if (!fromPath) {
    fail(
      'Missing required --from argument.',
      'Usage: node .claude/scripts/import-prototype.js --from <path-to-prototype-repo>'
    );
  }

  const repoRoot = path.resolve(fromPath);
  const projectRoot = path.resolve('.');

  // Self-reference guard
  if (repoRoot === projectRoot) {
    fail(
      'Source path resolves to the current project directory.',
      '--from must point to a different repository, not the current project.'
    );
  }

  // Overlapping paths guard
  const repoRootNorm = repoRoot.replace(/[\\/]+$/, '') + path.sep;
  const projectRootNorm = projectRoot.replace(/[\\/]+$/, '') + path.sep;

  if (projectRootNorm.startsWith(repoRootNorm)) {
    fail(
      `Source path (${repoRoot}) is a parent of the current project.`,
      '--from must point to a separate repository that does not contain the current project.'
    );
  }
  if (repoRootNorm.startsWith(projectRootNorm)) {
    fail(
      `Source path (${repoRoot}) is inside the current project.`,
      '--from must point to a separate repository, not a subdirectory of this project.'
    );
  }

  // Validate existence
  if (!fs.existsSync(repoRoot)) {
    fail(
      `Path does not exist: ${repoRoot}`,
      'Check the path and try again. Use an absolute path or a path relative to the current directory.'
    );
  }

  if (!isPrototypeRepo(repoRoot)) {
    fail(
      'Could not detect a prototype repository at that path. Expected marker file: genesis/genesis.md.',
      'Check that the path points to a prototype repository with the expected structure.'
    );
  }

  const destRoot = path.resolve('documentation');
  fs.mkdirSync(destRoot, { recursive: true });

  const { result, allCopied } = importPrototype(repoRoot, destRoot);
  const totalFiles = allCopied.length;
  const totalKB = Math.round(totalSize(allCopied) / 1024);

  const output = {
    status: 'ok',
    message: `Imported ${totalFiles} files (${totalKB} KB) from ${path.basename(repoRoot)}`,
    originalRepoPath: repoRoot,
    copied: result,
    totalFiles,
    totalSizeKB: totalKB
  };

  console.log(JSON.stringify(output, null, 2));
}

try {
  main();
} catch (error) {
  if (error.code === 'EACCES' || error.code === 'EPERM') {
    fail(
      `Permission denied: ${error.path || error.message}`,
      'Check file permissions on the source and destination directories.'
    );
  } else if (error.code === 'ENOSPC') {
    fail('Disk space full.', 'Free up disk space and try again.');
  } else {
    fail(`Unexpected error: ${error.message}`);
  }
}
