#!/usr/bin/env node
/**
 * Tests for scan-doc.js
 *
 * Usage:
 *   node .claude/scripts/scan-doc.tests.js
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const scriptPath = path.join(__dirname, 'scan-doc.js');
const tmpDir = path.join(os.tmpdir(), 'scan-doc-tests-' + Date.now());

let passed = 0;
let failed = 0;
const errors = [];

// =============================================================================
// HELPERS
// =============================================================================

function setup() {
  fs.mkdirSync(tmpDir, { recursive: true });
}

function cleanup() {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function writeFile(name, content) {
  const filePath = path.join(tmpDir, name);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

function writeBinaryFile(name, bytes) {
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, Buffer.from(bytes));
  return filePath;
}

function run(args) {
  try {
    const output = execFileSync('node', [scriptPath, ...args], {
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: true, data: JSON.parse(output) };
  } catch (err) {
    return {
      ok: false,
      exitCode: err.status ?? 1,
      stderr: (err.stderr ?? '').trim(),
    };
  }
}

function assert(condition, description, actual) {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m: ${description}`);
  } else {
    const suffix = actual !== undefined ? ` (got: ${JSON.stringify(actual)})` : '';
    failed++;
    errors.push(`FAIL: ${description}${suffix}`);
    console.log(`  \x1b[31mFAIL: ${description}${suffix}\x1b[0m`);
  }
}

// =============================================================================
// TESTS
// =============================================================================

setup();

// --- No args ---
console.log('\nError handling');

const noArgs = run([]);
assert(!noArgs.ok && noArgs.exitCode === 1, 'no args = exit 1');

const missing = run([path.join(tmpDir, 'nonexistent.md')]);
assert(!missing.ok && missing.stderr.includes('Path not found'), 'missing file = error message');

// --- Markdown file ---
console.log('\nMarkdown file scanning');

const mdPath = writeFile('test.md', [
  '# Main Title',
  '',
  '## Overview',
  '',
  'Some content here.',
  '',
  '**Bold Heading**',
  '',
  'More content.',
  '',
  '- **List item** with bold',
  '',
  '**Fields:** not a heading because of trailing text.',
  '',
  '### Sub Section',
].join('\n'));

const md = run([mdPath]);
assert(md.ok, 'markdown file parses');
assert(md.data.type === 'markdown', 'type = markdown');
assert(md.data.lines === 15, 'line count = 15');
assert(md.data.binary === false, 'not binary');
assert(!md.data.encoding, 'no encoding field (removed)');

const h = md.data.headings;
assert(h.length === 4, 'finds 4 headings');
assert(h[0].level === 1 && h[0].text === 'Main Title', 'h1: Main Title');
assert(h[1].level === 2 && h[1].text === 'Overview', 'h2: Overview');
assert(h[2].level === 0 && h[2].text === 'Bold Heading', 'bold heading detected (level 0)');
assert(h[3].level === 3 && h[3].text === 'Sub Section', 'h3: Sub Section');

// --- Bold heading edge cases ---
console.log('\nBold heading edge cases');

const boldPath = writeFile('bold-test.md', [
  '**Title**',
  '**Fields:** not a heading',
  '- **List item**',
  '  **Indented bold heading**',
  '**Screen 1: Dashboard**',
].join('\n'));

const bold = run([boldPath]);
const bh = bold.data.headings;
assert(bh.length === 3, 'finds 3 bold headings (excludes inline bold)');
assert(bh[0].text === 'Title', 'standalone **Title**');
assert(bh[1].text === 'Indented bold heading', 'indented bold heading detected');
assert(bh[2].text === 'Screen 1: Dashboard', '**Screen 1: Dashboard**');

// --- Frontmatter ---
console.log('\nFrontmatter extraction');

const fmPath = writeFile('with-frontmatter.md', [
  '---',
  'pipeline_stage: "ingest"',
  'created: 2026-01-15',
  'agent: a1-interpreter',
  '---',
  '',
  '# Genesis Doc',
].join('\n'));

const fm = run([fmPath]);
assert(fm.data.frontmatter !== null, 'frontmatter detected');
assert(fm.data.frontmatter.pipeline_stage === 'ingest', 'pipeline_stage extracted');
assert(fm.data.frontmatter.agent === 'a1-interpreter', 'agent extracted');

const noFmPath = writeFile('no-frontmatter.md', '# Just a heading\n\nContent.');
const noFm = run([noFmPath]);
assert(noFm.data.frontmatter === null, 'no frontmatter = null');

// --- Keywords ---
console.log('\nKeyword counting');

const kwPath = writeFile('keywords.md', [
  'This project uses BFF authentication with role-based access.',
  'The auth system supports admin and viewer roles.',
  'No compliance requirements identified.',
  'The API provides a mock endpoint for testing.',
].join('\n'));

const kw = run([kwPath, '--keywords', 'auth,role,BFF,compliance,mock,api']);
assert(kw.data.keywords.auth === 2, 'auth = 2 (auth + authentication)', kw.data.keywords.auth);
assert(kw.data.keywords.role === 2, 'role = 2 (role + roles)', kw.data.keywords.role);
assert(kw.data.keywords.bff === 1, 'bff = 1', kw.data.keywords.bff);
assert(kw.data.keywords.compliance === 1, 'compliance = 1', kw.data.keywords.compliance);
assert(kw.data.keywords.mock === 1, 'mock = 1', kw.data.keywords.mock);
assert(kw.data.keywords.api === 1, 'api = 1', kw.data.keywords.api);

const noKw = run([kwPath]);
assert(!noKw.data.keywords, 'no --keywords flag = no keywords field');

// --- YAML / OpenAPI detection ---
console.log('\nYAML / OpenAPI detection');

const openApiPath = writeFile('api-spec.yaml', [
  'openapi: "3.0.3"',
  'info:',
  '  title: Test API',
  'paths:',
  '  /users:',
  '    get:',
  '      summary: List users',
].join('\n'));

const oa = run([openApiPath]);
assert(oa.data.type === 'yaml', 'type = yaml');
assert(oa.data.isOpenApiSpec === true, 'detects OpenAPI spec');
assert(oa.data.openApiVersion === '3.0.3', 'extracts version');

const plainYaml = writeFile('config.yaml', 'key: value\nother: data\n');
const py = run([plainYaml]);
assert(py.data.isOpenApiSpec === false, 'plain YAML is not OpenAPI');

const swaggerPath = writeFile('old-api.json', '{"swagger": "2.0", "info": {}}');
const sw = run([swaggerPath]);
assert(sw.ok && sw.data.isOpenApiSpec === true, 'detects Swagger spec', sw.ok ? sw.data.isOpenApiSpec : sw.stderr);
assert(sw.ok && sw.data.openApiVersion === '2.0', 'extracts Swagger version', sw.ok ? sw.data.openApiVersion : sw.stderr);

// --- CSV ---
console.log('\nCSV files');

const csvPath = writeFile('data.csv', 'Name,Amount\nABC Corp,125000\nXYZ Ltd,89000\n');
const csv = run([csvPath]);
assert(csv.data.type === 'csv', 'type = csv');
assert(csv.data.lines === 4, 'line count includes trailing newline');
assert(csv.data.binary === false, 'csv is not binary');

// --- Office formats ---
console.log('\nOffice format detection');

const docxPath = writeBinaryFile('spec.docx', [0x50, 0x4b, 0x03, 0x04]);
const docx = run([docxPath]);
assert(docx.data.type === 'office', 'docx type = office');
assert(docx.data.binary === true, 'docx is binary');
assert(docx.data.note.includes('export'), 'docx note suggests export');

const xlsxPath = writeBinaryFile('data.xlsx', [0x50, 0x4b, 0x03, 0x04]);
const xlsx = run([xlsxPath]);
assert(xlsx.data.type === 'office', 'xlsx type = office');

// --- PDF ---
console.log('\nPDF detection');

const pdfPath = writeBinaryFile('doc.pdf', [0x25, 0x50, 0x44, 0x46]);
const pdf = run([pdfPath]);
assert(pdf.ok && pdf.data.type === 'pdf', 'pdf type = pdf', pdf.ok ? pdf.data.type : pdf.stderr);
assert(pdf.ok && pdf.data.binary === true, 'pdf is binary', pdf.ok ? pdf.data.binary : pdf.stderr);
assert(pdf.ok && pdf.data.note && pdf.data.note.includes('Read tool'), 'pdf note mentions Read tool', pdf.ok ? pdf.data.note : pdf.stderr);

// --- Image ---
console.log('\nImage detection');

const imgPath = writeBinaryFile('screenshot.png', [0x89, 0x50, 0x4e, 0x47]);
const img = run([imgPath]);
assert(img.data.type === 'image', 'png type = image');
assert(img.data.binary === true, 'image is binary');

// --- Unknown binary ---
console.log('\nUnknown binary detection');

const binPath = writeBinaryFile('mystery.dat', Array.from({ length: 100 }, () => 0));
const bin = run([binPath]);
assert(bin.data.binary === true, 'null-byte file detected as binary');
assert(bin.data.note.includes('text-based format'), 'unknown binary suggests text format');

// --- Pencil design ---
console.log('\nPencil design file');

const penPath = writeBinaryFile('project.pen', [0x50, 0x4b, 0x03, 0x04]);
const pen = run([penPath]);
assert(pen.data.type === 'pencil-design', 'pen type = pencil-design');
assert(pen.data.note.includes('designer-intent'), 'pen note describes designer-intent reference role');

// --- Directory scanning ---
console.log('\nDirectory scanning');

writeFile('dir-test/README.md', '# Project\n\nOverview.');
writeFile('dir-test/api.yaml', 'openapi: "3.1.0"\ninfo:\n  title: API');
writeFile('dir-test/data.csv', 'a,b\n1,2');
writeBinaryFile('dir-test/logo.png', [0x89, 0x50, 0x4e, 0x47]);

const dir = run([path.join(tmpDir, 'dir-test')]);
assert(dir.ok, 'directory scan succeeds');
assert(dir.data.summary.totalFiles === 4, 'counts 4 files');
assert(dir.data.summary.fileTypes.markdown === 1, '1 markdown file');
assert(dir.data.summary.fileTypes.yaml === 1, '1 yaml file');
assert(dir.data.summary.fileTypes.csv === 1, '1 csv file');
assert(dir.data.summary.fileTypes.image === 1, '1 image file');

// --- Empty directory ---
console.log('\nEmpty directory');

fs.mkdirSync(path.join(tmpDir, 'empty-dir'), { recursive: true });
const empty = run([path.join(tmpDir, 'empty-dir')]);
assert(empty.ok, 'empty directory scan succeeds');
assert(empty.data.summary.totalFiles === 0, 'counts 0 files');

// --- Hidden files skipped ---
console.log('\nHidden file handling');

writeFile('hidden-test/visible.md', '# Visible');
writeFile('hidden-test/.hidden.md', '# Hidden');

const hidden = run([path.join(tmpDir, 'hidden-test')]);
assert(hidden.data.summary.totalFiles === 1, 'hidden files skipped');

// --- Markdown extension variants ---
console.log('\nMarkdown extension variants');

const mdownPath = writeFile('notes.mdown', '# Notes\n\nContent.');
const mdown = run([mdownPath]);
assert(mdown.data.type === 'markdown', '.mdown detected as markdown');
assert(mdown.data.headings.length === 1, '.mdown headings extracted');

const markdownPath = writeFile('spec.markdown', '## Spec\n\nDetails.');
const markdown = run([markdownPath]);
assert(markdown.data.type === 'markdown', '.markdown detected as markdown');

// =============================================================================
// CLEANUP & SUMMARY
// =============================================================================

cleanup();

console.log('\n========================================');
console.log(`Results: ${passed} passed, ${failed} failed`);

if (errors.length > 0) {
  console.log('\nFailures:');
  for (const err of errors) {
    console.log(`  \x1b[31m${err}\x1b[0m`);
  }
}

console.log('========================================\n');
process.exit(failed === 0 ? 0 : 1);
