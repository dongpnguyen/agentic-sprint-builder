# Agentic Sprint Builder Instruction Note

## Codex Response Marker

When Codex has finished answering a question or completing a task, the final response should end with:

```text
=====COMPLETE=====
```

## Purpose

Agentic Sprint Builder turns product requirements into a small runnable implementation using a multi-agent workflow. The dashboard accepts text requirements, an optional technical spec, optional requirement/mockup images, and run options.

## Inputs

Use these inputs on the dashboard:

- `requirements.md`: Required. This is the source of truth for scope.
- `tech-spec.md`: Optional. Use it to define stack choices such as Next.js, FastAPI, database, ports, or integration constraints.
- Requirement images: Optional. Upload PNG, JPG, or WebP mockups/screenshots when visual UI context is needed. Each image is treated as a page/screen candidate in upload order.
- Clean generated code before run: Optional. Keep enabled for a new requirement or a clean retest. Disable it only when the team should patch the current `generated-code` app.

## Image And Text Conflict Rule

If the image and `requirements.md` do not match, `requirements.md` wins.

Examples:

- If `requirements.md` says only `Home Page` and `Product Detail Page`, but the image shows checkout or profile pages, those extra screens are out of scope.
- If an image shows a layout, colors, spacing, or UI components for an in-scope page, BA should convert those visual details into concrete requirements.
- If multiple images are uploaded, BA should map each image to a page/screen name, route, purpose, and acceptance criteria.
- If a visual detail is unclear or conflicts with explicit text, BA should document it as an assumption, risk, or conflict instead of silently expanding scope.

Expected BA behavior:

- Extract useful visual requirements from the image.
- Keep explicit text scope authoritative.
- Call out mismatches between text and image.
- Hand DEV only the in-scope requirements.

## Agent Flow

The workflow is:

```text
BA -> DEV -> QA Code Review -> DEPLOY -> QA Post-Deploy E2E
```

### BA

BA analyzes text requirements, optional tech spec, existing generated code, recent run history, and optional requirement image.

BA produces:

- Product summary
- In-scope and out-of-scope items
- User stories
- Visual/UI requirements
- Data/API notes
- Acceptance criteria
- Assumptions, risks, and handoff notes

### DEV

DEV implements the app from BA output and the tech spec.

DEV produces:

- Architecture summary
- Generated implementation files
- Setup/run/build/test instructions

DEV should not own Docker packaging. Docker/local container packaging belongs to DEPLOY.

### QA Code Review

QA reviews DEV output before deployment.

QA checks:

- Requirements fit
- Missing files or dependency manifests
- Build/run readiness
- API and CORS wiring
- Likely runtime blockers
- Regression risk

If QA finds blocking issues, QA sends fix instructions back to DEV. Deployment is skipped until code review passes.

### DEPLOY

DEPLOY runs only after QA code review passes.

DEPLOY creates local deployment packaging:

- Docker Compose files
- Dockerfiles
- `.dockerignore`
- Environment examples
- Health check expectations
- Build/run/log/shutdown commands
- Rancher Desktop command variants for `docker compose` and `nerdctl compose`

After packaging, DEPLOY must build and start the generated container stack locally before QA post-deployment E2E review. The orchestrator runs the generated Compose stack from `generated-code/`, waits for backend and frontend health, and runs `backend/seed_data.py` inside the backend container when that script exists.

### QA Post-Deploy E2E

QA reviews the deployment output and defines end-to-end validation.
QA post-deploy review must use the actual container execution evidence. If the container stack did not start successfully, QA should report `NEEDS_FIX` instead of treating E2E as complete.

QA checks:

- Docker Compose completeness
- Ports and environment variables
- Frontend/backend connectivity
- Health checks
- Browser happy path
- API/health verification
- Negative/error scenarios

If post-deploy QA finds deployment blockers, feedback goes back to DEPLOY.

## Rancher Desktop Deployment

The DEPLOY agent should generate local container artifacts that run on Rancher Desktop.

Use `docker compose` when Rancher Desktop is running in Docker-compatible mode:

```bash
docker compose build
docker compose up -d
docker compose ps
docker compose logs
docker compose down
```

Use `nerdctl compose` when Rancher Desktop is running in containerd mode:

```bash
nerdctl compose build
nerdctl compose up -d
nerdctl compose ps
nerdctl compose logs
nerdctl compose down
```

Expected deployment artifact rules:

- Compose files must work from the root `generated-code` folder.
- App servers must bind to `0.0.0.0` inside containers.
- Browser URLs should use `localhost`.
- Container-to-container calls should use service names such as `backend`.
- Deployment should not require Docker Desktop-only features or cloud registries.

## How To Use

1. Open the dashboard.
2. Paste `requirements.md`.
3. Optionally paste `tech-spec.md`.
4. Optionally upload one or more requirement/mockup images.
5. Keep `Clean generated code before run` enabled for new requirements, or turn it off for incremental fixes to the current generated app.
6. Click `Run AI Team`.
7. Review BA output first to confirm scope and image interpretation.
8. Review DEV output and QA code review.
9. If code review passes, review DEPLOY output.
10. Review post-deploy QA E2E guidance.

## Important Notes

- Do not put secrets into `requirements.md`, `tech-spec.md`, or uploaded images.
- Do not commit `.env`; it contains local API keys.
- Uploaded images are sent to the LLM for BA visual analysis.
- Run history stores only image metadata, not the base64 image content.
- Cleaning generated code removes only `generated-code/`; it preserves `generated-runs/`, `.env`, and the application source files.
- Current image count limit is controlled by `MAX_REQUIREMENT_IMAGES`.
- Current image upload limit is controlled by `MAX_REQUIREMENT_IMAGE_BYTES`.
