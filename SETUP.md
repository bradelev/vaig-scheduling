# Agentic kit setup — VAIG v2

## 0. Local requirements

Node 20, `supabase` CLI (only for `migration new` — **no Docker**: the Supabase stack runs exclusively in CI), `gh` CLI authenticated, `jq` (the hooks use it), Claude Code with a subscription.

## 1. Install the kit (corresponds to E0-T1) — ✅ done

1. Kit at the repo root together with `PRD.md`.
2. `chmod +x .claude/hooks/*.sh`
3. Initial commit and push to `main`.
4. `main` protected: require PR + status check `check` (CI is the real referee).

## 2. Operating mode: local, no API

All agentic work runs in **local Claude Code sessions on the subscription** — the Anthropic API is not used: no GitHub App, no `ANTHROPIC_API_KEY` in Actions, no `@claude` workflow. CI (`ci.yml`) keeps running on GitHub as the referee for PRs (it doesn't consume Claude quota), and it is the only place where the Supabase stack (Docker) exists — it also runs the integration tests that can't run locally.

**Hard budget:** no implementation may take the weekly quota past **80%**. Check `/usage` before starting a task; the session rules that sustain the budget live in `CLAUDE.md`. The main lever: the architect (session model) delegates mechanical work to the `dev` subagent (Haiku) and reviews everything.

**Never load production secrets (WhatsApp, service account, prod service role) into Actions.** CI runs 100% against the runner's local stack.

## 3. Session 0 — from the PRD to the issues

```
claude
> /create-issues
```

Review the created issues (2 min). The `agent:ready` ones are delegable; the `human` ones are yours.

## 4. Operating

- `claude` → `/task E0-T2`. One task = one session = one PR. Sequential by default; up to **2 independent tasks in parallel** via worktrees (see CLAUDE.md).
- **Architect model:** start sessions on **Fable 5** (`/model`) while it's enabled — until **2026-07-19** — then fall back to the best subscription model.
- Before starting a task, check `/usage`: if you're close to 80% of the weekly quota, the task waits for next week.
- **If CI fails on a PR:** resume in a local session on the branch and fix until green.
- **Your role:** merge PRs, do the `human` tasks, unblock.

## 5. Critical sequence (from the PRD)

1. **Today, before anything else:** E4-T1 — template submitted for Meta approval (lead time of hours to days).
2. E0-T2 as soon as the kit is committed (creates the scaffold and the `check/lint/typecheck/test/test:functions/test:integration` scripts that CI and the hooks expect — the contract is in CLAUDE.md).
3. **Early:** E1-T3 (CSV) and E2-T2 (**anonymized** fixtures: invented names and phone numbers with a real format). Without these inputs the agents build against mocks and verification loses its teeth.

## 6. What this kit deliberately does NOT automate

- The **merge**: it's your control point. Don't enable auto-merge.
- The **deploys** (`db push`, `functions deploy`, `secrets`, Vercel): human task, enforced by the hooks + denylist.
- Editing `.claude/` and `.github/workflows/`: the agent doesn't edit its own cage.
