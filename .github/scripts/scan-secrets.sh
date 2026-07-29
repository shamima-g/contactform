#!/usr/bin/env bash

# Secret Scanner
# Used by both the pre-commit hook (staged files) and CI (directory scan).
#
# Usage:
#   scan-secrets.sh --staged          # Pre-commit: scan only staged files
#   scan-secrets.sh --dir web         # CI: scan a directory
#
# Exit codes:
#   0 = clean
#   1 = secrets found

set -euo pipefail

# ─── Colours (disabled when not a terminal) ──────────────────────────────────
if [ -t 1 ]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  BOLD='\033[1m'
  RESET='\033[0m'
else
  RED='' GREEN='' YELLOW='' BOLD='' RESET=''
fi

# ─── Pattern definitions ─────────────────────────────────────────────────────
# Each entry: "Label:::regex"
# Patterns are intentionally broad — false positives are better than missed secrets.
PATTERNS=(
  # Cloud provider keys
  "AWS Access Key:::AKIA[0-9A-Z]{16}"
  "AWS Secret Key:::aws_secret_access_key\s*[:=]\s*[\"'][A-Za-z0-9/+=]{40}[\"']"
  "Google API Key:::AIza[0-9A-Za-z_-]{35}"
  "Azure Storage Key:::AccountKey=[A-Za-z0-9+/=]{86,88}"

  # SaaS tokens
  "GitHub PAT:::ghp_[A-Za-z0-9]{36}"
  "GitHub OAuth:::gho_[A-Za-z0-9]{36}"
  "GitHub App Token:::ghu_[A-Za-z0-9]{36}"
  "GitHub App Refresh:::ghr_[A-Za-z0-9]{36}"
  "Slack Bot Token:::xoxb-[0-9]{10,13}-[0-9]{10,13}-[A-Za-z0-9]{24}"
  "Slack User Token:::xoxp-[0-9]{10,13}-[0-9]{10,13}-[A-Za-z0-9]{24,34}"
  "Slack App Token:::xapp-[0-9]-[A-Z0-9]{10,}-[0-9a-z]{50,}"
  "Stripe Secret Key:::sk_(live|test)_[0-9a-zA-Z]{24,}"
  "Stripe Publishable Key:::pk_(live|test)_[0-9a-zA-Z]{24,}"
  "Stripe Restricted Key:::rk_(live|test)_[0-9a-zA-Z]{24,}"
  "SendGrid Key:::SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}"
  "Twilio Key:::SK[0-9a-fA-F]{32}"
  "npm Token:::npm_[A-Za-z0-9]{36}"

  # AI provider keys
  "OpenAI API Key:::sk-proj-[A-Za-z0-9_-]{40,}"
  "OpenAI Legacy Key:::sk-[A-Za-z0-9]{32,}"
  "Anthropic API Key:::sk-ant-[A-Za-z0-9_-]{80,}"

  # Private keys
  "Private Key Block:::-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----"

  # JWT / Bearer tokens
  "Bearer Token:::bearer\s+[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"

  # Generic secret assignments (case-insensitive match on variable name)
  # Catches: apiKey, API_KEY, api-key, ApiKey, secret, SECRET_KEY, token, auth_token, etc.
  "Generic API Key:::[\"']?[Aa](pi|PI)[_-]?[Kk](ey|EY)[\"']?\s*[:=]\s*[\"'][A-Za-z0-9_/+=-]{20,}[\"']"
  "Generic Secret:::[\"']?[Ss](ecret|ECRET)[_-]?[Kk]?(ey|EY)?[\"']?\s*[:=]\s*[\"'][A-Za-z0-9_/+=-]{20,}[\"']"
  "Generic Token:::[\"']?[Aa](uth|UTH)?[_-]?[Tt](oken|OKEN)[\"']?\s*[:=]\s*[\"'][A-Za-z0-9_/+=-]{20,}[\"']"
  "Generic Password:::password\s*[:=]\s*[\"'][^\$\"'][^\"']{7,}[\"']"

  # Connection strings with embedded credentials
  "Connection String:::://[^:]+:[^@]{8,}@[a-zA-Z0-9.\-]+"
)

