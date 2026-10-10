# ChatGPT integration notes

## Architecture

Browser (127.0.0.1:3210) -> dependency-free Node control server -> local Codex
app-server over stdin/stdout -> OpenAI Responses with the authorized OAuth token.
The agent invokes the existing Node scripts for separately billed provider work.
The original Vite/React viewer runs independently at 127.0.0.1:5173 and is framed
by the control panel. A failed viewer does not sign the user out.

The OAuth flow is the documented **open-source ChatGPT plan-sharing flow**,
not a copied Codex client ID, extracted session cookie, backend-api proxy, or
OpenAI API-key conversion. First login uses `dynamic_agent_client`; later logins
reuse the issued client ID and stable host ID for that account registration.
Fresh state, nonce, and PKCE are generated for every attempt. A returning callback
must match the stored identity before any credential record is replaced.

Token signature, issuer, audience, expiry, and nonce are verified before use.
Signed identity alone does not authorize plan usage: the granted OAuth scopes
must include `chatgpt.tokens.use.direct`. Model choices come from the OAuth model
catalog, not a hardcoded list or the app-server's bundled catalog.

Codex receives the access token through its child environment, not command-line
arguments. It uses the HTTP Responses provider with `requires_openai_auth=false`
and WebSockets disabled. Token rotation restarts that child and resumes the saved
world thread. Failed/interrupted turns are displayed distinctly from completion.
Unsupported new app-server permission/tool requests fail closed, not auto-approve.

## Storage and security boundaries

Per-checkout state is stored outside the repository under
`~/.image-blaster/<hash-of-absolute-checkout-path>/`. `accounts.json` contains the
stable host, separate client/account records, and credentials. `threads.json`
stores per-account/world thread IDs. `codex/<account-id>/` holds isolated Codex
state. This app never imports or changes the user's normal `~/.codex` login.

On POSIX, directories/files are created with modes 0700/0600 and JSON updates use
atomic replacement. Tokens are **not encrypted at rest**. Use OS disk encryption
and protect the home folder; on Windows verify the directory ACL permits only
your user. Any local program running as your user is inside this trust boundary.
Do not share this state directory or include it in support bundles.

A process lock prevents two copies of this launcher from racing token refresh
for the same checkout. Copying the private store elsewhere defeats that boundary.
Moving the checkout creates a new storage namespace; reconnect rather than
mixing registrations or copying tokens by hand.

The control server binds only to 127.0.0.1. It validates the exact Host, request
Origin, and a random local control token for API calls. It exposes only explicit
UI assets, not repository files or secrets. OAuth callbacks use single-use state
validation instead of the local API token. The UI uses textContent for model
output, a restrictive CSP, and no persistent browser credential storage.

Uploads accept PNG/JPEG/WebP signatures, limit size to 20 MB and eight attachments
per turn, assign filenames on the server, reject symlinked inputs, and do not
serve uploaded files as active browser content. Signature checks do not prove an
image is well-formed; the image decoder can still reject a malformed file.
Removed attachments remain in input/ and should not be staged automatically.

The original Vite viewer and original generation scripts are **not a hardened
multi-user service**, and this change is not a complete audit of them. Run only
trusted code/workspaces. The agent is still a local code executor: approval can
authorize commands with filesystem/network access. Review complete commands,
including scripts that commands invoke. Prompt guidance is not a security sandbox.
The conservative Codex sandbox and one-time approvals are defenses, not a promise
that arbitrary approved code cannot access data available to your OS account.

Sign out stops local work, attempts renewable-session revocation with retry,
clears tokens locally, and retains nonsecret registration identity. A revocation
failure is disclosed; disconnect the app in ChatGPT Settings to revoke remotely.
The Stop control interrupts local work only. Provider jobs can continue after the
local process stops, and charges are not reversed.

## Live acceptance checklist (not run by the mock suite)

1. Start from a fresh private state directory on a supported desktop with Codex
   installed. Complete real ChatGPT consent. Confirm the welcome message and
   available models; make one explicitly approved small inference request.
2. Reconnect the saved account. Confirm the same registration is reused. Sign in
   with another account/workspace and verify histories and credentials separate.
3. Exercise real token refresh, interrupted turn, model/plan denial, expired
   session, account logout, and remote revocation. Confirm failures stay visible.
4. Install the original viewer dependencies and confirm empty state, world load,
   editing, and refresh of real generated artifacts. Run the original viewer
   test/build/typecheck commands separately.
5. With explicit spending approval, run one source through analysis, selected
   object confirmation, plate, world, one mesh, and one sound. Check actual output
   files, local loading, and provider billing. No such calls belong in unit tests.
6. Validate native Windows and macOS launch, callback routing, permissions, and
   Codex sandbox behavior before claiming cross-platform support.

## Troubleshooting

- **Codex CLI not found:** install a current `@openai/codex`, or point
  `IMAGE_BLASTER_CODEX` at its native executable or `bin/codex.js`. The override
  is a single executable path, not a shell command with embedded arguments.
- **Viewer missing:** install the original dependencies with Bun, or run
  `npm install --prefix app --workspaces=false`. Check the terminal for port
  conflicts. The control panel can start before dependencies are installed.
- **Browser is on another machine:** the OAuth callback must reach the same
  loopback listener. This edition is not a remote-hosted login implementation.
- **API request authorization failed after restart:** reload the page to obtain
  the new local control token. Browser credential material is not persisted.
- **Pending sign-in:** return to the control panel and use Cancel sign-in before
  starting another turn. An expired/denied callback cannot authorize inference.
- **Paid step failed:** inspect existing request metadata. Repair local files
  rather than silently resubmitting a generation. Consult provider-side usage.
- **An old process left a lock:** first verify that its PID is no longer running.
  The launcher automatically removes locks only for confirmed nonexistent PIDs.

## Official references used for the implementation

Verified October 10, 2026. Preview APIs may change; recheck these when updating.

- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Codex app-server provider](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [App-server protocol](https://learn.chatgpt.com/docs/app-server)
- [Manage ChatGPT usage](https://chatgpt.com/settings/usage)
