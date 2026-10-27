# Developer Guide - Monthly Monitoring Testing System

Audience: a developer taking over this project. Read this top to bottom once, then use the "Where to change things" table (section 9) as a lookup.

Companion documents:
- `CLAUDE.md` - how a monthly run is requested and delivered, and the safety rules. Always read it first.
- `docs/PROJECT_CONTEXT.md` - client background, user preferences, per-project facts, current state of the build.
- `docs/CLOUD.md`, `docs/FIRST_CLOUD_RUN.md`, `docs/LIMITATIONS.md` - running in a Claude Code cloud session, and known gaps.

---

## 1. What this system is

One reusable audit engine and one config file per client project. Every month you give the engine a website URL and a month; it audits the live site, stores the results, compares them with last month, and produces the client reports (a PowerPoint deck and, for most projects, a PDF technical report). It never changes anything on a client site.

There are no separate apps per client. A new client means a new file in `projects/`, plus a report generator only if the client needs a different report design.

```
URL + month (+ scores)                            one command
        |
engine/identify.js     URL -> project file (projects/<id>.json)
        |
engine/run-audit.js    runs the enabled audits in order
        |
audits/<name>/index.js each audit wraps one or more runners
        |
runners/*.js           do the real work (HTTP checks, browser, DNS, TLS, Lighthouse ...)
        |
results/<site>/<month>/*_result.json     raw output, one file per runner (git-ignored)
        |
lib/differ.js + engine/history.js        new / persisting / resolved findings, metric changes
        |
history/<project>/<month>.json           permanent record (committed)
        |
engine/reports.js      picks the report generator(s) for the project
        |
generate_*.js, report/generator.js       build the PDF / PPTX
        |
reports/<project>/<month>/               finished client files (committed)
```

## 2. Quick start

Requirements: Node 22 or newer, a Chromium that Playwright can launch (`node scripts/ensure-browser.mjs` installs one), and optionally PowerPoint (Windows) or LibreOffice for the deck-to-PDF conversion.

```
npm install
cp .env.example .env            # fill in only the secrets you have; every login is optional
npm test                        # unit tests, must be green before any commit
node engine/run-audit.js --url https://www.ourgreenhouse.com --month 2026-10 --dry-run
node engine/run-audit.js --url https://www.ourgreenhouse.com --month 2026-10 --outputs client
```

`--dry-run` identifies the project, lists its audits, shows which environment variables are present, and reports what inputs are still missing. It runs nothing. Use it first, always.

Command line flags of `engine/run-audit.js`:

| Flag | Meaning |
|---|---|
| `--url <url>` | Site to audit. The hostname selects the project and site. |
| `--project <id>` with `--all-sites` | Run every site of a project (for example PartsConnexion and AudioConnexion). |
| `--month YYYY-MM` | Audit month. Decides the results, history and report folder names. |
| `--scores "<text>"`, `--scores-json '<json>'`, `--scores-file <path>` | Before/After performance scores from the monthly prompt (scored projects only). Parsed by `engine/scores.js`. |
| `--cwv "<text>"` | Desktop LCP and CLS supplied by the prompt (Parts/Audio). |
| `--outputs technical,client` | Reports to build. `client` is the PowerPoint deck (and PDF copy), `technical` the PDF report. |
| `--only a,b` / `--skip a,b` | Run or skip audits by name (list in section 5). |
| `--stage before` | Capture a same-month PageSpeed baseline; builds no reports. |
| `--reports-only` | Rebuild reports from the saved results; measures nothing. |
| `--no-history` | Do not write `history/`. Use when testing. |
| `--timeout-min <n>` | Per-audit time limit (default 25 minutes). |
| `--no-env` | Ignore `.env` (rehearses a run with no secrets). |

Batch mode for several sites: `node engine/run-sheet.js --file inputs/<month>/sheet-paste.tsv [--dry-run]`. The sheet format is described in `engine/sheet.js` and `CLAUDE.md`.

