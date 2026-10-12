---
description: "Work a PRD task end to end: /task E2-T3"
argument-hint: "<task ID, e.g. E2-T3>"
---

Work task **$ARGUMENTS** end to end:

1. Find the issue: `gh issue list --search "[$ARGUMENTS]" --state open`. Read the full issue **and** the PRD section it references. If the issue has open dependencies, say so and stop.
2. If `docs/TECH_DEBT.md` exists, check whether any item touches the same files as this task — fold it into the plan or justify why not.
3. Refine the spec before planning: the issue's AC as a verifiable checklist + relevant edge cases (empty/null states, invalid phone numbers, External+manual duplicates, date changes, `America/Montevideo`, idempotency where the PRD requires it). If an ambiguity would change the implementation, ask and stop until answered — do not assume.
4. Draft the plan: files to touch, new migration yes/no, tests to write, which pieces get delegated to the `dev` subagent vs kept by the architect, and what is explicitly out of scope. Then invoke the `architect` subagent in **plan** mode with the plan and fold its findings in. Present the plan together with the architect's verdict and anything you chose not to adopt (and why). **Wait for confirmation before editing.**
5. Branch: `git checkout -b task/$ARGUMENTS-<short-slug>` from an updated `main` (for a parallel task, use a worktree per CLAUDE.md instead).
6. Implement with tests. Delegate mechanical pieces to the `dev` subagent with exact instructions and review its diff line by line. Run `npm run check` until green — no Docker locally; integration tests run in CI. If the task touches the Next.js UI: clean `npm run build` too.
7. Out-of-scope debt found along the way: don't fix it, don't lose it — record it in `docs/TECH_DEBT.md` (format in CLAUDE.md).
8. Atomic conventional commits in English, `type(scope): description ($ARGUMENTS)` — one concern per commit.
9. Invoke the `reviewer` subagent on the diff. If the diff touches a sensitive surface, also invoke the `architect` subagent in **diff** mode. Sensitive means any of: a `"use server"` module, `app/api/**`, `middleware.ts`, `next.config.mjs`, `lib/auth/**`, `lib/client-auth/**`, `lib/security/**`, `supabase/migrations/**`, `supabase/functions/**`, anything that sends a message or charges money, or `docs/**`/`.env.example` (secrets). Resolve every BLOCK/CRITICAL/HIGH before the PR; log accepted lower findings in `docs/TECH_DEBT.md`.
10. Push the branch and `gh pr create` with: title in conventional-commit form, `type(scope): description ($ARGUMENTS)` (e.g. `feat(sync): matching cascade (E2-T3)`), `Closes #<n>` in the body, the AC checklist ticked, and what / how / decisions made. The PR is squash-merged and its title becomes the single commit on `main`, so the title must describe the whole PR, not its last commit.
11. Finish by reporting the PR link. Do not merge.

**Budget (CLAUDE.md):** if the session balloons beyond the plan, commit the progress, comment the status on the issue and stop — resume in a fresh session. Never risk 80% of the weekly quota.
