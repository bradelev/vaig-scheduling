#!/usr/bin/env bash
# PreToolUse guard — deterministic veto.
# Exit 2 = block the action (Claude sees the reason on stderr). Exit 0 = allow.
# These rules hold no matter how the prompt is phrased.

INPUT=$(cat)

if ! command -v jq >/dev/null 2>&1; then
  echo "GUARD: jq is not installed — guardrails inactive (install it: apt/brew install jq)" >&2
  exit 0
fi

TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty')

deny() {
  echo "GUARD BLOCKED: $1" >&2
  exit 2
}

# ---------- Bash commands ----------
if [ "$TOOL" = "Bash" ]; then
  CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty')

  if printf '%s' "$CMD" | grep -Eq 'git[[:space:]]+push[[:space:]].*(--force|[[:space:]]-f([[:space:]]|$))'; then
    deny "push --force is forbidden"
  fi
  if printf '%s' "$CMD" | grep -Eq 'git[[:space:]]+push[[:space:]]+(origin[[:space:]]+)?(main|master)([[:space:]]|$)'; then
    deny "direct push to main is forbidden — open a PR"
  fi
  if printf '%s' "$CMD" | grep -Eq 'supabase[[:space:]]+(db[[:space:]]+push|functions[[:space:]]+deploy|secrets|link)'; then
    deny "operations against production Supabase are a [HUMAN] task (PRD)"
  fi
  if printf '%s' "$CMD" | grep -Eq '(^|[[:space:]/])vercel([[:space:]]|$)'; then
    deny "Vercel deploys are a [HUMAN] task"
  fi
  if printf '%s' "$CMD" | grep -Eq '\.env\.(production|prod)'; then
    deny "production secrets are out of the agent's reach"
  fi
  if printf '%s' "$CMD" | grep -Eq 'rm[[:space:]]+-[a-zA-Z]*r[a-zA-Z]*f[[:space:]]+(/|~|\.\.)'; then
    deny "rm -rf on dangerous paths"
  fi
fi

# ---------- File edits ----------
case "$TOOL" in
  Edit|Write|MultiEdit)
    FP=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty')

    case "$FP" in
      *.claude/settings*|*.claude/hooks/*|*.github/workflows/*)
        deny "the agent does not edit its own cage ($FP)"
        ;;
      *supabase/migrations/*)
        # Creating a new migration is allowed; editing an existing one is not.
        if [ -e "$FP" ]; then
          deny "existing migrations are never edited — create a new migration"
        fi
        ;;
      *.env.production*)
        deny "production secrets are out of the agent's reach"
        ;;
    esac
    ;;
esac

exit 0