Always test with a fake month such as `2099-01` and delete `results/*/2099-01`, `history/*/2099-01.json` and `reports/*/2099-01` afterwards, so real months are never overwritten.

## 3. Repository map

### 3.1 Root

| Path | Purpose |
|---|---|
| `CLAUDE.md` | Instructions for the AI session that runs the monthly audit: the prompt format, project table, safety rules. Read by every session. |
| `package.json`, `package-lock.json` | Dependencies and npm scripts (`audit`, `preflight`, `ensure-browser`, `test`, `test:integration`). ES modules (`"type": "module"`). |
| `.env.example` | Names (never values) of every environment variable. Copy to `.env`, which is git-ignored. |
| `.gitignore` | Keeps secrets, `results/`, `scratch/`, and loose office files out of git. `reports/`, `history/`, `inputs/`, `templates/` are tracked. |
| `.agents/AGENTS.md` | Short pointer for AI agents to the three documents above. |
| `white-logo.png` | WebDesk logo used by the report generators. |
| `generate_ppt_report.js` | Client deck for the "optimization report" projects (Genpet, PartsConnexion, AudioConnexion, legacy LidStyles). Reads saved results and scores; builds the deck with pptxgenjs. |
| `generate_tree_widget_report.js` | Client deck (PPTX and PDF) for Integrity Reforestation. Content comes from `config/monthly-monitoring-input-<month>.json`, not from measurement. |
| `generate_integrity_technical_report.js` | Technical PDF for the Integrity admin dashboard QA, from `integrity_dashboard_result.json`. |
| `generate_ogh_report.js` | Our Green House client deck. Patches `templates/ogh/monthly-report-template.pptx` with the month's results (section 7.4). |
| `scratch/` | Local working area, git-ignored. Safe to delete. Not part of the system. |

### 3.2 `engine/` - the orchestration layer

| File | Purpose |
|---|---|
| `run-audit.js` | The main command. Parses flags, identifies the project, validates required inputs (scores), runs each enabled audit with a timeout, saves raw results, diffs against last month, writes history, calls `reports.js`, prints a JSON summary. A failed audit is recorded as `failed` and the rest continue. |
| `run-sheet.js`, `sheet.js` | Batch runner and its spreadsheet parser. One audit run per site found in a pasted TSV/CSV. Saves the paste under `inputs/<month>/`. |
| `identify.js` | Maps a URL or hostname to a project and site using the `domains` lists in `projects/*.json`. |
| `scores.js` | Parses and normalises the Before/After performance scores and the desktop LCP/CLS figures given in the prompt. Scores are never hard-coded or replaced by measurements. |
| `history.js` | Builds and stores the normalised monthly record (`history/<project>/<month>.json`): findings, key metrics, audit statuses, and the comparison with the previous month. |
| `reports.js` | Chooses what to build per project (`reports.client` / `reports.technical` in the project file), runs the generators, converts decks to PDF, copies finished files to `reports/<project>/<month>/`. |

### 3.3 `audits/` - one folder per audit category

An audit is a thin module exporting `meta` (name, description) and `run(ctx)`. It calls one or more runners and returns `{ status, runners, findings, metrics }`. `audits/index.js` is the registry and defines the execution order. `audits/_shared.js` holds helpers (run a runner per configured page, combine results, save to the archive).

