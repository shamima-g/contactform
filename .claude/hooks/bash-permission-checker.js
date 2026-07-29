#!/usr/bin/env node
/**
 * PreToolUse hook that auto-approves safe Bash commands for Claude Code.
 *
 * Receives tool call JSON via stdin, checks against deny/allow patterns,
 * and outputs permission decision JSON.
 *
 * Exit codes:
 * - 0 with JSON output: Command approved
 * - 0 without output: Falls through to normal permission system
 * - 2: Block the command
 *
 * Location: .claude/hooks/bash-permission-checker.js
 * Ported from: .claude/hooks/bash-permission-checker.ps1
 */
'use strict';

const fs = require('fs');
const path = require('path');

// =============================================================================
// READ STDIN
// =============================================================================
let inputJson;
try {
  const raw = fs.readFileSync(0, 'utf8'); // fd 0 = stdin
  inputJson = JSON.parse(raw);
} catch {
  process.exit(0);
}

if (inputJson.tool_name !== 'Bash') process.exit(0);

let command = inputJson.tool_input?.command;
if (!command) process.exit(0);

// =============================================================================
// HELPERS
// =============================================================================

function writeAllowAndExit(reason) {
  const output = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: reason,
    },
  });
  process.stdout.write(output);
  process.exit(0);
}

function denyAndExit(msg) {
  process.stderr.write(msg + '\n');
  process.exit(2);
}

// =============================================================================
// NORMALIZATION - strip harmless trailing suffixes (redirects, &, |)
// =============================================================================

const trailingSuffixPatterns = [
  /\s+2>(?:&1|\/dev\/null)\s*$/,
  /\s+>\s*\/dev\/null\s*$/,
  /\s+2?>\s*\/tmp\/[\w.-]+\s*$/,
  /\s+&>\s*\/tmp\/[\w.-]+\s*$/,
  // PowerShell stream redirects to $null (the shell is PowerShell on Windows):
  // `2>$null`, `>$null`, `1>$null`, `*>$null`. `$null` is case-insensitive in PowerShell.
  /\s+(?:\*|\d)?>\s*\$null\s*$/i,
  /\s+&\s*$/,
  /\s+\|\s*$/,
];

function stripTrailingSuffix(cmd) {
  let prev;
  do {
    prev = cmd;
    for (const re of trailingSuffixPatterns) {
      cmd = cmd.replace(re, '').trim();
    }
  } while (cmd !== prev);
  return cmd;
}

/** Collapse bash line continuations (backslash-newline) into a single space */
function collapseLineContinuations(cmd) {
  return cmd.replace(/\\\n\s*/g, ' ');
}

command = collapseLineContinuations(command);
command = stripTrailingSuffix(command);

// =============================================================================
// COMPOUND COMMAND SPLITTER
// =============================================================================

