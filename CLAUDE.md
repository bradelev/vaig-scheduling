# CLAUDE.md — VAIG v2

## Source of truth

`PRD.md` at the repo root. **Before touching code, read the PRD section that corresponds to the task** (the issue references it). If the issue and the PRD contradict each other, the PRD wins and you comment on the issue.

## Scope contract (PRD §3 — no exceptions)

None of: chatbot/LLM, self-scheduling, writing to Google Calendar, payments, analytics, fuzzy matching, direct External integration, multi-tenant. **If a task seems to ask for something outside this: do not implement it, comment on the issue and stop.**

**APPROVED SCOPE EXPANSION (Braulio, 2026-08-26) — the online booking project.** An internal booking plan (kept private) is the source of truth. Braulio has consciously reversed part of §3 to build **VAIG's own online booking** (single-tenant, same repo, reusing existing infra). This UN-forbids, *within that project's phases only*: **self-scheduling** (public booking page), **payments** (deposit "seña" by bank transfer only — Mercado Pago explicitly rejected), a **prepaid-package/credit "cuponera"** ledger, an **availability-rules engine** + staff scheduling, **phone login for clients**, and **coexistence with the External booking app** (per segment). Still forbidden: writing arbitrary events to Google Calendar beyond the existing mirror, fuzzy matching, chatbot/LLM, and **multi-tenant / SaaS-for-other-businesses** (NOT approved). Build these only as part of the booking plan's phases; anything outside both the original §3 and this expansion still stops-and-asks. **Second expansion (Braulio, 2026-09-02, "todo junto, dale"):** in-house **analytics** — anonymous booking-funnel events, the identified short-lived "reservas a medio camino" recovery queue (human wa.me outreach only, never automated sends), and panel-usage counts — per `docs/booking-analytics.md`, which is its source of truth. Third-party trackers stay forbidden.

## Language