| Audit (`--only` name) | What it checks | Runner(s) used |
|---|---|---|
| `network` | Availability and response time. UptimeRobot 30-day figure if `UPTIMEROBOT_API_KEY` is set, otherwise a live probe. | `uptime.runner.js` |
| `dns` | NS, MX, SPF, DMARC, DKIM and address records. Falls back to DNS-over-HTTPS if raw DNS is blocked. | `dns.runner.js` |
| `ssl` | Certificate validity, expiry, issuer, chain. | `ssl.runner.js` |
| `availability` | Every page linked from header, menus and footer: status, redirects, response-time buckets, "not found" page. | `storefront.runner.js` |
| `seo` | Sitemap and crawl, canonicals, robots.txt, structured data. For storefront projects also a sample of about 19 pages (titles, descriptions, headings, sharing tags). | `crawler.runner.js`, `storefront.runner.js` |
| `ai-crawlers` | robots.txt rules for AI crawlers (GPTBot, Gemini, Claude, Perplexity). Reuses the SEO crawl. | `crawler.runner.js` |
| `performance` | PageSpeed Insights (median of 3) per configured page, mobile and desktop. Falls back to local Lighthouse without an API key. | `lighthouse.runner.js` |
| `security` | Browser-level checks per page: security headers, cookies, subresource integrity, console and network errors, vulnerable JavaScript libraries (Retire.js). Storefront projects add the http-to-https redirect and mixed-content checks. | `devtools.runner.js`, `runners/lib/retirejs.js`, `runners/lib/owasp.js`, `storefront.runner.js` |
| `functional` | Customer journeys on the live store: search, category, product, add to cart, quantity, invalid coupon, checkout view, remove, sign-in messages, gift basket builder. Read-only. | `storefront.runner.js` |
| `responsive` | Desktop, tablet and phone layouts, sideways scrolling, phone menu, screenshots. | `storefront.runner.js` |
| `accessibility` | Automated axe checks (WCAG 2 A and AA) on home, product, cart and sign-in pages. | `storefront.runner.js` |
| `currency` | USD/CAD recalculation on the storefront (guest session, never checkout). Only for sites with `currencies` set. | `currency.runner.js` |
| `companion-app` | Authenticated, read-only QA of the client's companion app (Heroku dashboards). Every non-GET request after login is blocked and reported critical. | `customapp.runner.js`, `integrityDashboard.runner.js` |
| `cache` | Placeholder. Reports `not_implemented`; server and build-cache figures come from hosting dashboards, not an API. |  |

An audit that a project does not use is set to `"enabled": false` in its project file and is reported as `disabled`, with the reason, never silently dropped.

### 3.4 `runners/` - the code that actually measures

Runners collect facts and return findings. They must never throw; on error they return an `info` finding "Runner error" so the rest of the run continues.

| File | Purpose |
|---|---|
| `uptime.runner.js` | UptimeRobot API (read-only) plus a live synthetic probe. Note: it auto-registers a monitor in the UptimeRobot account for a host it has not seen. Treat the 100% of a brand-new monitor as "no history", not a result. |
| `dns.runner.js` | A, AAAA, CNAME, MX, NS, TXT records, SPF/DMARC/DKIM presence. |
| `ssl.runner.js` | Reads the TLS certificate (natively, or through the browser behind a proxy). |
| `crawler.runner.js` | Sitemap and page crawl, robots.txt, canonical and structured-data checks, AI-crawler rules, multi-viewport layout. |
| `lighthouse.runner.js` | PageSpeed Insights API with local Lighthouse fallback. Stores measurements for trending. |
| `devtools.runner.js` | Playwright plus Chrome DevTools Protocol: headers, cookies, SRI, console errors, network errors, library vulnerabilities; optional authenticated pass with a storefront login. |
| `storefront.runner.js` | Storefront audits for BigCommerce-style stores: availability crawl, customer journeys, responsive layouts, accessibility, SEO sample, security extras. Selectors and paths come from the site's `storefront` block. Read-only (section 8). |
| `currency.runner.js` | USD/CAD price recalculation check. |
| `customapp.runner.js` | Generic authenticated companion-app runner (Genpet, PartsConnexion): login, visit approved read-only pages, block and report any write request. |
| `integrityDashboard.runner.js` | Dedicated read-only QA of the Integrity Reforestation admin dashboard (page by page, filters, pagination). Configured by `config/integrity-dashboard.json`. |
| `lib/retirejs.js` | Downloads each loaded script and matches it against the Retire.js vulnerability database. |
| `lib/owasp.js` | Maps check ids to OWASP Top 10 categories shown in findings. |

