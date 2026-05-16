# Agentic Sprint Builder

A Next.js-only TypeScript project for the AI Agentic Tech Contest Phase 1.

It demonstrates a markdown-skill multi-agent SDLC pipeline:

```text
requirements.md + tech-spec.md
        |
Orchestrator
        |
BA Agent -> PRD + stories + acceptance criteria
        |
DEV Agent -> architecture + implementation files
        |
QA Agent -> code review + fix request to DEV if needed
        |
DEPLOY Agent -> Docker/local-run files after code review passes
        |
QA Agent -> post-deploy E2E review after deployment succeeds
        |
Contest Dashboard events
```

The project uses four roles: BA, DEV, QA, and DEPLOY. BA analyzes requirements, DEV implements, QA reviews DEV code and sends fixes back to DEV when needed, DEPLOY packages the app only after code review passes, and QA performs post-deployment end-to-end readiness review after deployment artifacts are generated. If post-deployment QA finds container or E2E blockers, it can send one fix request back to DEPLOY.

## Why this project fits the contest

- Uses a real multi-agent workflow: BA, DEV, QA, and DEPLOY.
- Agent skills are written in Markdown under `skills/`.
- Uses OpenRouter as the current LLM gateway.
- Emits dashboard events using the provided contest API.
- Generates Phase 1 implementation artifacts from text requirements and optional requirement/mockup images.
- Includes feedback loops for run/build readiness, code review blockers, and post-deployment E2E blockers.
- Generates Rancher Desktop-compatible local container deployment artifacts through the DEPLOY agent.
- Feeds existing generated code and recent run history back into BA, DEV, QA, and DEPLOY agents for incremental changes.

## Setup

```bash
cp .env.example .env
npm install
npm run dev
```

Open:

```text
http://localhost:3000
```

Run history:

```text
http://localhost:3000/runs
```

## Required environment variables

```bash
LLM_PROVIDER=openrouter
LLM_MAX_TOKENS=16000
OPENROUTER_API_KEY=your_openrouter_api_key
OPENROUTER_MODEL=openai/gpt-4.1-mini
# Optional temporary OpenAI/Codex provider:
# LLM_PROVIDER=openai
# OPENAI_API_KEY=your_openai_api_key
# OPENAI_MODEL=gpt-4.1-mini
DASHBOARD_BASE_URL=https://aitechcontest.kms-technology.com/api
DASHBOARD_COMPANY_ID=
DASHBOARD_COMPANY_NAME=Agentic Sprint Builder
MAX_REQUIREMENT_IMAGES=8
MAX_REQUIREMENT_IMAGE_BYTES=5242880
VALIDATE_GENERATED_EXECUTION=true
ALLOW_GENERATED_DOCKER=true
REQUIRE_DEPLOYED_CONTAINERS=true
GENERATED_FRONTEND_PORT=3000
GENERATED_BACKEND_PORT=8000
GENERATED_COMPOSE_ENGINE=auto
```

## Dashboard registration

Option 1: use UI button **Register Dashboard Company**.

Option 2: call API:

```bash
curl -X POST http://localhost:3000/api/dashboard/register
```

Copy the returned `company_id` into `.env`:

```bash
DASHBOARD_COMPANY_ID=returned-company-id
```

Restart `npm run dev`.

## How skills work

Each agent has a Markdown skill file:

```text
skills/ba.md
skills/dev.md
skills/qa.md
skills/deploy.md
```

The loader reads front matter metadata and the markdown body. The markdown body becomes the system prompt.

Example metadata:

```md
---
agent_id: ba
name: Alice BA
role: analyst
model: gpt-4.1-mini
temperature: 0.2
---
```

## Main files

```text
lib/orchestrator.ts              # Controls BA -> DEV -> QA -> DEPLOY -> QA workflow
lib/openrouter.ts                # OpenRouter client
lib/dashboard.ts                 # Contest dashboard client
lib/skills/loadSkill.ts          # Markdown skill loader
lib/agents/ba-agent.ts           # BA agent
lib/agents/dev-agent.ts          # DEV agent
lib/agents/qa-agent.ts           # QA agent
lib/agents/deploy-agent.ts       # DEPLOY agent
app/api/runs/route.ts            # Run endpoint
app/page.tsx                     # Demo UI
app/runs/page.tsx                # Run history UI
app/runs/[runId]/page.tsx        # Per-run output UI
```

## Demo flow

1. Paste `requirements.md`.
2. Optionally paste `tech-spec.md`.
3. Optionally load up to 8 PNG, JPG, or WebP requirement/mockup images on the dashboard. Each image is treated as a page/screen candidate in upload order.
4. Choose whether to keep **Clean generated code before run** enabled. Keep it on for new requirements; turn it off when you want agents to patch the current generated app.
5. Click **Run AI Team**.
6. Watch BA analysis, DEV implementation, QA code review, DEPLOY packaging, container startup, and post-deployment QA outputs.
7. Deployment only runs after code review passes. DEPLOY generates Docker Compose/local container files, builds and starts the container stack, seeds data when a seed script exists, then QA reviews the running deployment evidence.
8. Check dashboard for events if `ENABLE_DASHBOARD=true` and `DASHBOARD_COMPANY_ID` is set.
9. Run artifacts are written under `generated-runs/{yyyy-MM-dd-HH-mm-ss}`.
10. DEV-generated source files and DEPLOY-generated local container files are written to the fixed `generated-code/` workspace.

On each run, the agents read the current `generated-code/` snapshot plus recent `generated-runs/` history so feature changes can be handled incrementally instead of recreating the project from scratch.
When **Clean generated code before run** is enabled, only `generated-code/` is cleared before BA and DEV read the workspace. `generated-runs/`, `.env`, and the app source are preserved.

## Rancher Desktop deployment

DEPLOY targets Rancher Desktop-compatible local containers.
After DEPLOY writes the artifacts, the orchestrator runs the generated Compose stack from `generated-code/` when `VALIDATE_GENERATED_EXECUTION=true` and `ALLOW_GENERATED_DOCKER=true`. If `REQUIRE_DEPLOYED_CONTAINERS=true`, post-deployment QA is blocked until Docker Compose or nerdctl compose actually starts the stack successfully.

When Rancher Desktop is configured for Docker-compatible mode, use the generated Docker commands from `generated-code`:

```bash
docker compose build
docker compose up -d
docker compose ps
docker compose logs
docker compose down
```

When Rancher Desktop is configured for containerd mode, use the generated nerdctl commands:

```bash
nerdctl compose build
nerdctl compose up -d
nerdctl compose ps
nerdctl compose logs
nerdctl compose down
```

Generated Compose files should avoid Docker Desktop-only features, bind services to `0.0.0.0` inside containers, use service DNS names such as `backend` for container-to-container calls, and expose browser-facing URLs on `localhost`.

## Notes

This project itself does not use Python. The DEV agent may generate Python/FastAPI files if the provided tech spec requires that as the target implementation.
