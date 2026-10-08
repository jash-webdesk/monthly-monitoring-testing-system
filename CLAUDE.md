# Monthly Monitoring System - instructions for Claude

One reusable audit engine, one config file per project. Do not create separate apps per client.
Read this file first in every session (local or Claude Code cloud).

## What the user types each month
A short prompt: website URL, month, Before/After performance scores (only for projects that use them), and which outputs to generate. Everything else is collected automatically. The user never supplies audit findings.

Example:
"Run the October 2026 monthly monitoring audit for Genpet. Performance: Homepage Mobile Before 68 -> After 74, Desktop 79 -> 83; About Us Mobile 71 -> 77, Desktop 82 -> 87. Generate: Technical Report, Client Report"

## Step 1 - identify the project and ask only for what that project needs
Run `node engine/run-audit.js --url <url> --month <YYYY-MM> --dry-run` (add `--scores` if given). The output lists the project, its audits, required environment variables (present or not), and `performanceScores`:

| Project (file in projects/) | URL / domains | Before/After scores | Notes |
|---|---|---|---|
| parts-audio-connexion | partsconnexion.com, audio-connexion.com | REQUIRED, per site, per page, per viewport | The URL picks the site; use `--all-sites` for both. PartsConnexion has a Heroku companion app and USD/CAD currency checks. AudioConnexion has neither. |
| genpet | genpet.org (companion: app.genpet.org) | REQUIRED, per page, per viewport | Companion app is read-only. |
| integrity-reforestation | integrity-dashboard-bf73ab673f4c.herokuapp.com, test-demo-store-801srwej.myshopify.com | NOT USED. Never ask for PageSpeed scores | Audit = read-only admin dashboard QA + dashboard security checks. Client deck needs `config/monthly-monitoring-input-<month>.json`. Widget capture on the Horizon theme is manual (storefront password). |
| lidstyles (legacy) | lidstyles.com | REQUIRED | Kept for archived history. |

Ask the user only for inputs the dry run reports as missing. Number of pages and viewports varies by project and by month; never assume a fixed set and never invent scores. If scores are missing for a scored project, say so; the engine falls back to measured PageSpeed values and records a warning.

## Step 2 - run
```
node engine/run-audit.js --url <url> --month <YYYY-MM> --scores "<text>" --outputs technical,client
```
- `--scores` accepts compact text ("Homepage Mobile 68>74, Desktop 79>83; About Us Mobile 71>77, Desktop 82>87"), `--scores-json '<json>'`, or `--scores-file <path>`.
- `--outputs`: `technical` (PDF report) and/or `client` (PowerPoint deck). Either or both.
- `--only a,b` / `--skip a,b` choose audits: network, dns, ssl, seo, ai-crawlers, performance, security, currency, companion-app, functional, cache.
- `--reports-only` regenerates reports from existing results. `--stage before` captures a same-month PageSpeed baseline (no reports).
- In the cloud, foreground commands time out after about 2 minutes. Run the audit in the background (`run_in_background`) redirecting to a log, and poll the log.
- A failed audit is recorded as `failed` and the rest continue. Report any failed, skipped, disabled or not_implemented audit to the user honestly in the summary.

## Step 3 - deliver
1. Reports are copied to `reports/<project>/<YYYY-MM>/`; the normalized record is `history/<project>/<YYYY-MM>.json` (includes new/persisting/resolved findings and metric changes vs the previous month).
2. Commit `reports/` and `history/` to a `claude/...` branch and push (never force-push, never push to main without being asked). End the session by giving the user direct GitHub links to each report file and a short summary: audits run and their status, finding counts, month-over-month changes, regressions, warnings.

## Architecture
```
prompt -> engine/identify.js -> projects/<id>.json -> engine/run-audit.js
       -> audits/<category>/index.js (wraps runners/*.js) -> raw runner results (results/, ignored by git)
       -> engine/history.js (normalize + compare) -> history/
       -> engine/reports.js -> report/generator.js, generate_ppt_report.js, generate_integrity_technical_report.js, generate_tree_widget_report.js
```
Existing runners and report generators are reused, not rewritten. `lib/net.js`, `lib/browser.js`, `lib/resolver.js` make everything work behind the cloud egress proxy (fetch, https, Chromium, DNS-over-HTTPS, browser-based SSL read).

## Safety rules (do not relax)
- Never commit secrets. Credentials come only from environment variables (names in `.env.example`). Never print them.
- Companion apps are READ-ONLY. The runners abort every non-GET request after login and report it as critical. Do not whitelist a write request (for example POST /api/users/singleUser) without explicit user sign-off.
- Never type a password into a browser for the user. The Shopify storefront password is entered by the user.
- Do not accept terms, create accounts, check out or place orders on client sites.
- Test with a fake month such as `2099-01` and delete it afterwards, so real results are never overwritten.
- No emojis in docs or code comments.

## Cloud notes
See `docs/CLOUD.md` (setup, network access, environment variables, sharing) and `docs/LIMITATIONS.md`. Run `node scripts/cloud-preflight.mjs` first in a cloud session; it checks the browser, DNS, proxy and environment variables.