### 3.5 `lib/` - shared building blocks

| File | Purpose |
|---|---|
| `result.js` | The finding and runner-result contract: severity levels (`critical`, `high`, `medium`, `low`, `info`), categories, `createFinding`, `createRunnerResult`. Every runner uses it; add a new category here first. |
| `config.js` | Loads `projects/*.json`, merges per-site config with per-run overrides (scores), loads `config/known-issues.json`. |
| `archive.js` | Reads and writes `results/<site>/<month>/<runner>_result.json`, and finds the previous month. |
| `differ.js` | Month-over-month comparison. A finding id present now but not last month is `new`, in both is `persisting`, only last month is `resolved`, listed in known-issues is `suppressed`. |
| `net.js`, `resolver.js`, `browser.js` | Make fetch, https, DNS and Chromium work behind the cloud egress proxy. `browser.js` is the single place that launches Chromium. |
| `pptxToPdf.js` | Converts a deck to PDF using LibreOffice, or PowerPoint through COM on Windows. Returns null (and the run says so) if neither exists. |
| `logger.js` | The only logging path. Runners must not use `console.log`. |
| `integrityAreas.js` | Integrity-specific: the five dashboard areas, mapping of finding ids to areas, dev-fix records. Shared by the Integrity deck and technical report. |

### 3.6 `projects/` - one file per client

The configuration that makes the engine behave differently per client. Files beginning with `_` are ignored.

| File | Client | Notes |
|---|---|---|
| `parts-audio-connexion.json` | PartsConnexion and AudioConnexion (two sites, one project) | Scores required, per site. Heroku companion app and USD/CAD only for PartsConnexion. |
| `genpet.json` | Genpet (companion app app.genpet.org) | Scores required. |
| `integrity-reforestation.json` | Integrity Reforestation (Heroku admin dashboard + Shopify widget) | No scores. Client deck driven by monthly input JSON. |
| `our-green-house.json` | Our Green House (BigCommerce gift baskets) | No scores. Storefront audits and the template-based deck. |
| `lidstyles.json` | LidStyles (legacy) | Kept only so archived history keeps working. |

Meaning of the top-level keys:

| Key | Purpose |
|---|---|
| `id`, `name`, `client`, `platform` | Identity and display names. `id` is the folder name under `history/` and `reports/`. |
| `domains` | Hostnames that belong to the project (used by `identify.js`). |
| `sites[]` | Monitored sites: `hostname`, `archiveKey` (folder under `results/`), `pages` (named URLs audited for performance and security), `timeout`, `retries`, `storefront` block (storefront projects), `customApp` or `companionApp` (companion apps with login selectors and the approved read-only pages), `storefrontLogin` (names of the env variables for an optional customer login), `currencies`, `categoryScores` (fixed Lighthouse category scores used by reports). |
| `audits` | Per audit: `enabled`, optional `pages`, and a note or `reason`. |
| `secrets[]` | Environment variables the project can use, with purpose and whether required. Shown by `--dry-run`. |
| `reports` | Which generator builds each output, for example `"client": "ogh-deck"` or `"client": "integrity-deck"`. `engine/reports.js` reads this. |
| `reportMeta` | Generator extras, for example client display names or the Integrity input file pattern. |
| `inputs` | `performanceScores`: `required` or `not-applicable`. Decides whether the engine insists on Before/After scores. |
| `context` | Plain-language description for people and AI sessions. |

The `storefront` block of a site (Our Green House) holds the platform, page paths, search terms, the CSS selector of the add-to-cart button, the sample product, how many pages to crawl and sample, and the optional gift-basket builder path. To support another BigCommerce store, copy this block and change the paths and selectors.

### 3.7 `config/` - monthly and per-client data