Everything in this repo is in English: code, comments, commits, docs, PRs, issues, branch names. The only Spanish allowed is (a) end-user-facing copy — customers (WhatsApp template body, `wa.me` prefilled text) **and the staff operator UI**, since the whole team is Uruguayan (Braulio's decision, 2026-07-14) — and (b) the literal patterns/stopwords in `lib/normalize.ts` that match real Spanish calendar text.

## Commands

| Command | What it does |
|---|---|
| `supabase migration new <name>` | Creates an empty migration file (no Docker needed) |
| `npm run check` | **The local verdict**: lint + typecheck + unit tests. Docker-free. If this is green, your part is done. |
| `npm run test` | Unit tests (vitest, fixtures/mocks — no stack) |
| `npm run test:functions` | Edge function tests (`deno test --allow-all supabase/functions` — no stack) |
| `npm run test:integration` | Integration tests against a live Supabase stack — **CI only** |

**No Docker on dev machines.** The Supabase stack (Postgres + edge runtime) only exists in the CI runner: locally everything runs against fixtures and mocks, migrations are authored blind, and CI validates them (`supabase start` applies all migrations) and runs the integration tests. Never run `supabase start`/`db reset` locally.

Script contract (created in E0-T2, never renamed): `lint`, `typecheck` (tsc `--noEmit`, **excludes** `supabase/functions/`), `test`, `test:functions`, `check` (= all of the above, Docker-free), `test:integration` (assumes a running stack, uses the default local URLs/keys from `supabase status`).

## Definition of Done (every task)

1. Every AC on the issue met (checklist ticked in the PR).
2. `npm run check` green locally **and CI green on the PR** (CI also runs the integration tests you can't run locally).
3. If the task touches the Next.js UI: clean `npm run build` before the PR — tsc and vitest don't catch Next build failures (Server/Client Component boundaries, `use client`, imports in route segments).
4. Branch `task/<ID>-<slug>` (e.g. `task/E2-T3-sync-calendar`), PR against `main` with `Closes #<n>`, description: what / how / decisions made. **PR title in conventional-commit form**, `type(scope): description (<ID>)`: PRs are squash-merged and the title becomes the commit on `main`, so it must summarize the whole PR.
5. New tests for new logic. The matching cascade (PRD §7) and classification (§7.0) are tested against the fixtures in `fixtures/` — never against the real calendar.
6. Atomic conventional commits in English, `type(scope): description (<ID>)` (e.g. `feat(sync): matching cascade (E2-T3)`) — one concern per commit.

## Hard rules (besides the hooks that enforce them)

- **Prod is human.** Never `supabase db push`, `supabase functions deploy`, `supabase secrets`, `supabase link`, or `vercel`. Deploying is not part of your job.
- Never edit `.claude/`, `.github/workflows/` or existing migrations — schema change = new migration.
- Never push directly to `main`, never `--force`.
- **Sensitive data:** fixtures and tests use invented names and phone numbers with a real format (`+59891234567`). Never commit real client data. Never log full phone numbers in production code (last 4 digits is enough).
- **Secrets & real values in ANY tracked file (incl. docs):** never write a real secret, token, key, project-ref, service-account email, calendar id, or personal phone/email into a committed file — **not even in `docs/` or a "copy-paste" deploy checklist** (this is exactly how `WHATSAPP_VERIFY_TOKEN` leaked, 2026-08-03). Real values live only in the gitignored `.env`. In docs and examples use placeholders (`'...'`, `<value>`, `+598...`). A pre-commit hook (`npm run install-hooks`, script `scripts/scan-secrets.sh`) scans for these patterns and blocks the commit; treat a hook hit as a real finding, not a nuisance.
- Timezone for all date logic: `America/Montevideo` (PRD §9.1).

## Delegation (architect → devs)

The session model is the **architect**: it owns the spec, the plan, the review and the final integration. **Architect model: Claude Fable 5 while it's enabled (until 2026-07-19); after that, the best model available on the subscription (Opus).** Mechanical work is delegated to cheaper models — this is the main quota lever:

- **`dev` subagent (Sonnet):** boilerplate, scaffolding, fixtures, repetitive edits, simple CRUD, executing a fully spelled-out spec. Hand it exact instructions: files, names, signatures, expected tests.
- **`reviewer` subagent (Fable while enabled, then Opus):** adversarial review of the diff before every PR: AC, scope, test quality, language.
- **`architect` subagent (Opus):** independent, read-only architecture and security audit. The session designs and writes the change, so it can't objectively audit it. Runs in **plan** mode on every `/task` plan, in **diff** mode before the PR whenever the diff touches a sensitive surface (list in `/task` step 9), and in **audit** mode on the whole repo before any new public surface or before publishing code. Its checklist comes from the 2026-10-11 audit (unguarded service-role Server Actions, account squatting, missing rate limits and daily caps, missing headers, secrets in docs) and from the external-boundary bugs of v3 (Postgres semantics, Google API contract, midnight timing).
- The frontmatter in `.claude/agents/*.md` may lag behind (the agent never edits `.claude/`): the session pins these models per invocation via the Agent tool's `model` parameter until Braulio updates the frontmatter himself.
- **Never delegated:** the matching cascade (§7) and classification (§7.0), timezone logic, webhook signature validation, migration design, anything security-sensitive.
- **Delegation without review is prohibited:** always review a delegate's diff line by line before committing it.

## Quota budget (hard rule)

This project runs on the local Claude Code subscription — no API. No implementation may take the weekly quota past **80%**. What sustains it:

- One task = one session. Sequential by default; up to **2 tasks in parallel** via worktrees when they are independent (see below).
- Delegating mechanical work to the `dev` subagent (Sonnet) is the cheapest way to spend the architect's quota only on architecture and review.
- Implement the minimum that meets the AC — no gold-plating, no opportunistic refactors (those go to `docs/TECH_DEBT.md`).
- If a session balloons beyond the plan (growing scope, very long context), commit the progress, comment the status on the issue and stop — resuming in a fresh session is cheap, an endless session is not.

## Worktrees (parallel tasks)

At most **2 concurrent tasks**, and only if they are independent (no shared files, no migration ordering between them):

```bash
git fetch origin main
git worktree add .claude/worktrees/<ID> -b task/<ID>-<slug> origin/main
# ...work inside .claude/worktrees/<ID>...
git worktree remove .claude/worktrees/<ID>   # after the PR is merged
```

`.claude/worktrees/` is gitignored. If a worktree already exists for the ID, ask: reuse or recreate?

## Tech debt

A real problem outside the task's scope (an obvious refactor, a latent bug, missing coverage elsewhere): don't fix it, don't lose it — record it in `docs/TECH_DEBT.md` (create the file if missing):

```
### [YYYY-MM-DD] <short title>
**Priority**: high | medium | low
**File**: <path>
**Description**: <what needs doing and why>
**Acceptance criterion**: <verifiable outcome>
```

At the start of every `/task`, check for items touching the same files as the task and fold them into the plan (or justify why not).

## Workflow

- One task = one session = one PR. Never mix tasks.
- Everything runs locally: `/task E2-T3`. There is no agent in CI — `agent:ready` issues are worked in local Claude Code sessions.
- Before implementation, invoke the `architect` who criticize the decision and give directives to the dev.
- Before opening the PR, invoke the `reviewer` subagent on the diff (and the `architect` subagent when the diff touches a sensitive surface) and resolve their findings.
- If you're missing a human input (fixtures, CSV, credentials), comment on the issue what's missing and stop — don't invent it.
