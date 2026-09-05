# Source of Truth — Repository B

> **Read this before acting on anything else in this repository.**

**Governance for this codebase does not live here.** This repository holds the code for `app.dongchannel.com`. Requirement IDs, acceptance criteria, statuses, evidence and decisions are all recorded in **Repository A**.

## Where governance lives

| | |
|---|---|
| **Repository A** | `dongchannel-website` |
| **GitHub** | `https://github.com/dongmd/dongchannel-website.git` · branch `main` |
| **Local path** | `D:\Project\update-my-website\dongchannel-dot-com` |

| Authority | Path in Repository A |
|---|---|
| **Master PRD** | `docs/v3/PRD_DongChannel_AI_Money_OS_FINAL.md` |
| **Master TDD** | `docs/v3/TDD_DongChannel_AI_Money_OS_FINAL.md` |
| **Active execution — scope** | `docs/v2/PRD_V2.md` |
| **Active execution — design** | `docs/v2/TDD_V2.md` |
| **Task order** | `docs/v2/IMPLEMENTATION_PLAN.md` |
| **Status, evidence, debt, decisions** | `docs/v2/IMPLEMENTATION_TRACEABILITY.md` |
| **This repo's own index** | `docs/00_SOURCE_OF_TRUTH.md` in Repository A |

---

## ⛔ Fail closed if you cannot read Repository A

If a session has this repository open but **cannot access Repository A's governance documents**, then:

1. **Do not** infer scope from `docs/PRD.md` or `docs/TDD.md` in this repository. They are **SUPERSEDED** and describe a narrower, earlier product.
2. **Do not** start a new requirement.
3. **Report that the governance source is unavailable** and stop.

Guessing the requirement from local documents is the specific failure this file exists to prevent. The legacy documents here are internally coherent and confidently written, which makes them more dangerous than an obvious gap — they describe an "AI Operations Hub" dashboard, not the AI Money OS this codebase has become.

---

## Architecture rules that bind this repository

- **`dongchannel-ops-hub` (this repo) is the canonical source for `app.dongchannel.com`.** Do not create a second application, service or runtime for it.
- **PostgreSQL `dongchannel_ops` is the System of Record** for the AI Money OS. There is exactly one, and its schema is owned by **one Drizzle migration chain** in `app/src/lib/db/migrations`. Do not introduce a second schema owner, a second migration tool, or a second canonical database.
- **Hermes is an agent runtime, not a System of Record.** Agent output that matters must be normalised into PostgreSQL. Hermes memory is supplemental context only.
- **WordPress MySQL and PostgreSQL never read or write each other directly.** Integration is an authenticated REST API in both directions. No cross-database queries, no shared credentials, no replication.
- **n8n is an orchestration layer.** It owns no entity and holds no core business logic.

---

## Document status in this repository

| File | Status |
|---|---|
| `docs/PRD.md` | **SUPERSEDED** — 2026-07-21, "AI Operations Hub". Superseded by Repository A's Master PRD + `PRD_V2.md` |
| `docs/TDD.md` | **SUPERSEDED** — 2026-07-23. Superseded by Repository A's Master TDD + `TDD_V2.md` |
| `docs/PRD_TDD_DongChannel_AI_Operations_Hub.md` | **ARCHIVED** — a combined copy of the two files above |
| `docs/security-audit.md`, `docs/google-oauth-setup.md`, `docs/dashboard-discovery.md` | **REFERENCE** — still useful operationally |
| `hermes-or-openclaw/*.md` | **REFERENCE** — Hermes runtime notes |
| `CLAUDE.md` | **REFERENCE** — repo conventions; scope comes from Repository A |

**None of these are deleted.** They are provenance for how the system got here.

---

## Deployment ownership

Claude Code performs deployment. **The owner does not deploy.** The owner reviews and approves decisions, content, security and scope where a requirement calls for it.

> ### Zero-touch mandate — owner instruction, 2026-09-05
>
> **Claude Code Desktop deploys production directly.** The full pipeline —
> `coding → test/lint/typecheck → commit → push → deploy → PM2 restart →
> health check → smoke test → verify` — runs **autonomously, with no
> confirmation between steps**, for anything inside project scope reachable
> with access Claude already holds (SSH to `vocapro` is configured and
> sufficient).
>
> On failure: investigate, fix, or **roll back to the last stable commit**, then
> report. Ask the owner only for MFA / expired credentials, insufficient access,
> or a real risk of **data loss or an unrollbackable outcome**.
>
> **The earlier "Desktop must not deploy; CLI is the only deployer" split is
> WITHDRAWN.** It cost a session: Desktop completed `P4-R08 AC-10`, could not
> demonstrate it, and produced a `READY_FOR_PROD` handoff for a deploy that then
> had to be routed elsewhere. Both Desktop and CLI deploy, through the same
> gates below — the gates are the safety mechanism, not the choice of tool.
>
> Autonomy over pacing is **not** autonomy over truth: a green deploy still
> proves only that the pipeline ran. Nothing becomes `VERIFIED` because it
> deployed. Full text: Repository A's `docs/WORKING_PROTOCOL.md` §0.

```
code → gated tests/build → commit → push
     → VPS deploy pipeline → backup → migrate (if needed)
     → PM2 restart → health verification
```

Run it with `bash app/deploy/deploy-vps.sh` on the VPS. The gate order is fixed:

```
lint → typecheck → test → build
══ nothing touches the database above this line ══
backup → migrate → seed (opt-in) → restart
→ local health → external health → root → evidence
```

**Do not reorder so that migration runs before the application gates.** That ordering is what left the database ahead of the running app in TD-18, and `app/deploy/test-deploy-guards.sh` exists to keep it from coming back. Run that suite after any change to the deploy script.

Two behaviours worth knowing before mistaking them for bugs:

- The deploy script re-execs from `/tmp` before pulling, so **a change to the script itself takes effect on the next deploy** (TD-19).
- Seeding is opt-in: `DEPLOY_RUN_SEED=1`. Production does not seed by default.

---

## Working protocol

Repository A's `docs/WORKING_PROTOCOL.md` governs **how batches are paced and
handed back** in every Claude Code session, on this repository too. **As amended
2026-09-05 (§0, zero-touch):** for work inside project scope, run the whole
pipeline through production verification without pausing for approval, and
report what was done; propose the next batch but do not wait on it. Stop only
for MFA / credentials, insufficient access, or risk of data loss or an
unrollbackable outcome. It changes no requirement and no architecture.

## Status report header

Every status report starts with these five lines:

```
REPOSITORY
SOURCE OF TRUTH
CURRENT REQUIREMENT
DEPLOY TARGET
STATUS
```

## Cross-repository work

A requirement needing changes in both repositories carries **separate commits, deployments and evidence per repository**.