| File | Purpose |
|---|---|
| `known-issues.json` | Confirmed false positives per hostname, matched by finding id. Matching findings are marked `suppressed` in the comparison. Do not add entries without confirming with the team. |
| `integrity-dashboard.json` | Integrity dashboard base URL, login selectors (credentials come from env variables), pages and the checks to run. Read-only by design. |
| `monthly-monitoring-input.json` | Template/last input for the Integrity client deck (theme update log, widget screenshot links, dev-team notes, ops section). |
| `monthly-monitoring-input-<month>.json` | The Integrity deck input for a specific month. Written from the pasted dev-team text; validated by `scripts/validate-integrity-input.mjs` before the deck is built. |
| `dev-fixes/<project>-<month>.json` | Fixes reported by the dev team for the month; counted as fixed when the Integrity deck and technical report are built. |
| `dev-notes/<project>-<month>.txt` | Dev-team text saved from the spreadsheet row (created by the batch runner). |
| `site-updates/<month>.json` | Extra per-site slides for the month, for example the PartsConnexion "Server Memory and Log Optimization" slide. `generate_ppt_report.js` reads it. |

### 3.8 `report/` - PDF technical report

| File | Purpose |
|---|---|
| `generator.js` | Builds the A4 technical PDF (HTML rendered by Chromium) from saved results, history comparison and scores. Also the SSL certificate description. |
| `dns-view.js` | Turns the DNS result into the words and flags used in the DNS section. Unit tested. |
| `clientReportStyles.js` | The shared stylesheet for the client-facing A4 PDFs. Change it to restyle all PDF reports. |

### 3.9 `templates/`

`templates/ogh/monthly-report-template.pptx` is the September Our Green House deck, kept as a template. `generate_ogh_report.js` patches it every month, so layout, fonts, icons and colours never drift. Treat it as read-only: if the design must change, edit this file in PowerPoint, then check `generate_ogh_report.js` still finds every shape.

### 3.10 `scripts/` - helper tools (not part of a normal run)

| File | Purpose |
|---|---|
| `cloud-setup.sh` | Setup script for the Claude Code cloud environment (installs LibreOffice, browser). |
| `cloud-preflight.mjs` | Checks browser, DNS, proxy, environment variables in a cloud session. Run it first there. |
| `ensure-browser.mjs` | Makes sure a Chromium that Playwright can launch exists (installs it if not). |
| `print-allowed-domains.mjs` | Prints the domain allowlist for a restricted cloud network. |
| `validate-integrity-input.mjs` | Validates the Integrity monthly input JSON and warns about text carried over from the previous month. |
| `build-delivery-page.mjs`, `delivery-page.template.html` | Builds the self-contained HTML delivery page (reports embedded with Save buttons) for the Claude Artifact tool. |
| `build-screenshot-slides.mjs` | Builds PowerPoint slides from folders of screenshots, scaled to fit, never stretched. Used for the Integrity theme screenshot slides. |
| `compress-screenshots.ps1` | Converts and downsizes screenshots to JPEG before they go into a deck. |

### 3.11 `tests/`

Run with `npm test` (unit) and `npm run test:integration`. Unit tests cover the engine (project loading, scores, outputs), the spreadsheet parser, the DNS and SSL report text, and the storefront page analysis. Add a test whenever you change parsing, scoring or report wording logic. Tests never touch the network.

### 3.12 Data folders

| Folder | Tracked in git | Contents |
|---|---|---|
| `results/<site>/<month>/` | No (ignored) | Raw output of every runner for that run (section 6). Can be rebuilt by re-running. |
| `history/<project>/<month>.json` | Yes | The permanent normalised record of the run and the comparison with the previous month. |
| `reports/<project>/<month>/` | Yes | Finished client files (PDF and PPTX). |
| `inputs/<month>/` | Yes | The pasted spreadsheet for batch runs. |

## 4. Adding or changing things safely

