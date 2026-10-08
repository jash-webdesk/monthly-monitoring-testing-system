# Running the monthly audit in a Claude Code cloud session

The audit runs on Anthropic's cloud VM, not on your laptop. The repository is the single source of truth: the session clones it fresh, runs the engine, and delivers results by pushing to a `claude/...` branch. No paid hosting, VPS or database is involved; usage counts against your Claude plan.

## One-time setup (about 10 minutes)

1. **Repo access.** In claude.ai/code connect GitHub and grant access to `jash-webdesk/monthly-monitoring-testing-system` (private).
2. **Create an environment** (Claude Code on the web, environment settings):
   - Network access: **Full** (or Custom with the allowlist printed by `node scripts/print-allowed-domains.mjs`). The default "Trusted" level does not reach client websites.
   - Setup script: `bash scripts/cloud-setup.sh`
   - Environment variables (names are in `.env.example`; values are plain text visible to anyone who can edit the environment, so use dedicated low-privilege or read-only monitoring accounts):
     `PAGESPEED_API_KEY`, `UPTIMEROBOT_API_KEY`, `GENPET_CUSTOMAPP_USERNAME/PASSWORD`, `PARTSCONNEXION_CUSTOMAPP_USERNAME/PASSWORD`, `INTEGRITY_CUSTOMAPP_USERNAME/PASSWORD`.
     Every login is optional, and each belongs to one site only (storefront logins: `PARTSCONNEXION_STOREFRONT_*`, `AUDIOCONNEXION_STOREFRONT_*`, `GENPET_STOREFRONT_*`). Leave a pair out and that step runs without logging in: the security audit runs as a guest, a companion app gets only its unauthenticated health check, and the Integrity dashboard audit is skipped because everything in it is behind the login. Only `PAGESPEED_API_KEY` is needed for the performance audit.
3. **Merge `setup/cloud-engine` into `main`** (or select that branch when starting the session) so the engine is in the repo the session clones.

## Every month

1. Open claude.ai/code (or the Claude desktop app, Code tab), choose the repo and the environment, and start a cloud session.
2. Paste a prompt such as:
   > Run the October 2026 monthly monitoring audit for Genpet. Performance: Homepage Mobile Before 68 -> After 74, Desktop 79 -> 83; About Us Mobile 71 -> 77, Desktop 82 -> 87. Generate: Technical Report, Client Report
   For Integrity Reforestation, give only the month and outputs (no performance scores):
   > Run the October 2026 monthly monitoring audit for Integrity Reforestation. Generate: Technical Report
3. Claude reads `CLAUDE.md`, runs `node scripts/cloud-preflight.mjs`, identifies the project from the URL, runs `node engine/run-audit.js ...` in the background, polls the log, commits `reports/` and `history/` to a `claude/...` branch, and replies with links to each report on GitHub.
4. You can close the laptop once the session is running; the session continues in the cloud. Open the GitHub links (or the PR) to download the reports.

## Where results live
- `reports/<project>/<YYYY-MM>/` - finished PDF and PPTX files (committed)
- `history/<project>/<YYYY-MM>.json` - normalized results and month-over-month comparison (committed)
- `results/` - raw runner output and screenshots (not committed; lost when the VM ends)

## Sharing with teammates
- The repo is the source of truth. Add teammates as GitHub collaborators (Settings, Collaborators). They get the code, configs, reports and history, but nothing from your Claude environment.
- A teammate starts their own cloud session with their own Claude account and must create their own environment with their own variables. Sessions are private to the account that started them. Shared environments exist only on Team and Enterprise plans, and then the variables are visible to anyone who can edit that environment.
- Do not share your personal logins. Create dedicated monitoring users for each client application and rotate them if someone leaves.
- Never commit values from `.env`; `.gitignore` excludes it.

## Cowork vs Claude Code cloud
Use Claude Code cloud for this system. It clones a GitHub repo, has a shell, Node and git, and can push branches. Cowork has no documented GitHub-repo or cloud-shell workflow, so the system does not depend on it.