function splitCompoundCommand(text) {
  const commands = [];
  let current = '';
  let i = 0;
  const len = text.length;
  let state = 'NORMAL';
  let heredocDelimiter = null;
  let parenDepth = 0;

  while (i < len) {
    const c = text[i];

    if (state === 'SINGLE_QUOTE') {
      current += c;
      if (c === "'") state = 'NORMAL';
      i++;
      continue;
    }

    if (state === 'DOUBLE_QUOTE') {
      current += c;
      if (c === '\\' && i + 1 < len && text[i + 1] === '"') {
        current += text[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') state = 'NORMAL';
      i++;
      continue;
    }

    if (state === 'HEREDOC') {
      current += c;
      if (c === '\n') {
        let lineEnd = text.indexOf('\n', i + 1);
        if (lineEnd === -1) lineEnd = len;
        const line = text.substring(i + 1, lineEnd).trim();
        if (line === heredocDelimiter) {
          current += text.substring(i + 1, lineEnd);
          i = lineEnd;
          state = 'NORMAL';
          heredocDelimiter = null;
          continue;
        }
      }
      i++;
      continue;
    }

    // state === 'NORMAL'
    if (c === "'" && parenDepth === 0) {
      current += c;
      state = 'SINGLE_QUOTE';
      i++;
      continue;
    }
    if (c === '"' && parenDepth === 0) {
      current += c;
      state = 'DOUBLE_QUOTE';
      i++;
      continue;
    }

    if (c === '(') {
      parenDepth++;
      current += c;
      i++;
      continue;
    }
    if (c === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      current += c;
      i++;
      continue;
    }

    if (parenDepth > 0) {
      current += c;
      i++;
      continue;
    }

    // Heredoc detection: << [-] ['"]DELIM['"]
    if (c === '<' && i + 1 < len && text[i + 1] === '<') {
      current += '<<';
      i += 2;
      while (i < len && (text[i] === '-' || /\s/.test(text[i])) && text[i] !== '\n') {
        current += text[i];
        i++;
      }
      let quoteChar = null;
      if (i < len && (text[i] === "'" || text[i] === '"')) {
        quoteChar = text[i];
        current += text[i];
        i++;
      }
      const delimStart = i;
      while (i < len && /\w/.test(text[i])) {
        current += text[i];
        i++;
      }
      heredocDelimiter = text.substring(delimStart, i);
      if (quoteChar && i < len && text[i] === quoteChar) {
        current += text[i];
        i++;
      }
      if (heredocDelimiter.length > 0) state = 'HEREDOC';
      continue;
    }

    // Split on &&
    if (c === '&' && i + 1 < len && text[i + 1] === '&') {
      const trimmed = current.trim();
      if (trimmed) commands.push(trimmed);
      current = '';
      i += 2;
      continue;
    }

    // Split on || (but NOT single |)
    if (c === '|' && i + 1 < len && text[i + 1] === '|') {
      const trimmed = current.trim();
      if (trimmed) commands.push(trimmed);
      current = '';
      i += 2;
      continue;
    }

    // Split on ;
    if (c === ';') {
      const trimmed = current.trim();
      if (trimmed) commands.push(trimmed);
      current = '';
      i++;
      continue;
    }

    // Split on newline
    if (c === '\n') {
      const trimmed = current.trim();
      if (trimmed) commands.push(trimmed);
      current = '';
      i++;
      continue;
    }

    // Single pipe is NOT a split point
    current += c;
    i++;
  }

  const trimmed = current.trim();
  if (trimmed) commands.push(trimmed);

  if (state !== 'NORMAL' || parenDepth !== 0) return null;
  if (commands.length <= 1) return null;
  return commands;
}

// =============================================================================
// PIPELINE SPLITTER
// =============================================================================

function splitPipeline(text) {
  if (text.indexOf('|') === -1) return null;

  const segments = [];
  let current = '';
  let i = 0;
  const len = text.length;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  while (i < len) {
    const c = text[i];

    if (inSingleQuote) {
      current += c;
      if (c === "'") inSingleQuote = false;
      i++;
      continue;
    }

    if (inDoubleQuote) {
      current += c;
      if (c === '\\' && i + 1 < len && text[i + 1] === '"') {
        current += text[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') inDoubleQuote = false;
      i++;
      continue;
    }

    if (c === "'") {
      current += c;
      inSingleQuote = true;
      i++;
      continue;
    }

    if (c === '"') {
      current += c;
      inDoubleQuote = true;
      i++;
      continue;
    }

    // || is NOT a pipe split
    if (c === '|' && i + 1 < len && text[i + 1] === '|') {
      current += '||';
      i += 2;
      continue;
    }

    // Single | is a split point
    if (c === '|') {
      const trimmed = current.trim();
      if (trimmed) segments.push(trimmed);
      current = '';
      i++;
      continue;
    }

    current += c;
    i++;
  }

  const trimmed = current.trim();
  if (trimmed) segments.push(trimmed);

  if (inSingleQuote || inDoubleQuote) return null;
  if (segments.length <= 1) return null;
  return segments;
}

// =============================================================================
// PREFERENCES
// =============================================================================

function getPreferences() {
  try {
    const configPath = path.join(__dirname, '..', 'preferences.json');
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return null;
  }
}

const prefs = getPreferences();

// =============================================================================
// DENY PATTERNS
// =============================================================================

const fileReadCmdsBase = 'cat|type|Get-Content|more|less|head|tail|sed|awk';
const fileReadCmds = '(' + fileReadCmdsBase + ')';
// safeDirs (narrow) — used for deny-bypass in isSafeDirCommand and for write-adjacent ops (mkdir, PowerShell, start "").
// Do NOT add `src` here: would let `cat src/id_rsa`-style commands bypass the secret-file deny patterns.
const safeDirs = '(documentation|web|generated-docs|\\.claude|\\.github|\\.next)';  // .next = Next.js build output (read-only, regenerable)
// safeDirsRead (broader) — used for pure-read allow patterns (cat/type/head/tail/sed/grep/wc/diff/ls/cp-source).
// Adds `src` with a boundary lookbehind so `my-src/`, `mysrc/`, `_src/` do NOT match — only paths where `src` is
// a top-level dir or immediately follows `/`, `\`, `"`, `'`. Because `src` is NOT in safeDirs (the bypass variable),
// reads of `src/id_rsa`, `src/.env`, etc. are still caught by the secret deny patterns below.
// Also includes the regenerable build/test artifact dirs (.next/test-results/playwright-report/coverage) so agents
// can read debug output (error-context snapshots, reports, coverage). These are read-only here — NOT in safeDirs —
// so secret-named files inside them (e.g. test-results/credentials.md) are still caught by the deny patterns.
// Shared list of REGENERABLE build/test artifact dir names. Referenced by both
// safeDirsRead (read-allow, below) and regenArtifacts (rm -rf allow, further down) so
// the two can never drift — add a new artifact dir here and both rules pick it up.
// NB: entries here ALSO become read-safe via safeDirsRead — only add dirs safe to both
// read AND rm. node_modules caches are rm-only; keep them inline in regenArtifacts.
const regenArtifactDirs = '\\.next|test-results|playwright-report|coverage';
const safeDirsRead = '(documentation|web|generated-docs|\\.claude|\\.github|' + regenArtifactDirs + '|(?:(?<=^|[\\s"\'/\\\\])src))';
const safeDirsWrite = '(web|\\.claude[/\\\\](?:context|scripts)|generated-docs)';
const absPathChar = '[\\w./:~\\\\()\\[\\]-]';  // single path char (absolute paths: includes colon, tilde, brackets for Next.js dynamic routes)
// Quoted-context path char: same as absPathChar plus space. Use ONLY inside "..."/'...' alternatives
// where the surrounding quotes guarantee the value is one shell token. Excludes shell metachars
// ($, `, ") so command substitution / quote-escapes inside a quoted path still fall through.
const absPathCharQ = '[\\w./:~\\\\()\\[\\] -]';
// Single path token: bare (no spaces), double-quoted (spaces ok), or single-quoted (spaces ok).
// Use anywhere a single path argument may appear quoted-or-bare. Shell metachars rejected via absPathCharQ.
const pathTok = '(?:"' + absPathCharQ + '+"|\'' + absPathCharQ + '+\'|' + absPathChar + '+)';
// Worktree dir (forward-slash paths, e.g. ../tmp, ../proj-planning). First char is NOT a dash,
// so a flag like `--force` can't pose as the path and slip through the worktree allow-rules.
const wtPath = '[\\w./~][\\w./@{}~-]*';
// Git ref / remote-name token, non-dash-leading (first char `[\w./]`). Shared by all the push
// allow-rules below so the "a `--flag` can't be swallowed as a ref" invariant lives in ONE place —
// broadening it in one rule but not the others would silently re-open flag-injection.
const refTok = '[\\w./][\\w./-]*';
const gitGlobalOpts = '(?:(?:-C\\s+' + pathTok + '|--(?:work-tree|git-dir)=' + pathTok + '|--no-pager)\\s+)*';
const gitCmd = 'git\\s+' + gitGlobalOpts;  // "git " + optional global options
// One chain-safe git argument: a quoted string, or a run of chars that EXCLUDES the shell
// operators enabling command chaining / substitution / redirection (`; & | ` + '`' + ` $ < > ( )` and
// quotes). Bare and quoted runs glue into one token, so `--author="Jane Doe"` and
// `--pretty=format:"%h %s"` still match as a single argument.
// NB: the bare branch is a SINGLE char `[^...]`, NOT `[^...]+`, with the repetition carried only by
// the outer `+`. Writing it as `(?:...|[^...]+)+` is a `(x+)+` nested quantifier that backtracks
// CATASTROPHICALLY (ReDoS): when the overall pattern fails — e.g. `git add a b c && git commit ...`,
// where `add(?:\s+gitArgToken)+\s*$` can't reach `$` because of the trailing `&&` — the engine
// re-partitions every bare arg exponentially. With multiple file-path args the hook blew past its
// 10s timeout, so Claude Code fell through to a manual permission prompt. Single-char bare branch =
// one deterministic match per position = linear. See tmp scaling test in git history if reviving.
const gitArgToken = '(?:"[^"]*"|\'[^\']*\'|[^\\s;&|`$<>()\'"])+';
// Zero-or-more git args. Used by the read-only git allow-patterns below INSTEAD of a `.*` catch-all:
// a `.*`/`.+` tail lets a chained command (`git log && rm -rf web/src`, `git rev-parse HEAD ; curl evil`)
// match the WHOLE command and be auto-approved at the anchored-allow loop BEFORE the compound/pipeline
// splitters run. With this bounded list, a shell operator breaks the match so the command falls through
// to per-segment vetting (which prompts on the dangerous half). Benign `2>&1`/`2>/dev/null` redirects
// are still stripped beforehand, and `git add . && git status` still allows via compound splitting.
const gitSafeArgs = '(?:\\s+' + gitArgToken + ')*';
// gitSafeArgs reused for the non-git exec allow-patterns (npm/npx/node/devtools/ls/…) — same
// bounded, operator-free arg list, so a chained command can't ride a `.*` tail (see above).
const execSafeArgs = gitSafeArgs;
// One-or-more bounded args — for a REQUIRED message/prompt (`git commit -m …`, `claude -p …`).
// A quoted message (the normal form, including multi-line) is allowed via gitArgToken's quoted
// branch; a bare `;`/`&&`/`|` still breaks the match, so `git commit -m x ; rm -rf /` falls
// through to per-segment vetting instead of auto-approving whole (the same chained-command
// bypass execSafeArgs closes, which an unbounded `[\s\S]+$` tail here would otherwise re-open).
const execMsgArgs = '(?:\\s+' + gitArgToken + ')+';

const denyPatterns = [
  'rm\\s+-rf\\s+/',
  fileReadCmds + '.*id_rsa',
  fileReadCmds + '.*\\.pem\\b',
  fileReadCmds + '.*credentials',
  fileReadCmds + '.*[/\\\\]\\.ssh[/\\\\]',
  fileReadCmds + '.*private.*key',
  fileReadCmds + '.*secret',
  // Force / destructive pushes. `[^;&|]*` (not `.*`) bounds each match to the push command's own
  // args so it can't run across a `;` / `&&` / `|` into a following segment (e.g. a benign
  // `&& echo "1 + 2"`) and hard-deny a safe push — the deny loop tests the whole unsplit command
  // before it is segmented, and a real force/destructive push never contains a shell operator
  // between `push` and its flag/refspec.
  // Bare --force / --force= only. The negative lookahead releases --force-with-lease (a safe
  // rebase-push that refuses if the remote moved unexpectedly), which is allow-listed — scoped to
  // epic/* branches — further down. -f (short --force) is caught by the standalone-flag rule below.
  gitCmd + 'push\\s+[^;&|]*--force(?![-\\w])',
  // Standalone `-f` flag only: whitespace before, whitespace-or-end after. A branch name that ends
  // in `-f` (e.g. `epic/report-f`) has `-f` preceded by a word char, so it is NOT matched here — that
  // legitimate push falls through to the push allow-list instead of being hard-blocked.
  gitCmd + 'push\\s+[^;&|]*(?<=\\s)-f(?=\\s|$)',
  // A `+`-prefixed refspec (`git push origin +src:dst`, or a bare `+branch`) is a FORCE push — deny
  // it exactly like --force/-f. `\s\+` matches an arg that STARTS with `+`; a `+` inside a name like
  // `feature+x` is preceded by a word char, so it never matches.
  gitCmd + 'push\\s+[^;&|]*\\s\\+',
  gitCmd + 'push\\s+[^;&|]*--delete',
  gitCmd + 'push\\s+[^;&|]*--no-verify',
  gitCmd + 'commit\\s+.*--no-verify',
  gitCmd + 'commit\\s+.*--amend',
  // Only --hard and --keep can overwrite uncommitted working-tree changes.
  // --soft / --mixed / `git reset HEAD <paths>` are recoverable (only move index/HEAD).
  gitCmd + 'reset\\s+.*--hard\\b',
  gitCmd + 'reset\\s+.*--keep\\b',
].map(p => new RegExp(p, 'i'));

// Safe-directory file path pattern
const fileReadCmdsExt = '(' + fileReadCmdsBase + '|wc|diff)';
const cdPrefix = '(?:cd\\s+' + pathTok + '\\s*&&\\s*)?';
const safeDirFilePattern = new RegExp(
  '^\\s*' + cdPrefix + fileReadCmdsExt + '\\s+(?:[-+]?[\\w-]+\\s+)*["\']?' + absPathChar + '*' + safeDirs + '[/\\\\]',
  'i'
);

function isSafeDirCommand(cmd) {
  return safeDirFilePattern.test(cmd);
}

// Hoist once
const commandIsSafeDir = isSafeDirCommand(command);

for (const pattern of denyPatterns) {
  if (pattern.test(command)) {
    if (commandIsSafeDir) continue;
    denyAndExit('Blocked by security policy: Command matches deny pattern');
  }
}

// =============================================================================
// ALWAYS-DENY PATTERNS — not subject to safe-dir bypass
// =============================================================================
// These protect against reading credential-like files even inside safe dirs,
// and cover grep (which the deny-bypass intentionally excludes for broader `.*secret`
// patterns — quoting "secret" as a grep search term is a legitimate use case).
// Secret-token boundary (lookahead, non-consuming): the credential-like leaf ends here —
// followed by whitespace (another argument), end-of-string, pipeline `|`, or compound `&`/`;`.
// The whitespace case catches a secret in a NON-final argument position (e.g.
// `cat web/.env web/a.ts`). Used for GREP, whose first arg may be a QUOTED SEARCH TERM
// (`grep "private_key" file`) — consuming a closing quote here would wrongly read the term
// as a file, so grep keeps the non-quote boundary.
const segEnd = '(?=$|\\s|[|&;])';
// Same boundary but also consuming an optional CLOSING quote. Used for content-dumping READ
// commands (cat/head/…), whose argument is always a file path — this closes the
// `cat "web/.env"` / `cat 'web/.env'` bypass where a trailing quote broke the plain boundary
// so the read auto-approved.
const readSegEnd = '["\']?' + segEnd;
// File leaf beginning with `.env` — require `.env` at a path boundary (after `/`, `\`, or start of file arg)
// to avoid false positives on files like `web/src/config.env.ts`.
const dotEnvLeaf = '(?:\\S*[/\\\\])?\\.env(?:\\.\\w+)?';
// Credential-like file-path leaves. A read of any of these is denied even inside a safe dir
// and even when it rides alongside a benign file in a multi-arg command — closing the gap
// where `cat web/a.ts web/credentials.json` (or `wc web/a.ts web/id_rsa`) auto-approved
// because the per-command deny patterns are skipped for safe-dir commands.
const secretPathLeaves = [
  '\\S*[/\\\\]id_rsa(?:\\.\\w+)?',
  '\\S*\\.pem',
  '\\S*[/\\\\]\\.ssh[/\\\\]\\S*',
  // `credentials` counts as a file when it is path-qualified (`secrets/credentials`)
  // OR carries a file extension (`credentials.json`). A bare `credentials` with neither
  // stays a legitimate search/grep term and is intentionally NOT matched.
  '(?:\\S*[/\\\\]credentials(?:\\.\\w+)?|\\S*credentials\\.\\w+)',
  '\\S*private[_-]?key(?:\\.\\w+)?',
  dotEnvLeaf,
];
// `<cmd>\b[^|;&]*\s+<leaf><boundary>` — the `[^|;&]*` stays within one command segment and the
// trailing `\s+<leaf>` matches the credential file in ANY argument position.
const denyReadOfSecret = (cmds, boundary) =>
  secretPathLeaves.map((leaf) => cmds + '\\b[^|;&]*\\s+' + leaf + boundary);
const alwaysDenyPatterns = [
  // Content-dumping reads (cat/type/Get-Content/more/less/head/tail/sed/awk/wc/diff) of any
  // credential file, in any arg position — not subject to the safe-dir bypass. Uses the
  // quote-consuming boundary so `cat "web/.env"` is caught (a read arg is always a file).
  // NOTE: the generic `secret` substring is intentionally NOT blocked here — a safe-dir file
  // that merely contains the word "secret" (e.g. `secret-santa.ts`) is treated as innocent,
  // matching the existing safe-dir allowance; only the unambiguous credential file types above
  // are hard-denied.
  ...denyReadOfSecret(fileReadCmdsExt, readSegEnd),
  // Grep reading obvious secret file PATHS. Uses the plain (non-quote) boundary so grepping
  // FOR a quoted term (`grep "private_key" file`) stays allowed — that token is a search
  // term, not a file. (No bare-`secret` entry for the same reason.)
  ...denyReadOfSecret('grep', segEnd),
].map(p => new RegExp(p, 'i'));

for (const pattern of alwaysDenyPatterns) {
  if (pattern.test(command)) {
    denyAndExit('Blocked by security policy: Command attempts to read a credential-like file');
  }
}

// =============================================================================
// ALLOW PATTERNS
// =============================================================================

const winPath = '["\']?' + absPathChar + '*';
// Same as winPath but tolerates SPACES when (and only when) the path is quoted — covers a
// workspace under e.g. "C:\...\test samples\...". Either a quoted run (opening quote consumed
// here, spaces allowed; the matching close is the trailing ["']? after the leaf) OR a bare run
// (no spaces, as before). Use where a path arg may be a quoted absolute path with spaces.
const winPathSp = '(?:["\'][\\w./:~\\\\ ()\\[\\]-]*|' + absPathChar + '*)';
// Shared subpath char class. Brackets `[]` are included for Next.js dynamic-route dirs (`[id]`, `[...slug]`).
// `-` is appended last in each composed class so it stays literal (avoids accidental range with `]`).
const subPathCore = '\\w./\\\\()\\[\\]';
const subPath = '[' + subPathCore + '-]';
const subPathW = '(?:(?!\\.\\.[/\\\\])[' + subPathCore + '-])';  // write-safe: no path traversal
const subPathQ = '[' + subPathCore + ' -]';                       // subpath chars including space
// Read-safe variants: same per-char `(?!\.\.[/\\])` traversal guard as subPathW so a safe-dir
// read/grep arg cannot be walked back out of the safe dir (`cat web/../../etc/passwd`,
// `grep -r foo web/../../etc/passwd`). Without the guard the `.`/`/` in subPathCore let `../`
// through and the read auto-approves a file outside the safe dirs.
const subPathE = '(?:(?!\\.\\.[/\\\\])(?:[' + subPathCore + '-]|\\\\ ))';   // subpath chars including backslash-escaped space
const subPathEG = '(?:(?!\\.\\.[/\\\\])(?:[' + subPathCore + '*?-]|\\\\ ))'; // subPathE + glob chars (* ?) for grep path args like `web/*.ts`
// A single safe-dir file argument (bare, no spaces). Reused so cat/head/tail/wc can each
// accept one-or-more file args via `(?:\s+safeReadFile)+` — mirrors grep's multi-path support.
// No glob chars here on purpose: content-dumping commands must not match dotfile globs
// (e.g. `cat web/.env*`) that would slip past the .env always-deny rule.
const safeReadFile = winPath + safeDirsRead + '[/\\\\]' + subPathE + '+["\']?';
const npmPrefix = '(?:--prefix\\s+' + pathTok + '\\s+)?';
const envPrefix = '(?:[A-Z_][A-Z0-9_]*=["\']?[\\w./:~= -]+["\']?\\s+)*';  // optional VAR=value prefixes (with optional quotes)
const cdEnvPrefix = cdPrefix + envPrefix;
// Single source of truth for dev-tool names allowed via npm exec / npx / node_modules/.bin.
// Keep this list in sync; the three patterns below all reference it.
const devTools = 'tsc|vitest|next|eslint|msw|playwright|prettier|shadcn';
// Curated allowlist of REGENERABLE build/test artifact dirs that are safe to `rm -rf`
// (no source/data loss — each is rebuilt on the next build/test run). Used by the
// tightly-anchored destructive-rm allow below. Shares the read+rm-safe dir list with
// safeDirsRead via regenArtifactDirs; adds the regenerable `node_modules` build/test
// caches `.cache` / `.vite` / `.vitest` inline (rm-target only — never bare `node_modules`,
// whose recovery `npm install` is itself not auto-approved). These caches stay OUT of
// regenArtifactDirs deliberately: that list is dual-use (also feeds safeDirsRead's
// read-allow) and node_modules caches must be rm-able but NOT read-safe. To add a new
// read+rm artifact dir, edit regenArtifactDirs; to add a node_modules cache, extend the
// inline alternation here.
const regenArtifacts = '(?:' + regenArtifactDirs + '|node_modules[/\\\\]\\.(?:cache|vite|vitest))';
// A single safe `rm -rf` target: `[./][web/]<artifact>[/<subpath>]`. The optional subpath
// uses subPathW (write-safe — its `(?!\.\.[/\\])` guard blocks `../` traversal), so anything
// strictly INSIDE a regenerable artifact dir is allowed while `.next/../src` is not.
const rmTarget = '["\']?(?:\\.[/\\\\])?(?:web[/\\\\])?' + regenArtifacts + '(?:[/\\\\]' + subPathW + '*)?["\']?';
// Well-known, non-secret root manifest files agents read by bare name (e.g. after `cd web`).
// Read-only allow only. Excludes `.npmrc` (can hold registry auth tokens).
const rootManifests = '(?:package|package-lock|tsconfig(?:\\.[\\w-]+)?|jsconfig|components)\\.json';
// A BARE manifest leaf (e.g. `package.json`, `tsconfig.build.json`) — no path prefix.
// Shared by the cat/type/head|tail manifest-read patterns below so they stay in sync.
// Deliberately NOT path-prefixed: an arbitrary `(?:absPathChar*[/\\])?` prefix auto-approves
// `cat ../../../etc/package.json` / `cat /etc/package.json` (no safe-dir anchor, no ../ guard).
// Safe-dir-prefixed manifests (`cat web/package.json`) are already covered by the general
// safe-read patterns (safeReadFile), so this leaf-only form loses no legitimate read.
const manifestArg = '["\']?' + rootManifests + '["\']?';
const grepFlags = '(?:\\s+-[\\w]+(?:\\s+\\d+)?)*';  // grep flags with optional numeric arg (e.g. -A 3, -C 2)
// Search term for grep / xargs grep: double-quoted (may contain '), single-quoted
// (may contain "), or a bare token. One constant so every grep allow-pattern stays in lockstep.
const grepTerm = '(?:"[^"]*"|\'[^\']*\'|\\S+)';

// curl flag value: double-quoted (allows ${VAR}/$VAR, blocks $(...), backticks, and `@`),
// single-quoted (literal, no `@`), or bare token (no shell metachars, no `@`).
// `@` is curl's read-from-file sigil (`-d @f`, `-F field=@f`): excluding it everywhere stops
// an auto-approved localhost curl from reading a local file into the request body and POSTing
// it out (file exfiltration). The file-path flags `-T`/`--upload-file` (bare-path upload) and
// `-o`/`--output` (response write) are constrained by curlFlag below, not here.
// Bare token must not start with `-` — otherwise `-X` is ambiguously parsable as either
// the previous flag's value or the next flag, causing catastrophic backtracking on
// failing matches with many flag-shaped tokens.
const curlValue =
  '(?:' +
    '"(?:[^"$`\\\\@]|\\\\.|\\$\\{[A-Za-z_][A-Za-z0-9_]*\\}|\\$[A-Za-z_][A-Za-z0-9_]*)*"' +
    '|' +
    "'[^'@]*'" +
    '|' +
    '[\\w./%{}=:,+~][\\w./%{}=:,+~-]*' +
  ')';
// curl output sink: a throwaway target only (`/dev/null` or `/tmp/…`). Pins `-o`/`--output`
// so an auto-approved localhost curl can't write the response to an arbitrary path
// (`-o /etc/cron.d/x`). Raw `curl -o <real-path>` is not a connectivity probe — the smoke
// test goes through run-smoke-test.js, which is auto-approved as a node script.
// The `/tmp/` branch carries the same per-char `(?!\.\.[/\\])` guard as subPathW so the sink
// cannot be walked back out via traversal (`-o /tmp/../../etc/cron.d/x`).
const curlSink = '["\']?(?:/dev/null|/tmp/(?:(?!\\.\\.[/\\\\])[\\w./-])+)["\']?';
// curl flags are an ALLOWLIST, not a denylist of dangerous ones — denylisting is whack-a-mole:
// curl has many flags that read/write files or proxy the request: -K/--config (reads a config
// file that can itself set output=/url=/-d @file), -D/--dump-header, -c/--cookie-jar, --trace*,
// --stderr (write a file), -E/--cert, -b/--cookie, --cacert, --key (read a file), -x/--proxy
// (route through an arbitrary proxy that sees auth headers), -F/--form, -T/--upload-file, -O.
// Anything not listed below falls THROUGH to a normal permission prompt.
//
// Unlike every other allow-pattern, the curl pattern is compiled CASE-SENSITIVELY (see
// anchoredAllowPatterns / curlAllowPattern) precisely because curl's SHORT flags collide
// across case with dangerous ones: -o/-O (--remote-name CWD write), -d/-D, -e/-E, -f/-F,
// -k/-K, -X/-x. Case-sensitive matching means `-o` is only `-o` and `-O` simply falls
// through. The short classes below still spell out both cases where both are safe
// (-s/-S, -i/-I, -v/-V); data / method / referer / insecure / fail are offered as their
// long forms only (curl rejects upper-cased long options, so there is no dangerous twin).
const curlNoValueFlag =
  '(?:-[sSiIvVLg#]+' +
    '|--(?:silent|show-error|include|head|verbose|fail|location|insecure|globoff|compressed' +
        '|progress-bar|http1\\.0|http1\\.1|http2|tcp-nodelay|no-keepalive))';
// Value-taking flags whose value must NOT be a file (curlValue already excludes `@`) and must
// not be a second URL (the `(?!https?://)` keeps `--url http://evil` / a trailing host from
// matching here — the request URL is pinned to localhost by the curl pattern below).
const curlValueFlag =
  '(?:-[Hwm]' +
    '|--(?:request|header|user-agent|referer|write-out|data|data-raw|data-binary|data-ascii' +
        '|data-urlencode|connect-timeout|max-time|retry))' +
  '\\s+(?!https?://)' + curlValue;
// `-o`/`--output` pinned to a throwaway sink so it can't write the response to an arbitrary path.
const curlOutputFlag = '(?:-o|--output)\\s+' + curlSink;
const curlFlag = '\\s+(?:' + curlOutputFlag + '|' + curlValueFlag + '|' + curlNoValueFlag + ')';
// The full curl allow-pattern. Held in its own const so anchoredAllowPatterns can compile it
// CASE-SENSITIVELY (every other pattern stays case-insensitive); see the flag comment above.
const curlAllowPattern =
  cdPrefix +
  'curl(?:' + curlFlag + ')*\\s+["\']?https?://(?:localhost|127\\.0\\.0\\.1)(?::\\d+)?(?:/[\\w./?&=%+-]*)?["\']?\\s*$';

let allowPatterns = [
  // --- NPM ---
  cdEnvPrefix + 'npm\\s+' + npmPrefix + 'ci(?:\\s+--[\\w-]+)*\\s*$',
  cdEnvPrefix + 'npm\\s+' + npmPrefix + 'install(?:\\s+--[\\w-]+)*\\s*$',
  cdEnvPrefix + 'npm\\s+' + npmPrefix + 'i(?:\\s+--[\\w-]+)*\\s*$',
  cdEnvPrefix + 'npm\\s+' + npmPrefix + 'install(?:\\s+--[\\w-]+)*(?:\\s+@types/[\\w-]+)+\\s*$',
  cdEnvPrefix + 'npm\\s+' + npmPrefix + 'i(?:\\s+--[\\w-]+)*(?:\\s+@types/[\\w-]+)+\\s*$',
  cdEnvPrefix + 'npm\\s+' + npmPrefix + 'install(?:\\s+--[\\w-]+)*(?:\\s+@radix-ui/[\\w-]+)+\\s*$',
  cdEnvPrefix + 'npm\\s+' + npmPrefix + 'i(?:\\s+--[\\w-]+)*(?:\\s+@radix-ui/[\\w-]+)+\\s*$',
  cdEnvPrefix + 'npm\\s+' + npmPrefix + 'install(?:\\s+--[\\w-]+)*\\s+msw(?:\\s+--[\\w-]+)*\\s*$',
  cdEnvPrefix + 'npm\\s+' + npmPrefix + 'i(?:\\s+--[\\w-]+)*\\s+msw(?:\\s+--[\\w-]+)*\\s*$',
  cdEnvPrefix + 'npm\\s+' + npmPrefix + 'test' + execSafeArgs + '\\s*$',
  cdEnvPrefix + 'npm\\s+' + npmPrefix + 't' + execSafeArgs + '\\s*$',
  // Colon-segments after a whitelisted base are unbounded (`*`, not `?`): multi-segment
  // scripts such as `test:e2e:install` and `test:e2e:ui` must auto-approve too, not just
  // single-segment `test:e2e`. The FIRST segment stays gated to the safe base list above,
  // so this widens which scripts match without widening the trusted base names.
  cdEnvPrefix + 'npm\\s+' + npmPrefix + 'run\\s+(build|lint|dev|format|test|typecheck|tsc|check|generate)(?::\\w+)*' + execSafeArgs + '\\s*$',
  cdEnvPrefix + 'npm\\s+' + npmPrefix + 'audit' + execSafeArgs + '\\s*$',
  cdEnvPrefix + 'npm\\s+' + npmPrefix + 'exec\\s+(?:--\\s+)?(?:' + devTools + ')' + execSafeArgs + '\\s*$',
  cdPrefix + '(?:test\\s+-d|\\[\\s+-d)\\s+node_modules\\s*\\]?(?:\\s*[&|]+\\s*(?:echo\\s+["\'].*["\']|\\(echo\\s+["\'].*["\']\\)|\\(?npm\\s+install\\)?)\\s*)*$',
  cdPrefix + 'if\\s+exist\\s+["\']?node_modules[/\\\\]?["\']?\\s*(?:\\(.*\\)\\s*)?(?:else\\s*\\(.*\\)\\s*)?$',

  // --- NPX / bare dev tools ---
  cdEnvPrefix + 'npx\\s+' + npmPrefix + '(?:' + devTools.replace('shadcn', 'shadcn(?:@[\\w.]+)?') + ')' + execSafeArgs + '\\s*$',
  cdEnvPrefix + 'node_modules[/\\\\]\\.bin[/\\\\](?:' + devTools + ')' + execSafeArgs + '\\s*$',
  cdEnvPrefix + '(tsc|vitest|eslint|prettier)' + execSafeArgs + '\\s*$',

  // --- Node scripts (safe directories only) ---
  // winPathSp lets the path prefix carry spaces when quoted (workspace under "...\test samples\..."),
  // so an absolute quoted script path auto-approves just like a relative one.
  cdEnvPrefix + 'node\\s+' + winPathSp + '\\.claude[/\\\\]scripts[/\\\\]' + subPathW + '+["\']?' + execSafeArgs + '\\s*$',
  cdEnvPrefix + 'node\\s+' + winPathSp + 'web[/\\\\]' + subPathW + '+["\']?' + execSafeArgs + '\\s*$',
  cdEnvPrefix + 'node\\s+' + winPathSp + 'generated-docs[/\\\\]' + subPathW + '+["\']?' + execSafeArgs + '\\s*$',
  cdEnvPrefix + 'node\\s+' + winPathSp + '\\.github[/\\\\]scripts[/\\\\]' + subPathW + '+["\']?' + execSafeArgs + '\\s*$',

  // --- Directory operations (safe directories) ---
  cdPrefix + 'mkdir\\s+(?:-p\\s+)?(?:' + winPathSp + safeDirsRead + '[/\\\\]?' + subPath + '*["\']?\\s*)+$',

  // --- File reading (safe directories only; uses safeDirsRead → includes `src` with boundary anchor) ---
  cdPrefix + 'sed\\s+-n\\s+.+\\s+' + safeReadFile + '\\s*$',
  cdPrefix + 'cat(?:\\s+' + safeReadFile + ')+\\s*$',
  // Reading inside node_modules is fine; the `(?!.*\.\.[/\\])` guard blocks `../` traversal
  // out of it (e.g. `cat node_modules/../../../etc/passwd.txt`), mirroring subPathW elsewhere.
  cdPrefix + 'cat\\s+node_modules/(?!.*\\.\\.[/\\\\])[\\w@.*/-]+\\.\\w+\\s*$',
  cdPrefix + 'type\\s+' + safeReadFile + '\\s*$',
  // Config files: extension may be a glob (`next.config.*`) to cover the ambiguous
  // .js/.mjs/.ts/.cjs case. Safe — the literal `.config.` anchor can never match a
  // bare dotfile secret like `.env`/`.env.local` (those have no `.config.` segment).
  cdPrefix + 'cat\\s+' + winPath + '[\\w.-]+\\.config\\.[\\w*?]+["\']?\\s*$',
  cdPrefix + 'type\\s+' + winPath + '[\\w.-]+\\.config\\.[\\w*?]+["\']?\\s*$',
  // Well-known root manifest files (see `rootManifests`) — readable bare or path-prefixed,
  // e.g. `cat package.json`. The prefix requires a trailing separator, so the manifest must
  // be a path leaf (`mypackage.json` does NOT match).
  cdPrefix + 'cat\\s+' + manifestArg + '\\s*$',
  cdPrefix + 'type\\s+' + manifestArg + '\\s*$',
  cdPrefix + '(head|tail)(?:\\s+[-+]?[\\w]+)*\\s+' + manifestArg + '\\s*$',
  cdPrefix + 'grep' + grepFlags + '\\s+' + grepTerm + '(?:\\s+' + winPathSp + safeDirsRead + '(?:[/\\\\]' + subPathEG + '*)?["\']?)+\\s*$',
  cdPrefix + '(head|tail)(?:\\s+[-+]?[\\w]+)*(?:\\s+' + safeReadFile + ')+\\s*$',
  cdPrefix + 'wc(?:\\s+-[lwcmL]+)*(?:\\s+' + safeReadFile + ')+\\s*$',
  cdPrefix + 'diff(?:\\s+--?[\\w-]+)*\\s+' + safeReadFile + '\\s+' + safeReadFile + '\\s*$',

  // --- Quoted paths with spaces ---
  cdPrefix + 'sed\\s+-n\\s+.+\\s+["\'][\\w./:~\\\\ ()-]*' + safeDirsRead + '[/\\\\]' + subPathQ + '+["\']\\s*$',
  cdPrefix + 'cat\\s+["\'][\\w./:~\\\\ ()-]*' + safeDirsRead + '[/\\\\]' + subPathQ + '+["\']\\s*$',
  cdPrefix + 'type\\s+["\'][\\w./:~\\\\ ()-]*' + safeDirsRead + '[/\\\\]' + subPathQ + '+["\']\\s*$',
  cdPrefix + '(head|tail)(?:\\s+[-+]?[\\w]+)*\\s+["\'][\\w./:~\\\\ ()-]*' + safeDirsRead + '[/\\\\]' + subPathQ + '+["\']\\s*$',
  cdPrefix + 'wc(?:\\s+-[lwcmL]+)*\\s+["\'][\\w./:~\\\\ ()-]*' + safeDirsRead + '[/\\\\]' + subPathQ + '+["\']\\s*$',
  cdPrefix + 'diff(?:\\s+--?[\\w-]+)*\\s+["\'][\\w./:~\\\\ ()-]*' + safeDirsRead + '[/\\\\]' + subPathQ + '+["\']\\s+["\'][\\w./:~\\\\ ()-]*' + safeDirsRead + '[/\\\\]' + subPathQ + '+["\']\\s*$',

  // --- Pipeline filter commands (no file argument) ---
  cdPrefix + 'xargs\\s+grep' + grepFlags + '\\s+' + grepTerm + '\\s*$',
  cdPrefix + 'grep' + grepFlags + '\\s+' + grepTerm + '\\s*$',
  cdPrefix + '(head|tail|cat)(?:\\s+[-+]?[\\w]+)*\\s*$',
  // `sed -n '<line-range>p'` reading a piped stream (e.g. `grep ... | sed -n '1,30p'`).
  // Restricted to numeric / `$` line-address printing — NOT arbitrary sed scripts, which
  // could write files (`w`/`W`/`s///w`) or run commands (`e`). No `-i`, no file arg.
  cdPrefix + 'sed\\s+-n\\s+["\']?(?:\\d+|\\$)(?:,(?:\\d+|\\$))?p["\']?\\s*$',
  cdPrefix + 'wc(?:\\s+-[lwcmL]+)*\\s*$',
  cdPrefix + '(sort|uniq|od)(?:\\s+[-\\w]+)*\\s*$',
  cdPrefix + 'xxd(?:\\s+-[\\w]+(?:\\s+\\d+)?)*\\s*$',

  // --- File copy (read from safe dirs, write to write-safe dirs, no path traversal in dest) ---
  cdPrefix + 'cp(?:\\s+-[\\w]+)*\\s+' + safeReadFile + '\\s+' + winPath + safeDirsWrite + '[/\\\\]' + subPathW + '+["\']?\\s*$',
  cdPrefix + 'cp(?:\\s+-[\\w]+)*\\s+["\'][\\w./:~\\\\ ()-]*' + safeDirsRead + '[/\\\\]' + subPathQ + '+["\']\\s+["\'][\\w./:~\\\\ ()-]*' + safeDirsWrite + '[/\\\\](?:(?!\\.\\.[/\\\\])[\\w./\\\\ ()-])+["\']\\s*$',

  // --- File writing (safe directories only, write-safe subpath blocks ../ traversal) ---
  cdPrefix + 'cat\\s*>\\s*' + winPath + safeDirsWrite + '[/\\\\]' + subPathW + '+["\']?\\s*$',
  cdPrefix + 'cat\\s*>\\s*' + winPath + safeDirsWrite + '[/\\\\]' + subPathW + '+["\']?\\s*<<\\s*-?\\s*[\'"]?\\w+[\'"]?',
  cdPrefix + 'sed\\s+-i\\S*\\s+.+\\s+' + winPath + safeDirsWrite + '[/\\\\]' + subPathW + '+["\']?\\s*$',
  cdPrefix + 'sed\\s+-i\\S*\\s+.+\\s+["\'][\\w./:~\\\\ ()-]*' + safeDirsWrite + '[/\\\\](?:(?!\\.\\.[/\\\\])[\\w./\\\\ ()-])+["\']\\s*$',

  // --- Find (any path, read-only flags only: no -exec, -execdir, -delete, -ok) ---
  cdPrefix + 'find\\s+' + pathTok + '(?:\\s+(?:-(?:name|iname|type|maxdepth|mindepth|path)\\s+["\']?[\\w.*?/\\\\:-]+["\']?|-(?:empty|print0?)|!|-not|-o|\\\\[()]?))*\\s*$',

  // --- Directory listing ---
  cdPrefix + 'ls(?:\\s+-[\\w]+)*(?:\\s+["\']?[\\w./:~\\\\*?()\\[\\]-]+["\']?)*\\s*$',
  cdPrefix + 'ls(?:\\s+-[\\w]+)*\\s+["\']?[\\w./:~\\\\()\\[\\]-]*' + safeDirsRead + '[/\\\\]?[\\w./\\\\*?()\\[\\]-]*["\']?' + execSafeArgs + '\\s*$',
  cdPrefix + 'dir(?:\\s+' + winPath + '["\']?)*\\s*$',
  cdPrefix + 'Get-ChildItem' + execSafeArgs + '\\s*$',

  // --- PowerShell ---
  // `[^;&|]*` (not `.*`) and an end anchor keep a chained command (`... ; Remove-Item ...`,
  // `... | iex`) from riding inside the -Command string and matching the whole command.
  'powershell\\s+-Command\\s+[^;&|]*(Get-Content|Select-Object)[^;&|]*' + winPath + safeDirs + '[^;&|]*$',
  'powershell\\s+-Command\\s+[^;&|]*Set-Content[^;&|]*' + winPath + safeDirsWrite + '[^;&|]*$',

  // --- PowerShell cmdlets (direct invocation; PowerShell is the user's shell) ---
  // New-Item creating a directory under a write-safe path. Requires `-ItemType Directory`
  // (lookahead) so file creation isn't auto-approved. subPathW blocks ../ traversal.
  cdPrefix + 'New-Item(?=[^|;&]*-ItemType\\s+Directory\\b)(?:\\s+(?:-ItemType\\s+Directory|-Force))*\\s+-Path\\s+' + winPathSp + safeDirsWrite + '[/\\\\]?' + subPathW + '*["\']?(?:\\s+(?:-ItemType\\s+Directory|-Force))*\\s*$',
  cdPrefix + 'Out-Null\\s*$',
  cdPrefix + 'Write-Output\\s+["\'][^"\']*["\']\\s*$',
  cdPrefix + 'Write-Output\\s+' + absPathChar + '+\\s*$',

  // --- Utility commands ---
  cdPrefix + 'tasklist(?:\\s+/[\\w]+(?:\\s+["\']?[\\w.*,: ]+["\']?)?)*\\s*$',
  // netstat is read-only (lists connections/listening ports) — used to check the dev-server port
  cdPrefix + 'netstat(?:\\s+-[\\w]+)*\\s*$',
  cdPrefix + 'which\\s+\\w+',
  cdPrefix + 'where\\.exe\\s+\\w+',
  cdPrefix + 'command\\s+-v\\s+\\w+',
  cdPrefix + 'node\\s+--version\\s*$',
  cdPrefix + 'npm\\s+--version\\s*$',
  cdPrefix + 'git\\s+--version\\s*$',
  cdPrefix + gitCmd + 'status' + gitSafeArgs + '\\s*$',
  cdPrefix + gitCmd + 'log' + gitSafeArgs + '\\s*$',
  cdPrefix + gitCmd + 'diff' + gitSafeArgs + '\\s*$',
  cdPrefix + gitCmd + 'show' + gitSafeArgs + '\\s*$',
  cdPrefix + gitCmd + 'branch(?:\\s+(?:-[avrl]+|--(?:list|all|remotes|contains|merged|no-merged)))*\\s*$',
  cdPrefix + gitCmd + 'rev-parse' + gitSafeArgs + '\\s*$',
  // git symbolic-ref READ form only: optional read flags, then exactly ONE ref name.
  // `git symbolic-ref --short HEAD` prints the current branch (same job as rev-parse --abbrev-ref).
  // The WRITE form (`symbolic-ref <name> <ref>` — two positionals) and DELETE form (`-d`/`--delete`)
  // mutate .git and are deliberately excluded: a second positional or `-d` fails the match and
  // falls through to a manual prompt. The ref-name class excludes shell metachars so a chained
  // command can't ride along on the auto-approve.
  cdPrefix + gitCmd + 'symbolic-ref(?:\\s+(?:-q|--quiet|--short))*\\s+[\\w./@{}-]+\\s*$',
  cdPrefix + gitCmd + 'remote(?:\\s+-v)?\\s*$',
  // git stash: reversible save/restore/read ops only (changes live in the stash). EXCLUDES
  // `drop`/`clear`, which discard stashed work — those keep prompting. Bare `git stash` (= push) allowed.
  // Args are a bounded token list (refs/flags/`--`/paths/quoted messages), NOT a `.*` catch-all:
  // a `.*` tail would let a chained command (`git stash pop ; rm -rf web/src`) match here and be
  // auto-approved whole, BEFORE the compound/pipeline splitters run. With the bounded list, a `;`/`&&`/`|`
  // breaks the match so the command falls through to per-segment vetting. Benign `2>&1 | tail` still
  // works via the pipeline path (the redirect is stripped, `tail` is matched as its own segment).
  cdPrefix + gitCmd + 'stash(?:\\s+(?:push|save|pop|apply|show|list)(?:\\s+(?:"[^"]*"|\'[^\']*\'|[\\w@{}./\\\\:_-]+))*)?\\s*$',
  cdPrefix + gitCmd + 'describe' + gitSafeArgs + '\\s*$',
  cdPrefix + gitCmd + 'check-ignore' + gitSafeArgs + '\\s*$',
  cdPrefix + gitCmd + 'ls-files' + gitSafeArgs + '\\s*$',
  cdPrefix + gitCmd + 'tag(?:\\s+(?:-l|--list)' + gitSafeArgs + ')?\\s*$',
  cdPrefix + gitCmd + 'pull(?:\\s+(?:--rebase|--ff-only|--no-rebase|[\\w./-]+))*\\s*$',
  cdPrefix + gitCmd + 'add(?:\\s+' + gitArgToken + ')+\\s*$',
  cdPrefix + gitCmd + 'reset' + gitSafeArgs + '\\s*$',  // --hard and --keep blocked by deny patterns above
  // git worktree — for the §6.1 main-landing write and /plan's planning workspaces
  // (epic-branch-concurrency.md §6.1). `add`/`remove` take a `wtPath` whose first char can't be a
  // dash, so `remove --force` / `add --force …` (which can discard or duplicate a worktree) fall
  // through to a prompt rather than auto-approving. `list`/`prune` are read/cleanup only.
  cdPrefix + gitCmd + 'worktree\\s+add(?:\\s+(?:-b\\s+[\\w./-]+|--detach))*\\s+' + wtPath + '(?:\\s+[\\w./-]+)?\\s*$',
  cdPrefix + gitCmd + 'worktree\\s+remove\\s+' + wtPath + '\\s*$',
  cdPrefix + gitCmd + 'worktree\\s+(?:list|prune)(?:\\s+[\\w-]+)*\\s*$',
  cdPrefix + 'pwd\\s*$',
  cdPrefix + 'echo\\s+\\$[\\w]+\\s*$',

  // --- Standalone commands ---
  'cd\\s+' + pathTok + '\\s*$',
  'echo\\s+["\'].*["\']\\s*$',
  'echo\\s+' + absPathChar + '+\\s*$',
  'cat\\s*<<\\s*-?\\s*[\'"]?\\w+[\'"]?',
  'cat\\s*>\\s*["\']?/tmp/' + subPath + '+["\']?\\s*<<\\s*-?\\s*[\'"]?\\w+[\'"]?',
  'cat\\s+["\']?/tmp/' + subPath + '+["\']?\\s*$',
  cdPrefix + 'rm\\s+-f\\s+["\']?\\/tmp\\/[\\w.-]+["\']?\\s*$',
  // Clear regenerable build/test artifact dirs (see `regenArtifacts`). Accepts one OR MORE
  // targets, each a `[./][web/]<artifact>[/<subpath>]` (see `rmTarget`); end-anchored so EVERY
  // target must validate. Cannot match `web`, `web/src`, `../` traversal, a non-artifact
  // target, or a chained command — one bad target disqualifies the whole command.
  cdPrefix + 'rm\\s+-[rf]+(?:\\s+' + rmTarget + ')+\\s*$',
  '(?:test\\s+-[defrsxw]|\\[\\s+-[defrsxw])\\s+' + pathTok + '(?:\\s+-[oa]\\s+-[defrsxw]\\s+' + pathTok + ')*\\s*\\]?\\s*$',
  'true\\s*$',
  'false\\s*$',
  cdPrefix + 'sleep\\s+\\d+\\s*$',
  cdPrefix + 'jobs(?:\\s+-[\\w]+)*\\s*$',

  // --- curl (localhost/127.0.0.1 only; URL must be the last token; matched CASE-SENSITIVELY) ---
  curlAllowPattern,

  // --- Windows: open file in default app (safe directories only) ---
  'start\\s+""\\s+' + winPathSp + safeDirs + '[/\\\\]' + subPath + '+["\']?\\s*$',

  // --- Claude CLI subprocess (non-interactive -p mode only) ---
  cdEnvPrefix + 'claude\\s+(?:(?:--model|--max-turns|--output-format|--allowedTools|--verbose)\\s+[\\w.,-]+\\s+)*(?:-p|--print)' + execMsgArgs + '\\s*$',
];

// =============================================================================
// CONFIG-CONDITIONAL PATTERNS
// =============================================================================

// Safe commit/push shapes are ALWAYS allow-listed here — dangerous forms
// (--force / -f / --delete / --no-verify) are hard-blocked by denyPatterns above,
// which run first. Whether to *ask the user* before a commit/push is NOT decided
// here: that gate lives at the prompt layer (orchestrator-rules.md §Git Commit &
// Push Authorization), which reads .claude/preferences.json and uses AskUserQuestion
// so "ask before commit/push" is honored on every occurrence. Allow-listing the safe
// shapes here keeps the harness from raising its own (session-cached) permission
// dialog, which would otherwise both double-prompt and defeat the stored preference.
allowPatterns.push(
  cdPrefix + gitCmd + 'commit(?:\\s+(?:-[av]|--allow-empty))*\\s+(?:-m|--message)' + execMsgArgs + '\\s*$'
);
allowPatterns.push(
  // `refTok` is non-dash-leading, so an arbitrary `--flag` (e.g. --force-with-lease) can't be
  // swallowed as a "ref" and auto-approved. Only the explicit safe flags below are allowed.
  cdPrefix + gitCmd + 'push(?:\\s+(?:-u|--set-upstream|--tags|' + refTok + '))*\\s*$'
);
// Push a non-delete refspec to land a shared record on main (§6.1: `git push origin HEAD:main`).
// Both sides of `<src>:<dst>` must be non-empty, so the `:branch` delete form is NOT matched (it
// falls through to a prompt); `--delete` stays hard-denied above, and a `+`-prefixed force-refspec
// is hard-denied by the `push … \s\+` rule above (so `+main:main` can't ride this allow).
allowPatterns.push(
  cdPrefix + gitCmd + 'push\\s+' + refTok + '\\s+' + refTok + ':[\\w./-]+\\s*$'
);
// Rebase force-push, scoped to epic/* branches only (§6.1 step 6 / PR-rebase). --force-with-lease
// refuses if the remote moved unexpectedly, so it can't clobber another session's push. Bare
// --force / -f stay hard-denied; --force-with-lease to a non-epic ref falls through to a prompt.
allowPatterns.push(
  cdPrefix + gitCmd + 'push\\s+--force-with-lease(?:=[\\w./-]+)?\\s+' + refTok + '\\s+epic/[\\w./-]+\\s*$'
);

// --- Dynamic safe paths (e.g. prototype repo specified during INTAKE) ---
if (prefs?.safePaths?.prototypeRepo) {
  const rawPath = String(prefs.safePaths.prototypeRepo);
  // Escape regex special chars (including backslash), then normalize path separators
  const escapedPath = rawPath
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/[\\/]+/g, '[/\\\\]');

  // Read-only commands against the prototype repo (no trailing catch-all)
  const protoReadCmds = [
    'cat', 'type', 'head', 'tail', 'less', 'more',
    'wc', 'ls', 'dir',
  ];
  const flagsOpt = '(?:\\s+[-+]?[\\w-]+)*';
  const protoPath = escapedPath + '[/\\\\]?' + subPath + '*';
  const protoPathQ = escapedPath + '[/\\\\]?' + subPathQ + '*';
  for (const cmd of protoReadCmds) {
    allowPatterns.push(
      cdPrefix + cmd + flagsOpt + '\\s+["\']?' + protoPath + '["\']?\\s*$'
    );
    allowPatterns.push(
      cdPrefix + cmd + flagsOpt + '\\s+["\'][\\w./:~\\\\ ()-]*' + protoPathQ + '["\']\\s*$'
    );
  }
  // diff: requires both paths to be in the prototype repo (mirrors static diff pattern)
  allowPatterns.push(
    cdPrefix + 'diff' + flagsOpt + '\\s+["\']?' + protoPath + '["\']?\\s+["\']?' + protoPath + '["\']?\\s*$'
  );
  // find: read-only flags only (mirrors static find pattern — no -exec, -execdir, -delete, -ok)
  allowPatterns.push(
    cdPrefix + 'find\\s+["\']?' + protoPath + '["\']?(?:\\s+(?:-(?:name|iname|type|maxdepth|mindepth|path)\\s+["\']?[\\w.*?/\\\\:-]+["\']?|-(?:empty|print0?)|!|-not|-o|\\\\[()]?))*\\s*$'
  );
  // grep: needs a pattern argument before the path
  const grepPatternArg = '(?:\\s+' + grepTerm + ')';
  allowPatterns.push(
    cdPrefix + 'grep' + flagsOpt + grepPatternArg + '\\s+["\']?' + protoPath + '["\']?\\s*$'
  );
  allowPatterns.push(
    cdPrefix + 'grep' + flagsOpt + grepPatternArg + '\\s+["\'][\\w./:~\\\\ ()-]*' + protoPathQ + '["\']\\s*$'
  );
  // node import scripts reading from the prototype repo
  allowPatterns.push(
    cdEnvPrefix + 'node\\s+' + winPath + '\\.claude[/\\\\]scripts[/\\\\]' + subPathW + '+["\']?\\s+[^;&|`$()<>]*' + escapedPath + '[^;&|`$()<>]*$'
  );
}

// Anchor all patterns to start. Every pattern is case-INSENSITIVE except the curl pattern,
// which is case-SENSITIVE so short `-o` cannot match the excluded `-O` (--remote-name); see
// the curl flag comment above.
const anchoredAllowPatterns = allowPatterns.map(p =>
  new RegExp('^' + p, p === curlAllowPattern ? '' : 'i'));

// Check if command matches any allow pattern
for (const re of anchoredAllowPatterns) {
  if (re.test(command)) {
    writeAllowAndExit('Auto-approved: matches safe command pattern');
  }
}

// =============================================================================
// PIPELINE SPLITTING
// =============================================================================

function testPipelineAllowed(cmdText) {
  const segments = splitPipeline(cmdText);
  if (!segments) return false;

  for (let seg of segments) {
    seg = stripTrailingSuffix(seg);

    for (const pattern of alwaysDenyPatterns) {
      if (pattern.test(seg)) {
        denyAndExit('Blocked by security policy: Pipe segment attempts to read a credential-like file');
      }
    }

    const segIsSafeDir = isSafeDirCommand(seg);
    for (const pattern of denyPatterns) {
      if (pattern.test(seg)) {
        if (segIsSafeDir) return false;
        denyAndExit('Blocked by security policy: Pipe segment matches deny pattern');
      }
    }

    let segAllowed = false;
    for (const re of anchoredAllowPatterns) {
      if (re.test(seg)) {
        segAllowed = true;
        break;
      }
    }
    if (!segAllowed) {
      // A pipeline segment can itself be a parenthesized subshell, e.g.
      //   (cd web && npx tsc --noEmit) 2>&1 | tail -5
      // The trailing redirect is stripped above; if what remains is fully
      // parenthesized, verify every inner sub-command is independently safe
      // (deny patterns still apply, via testSubCommandAllowed). splitCompoundCommand
      // returns null for a single inner command, so fall back to [inner].
      const parenMatch = /^\s*\((.+)\)\s*$/.exec(seg);
      if (!parenMatch) return false;
      const inner = parenMatch[1].trim();
      for (const ic of splitCompoundCommand(inner) || [inner]) {
        if (!testSubCommandAllowed(ic)) return false;
      }
    }
  }

  return true;
}

if (testPipelineAllowed(command)) {
  writeAllowAndExit('Auto-approved: all pipeline segments match safe patterns');
}

// =============================================================================
// COMPOUND COMMAND SPLITTING
// =============================================================================

function testSubCommandAllowed(subCmd) {
  subCmd = stripTrailingSuffix(subCmd);

  // Bash comments are no-ops
  if (/^\s*#/.test(subCmd)) return true;

  for (const pattern of alwaysDenyPatterns) {
    if (pattern.test(subCmd)) {
      denyAndExit('Blocked by security policy: Sub-command attempts to read a credential-like file');
    }
  }

  const subCmdIsSafeDir = isSafeDirCommand(subCmd);
  for (const pattern of denyPatterns) {
    if (pattern.test(subCmd)) {
      if (subCmdIsSafeDir) return false;
      denyAndExit('Blocked by security policy: Sub-command matches deny pattern');
    }
  }

  for (const re of anchoredAllowPatterns) {
    if (re.test(subCmd)) return true;
  }

  if (testPipelineAllowed(subCmd)) return true;

  // If wrapped in parentheses, strip and recursively check
  let stripped = subCmd;
  let parenMatch;
  while ((parenMatch = /^\s*\((.+)\)\s*$/.exec(stripped))) {
    stripped = parenMatch[1].trim();
  }
  if (stripped !== subCmd) {
    const innerCommands = splitCompoundCommand(stripped);
    if (innerCommands && innerCommands.length > 1) {
      for (const inner of innerCommands) {
        if (!testSubCommandAllowed(inner)) return false;
      }
      return true;
    }
    for (const re of anchoredAllowPatterns) {
      if (re.test(stripped)) return true;
    }
  }

  return false;
}

const subCommands = splitCompoundCommand(command);

if (subCommands && subCommands.length > 1) {
  let allAllowed = true;
  for (const sub of subCommands) {
    if (!testSubCommandAllowed(sub)) {
      allAllowed = false;
      break;
    }
  }
  if (allAllowed) {
    writeAllowAndExit('Auto-approved: all sub-commands match safe patterns');
  }
}

// Third pass: parenthesized commands
if (/^\s*\(/.test(command)) {
  if (testSubCommandAllowed(command)) {
    writeAllowAndExit('Auto-approved: parenthesized command contains safe sub-commands');
  }
}

// No match - fall through
process.exit(0);