Rules that every change must respect (full list in `CLAUDE.md`):
- Companion apps and client sites are read-only. Never whitelist a write request without explicit sign-off.
- No secrets in the repository. Credentials come only from environment variables.
- Never type a password into a browser for the user.
- Reports go to clients: accurate, plain language, no invented number, failed or skipped audits stated honestly.
- Performance Before/After scores come from the monthly prompt and are never replaced by measurements.
- No emojis in documents or code comments.

## 5. Common tasks

### 5.1 Onboard a new client project
1. Copy the closest `projects/*.json` (for a BigCommerce store with no scores, `our-green-house.json`).
2. Change `id`, names, `domains`, the site `hostname`, `pages`, and the `storefront` block selectors.
3. Set each audit to enabled or disabled, with a reason for every disabled one.
4. Set `inputs.performanceScores` and the `secrets` list.
5. Choose the report: reuse `site-pdf` / `site-pptx` (the optimization report design), or write a new generator and register it in `engine/reports.js`.
6. Run `--dry-run`, then a full run with a fake month, then delete the fake month.
7. Add the project to the table in `CLAUDE.md` and a section to `docs/PROJECT_CONTEXT.md`.

### 5.2 Add a new audit check
- To a storefront project: add a function in `runners/storefront.runner.js`, return findings built with `createFinding`, wrap it in an `audits/<name>/index.js`, and register the audit in `audits/index.js`. Add the category to `lib/result.js` if it is new, enable it in the project file, and add a unit test for any parsing logic.
- To an existing runner: edit the runner; findings need a stable `id` so the month-over-month comparison works.

### 5.3 Change a finding's severity or wording
Severity and text are set where the finding is created, in the runner (`createFinding(...)`). The id is used for comparison, so keep it stable. To hide a confirmed false positive, add an entry to `config/known-issues.json` instead of deleting the check.

### 5.4 Change report wording or design
| Report | Edit |
|---|---|
| Our Green House deck | Wording and logic in `generate_ogh_report.js` (`wording()` builds all sentences); design in `templates/ogh/monthly-report-template.pptx`. |
| Parts/Audio/Genpet deck | `generate_ppt_report.js` (slide builders are in one file, one block per slide). |
| Integrity deck | `generate_tree_widget_report.js` plus the month's `config/monthly-monitoring-input-<month>.json`. |
| Integrity technical PDF | `generate_integrity_technical_report.js`. |
| Technical PDF (other projects) | `report/generator.js`; shared style in `report/clientReportStyles.js`; DNS wording in `report/dns-view.js`. |

### 5.5 Change a threshold (response-time buckets, slow page limit, number of pages sampled)
Storefront values: the `storefront` block of the site in `projects/<project>.json` (`navCrawl`, `seoSample`, search terms). Response-time bucket limits (under 1 s, 1 to 2 s, over 2 s) are set in the availability summary of `runners/storefront.runner.js`. Lighthouse and header rules are in `runners/lighthouse.runner.js` and `runners/devtools.runner.js`.

### 5.6 Change how many pages or which pages are audited
`sites[].pages` in the project file (performance and security audits); `storefront.navCrawl` and `storefront.seoSample` for the storefront crawl and SEO sample.

### 5.7 Monthly Integrity run
Paste the dev-team text; write `config/monthly-monitoring-input-<month>.json` from it only; run `node scripts/validate-integrity-input.mjs --month <month>`; then `node engine/run-audit.js --url <dashboard url> --month <month> --outputs client,technical`. Never carry evidence links or incident text over from a previous month.

## 6. What is in `results/<site>/<month>/`

Raw, regenerable output; git-ignored. The folder name is the site's `archiveKey`.

