#!/usr/bin/env node

/**
 * Test Quality Validator
 *
 * Scans test files for anti-patterns that indicate testing implementation
 * details rather than user-observable behavior.
 *
 * Usage:
 *   node .github/scripts/test-quality-validator.js
 *
 * Exit codes:
 *   0 - No issues found
 *   1 - Anti-patterns detected (CI should fail)
 *
 * This validator is intentionally strict. If you believe a flagged pattern
 * is valid for your use case, you can:
 *   1. Add a // test-quality-ignore comment on the line
 *   2. Add the file to the ignoredFiles array below
 */

const fs = require('fs');
const path = require('path');

// Files to ignore (relative to web/src/__tests__/)
const ignoredFiles = [
  // Add files here if they have legitimate reasons for flagged patterns
];

// Anti-patterns to detect with before/after examples
const antiPatterns = [
  {
    name: 'CSS class testing',
    pattern: /\.toHaveClass\s*\(/,
    message: 'Avoid testing CSS classes. Test user-visible behavior instead.',
    suggestion: 'Use .toBeDisabled(), .toBeVisible(), or test the visual outcome',
    badExample: "expect(button).toHaveClass('btn-primary')",
    goodExample: "expect(screen.getByRole('button')).toBeEnabled()",
  },
  {
    name: 'Function call count testing',
    pattern: /\.toHaveBeenCalledTimes\s*\(/,
    message: 'Avoid testing function call counts. Test the result of those calls.',
    suggestion: 'Test what the user sees after the function runs',
    badExample: 'expect(mockFn).toHaveBeenCalledTimes(3)',
    goodExample: "expect(screen.getByText('3 items loaded')).toBeInTheDocument()",
  },
  {
    name: 'Element count testing via querySelectorAll',
    pattern: /querySelectorAll.*\)\.toHaveLength\s*\(/,
    message: 'Avoid testing element counts. Test that specific content is visible.',
    suggestion: 'Use getByText() or getByRole() to find specific elements',
    badExample: "expect(container.querySelectorAll('li')).toHaveLength(5)",
    goodExample: "expect(screen.getByText('Item 1')).toBeInTheDocument()",
  },
  {
    name: 'Container querySelector usage',
    pattern: /container\.querySelector\s*\(/,
    message: 'Avoid using container.querySelector. Use Testing Library queries.',
    suggestion: 'Use screen.getByRole(), getByText(), or getByLabelText()',
    badExample: "container.querySelector('.my-component')",
    goodExample: "screen.getByRole('button', { name: 'Submit' })",
  },
  {
    name: 'Internal state testing',
    pattern: /\.state\s*\.\s*\w+\s*\)\s*\.toBe/,
    message: 'Avoid testing internal component state.',
    suggestion: 'Test what the user sees when state changes',
    badExample: 'expect(component.state.isLoading).toBe(true)',
    goodExample: "expect(screen.getByRole('progressbar')).toBeInTheDocument()",
  },
  {
    name: 'Store/Redux state testing',
    pattern: /getState\s*\(\s*\)\s*\.\w+/,
    message: 'Avoid testing store state directly. Test UI that reflects state.',
    suggestion: 'Verify the UI shows the expected content',
    badExample: 'expect(store.getState().user.isLoggedIn).toBe(true)',
    goodExample: "expect(screen.getByText('Welcome back!')).toBeInTheDocument()",
  },
  {
    name: 'Excessive getByTestId usage',
    pattern: /getByTestId\s*\(/,
    message: 'Prefer semantic queries over getByTestId. TestIds test implementation, not user experience.',
    suggestion: 'Use getByRole(), getByLabelText(), or getByText() instead',
    badExample: "screen.getByTestId('submit-btn')",
    goodExample: "screen.getByRole('button', { name: 'Submit' })",
  },
  {
    name: 'fireEvent usage (prefer userEvent)',
    pattern: /fireEvent\.\w+\s*\(/,
    message: 'Prefer userEvent over fireEvent for more realistic user interactions.',
    suggestion: 'Use userEvent.click(), userEvent.type(), etc.',
    badExample: 'fireEvent.click(button)',
    goodExample: 'await user.click(button)',
  },
  {
    name: 'Testing source code strings',
    pattern: /readFileSync.*\.toContain\s*\(/,
    message: 'Avoid reading source files and asserting on their contents.',
    suggestion: 'Test the actual behavior by running the code',
    badExample: "expect(fs.readFileSync(file)).toContain('function')",
    goodExample: 'Run the code and verify its output/effects',
  },
  {
    name: 'Testing snapshot of implementation',
    pattern: /\.toMatchInlineSnapshot\s*\(\s*`[^`]*className/,
    message: 'Avoid snapshots that capture CSS classes or implementation details.',
    suggestion: 'Use snapshots for stable content, not styling',
    badExample: 'expect(element).toMatchInlineSnapshot(`<div class="...">`)',
    goodExample: 'Test specific visible content instead of snapshots',
  },
];

// Test file patterns that shouldn't exist
const forbiddenFilePatterns = [
  {
    pattern: /constants\.test\.(ts|tsx|js|jsx)$/,
    message: 'constants.test.* files should not exist - constants have no behavior to test',
  },
  {
    pattern: /types\.test\.(ts|tsx|js|jsx)$/,
    message: 'types.test.* files should not exist - TypeScript compiler validates types',
  },
];

/**
 * Recursively find all test files
 */
function findTestFiles(dir, files = []) {
  if (!fs.existsSync(dir)) {
    return files;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      findTestFiles(fullPath, files);
    } else if (entry.isFile() && /\.test\.(ts|tsx|js|jsx)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }

  return files;
}

function checkFile(filePath, testDir) {
  const issues = [];
  const relativePath = path.relative(testDir, filePath);
  const fileName = path.basename(filePath);

  // Check for forbidden file patterns
  for (const forbidden of forbiddenFilePatterns) {
    if (forbidden.pattern.test(fileName)) {
      issues.push({
        file: relativePath,
        line: 0,
        pattern: 'Forbidden file',
        message: forbidden.message,
        suggestion: 'Delete this file and test the functionality through integration tests',
      });
    }
  }

  // Check file contents for anti-patterns
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  lines.forEach((line, index) => {
    // Skip lines with ignore comment
    if (line.includes('test-quality-ignore')) {
      return;
    }

    for (const antiPattern of antiPatterns) {
      if (antiPattern.pattern.test(line)) {
        issues.push({
          file: relativePath,
          line: index + 1,
          pattern: antiPattern.name,
          message: antiPattern.message,
          suggestion: antiPattern.suggestion,
          badExample: antiPattern.badExample,
          goodExample: antiPattern.goodExample,
        });
      }
    }
  });

  return issues;
}

function main() {
  // Find the web directory (script runs from project root or web directory)
  let baseDir = process.cwd();

  // Check if we're in the web directory or project root
  let testDir = path.join(baseDir, 'src', '__tests__');
  if (!fs.existsSync(testDir)) {
    testDir = path.join(baseDir, 'web', 'src', '__tests__');
  }

  if (!fs.existsSync(testDir)) {
    console.log('No test directory found.');
    console.log('Checked:', path.join(baseDir, 'src', '__tests__'));
    console.log('Checked:', path.join(baseDir, 'web', 'src', '__tests__'));
    console.log('✅ No test quality issues found (no tests to check)');
    process.exit(0);
  }

  const testFiles = findTestFiles(testDir);

  if (testFiles.length === 0) {
    console.log('No test files found in', testDir);
    console.log('✅ No test quality issues found!');
    process.exit(0);
  }

  console.log(`Scanning ${testFiles.length} test files for quality issues...\n`);

  let allIssues = [];

  for (const filePath of testFiles) {
    const relativePath = path.relative(testDir, filePath);

    // Skip ignored files
    if (ignoredFiles.some((ignored) => relativePath.includes(ignored))) {
      continue;
    }

    const issues = checkFile(filePath, testDir);
    allIssues = allIssues.concat(issues);
  }

  if (allIssues.length === 0) {
    console.log('✅ No test quality issues found!');
    process.exit(0);
  }

  console.log(`❌ Found ${allIssues.length} test quality issue(s):\n`);

  // Group by file
  const byFile = {};
  for (const issue of allIssues) {
    if (!byFile[issue.file]) {
      byFile[issue.file] = [];
    }
    byFile[issue.file].push(issue);
  }

  for (const [file, issues] of Object.entries(byFile)) {
    console.log(`📄 ${file}`);
    for (const issue of issues) {
      const lineInfo = issue.line > 0 ? `:${issue.line}` : '';
      console.log(`   Line${lineInfo}: ${issue.pattern}`);
      console.log(`   ├─ ${issue.message}`);
      console.log(`   ├─ 💡 ${issue.suggestion}`);
      if (issue.badExample && issue.goodExample) {
        console.log(`   ├─ ❌ Instead of: ${issue.badExample}`);
        console.log(`   └─ ✅ Try:        ${issue.goodExample}`);
      } else {
        console.log(`   └─ ${issue.suggestion}`);
      }
      console.log('');
    }
  }

  console.log('─'.repeat(70));
  console.log('');
  console.log('These patterns indicate tests that verify implementation details');
  console.log('rather than user-observable behavior.');
  console.log('');
  console.log('🤖 QUICK FIX: Copy and paste this prompt to Claude:');
  console.log('');
  console.log('Please fix the test quality issues found by npm run test:quality. Rewrite the flagged tests to verify user-observable behavior instead of implementation details.');
  console.log('');
  console.log('─'.repeat(70));
  console.log('');
  console.log('Other options:');
  console.log('  • Add "// test-quality-ignore" comment to skip a specific line');
  console.log('  • See CLAUDE.md "Acceptance Test Quality Checklist" for guidelines');
  console.log('');

  process.exit(1);
}

main();