# ─── File extensions to scan ──────────────────────────────────────────────────
FILE_EXTENSIONS="ts|tsx|js|jsx|json|yaml|yml|env|cfg|conf|toml|ini|sh|bash|py|example|local"
# Also match dotenv variants like .env.example, .env.local, .env.production
DOTENV_PATTERN='\.env(\.[a-zA-Z]+)?$'

# Build grep --include flags from FILE_EXTENSIONS (used in dir mode)
INCLUDE_FLAGS=""
IFS='|' read -ra EXTS <<< "$FILE_EXTENSIONS"
for ext in "${EXTS[@]}"; do
  INCLUDE_FLAGS="$INCLUDE_FLAGS --include=*.$ext"
done
# Dotenv variants for dir mode
INCLUDE_FLAGS="$INCLUDE_FLAGS --include=.env --include=.env.*"

# ─── Test-layer exemption (single source of truth for BOTH modes) ─────────────
# Test files hold mock data by construction — fake passwords, fake tokens, fake
# auth-chain bodies (see .claude/policies/testing-policy.md and web/e2e/README.md).
# The broad regex patterns above would flag those on the first commit of every
# auth-bearing epic, so the test layer is exempt from the regex scan in BOTH
# modes. Know the tradeoff: the only remaining net over the test layer is CI's
# TruffleHog step, which runs in CI only (never at pre-commit), scans just the
# pushed commit range, and reports only *verified* live credentials. A real but
# non-verifiable secret in a test file slips past both scans, so code review —
# not this gate — is the backstop for those.
# Defined once here so staged and dir mode stay in sync. Keep entries glob-free:
# staged mode matches them literally, dir mode passes them to grep as globs.
EXEMPT_DIR_NAMES=(__tests__ e2e)            # any path segment equal to one of these
EXEMPT_FILE_GLOBS=('*.test.*' '*.spec.*')   # basename globs