| File | Written by |
|---|---|
| `uptime_result.json` | network audit |
| `dns_result.json`, `ssl_result.json` | dns, ssl audits |
| `crawler_result.json`, `crawl_audit_result.json` | seo audit (the crawl; the second name is kept for the report generators) |
| `seo_sample_result.json` | seo audit, storefront projects (sampled pages, robots.txt) |
| `lighthouse_result.json` | performance audit (measured scores, Core Web Vitals); `lighthouse_before_result.json` for `--stage before` |
| `devtools_result.json` | security audit (headers, cookies, SRI, library vulnerabilities, console errors) |
| `security_extras_result.json` | security audit, storefront projects (http redirect, mixed content, search reflection) |
| `availability_result.json` | availability audit (every navigation page, buckets, error page) |
| `functional_result.json` | functional audit (each journey step with pass/fail and notes) |
| `responsive_result.json` | responsive audit |
| `accessibility_result.json` | accessibility audit (axe violations) |
| `currency_result.json` | currency audit |
| `customapp_result.json`, `integrity_dashboard_result.json` | companion-app audit |
| `raw.json` | every finding of the run in one file |
| `diff_result.json` | comparison with the previous month |
| `evidence/` | Screenshots taken by the functional and responsive audits (JPEG). Sizes match the picture frames of the Our Green House template: desktop 1366x778, tablet 820x1114, phone 390x844. |
| `screenshot_*.png` | Browser screenshots from the security and companion-app runners |
| `*.pptx`, `*.pdf`, `*.html` | Report files written by the generators before they are copied to `reports/` |

Every `*_result.json` has the same shape: `runner`, `status`, `findings[]` (id, severity, title, detail, evidence, recommendation), and `metrics`.

## 7. Reports and history

### 7.1 `reports/<project>/<month>/`
The finished, client-ready files. `engine/reports.js` copies every `.pdf` and `.pptx` produced during the run here. Typical names:
- `<Name>_Monthly_Optimization_Report_<Month>_<Year>.pptx` and `.pdf` - Parts, Audio, Genpet decks (the generator also writes a second file ending `_v2`).
- `<site>-<month>-report.pdf` (for example `parts-2026-10-report.pdf`) - technical PDF.
- `Monthly_Monitoring_Report_<Month>_<Year>.pptx/.pdf` and `integrity-<month>-custom-app-technical-report.pdf` - Integrity.
- `Our_Green_House_Monthly_Website_Maintenance_Report_<Month>_<Year>.pptx/.pdf` - Our Green House.

Deliver by committing `reports/`, `history/`, `inputs/` to a `claude/...` branch (never force-push, never push to `main` unasked).

### 7.2 `history/<project>/<month>.json`
One file per project per month. Contains the audit statuses (completed, failed, skipped, disabled, not_implemented), each finding with its lifecycle status (`new`, `persisting` with `openSince`, `resolved`, `suppressed`), key metrics (measured scores, LCP, certificate days remaining, uptime) and the differences against the latest earlier month. It is the only place month-over-month comparison reads from, so commit it.

### 7.3 Month-over-month logic
`lib/differ.js` compares finding ids. Because of that, ids must be stable across months, and the first run for a project shows everything as `new`.

### 7.4 Our Green House deck generation
`generate_ogh_report.js` does not build slides. It opens the template as a zip, and for each slide replaces text runs, table cells, chart data (and the embedded workbook behind each chart), colours of the status dots, and swaps the pictures for the month's evidence screenshots. Everything written comes from `results/<site>/<month>/*.json` through `buildOghData()` (numbers) and `wording()` (sentences). Run on its own with `node generate_ogh_report.js --host www.ourgreenhouse.com --month 2026-10`. If a slide's wording must change, edit `wording()`; if a number's source must change, edit `buildOghData()`. The template's shapes are found by their text or position, so avoid renaming or moving shapes in the template.

## 8. Safety design

- All storefront audits are GET-only except a guest cart: add one sample item, change quantity, enter an invalid coupon, view checkout, then remove the item. No payment, contact, newsletter or account creation is ever submitted.
- Companion-app runners abort every non-GET request after login and report it as critical. Only pages listed in `safeNavTargets` (or `config/integrity-dashboard.json`) are visited.
- Search reflection is tested with a harmless script string that is only checked for being echoed back, never executed.
- The Shopify storefront password (Integrity widget) is typed by a person; no script reads or stores it.

