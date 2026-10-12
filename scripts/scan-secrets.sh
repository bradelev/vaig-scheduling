#!/usr/bin/env bash
# Secret scanner (chore/secret-scanning, after the 2026-08-03 verify-token
# leak). Blocks a commit that adds a real secret / real value to a TRACKED
# file — including docs, which is exactly where the leak happened. The
# gitignored .env is where real values belong; committed files use
# placeholders ('...', <value>, +598...).
#
# Usage:
#   scripts/scan-secrets.sh            # scan staged changes (pre-commit hook)
#   scripts/scan-secrets.sh --all      # scan the whole working tree
#
# Exit 1 on a finding. Designed to be conservative: patterns target the
# concrete shapes that leaked, not "any long string", so false positives are
# rare. When one fires on a legitimate example, make the value a placeholder.

set -euo pipefail

mode="${1:-staged}"

# Files to scan. Staged: only added/modified. --all: every tracked file.
# `while read` (not mapfile) for macOS's bash 3.2 compatibility.
files=()
if [ "$mode" = "--all" ]; then
  while IFS= read -r f; do files+=("$f"); done < <(git ls-files)
else
  while IFS= read -r f; do files+=("$f"); done < <(git diff --cached --name-only --diff-filter=ACM)
fi
[ "${#files[@]}" -eq 0 ] && { echo "✔ No files to scan."; exit 0; }

# .env* is gitignored and never scanned; skip lockfiles/binaries too.
skip_re='^(package-lock\.json|.*\.(png|jpg|jpeg|gif|webp|ico|pdf|lock))$'

# Patterns: label|regex. Each targets a real-secret SHAPE, tuned to avoid the
# repo's legitimate placeholders (see the negative guards below).
# ERE (grep -E) patterns — no \s, no unbounded {n,} that BSD grep chokes on.
patterns=(
  "Supabase access token|sbp_[A-Za-z0-9]{20,60}"
  "Supabase secret/publishable key|sb_(secret|publishable)_[A-Za-z0-9_-]{20,60}"
  "JWT (anon/service key)|eyJ[A-Za-z0-9_-]{10,}[.][A-Za-z0-9_-]{10,}[.][A-Za-z0-9_-]{10,}"
  "Meta/WhatsApp long-lived token|EA[A-Za-z0-9]{80,300}"
  "Google API key|AIza[0-9A-Za-z_-]{30,40}"
  "Resend API key|re_[A-Za-z0-9]{20,60}"
  "PEM private key body|-----BEGIN [A-Z ]*PRIVATE KEY-----[^-]"
  "WhatsApp verify token (the 2026-08-03 leak)|WHATSAPP_VERIFY_TOKEN[ =]*['\"][A-Za-z0-9_]{6,}['\"]"
)

found=0
for f in "${files[@]}"; do
  [ -f "$f" ] || continue
  base="$(basename "$f")"
  [[ "$base" =~ $skip_re ]] && continue
  # This scanner file itself contains the patterns as literals — never scan it.
  [ "$f" = "scripts/scan-secrets.sh" ] && continue

  for entry in "${patterns[@]}"; do
    label="${entry%%|*}"
    re="${entry#*|}"
    # Grep the file. -P for Perl regex; -n for line numbers.
    while IFS= read -r hit; do
      lineno="${hit%%:*}"
      line="${hit#*:}"
      # Negative guards: legitimate placeholders never count.
      #   '...'  <value>  +598...  the literal '-----BEGIN PRIVATE KEY-----\n...'  # gitleaks:allow (placeholder pattern, not a key)
      case "$line" in
        *"'...'"*|*"<"*">"*|*"+598..."*|*'-----BEGIN PRIVATE KEY-----\n...'*) continue ;;
      esac
      echo "  ✖ [$label] $f:$lineno"
      echo "      $(printf '%s' "$line" | cut -c1-100)"
      found=1
    done < <(grep -nE "$re" "$f" 2>/dev/null || true)
  done
done

if [ "$found" -eq 1 ]; then
  echo ""
  echo "✖ Possible secret(s) in tracked files. Real values belong ONLY in the"
  echo "  gitignored .env — use placeholders ('...', <value>, +598...) in"
  echo "  committed files. If this is a false positive, adjust scripts/scan-secrets.sh."
  echo "  Bypass (rarely, and only if you are sure): git commit --no-verify"
  exit 1
fi

echo "✔ No secrets detected."
