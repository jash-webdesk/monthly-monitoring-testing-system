# Monthly Monitoring System - instructions for Claude

One reusable audit engine, one config file per project. Do not create separate apps per client.
Read this file first in every session (local or Claude Code cloud).

## What the user types each month
A short prompt: website URL, month, Before/After performance scores (only for projects that use them), and which outputs to generate. Everything else is collected automatically. The user never supplies audit findings.

Example:
"Run the October 2026 monthly monitoring audit for Genpet. Performance: Homepage Mobile Before 68 -> After 74, Desktop 79 -> 83; About Us Mobile 71 -> 77, Desktop 82 -> 87. Generate: Technical Report, Client Report"

## Spreadsheet mode (preferred for several sites at once)
If the prompt contains a pasted spreadsheet (tab separated, header row first), do not retype its data. Save it exactly as given to `inputs/<month>/sheet-paste.tsv` and use the batch runner:
```
node engine/run-sheet.js --file inputs/<month>/sheet-paste.tsv --dry-run   # parse and validate, runs nothing
node engine/run-sheet.js --file inputs/<month>/sheet-paste.tsv             # one audit per site, in order
```
Columns: `Project | URL | Month | Page | Mobile Before | Mobile After | Desktop Before | Desktop After | Outputs | Dev Team Notes` (see `engine/sheet.js`). URL, Month and Outputs fill down; a new URL starts a new run. The dry run lists every problem (missing scores, unknown site, bad month); report them to the user and stop, do not guess values. Each run is the normal engine, so mandatory scores, per-site logins and guest fallback all still apply.
For an Integrity row, the Dev Team Notes cell is saved to `config/dev-notes/<project>-<month>.txt`. Build the monthly input JSON from it as described below, validate it, then re-run that site with `--reports-only`. The batch summary flags this under `action`.

## Step 1 - identify the project and ask only for what that project needs
Run `node engine/run-audit.js --url <url> --month <YYYY-MM> --dry-run` (add `--scores` if given). The output lists the project, its audits, required environment variables (present or not), and `performanceScores`:

| Project (file in projects/) | URL / domains | Before/After scores | Notes |
|---|---|---|---|
| parts-audio-connexion | partsconnexion.com, audio-connexion.com | REQUIRED, per site, per page, per viewport | The URL picks the site; use `--all-sites` for both. PartsConnexion has a Heroku companion app and USD/CAD currency checks. AudioConnexion has neither. |
| genpet | genpet.org (companion: app.genpet.org) | REQUIRED, per page, per viewport | Companion app is read-only. |
| integrity-reforestation | integrity-dashboard-bf73ab673f4c.herokuapp.com, test-demo-store-801srwej.myshopify.com | NOT USED. Never ask for PageSpeed scores | Audit = read-only admin dashboard QA + dashboard security checks. Client deck needs `config/monthly-monitoring-input-<month>.json`. Widget capture on the Horizon theme is manual (storefront password). |
| lidstyles (legacy) | lidstyles.com | REQUIRED | Kept for archived history. |

Ask the user only for inputs the dry run reports as missing. Number of pages and viewports varies by project and by month; never assume a fixed set and never invent scores. If scores are missing for a scored project, say so; the engine falls back to measured PageSpeed values and records a warning.

## Integrity Reforestation: the monthly text block
The Integrity client deck is built from `config/monthly-monitoring-input-<month>.json`. Most of its content comes from a text block the user pastes into the prompt every month (dev team server and incident notes). Sections of that text, and where they go in the JSON (`opsMonitoringSection`):
- A. Build cache maintenance, with Before/After evidence links per environment -> `buildCacheAnalysis`
- B. Server performance metrics and 24-hour usage (response time, memory, throughput, Heroku metrics URL, usage screencast) -> `performanceMetrics`, `last24HoursUsage`
- C. Resolved incident (what happened, affected endpoint, root cause, resolution steps, status) -> `incidents`
- D. SSL certificate (domain, issuer, issued and expiry dates, screenshot name) -> `sslSecurity`
Also derived: `overview`, `overallSummary`, `finalAssessment`, and the executive summary.

When the prompt contains this block:
1. Read the previous month's input file to learn the exact JSON shape and wording style. Use it as the template, not as content.
2. Write `config/monthly-monitoring-input-<month>.json` for the new month from the pasted text ONLY. Copy every number, URL, date and name exactly as given. Never invent or reuse evidence links, metrics or incident text from a previous month. Narrative bullets (assessments, findings, conclusions) may be written, but only from facts in the text.
3. Anything the text does not cover (theme update versions, widget screenshot links under `themeUpdateLog` and `qaTestingSection`) must come from the user in the prompt. If it is missing, ask for it; do not carry it forward silently.
4. Run `node scripts/validate-integrity-input.mjs --month <month>`. Fix every error. Show the user any stale-carry-over warnings.
5. Then run the engine with `--outputs client` (and `technical`). The engine validates again before building the deck.
Do not ask for PageSpeed scores for this project.

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
2. Commit `reports/`, `history/`, `inputs/` and `config/dev-notes/` to a `claude/...` branch and push (never force-push, never push to main without being asked).
3. Report delivery page: if the Artifact tool is available in this session, build and publish one page per project run:
   `node scripts/build-delivery-page.mjs --project <id> --month <YYYY-MM> --out <file.html>` then publish it with the Artifact tool and `capabilities: {downloads: true}`. The page embeds the finished files and gives a Save button for each (technical PDF, client deck PDF, client deck PowerPoint). Give the user the artifact URL. If the Artifact tool is not available or publishing fails, say so plainly and rely on the GitHub links; never claim a link works that you could not create.
4. End the session with: the delivery page URL if one exists, direct GitHub links to each report file, and a short summary: audits run and their status (failed, skipped, disabled, not_implemented), finding counts, month-over-month changes, regressions, warnings.

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
