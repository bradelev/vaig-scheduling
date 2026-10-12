#!/usr/bin/env bash
# Installs the git pre-commit hook (secret scan). Idempotent — safe to run
# repeatedly. Runs automatically on `npm install` via the "prepare" script,
# and manually via `npm run install-hooks`. Skips gracefully outside a git
# checkout (e.g. CI installing from a tarball).
set -euo pipefail

git_dir="$(git rev-parse --git-dir 2>/dev/null || true)"
if [ -z "$git_dir" ]; then
  echo "install-hooks: not a git checkout, skipping."
  exit 0
fi

hook="$git_dir/hooks/pre-commit"
mkdir -p "$git_dir/hooks"
cat > "$hook" <<'HOOK'
#!/usr/bin/env bash
# Auto-installed by scripts/install-hooks.sh. Blocks commits that add secrets.
exec "$(git rev-parse --show-toplevel)/scripts/scan-secrets.sh" staged
HOOK
chmod +x "$hook"
echo "install-hooks: pre-commit hook installed at $hook"
