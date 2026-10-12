#!/usr/bin/env bash
# PostToolUse — immediate feedback after editing .ts/.tsx.
# Exit 2 = the error goes back to Claude on stderr so it fixes it now, not at the end.

INPUT=$(cat)
command -v jq >/dev/null 2>&1 || exit 0

FP=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty')

case "$FP" in
  *.ts|*.tsx) ;;
  *) exit 0 ;;
esac

# Edge functions are Deno, not tsc
case "$FP" in
  *supabase/functions/*)
    command -v deno >/dev/null 2>&1 || exit 0
    if ! OUT=$(deno check "$FP" 2>&1); then
      echo "deno check failed after editing $FP:" >&2
      printf '%s\n' "$OUT" | tail -40 >&2
      exit 2
    fi
    exit 0
    ;;
esac

# Rest of the repo: project tsc (if the scaffold exists yet)
[ -f package.json ] || exit 0
grep -q '"typecheck"' package.json || exit 0

if ! OUT=$(npm run --silent typecheck 2>&1); then
  echo "typecheck failed after editing $FP:" >&2
  printf '%s\n' "$OUT" | tail -40 >&2
  exit 2
fi

exit 0