# True (exit 0) when a path is in the exempt test layer. Used by staged mode.
is_exempt_path() {
  local path="$1" base="${1##*/}" d g
  for d in "${EXEMPT_DIR_NAMES[@]}"; do
    case "/$path/" in */"$d"/*) return 0 ;; esac
  done
  for g in "${EXEMPT_FILE_GLOBS[@]}"; do
    case "$base" in $g) return 0 ;; esac
  done
  return 1
}

# The same exemption rendered as grep flags for dir mode's `grep -r`.
TESTLAYER_EXCLUDE_FLAGS=""
for d in "${EXEMPT_DIR_NAMES[@]}"; do
  TESTLAYER_EXCLUDE_FLAGS="$TESTLAYER_EXCLUDE_FLAGS --exclude-dir=$d"
done
for g in "${EXEMPT_FILE_GLOBS[@]}"; do
  TESTLAYER_EXCLUDE_FLAGS="$TESTLAYER_EXCLUDE_FLAGS --exclude=$g"
done

# ─── Parse arguments ─────────────────────────────────────────────────────────
MODE=""
SCAN_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --staged)  MODE="staged"; shift ;;
    --dir)     MODE="dir"; SCAN_DIR="$2"; shift 2 ;;
    *)         echo "Unknown option: $1"; exit 2 ;;
  esac
done

if [ -z "$MODE" ]; then
  echo "Usage: scan-secrets.sh --staged | --dir <path>"
  exit 2
fi

# ─── Collect files to scan ───────────────────────────────────────────────────
TMPFILE=$(mktemp)
FILTERED=""
trap 'rm -f "$TMPFILE" "$FILTERED"' EXIT

if [ "$MODE" = "staged" ]; then
  # Only scan files staged for commit (added/modified, not deleted)
  git diff --cached --name-only --diff-filter=ACM | \
    grep -E "(\.($FILE_EXTENSIONS)$|$DOTENV_PATTERN)" | \
    grep -v "node_modules" | \
    grep -v "package-lock\.json" > "$TMPFILE" || true

  # Drop test-layer files (mock data by construction — see is_exempt_path).
  # Rebuild TMPFILE with only the non-exempt paths so the count and the scan agree.
  FILTERED=$(mktemp)
  while IFS= read -r file; do
    [ -z "$file" ] && continue
    if is_exempt_path "$file"; then continue; fi
    printf '%s\n' "$file"
  done < "$TMPFILE" > "$FILTERED"
  mv "$FILTERED" "$TMPFILE"

  FILE_COUNT=$(wc -l < "$TMPFILE" | tr -d ' ')
  if [ "$FILE_COUNT" -eq 0 ]; then
    echo -e "${GREEN}No scannable files found. Skipping secret scan.${RESET}"
    exit 0
  fi
  echo -e "${BOLD}Scanning $FILE_COUNT staged file(s) for secrets...${RESET}"
else
  echo -e "${BOLD}Scanning ${SCAN_DIR}/ for secrets...${RESET}"
fi

# ─── Safe-line filter (piped after grep) ──────────────────────────────────────
filter_safe_lines() {
  grep -Ev 'process\.env\.|import |require\(|// scan-secrets-ignore' || true
}

# ─── Scan ─────────────────────────────────────────────────────────────────────
FOUND=0
TOTAL_MATCHES=0

for entry in "${PATTERNS[@]}"; do
  LABEL="${entry%%:::*}"
  PATTERN="${entry##*:::}"

  MATCHES=""
  if [ "$MODE" = "staged" ]; then
    # Staged mode: grep each file individually (small file count)
    while IFS= read -r file; do
      [ -z "$file" ] && continue
      FILE_MATCHES=$(grep -Enn "$PATTERN" "$file" 2>/dev/null | filter_safe_lines) || true
      if [ -n "$FILE_MATCHES" ]; then
        MATCHES="${MATCHES}$(echo "$FILE_MATCHES" | sed "s|^|${file}:|")"$'\n'
      fi
    done < "$TMPFILE"
  else
    # Directory mode: use grep -r directly (fast)
    # $INCLUDE_FLAGS and $TESTLAYER_EXCLUDE_FLAGS are intentionally word-split.
    # Test-layer excludes come from the shared arrays above; the build/vendor
    # excludes below are dir-mode-only (staged commits don't contain them).
    # shellcheck disable=SC2086
    MATCHES=$(grep -rEn "$PATTERN" "$SCAN_DIR" \
      $INCLUDE_FLAGS \
      $TESTLAYER_EXCLUDE_FLAGS \
      --exclude-dir=node_modules \
      --exclude-dir=.next \
      --exclude-dir=dist \
      --exclude-dir=build \
      --exclude-dir=coverage \
      2>/dev/null | filter_safe_lines) || true
  fi

  if [[ "$MATCHES" =~ [^[:space:]] ]]; then
    FOUND=1
    MATCH_COUNT=$(echo "$MATCHES" | grep -c '.' || true)
    TOTAL_MATCHES=$((TOTAL_MATCHES + MATCH_COUNT))
    echo ""
    echo -e "${RED}${BOLD}[$LABEL]${RESET}"
    echo "$MATCHES" | head -10
    echo "---"
  fi
done

# ─── Result ───────────────────────────────────────────────────────────────────
echo ""
if [ "$FOUND" -eq 1 ]; then
  echo -e "${RED}${BOLD}BLOCKED: $TOTAL_MATCHES potential secret(s) detected.${RESET}"
  echo -e "${YELLOW}If this is a false positive, add ${BOLD}// scan-secrets-ignore${RESET}${YELLOW} to the line.${RESET}"
  echo -e "${YELLOW}Use environment variables instead of hardcoding secrets.${RESET}"
  exit 1
else
  echo -e "${GREEN}${BOLD}No secrets detected.${RESET}"
  exit 0
fi
