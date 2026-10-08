# First cloud run checklist

Do this once, in order. Stop and tell Claude where it stops if any step fails.

## 1. Get the code onto main
The cloud session clones the repo fresh, so the engine must be on the branch it clones.
- Open a pull request from `setup/cloud-engine` into `main` on GitHub, review it, merge it. (Or pick `setup/cloud-engine` as the branch when you start the session.)

## 2. Connect GitHub to Claude Code on the web
- claude.ai/code, connect GitHub, grant access to `jash-webdesk/monthly-monitoring-testing-system` only.

## 3. Create the environment
- Network access: Full (client sites and PageSpeed must be reachable). Custom allowlist alternative: `node scripts/print-allowed-domains.mjs`.
- Setup script: `bash scripts/cloud-setup.sh`
- Environment variables (names in `.env.example`). Required: `PAGESPEED_API_KEY`. Everything else is optional, and a missing login means that step runs as a guest or is skipped. Values are plain text visible to anyone who can edit the environment, so use dedicated low-privilege accounts.

## 4. Smoke test (about 5 minutes, writes nothing real)
Start a cloud session on the repo and paste:

> Follow CLAUDE.md. Run `node scripts/cloud-preflight.mjs` and show me the full output. Then run `node engine/run-audit.js --url https://genpet.org --month 2099-01 --only dns,ssl,network --scores "Homepage Mobile 1>2" --no-history` and show me the run summary. Do not commit anything. Tell me whether the Artifact tool is available in this session.

Expected: preflight shows PASS for internet, DNS, browser; the run completes with dns, ssl and network `completed`. Anything marked FAIL or WARN is what to fix before a real month (see `docs/LIMITATIONS.md`).

## 5. Report delivery test
> Follow CLAUDE.md. Run the full Genpet audit for month 2099-01 with dummy scores `Homepage Mobile 11>22, Desktop 33>44`, outputs technical and client. Publish the delivery page as an artifact if the Artifact tool exists and give me its URL, then push to a claude/ branch and give me the GitHub links. Delete the 2099-01 data from the branch afterwards.

Check: Save buttons work on the page, the client deck PDF exists (needs LibreOffice from the setup script), and the GitHub links open.

## 6. First real month
Use the prompt builder (private artifact in your claude.ai) to produce the prompt, paste it into a new cloud session.

## What a new session does and does not know
- It reads `CLAUDE.md` and the repo, so the rules, project table and workflows are all there.
- It does NOT see earlier conversations or the local auto-memory on your computer. Anything that matters must be in `CLAUDE.md` or `docs/`. If you notice something missing, tell Claude to add it there.