## 9. Where to change things (lookup)

| I want to ... | Go to |
|---|---|
| Add a client or site | New file in `projects/` (section 5.1) |
| Change which audits run for a client | `audits` block of `projects/<id>.json` |
| Change pages audited for performance/security | `sites[].pages` in the project file |
| Change a storefront selector, path, search term | `storefront` block of the site in the project file |
| Add a new automated check | `runners/storefront.runner.js` or the matching runner, then the matching `audits/<name>/index.js` |
| Add a new audit category | `audits/<name>/index.js`, `audits/index.js`, `lib/result.js` |
| Change severity or wording of a finding | The runner that creates it (stable `id`) |
| Suppress a confirmed false positive | `config/known-issues.json` |
| Change how scores or CWV text are read | `engine/scores.js` (and `engine/scores` tests) |
| Change which report is built for a project | `reports` block in the project file, `engine/reports.js` |
| Change the Our Green House report | `generate_ogh_report.js`, `templates/ogh/monthly-report-template.pptx` |
| Change the Parts/Audio/Genpet deck | `generate_ppt_report.js`; extra monthly slides via `config/site-updates/<month>.json` |
| Change the Integrity deck or its input | `generate_tree_widget_report.js`, `config/monthly-monitoring-input-<month>.json`, `scripts/validate-integrity-input.mjs` |
| Change the Integrity dashboard checks | `config/integrity-dashboard.json`, `runners/integrityDashboard.runner.js`, `lib/integrityAreas.js` |
| Change the PDF technical report | `report/generator.js`, `report/clientReportStyles.js`, `report/dns-view.js` |
| Change the month-over-month rules | `lib/differ.js`, `engine/history.js` |
| Change where results or reports are saved | `lib/archive.js`, `engine/reports.js`, `engine/history.js` |
| Work behind a proxy / in the cloud | `lib/net.js`, `lib/resolver.js`, `lib/browser.js`, `scripts/cloud-*.{sh,mjs}`, `docs/CLOUD.md` |
| Add or rename a secret | `.env.example`, the project's `secrets` list, the code reading it |
| Change the delivery page | `scripts/build-delivery-page.mjs`, `scripts/delivery-page.template.html` |

## 10. Known behaviour worth knowing

- Severity scoring is strict. The security audit reports an old jQuery as `critical` because the library scanner groups every vulnerable library on a page, even when the database rates the individual issue only medium. Review such findings before they reach a client.
- Header and script findings (CSP, SRI) are produced per audited page, so the same issue appears once per page; the Our Green House deck merges them.
- Lighthouse fallback (no `PAGESPEED_API_KEY`) is slow (3 to 4 minutes per page) and its numbers differ from PageSpeed.
- The UptimeRobot runner creates a monitor for a new host.
- The gift basket builder on Our Green House has a small script error in the page's own code; it is reported every month until the site owner fixes it.
- Removed at handover (still available in git history): `monitor.js`, `check_integrity_dashboard.js`, `crawl_audit.js`, `build-spacing-compliance-report.js`, the PageSpeed experiment scripts, `config/sites.json` (replaced by `projects/*.json`), and one-off Integrity helper scripts.

## 11. Handover checklist

1. `npm install`, `node scripts/ensure-browser.mjs`, `npm test` (all green).
2. Create `.env` from `.env.example` (get the keys from the account owner; never commit them).
3. `node engine/run-audit.js --url https://www.ourgreenhouse.com --month 2099-01 --dry-run`, then a real run with `--month 2099-01`, then delete the 2099-01 folders.
4. Read `CLAUDE.md` and `docs/PROJECT_CONTEXT.md` fully.
5. Confirm access to: the GitHub repository, UptimeRobot, the Google PageSpeed API key, and the companion app monitoring accounts.
