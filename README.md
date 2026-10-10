# Image Blaster · ChatGPT edition

A local image-to-world workspace powered by **Sign in with ChatGPT and Codex
app-server**, with the original Image Blaster 3D viewer and generation pipeline.
This is a fork of [neilsonnn/image-blaster](https://github.com/neilsonnn/image-blaster),
not an official OpenAI product. The original MIT license and attribution remain.

**Implementation preview:** local tests cover OAuth validation, refresh, account
isolation, app-server messages, approvals, and HTTP security. A real sign-in and
paid end-to-end generation still require validation on an eligible account.

## Start locally

Requirements: Node.js **22+**, a current **Codex CLI** supporting `app-server`, and
the existing viewer dependencies. The new control panel has no npm dependencies.

```sh
git clone https://github.com/ashtonbannister/image-blaster.git
cd image-blaster
git switch codex/chatgpt-login
npm install -g @openai/codex
# Install the original viewer dependencies (Bun's existing workspace):
bun install
# Or, without Bun: npm install --prefix app --workspaces=false
npm start
```

Open the printed **http://127.0.0.1:3210** URL in a browser on the same computer.
Use **Sign in with ChatGPT**, review the consent screen, then choose an available
model. No OpenAI API key or separate Codex login is needed for this path. Account
eligibility and model availability are determined by OpenAI, not this app.

Attach a PNG, JPEG, or WebP image, choose a world name, and start with:

> Analyze this image and propose the objects and generation stages. Do not make
> any paid generation requests yet.

Review the agent's plan and one-time command approvals. Once assets exist, choose
**Load world** or **Open viewer**. The original viewer normally runs on port 5173.
Existing `bun run dev`, `build`, `test`, and `typecheck` commands remain unchanged.

### Provider keys and costs

Copy `.env.example` to `.env` and enter your own `WORLD_LABS_API_KEY` and `FAL_KEY`
locally before requesting provider generation. Never paste credentials into the
chat. Existing `.env` files are loaded by the launcher.

| Capability | Service / billing |
| --- | --- |
| Agent reasoning, image understanding, and tool orchestration | Your authorized ChatGPT plan and limits |
| Static environment, splat, collision mesh | World Labs |
| Reference editing and object meshes | FAL providers |
| Ambient audio and object sounds | FAL / ElevenLabs |
| Viewer and project files | Local computer |

ChatGPT sign-in does **not** cover external generation charges. Hosted image
generation is not used through this token-sharing integration. The existing
image-edit providers remain separate. Set provider-side spending limits too:
command approvals are not hard currency budgets. Stopping the local agent cannot
undo charges or necessarily cancel cloud jobs already submitted.

## What changed

- Browser control panel: account picker, sign-in/out, welcome disclosure, model
  catalog, image upload, streaming chat, per-action approvals, and stop.
- Standards-based PKCE/OIDC login using OpenAI's documented open-source flow.
- Separate credential records and Codex homes; no reuse of `~/.codex/auth.json`.
- Original React / Three.js / Spark / Rapier viewer embedded alongside the agent.
- New Codex `AGENTS.md` and `.agents/skills/image-blast/SKILL.md` workflow.
- Original `.claude/scripts/` paths retained as reusable Node provider adapters.
  Claude itself is not launched or required by the ChatGPT path.

Objects remain `.glb` / `.obj`; environments use `.spz` with collider geometry;
audio remains `.mp3`. Projects and indexed artifact metadata stay in `worlds/`.
Original provider options (Hunyuan face count/PBR/generation type, optional Meshy,
image-edit selection, and audio processing) remain in the existing scripts.

## Configuration and testing

```sh
npm run test:chatgpt
node --check chatgpt/server.mjs
```

These tests use local mocks; they do not contact OpenAI, FAL, or World Labs and do
not spend credits. They do not substitute for the live acceptance checklist in
[docs/chatgpt-login.md](docs/chatgpt-login.md).

Optional environment variables: `IMAGE_BLASTER_PORT` (default 3210),
`IMAGE_BLASTER_VIEWER_PORT` (5173), `IMAGE_BLASTER_NO_VIEWER=1`, and
`IMAGE_BLASTER_CODEX` (a native executable or Codex's `bin/codex.js` path).
Windows npm installations are detected through their JavaScript entry point to
avoid a shell. Native Windows and macOS remain unverified; WSL/Linux is the first
manual validation target. Audio postprocessing also needs ffmpeg and ffprobe.

**Local single-user app only.** Do not deploy the development servers publicly,
expose them on a LAN, or mount untrusted workspaces. See the security boundaries,
storage details, and troubleshooting in [the integration notes](docs/chatgpt-login.md).
