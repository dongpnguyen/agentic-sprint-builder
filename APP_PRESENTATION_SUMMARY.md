# Agentic Sprint Builder Presentation Summary

## App Name

Agentic Sprint Builder

## One-Liner

Agentic Sprint Builder is a multi-agent software delivery tool that turns requirements, mockup images, and product assets into a generated full-stack web application, then reviews, deploys, and tests it through an automated SDLC flow.

## Problem

Building a demo application from requirements and UI mockups usually requires several manual steps: analysis, implementation, code review, deployment, bug fixing, and QA testing.

LLM-generated code can also introduce hidden issues such as missing dependencies, broken seed data, CORS errors, invalid Docker config, or incomplete implementation.

## Solution

The app coordinates specialized AI agents to work like a delivery team:

- **BA Agent** analyzes requirements and mockup images, then creates a visual and functional contract.
- **DEV Agent** generates the frontend, backend, database, and seed data.
- **QA Agent** reviews the implementation and checks requirement coverage.
- **DEPLOY Agent** packages and runs the app in containers.
- **Asset Agent** can prepare or download product images when needed.
- **Orchestrator** controls the workflow, routes blockers to the right agent, and decides when to retry, redeploy, or stop.

## Core Flow

1. User enters requirements and optional tech spec.
2. User uploads one or more mockup images.
3. Optional product image assets are uploaded or auto-downloaded.
4. BA converts requirements and images into implementation artifacts.
5. DEV generates the application.
6. Standard Guard Mode validates common failure points.
7. QA reviews the code before deployment.
8. DEPLOY builds and runs containers.
9. QA performs post-deployment readiness checks.
10. User opens the generated product in the browser.

## Key Features

- Multi-image requirement upload.
- Product asset folder upload.
- Optional auto-download of similar product images.
- Clean generated-code workspace before each run.
- Live execution progress screen.
- Timeline of agent activities.
- Structured blocker handoff between agents.
- Automatic fix loops for DEV and DEPLOY issues.
- Docker/Rancher Desktop compatible deployment.
- Post-deployment validation for backend, frontend, seed data, API, and container health.
- Completion dialog with button to open the generated product.

## Standard Guard Mode

Standard Guard Mode reduces common DEV-side bugs before deployment. It checks:

- Frontend install and build.
- Backend dependency install.
- Backend import and compile.
- Seed data execution.
- API contract risks.
- CORS setup.
- Image path validity.
- Dependency compatibility.

If a problem is found, the orchestrator sends a structured fix request back to DEV with evidence and suspected files.

## Technical Stack

Main app:

- Next.js
- TypeScript
- Tailwind CSS
- OpenRouter/OpenAI-compatible LLM provider
- Docker Compose / Rancher Desktop support

Generated app example:

- Next.js frontend
- FastAPI backend
- SQLModel
- SQLite
- Docker Compose

## Business Value

- Speeds up prototype creation from requirements and mockups.
- Reduces manual coordination between analysis, development, QA, and deployment.
- Makes LLM code generation safer through validation gates.
- Provides transparent progress and traceability.
- Helps teams quickly create demo-ready applications from visual inputs.

## Demo Script

1. Open dashboard at `localhost:3002`.
2. Upload requirement mockup images.
3. Optionally upload product image assets.
4. Click **Run AI Team**.
5. Watch live executing steps.
6. Review agent timeline and generated artifacts.
7. Wait for deployment and post-deploy QA.
8. Click **Open Generated Product**.
9. Show generated product running at `localhost:3000`.

## Current Strengths

- Generated product quality is improving through visual contracts and product assets.
- Agent flow now handles deployment and QA more realistically.
- Guard checks catch many common LLM-generated bugs automatically.
- UI now shows live progress, so long runs are easier to understand.

## Future Improvements

- Visual regression comparison against uploaded mockups.
- Run quality score.
- Manual “Send back to DEV” feedback button.
- Diff viewer between runs.
- More reusable golden templates for common stacks.
- Smarter token control for large image-heavy requests.
