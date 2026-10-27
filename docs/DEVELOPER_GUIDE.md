# Developer Guide - Monthly Monitoring Testing System

Audience: a developer taking over this project. Read this top to bottom once, then use the "Where to change things" table (section 10) as a lookup.

Contents: 1 What this system is, 2 Installation and setup, 3 Running the monthly audit, 4 Repository map (every folder and file), 5 Changing things safely, 6 Common tasks, 7 Results folder, 8 Reports and history, 9 Safety design, 10 Where to change things, 11 Known behaviour, 12 Findings and severity, 13 Per-project facts, 14 Report quality rules, 15 Troubleshooting, 16 Glossary, 17 Handover checklist.

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

## 2. Installation and setup (from a clean machine)

### 2.1 What you need
| Item | Version / note | Needed for |
|---|---|---|
| Git | any recent | cloning, committing reports |
| Node.js | 22 or newer (`node -v`; `package.json` enforces `>=22`) | everything |
| npm | comes with Node | installing dependencies |
| Chromium for Playwright | installed by the command in 2.3 | security, SEO crawl, storefront audits, currency, companion apps, SSL fallback, PDF reports |
| Microsoft PowerPoint (Windows) or LibreOffice | either one | turning client decks into PDF. Without either, the deck is delivered as PowerPoint only and the run says so. |
| Internet access to the client sites | no VPN needed | all audits |
| Accounts and keys | see 2.5 | optional, but PageSpeed is needed for scored projects |

Disk: about 1 GB for `node_modules` and the browser.

### 2.2 Install the dependencies
```
git clone https://github.com/jash-webdesk/monthly-monitoring-testing-system.git
cd monthly-monitoring-testing-system
git checkout setup/cloud-engine      # the working branch at handover; merge to main when ready
npm install
```
`npm install` reads `package.json` and `package-lock.json` and installs:

| Package | Used for |
|---|---|
| `playwright` | Controlling Chromium (browser audits, screenshots, PDF rendering) |
| `@axe-core/playwright` | Automated accessibility checks |
| `lighthouse` (12.8.2) | Local Lighthouse fallback when no PageSpeed key is set |
| `retire` | Vulnerable JavaScript library database |
| `pptxgenjs` | Building PowerPoint decks |
| `jszip` | Editing the Our Green House template deck (a .pptx is a zip) |
| `undici`, `https-proxy-agent` | Making Node's network calls work behind a proxy (cloud sessions) |

Use `npm ci` instead of `npm install` when you want exactly the versions in the lock file (for example on a build machine).

### 2.3 Install the browser
```
node scripts/ensure-browser.mjs
```
This tries the Playwright browser, downloads it with `npx playwright install chromium` if missing, and as a last resort falls back to the `@sparticuz/chromium` package. Exit code 0 means a browser launches. If it fails behind a corporate proxy, set `HTTPS_PROXY`, or point to an existing Chrome with `CHROMIUM_EXECUTABLE_PATH`.

### 2.4 Create the `.env` file
```
copy .env.example .env        # Windows (cmd)
cp .env.example .env          # macOS, Linux, Git Bash
```
Open `.env` and fill in only what you have. The file is git-ignored; never commit it and never paste its values into chat, tickets or reports. Every login is optional: a missing login means that step runs as a guest or is skipped, never a failure.

### 2.5 Environment variables
| Variable | Purpose | Needed |
|---|---|---|
| `PAGESPEED_API_KEY` | Google PageSpeed Insights API for the performance audit | Required for Genpet and Parts/Audio. Optional elsewhere (local Lighthouse is used without it; it takes 3 to 4 minutes per page and its numbers differ). |
| `UPTIMEROBOT_API_KEY` | Read-only UptimeRobot key for 30-day availability | Optional. Without it a live probe is used. With it, a monitor is auto-created for any new host. |
| `PARTSCONNEXION_CUSTOMAPP_USERNAME` / `_PASSWORD` | PartsConnexion Heroku app login (read-only monitoring user) | Needed for the companion-app audit |
| `GENPET_CUSTOMAPP_USERNAME` / `_PASSWORD` | Genpet app login | Needed for the companion-app audit |
| `INTEGRITY_CUSTOMAPP_USERNAME` / `_PASSWORD` | Integrity admin dashboard login | Needed for the dashboard audit |
| `PARTSCONNEXION_STOREFRONT_*`, `AUDIOCONNEXION_STOREFRONT_*`, `GENPET_STOREFRONT_*` (`USERNAME`, `PASSWORD`) | Optional customer login for the authenticated security pass | Optional, one pair per site |
| `INTEGRITY_STORE_PASSWORD` | Shopify storefront password for the widget capture | Not used by any script; the person enters it by hand |
| `CHROMIUM_EXECUTABLE_PATH` | Use this browser binary instead of Playwright's download | Optional |
| `BROWSER_IGNORE_CERT_ERRORS=1` | Accept untrusted certificates (TLS-inspecting proxy only) | Optional |
| `DNS_MODE` (`auto`, `native`, `doh`) | How DNS is resolved (`doh` = DNS-over-HTTPS) | Optional, default `auto` |
| `SSL_MODE` (`auto`, `native`, `browser`) | How the certificate is read | Optional, default `auto` |
| `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` | Proxy for all traffic | Only behind a proxy |
| `MM_NO_DOTENV=1` | Ignore `.env` (same as `--no-env`) | Testing |
| `DEBUG=1` | Verbose logging | Troubleshooting |

Use dedicated low-privilege accounts for every login. Rotate them if someone leaves.

### 2.6 Check the installation
```
npm test
node engine/run-audit.js --url https://www.ourgreenhouse.com --month 2099-01 --dry-run
```
`npm test` must show all tests passing. The dry run must print the project (`our-green-house`), its audits and which environment variables are present.
In a cloud or restricted environment also run `node scripts/cloud-preflight.mjs`; it prints PASS, WARN or FAIL for the browser, DNS, proxy and variables without printing any secret.

### 2.7 npm scripts
| Command | Runs |
|---|---|
| `npm test` | Unit tests (`tests/unit/*.test.mjs`) |
| `npm run test:integration` | `tests/integration/*.test.mjs` (network behaviour) |
| `npm run audit -- <flags>` | `node engine/run-audit.js <flags>` |
| `npm run preflight` | `scripts/cloud-preflight.mjs` |
| `npm run ensure-browser` | `scripts/ensure-browser.mjs` |

## 3. Running the monthly audit

### 3.1 What the person types each month
A short prompt: website URL, month, Before/After performance scores (only for projects that use them) and which outputs to generate. Everything else is collected automatically. The user never supplies audit findings.

Example: "Run the October 2026 monthly monitoring audit for Genpet. Performance: Homepage Mobile Before 68 -> After 74, Desktop 79 -> 83; About Us Mobile 71 -> 77, Desktop 82 -> 87. Generate: Technical Report, Client Report".

### 3.2 Step by step
1. Dry run: `node engine/run-audit.js --url <url> --month <YYYY-MM> --dry-run` (add `--scores` if scores were given). It lists missing inputs. Ask for those, never guess.
2. Run: `node engine/run-audit.js --url <url> --month <YYYY-MM> --scores "<text>" --outputs technical,client`. A full run takes from a few minutes to over 15 minutes per site. In the cloud, run it as a background task and watch the log.
3. Read the printed JSON summary: audits run and their status (`completed`, `failed`, `skipped`, `disabled`, `not_implemented`), finding counts, warnings, comparison with last month.
4. Open the reports in `reports/<project>/<month>/` and check them (section 8).
5. Commit `reports/`, `history/`, `inputs/` and `config/dev-notes/` to a `claude/...` branch and push. Never force-push, never push to `main` unasked.

### 3.3 Commands per project
| Project | Command |
|---|---|
| Our Green House | `node engine/run-audit.js --url https://www.ourgreenhouse.com --month 2026-10 --outputs client` |
| Genpet | `node engine/run-audit.js --url https://genpet.org --month 2026-10 --scores "<text>" --outputs technical,client` |
| PartsConnexion and AudioConnexion | `--project parts-audio-connexion --all-sites`, or run each URL separately; scores are per site (a `PartsConnexion: ...` line and an `AudioConnexion: ...` line); desktop LCP and CLS with `--cwv "<text>"` |
| Integrity Reforestation | `node engine/run-audit.js --url https://integrity-dashboard-bf73ab673f4c.herokuapp.com --month 2026-10 --outputs client,technical` after the monthly input JSON exists and validates (section 6.7) |
| Several sites at once | `node engine/run-sheet.js --file inputs/<month>/sheet-paste.tsv --dry-run`, then again without `--dry-run` |

### 3.4 Score text formats
`--scores` accepts compact text such as `Homepage Mobile 68>74, Desktop 79>83; About Us Mobile 71>77, Desktop 82>87`, the longer "Before 68 -> After 74" form, `--scores-json` and `--scores-file`. For two-site projects prefix each line with the site name. `--cwv` takes desktop LCP and CLS per site, for example `PartsConnexion: LCP 1.3 s, CLS 0; AudioConnexion: LCP 1.5 s, CLS 0`. Meaning of the numbers: Before is taken the day the month's audit starts, before that month's fixes; After is taken once the month's fixes are done (not last month versus this month). They are the user's own PageSpeed numbers and are never replaced by measurements.

### 3.5 Spreadsheet (batch) mode
Paste a tab-separated sheet (header row first) into `inputs/<month>/sheet-paste.tsv` exactly as given. Columns: `Project | URL | Month | Page | Mobile Before | Mobile After | Desktop Before | Desktop After | Outputs | Dev Team Notes`. URL, Month and Outputs fill down; a new URL starts a new run. The dry run lists every problem (missing scores, unknown site, bad month); report them and stop. For an Integrity row the Dev Team Notes are saved to `config/dev-notes/<project>-<month>.txt`; build the monthly input JSON from them, validate it, then re-run that site with `--reports-only`.

### 3.6 Re-running parts
- Only some audits: `--only dns,ssl` or `--skip performance`.
- Regenerate reports without measuring: `--reports-only` (or run a generator directly, section 8.4).
- Same-month PageSpeed baseline: `--stage before` (no reports).
- Test safely: use month `2099-01` and delete `results/*/2099-01`, `history/*/2099-01.json` and `reports/*/2099-01` afterwards.

### 3.7 Running in a Claude Code cloud session (alternative)
The same engine runs on Anthropic's cloud VM. One-time: connect GitHub, create an environment with network access Full, setup script `bash scripts/cloud-setup.sh`, and the environment variables from 2.5. Each month: start a session, paste the prompt; the session runs preflight, the engine (in the background), commits to a `claude/...` branch and replies with links. Details: `docs/CLOUD.md`, `docs/FIRST_CLOUD_RUN.md`, `docs/LIMITATIONS.md`. Also available: a prompt-builder artifact (https://claude.ai/artifact/FD9BzW2REd9jNERXA9Crs5) and a delivery page built by `scripts/build-delivery-page.mjs` and published with the Artifact tool (a page with a Save button for each finished file).

### 3.8 Flag reference for `engine/run-audit.js`


| Flag | Meaning |
|---|---|
| `--url <url>` | Site to audit. The hostname selects the project and site. |
| `--project <id>` with `--all-sites` | Run every site of a project (for example PartsConnexion and AudioConnexion). |
| `--month YYYY-MM` | Audit month. Decides the results, history and report folder names. |
| `--scores "<text>"`, `--scores-json '<json>'`, `--scores-file <path>` | Before/After performance scores from the monthly prompt (scored projects only). Parsed by `engine/scores.js`. |
| `--cwv "<text>"` | Desktop LCP and CLS supplied by the prompt (Parts/Audio). |
| `--outputs technical,client` | Reports to build. `client` is the PowerPoint deck (and PDF copy), `technical` the PDF report. |
| `--only a,b` / `--skip a,b` | Run or skip audits by name (list in section 4.3). |
| `--stage before` | Capture a same-month PageSpeed baseline; builds no reports. |
| `--reports-only` | Rebuild reports from the saved results; measures nothing. |
| `--no-history` | Do not write `history/`. Use when testing. |
| `--timeout-min <n>` | Per-audit time limit (default 25 minutes). |
| `--no-env` | Ignore `.env` (rehearses a run with no secrets). |

Batch mode for several sites: `node engine/run-sheet.js --file inputs/<month>/sheet-paste.tsv [--dry-run]`. The sheet format is described in `engine/sheet.js` and `CLAUDE.md`.

Always test with a fake month such as `2099-01` and delete `results/*/2099-01`, `history/*/2099-01.json` and `reports/*/2099-01` afterwards, so real months are never overwritten.

## 4. Repository map

### 4.1 Root

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
| `generate_ogh_report.js` | Our Green House client deck. Patches `templates/ogh/monthly-report-template.pptx` with the month's results (section 8.4). |
| `scratch/` | Local working area, git-ignored. Safe to delete. Not part of the system. |

### 4.2 `engine/` - the orchestration layer

| File | Purpose |
|---|---|
| `run-audit.js` | The main command. Parses flags, identifies the project, validates required inputs (scores), runs each enabled audit with a timeout, saves raw results, diffs against last month, writes history, calls `reports.js`, prints a JSON summary. A failed audit is recorded as `failed` and the rest continue. |
| `run-sheet.js`, `sheet.js` | Batch runner and its spreadsheet parser. One audit run per site found in a pasted TSV/CSV. Saves the paste under `inputs/<month>/`. |
| `identify.js` | Maps a URL or hostname to a project and site using the `domains` lists in `projects/*.json`. |
| `scores.js` | Parses and normalises the Before/After performance scores and the desktop LCP/CLS figures given in the prompt. Scores are never hard-coded or replaced by measurements. |
| `history.js` | Builds and stores the normalised monthly record (`history/<project>/<month>.json`): findings, key metrics, audit statuses, and the comparison with the previous month. |
| `reports.js` | Chooses what to build per project (`reports.client` / `reports.technical` in the project file), runs the generators, converts decks to PDF, copies finished files to `reports/<project>/<month>/`. |

### 4.3 `audits/` - one folder per audit category

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

### 4.4 `runners/` - the code that actually measures

Runners collect facts and return findings. They must never throw; on error they return an `info` finding "Runner error" so the rest of the run continues.

| File | Purpose |
|---|---|
| `uptime.runner.js` | UptimeRobot API (read-only) plus a live synthetic probe. Note: it auto-registers a monitor in the UptimeRobot account for a host it has not seen. Treat the 100% of a brand-new monitor as "no history", not a result. |
| `dns.runner.js` | A, AAAA, CNAME, MX, NS, TXT records, SPF/DMARC/DKIM presence. |
| `ssl.runner.js` | Reads the TLS certificate (natively, or through the browser behind a proxy). |
| `crawler.runner.js` | Sitemap and page crawl, robots.txt, canonical and structured-data checks, AI-crawler rules, multi-viewport layout. |
| `lighthouse.runner.js` | PageSpeed Insights API with local Lighthouse fallback. Stores measurements for trending. |
| `devtools.runner.js` | Playwright plus Chrome DevTools Protocol: headers, cookies, SRI, console errors, network errors, library vulnerabilities; optional authenticated pass with a storefront login. |
| `storefront.runner.js` | Storefront audits for BigCommerce-style stores: availability crawl, customer journeys, responsive layouts, accessibility, SEO sample, security extras. Selectors and paths come from the site's `storefront` block. Read-only (section 9). |
| `currency.runner.js` | USD/CAD price recalculation check. |
| `customapp.runner.js` | Generic authenticated companion-app runner (Genpet, PartsConnexion): login, visit approved read-only pages, block and report any write request. |
| `integrityDashboard.runner.js` | Dedicated read-only QA of the Integrity Reforestation admin dashboard (page by page, filters, pagination). Configured by `config/integrity-dashboard.json`. |
| `lib/retirejs.js` | Downloads each loaded script and matches it against the Retire.js vulnerability database. |
| `lib/owasp.js` | Maps check ids to OWASP Top 10 categories shown in findings. |

### 4.5 `lib/` - shared building blocks

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

### 4.6 `projects/` - one file per client

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

### 4.7 `config/` - monthly and per-client data

| File | Purpose |
|---|---|
| `known-issues.json` | Confirmed false positives per hostname, matched by finding id. Matching findings are marked `suppressed` in the comparison. Do not add entries without confirming with the team. |
| `integrity-dashboard.json` | Integrity dashboard base URL, login selectors (credentials come from env variables), pages and the checks to run. Read-only by design. |
| `monthly-monitoring-input.json` | Template/last input for the Integrity client deck (theme update log, widget screenshot links, dev-team notes, ops section). |
| `monthly-monitoring-input-<month>.json` | The Integrity deck input for a specific month. Written from the pasted dev-team text; validated by `scripts/validate-integrity-input.mjs` before the deck is built. |
| `dev-fixes/<project>-<month>.json` | Fixes reported by the dev team for the month; counted as fixed when the Integrity deck and technical report are built. |
| `dev-notes/<project>-<month>.txt` | Dev-team text saved from the spreadsheet row (created by the batch runner). |
| `site-updates/<month>.json` | Extra per-site slides for the month, for example the PartsConnexion "Server Memory and Log Optimization" slide. `generate_ppt_report.js` reads it. |

### 4.8 `report/` - PDF technical report

| File | Purpose |
|---|---|
| `generator.js` | Builds the A4 technical PDF (HTML rendered by Chromium) from saved results, history comparison and scores. Also the SSL certificate description. |
| `dns-view.js` | Turns the DNS result into the words and flags used in the DNS section. Unit tested. |
| `clientReportStyles.js` | The shared stylesheet for the client-facing A4 PDFs. Change it to restyle all PDF reports. |

### 4.9 `templates/`

`templates/ogh/monthly-report-template.pptx` is the September Our Green House deck, kept as a template. `generate_ogh_report.js` patches it every month, so layout, fonts, icons and colours never drift. Treat it as read-only: if the design must change, edit this file in PowerPoint, then check `generate_ogh_report.js` still finds every shape.

### 4.10 `scripts/` - helper tools (not part of a normal run)

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

### 4.11 `tests/`

Run with `npm test` (unit) and `npm run test:integration`. Unit tests cover the engine (project loading, scores, outputs), the spreadsheet parser, the DNS and SSL report text, and the storefront page analysis. Add a test whenever you change parsing, scoring or report wording logic. Tests never touch the network.

### 4.12 Data folders

| Folder | Tracked in git | Contents |
|---|---|---|
| `results/<site>/<month>/` | No (ignored) | Raw output of every runner for that run (section 7). Can be rebuilt by re-running. |
| `history/<project>/<month>.json` | Yes | The permanent normalised record of the run and the comparison with the previous month. |
| `reports/<project>/<month>/` | Yes | Finished client files (PDF and PPTX). |
| `inputs/<month>/` | Yes | The pasted spreadsheet for batch runs. |

## 5. Adding or changing things safely

Rules that every change must respect (full list in `CLAUDE.md`):
- Companion apps and client sites are read-only. Never whitelist a write request without explicit sign-off.
- No secrets in the repository. Credentials come only from environment variables.
- Never type a password into a browser for the user.
- Reports go to clients: accurate, plain language, no invented number, failed or skipped audits stated honestly.
- Performance Before/After scores come from the monthly prompt and are never replaced by measurements.
- No emojis in documents or code comments.

## 6. Common tasks

### 6.1 Onboard a new client project
1. Copy the closest `projects/*.json` (for a BigCommerce store with no scores, `our-green-house.json`).
2. Change `id`, names, `domains`, the site `hostname`, `pages`, and the `storefront` block selectors.
3. Set each audit to enabled or disabled, with a reason for every disabled one.
4. Set `inputs.performanceScores` and the `secrets` list.
5. Choose the report: reuse `site-pdf` / `site-pptx` (the optimization report design), or write a new generator and register it in `engine/reports.js`.
6. Run `--dry-run`, then a full run with a fake month, then delete the fake month.
7. Add the project to the table in `CLAUDE.md` and a section to `docs/PROJECT_CONTEXT.md`.

### 6.2 Add a new audit check
- To a storefront project: add a function in `runners/storefront.runner.js`, return findings built with `createFinding`, wrap it in an `audits/<name>/index.js`, and register the audit in `audits/index.js`. Add the category to `lib/result.js` if it is new, enable it in the project file, and add a unit test for any parsing logic.
- To an existing runner: edit the runner; findings need a stable `id` so the month-over-month comparison works.

### 6.3 Change a finding's severity or wording
Severity and text are set where the finding is created, in the runner (`createFinding(...)`). The id is used for comparison, so keep it stable. To hide a confirmed false positive, add an entry to `config/known-issues.json` instead of deleting the check.

### 6.4 Change report wording or design
| Report | Edit |
|---|---|
| Our Green House deck | Wording and logic in `generate_ogh_report.js` (`wording()` builds all sentences); design in `templates/ogh/monthly-report-template.pptx`. |
| Parts/Audio/Genpet deck | `generate_ppt_report.js` (slide builders are in one file, one block per slide). |
| Integrity deck | `generate_tree_widget_report.js` plus the month's `config/monthly-monitoring-input-<month>.json`. |
| Integrity technical PDF | `generate_integrity_technical_report.js`. |
| Technical PDF (other projects) | `report/generator.js`; shared style in `report/clientReportStyles.js`; DNS wording in `report/dns-view.js`. |

### 6.5 Change a threshold (response-time buckets, slow page limit, number of pages sampled)
Storefront values: the `storefront` block of the site in `projects/<project>.json` (`navCrawl`, `seoSample`, search terms). Response-time bucket limits (under 1 s, 1 to 2 s, over 2 s) are set in the availability summary of `runners/storefront.runner.js`. Lighthouse and header rules are in `runners/lighthouse.runner.js` and `runners/devtools.runner.js`.

### 6.6 Change how many pages or which pages are audited
`sites[].pages` in the project file (performance and security audits); `storefront.navCrawl` and `storefront.seoSample` for the storefront crawl and SEO sample.

### 6.7 Monthly Integrity run
Paste the dev-team text; write `config/monthly-monitoring-input-<month>.json` from it only; run `node scripts/validate-integrity-input.mjs --month <month>`; then `node engine/run-audit.js --url <dashboard url> --month <month> --outputs client,technical`. Never carry evidence links or incident text over from a previous month.

## 7. What is in `results/<site>/<month>/`

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

## 8. Reports and history

### 8.1 `reports/<project>/<month>/`
The finished, client-ready files. `engine/reports.js` copies every `.pdf` and `.pptx` produced during the run here. Typical names:
- `<Name>_Monthly_Optimization_Report_<Month>_<Year>.pptx` and `.pdf` - Parts, Audio, Genpet decks (the generator also writes a second file ending `_v2`).
- `<site>-<month>-report.pdf` (for example `parts-2026-10-report.pdf`) - technical PDF.
- `Monthly_Monitoring_Report_<Month>_<Year>.pptx/.pdf` and `integrity-<month>-custom-app-technical-report.pdf` - Integrity.
- `Our_Green_House_Monthly_Website_Maintenance_Report_<Month>_<Year>.pptx/.pdf` - Our Green House.

Deliver by committing `reports/`, `history/`, `inputs/` to a `claude/...` branch (never force-push, never push to `main` unasked).

### 8.2 `history/<project>/<month>.json`
One file per project per month. Contains the audit statuses (completed, failed, skipped, disabled, not_implemented), each finding with its lifecycle status (`new`, `persisting` with `openSince`, `resolved`, `suppressed`), key metrics (measured scores, LCP, certificate days remaining, uptime) and the differences against the latest earlier month. It is the only place month-over-month comparison reads from, so commit it.

### 8.3 Month-over-month logic
`lib/differ.js` compares finding ids. Because of that, ids must be stable across months, and the first run for a project shows everything as `new`.

### 8.4 Our Green House deck generation
`generate_ogh_report.js` does not build slides. It opens the template as a zip, and for each slide replaces text runs, table cells, chart data (and the embedded workbook behind each chart), colours of the status dots, and swaps the pictures for the month's evidence screenshots. Everything written comes from `results/<site>/<month>/*.json` through `buildOghData()` (numbers) and `wording()` (sentences). Run on its own with `node generate_ogh_report.js --host www.ourgreenhouse.com --month 2026-10`. If a slide's wording must change, edit `wording()`; if a number's source must change, edit `buildOghData()`. The template's shapes are found by their text or position, so avoid renaming or moving shapes in the template.

## 9. Safety design

- All storefront audits are GET-only except a guest cart: add one sample item, change quantity, enter an invalid coupon, view checkout, then remove the item. No payment, contact, newsletter or account creation is ever submitted.
- Companion-app runners abort every non-GET request after login and report it as critical. Only pages listed in `safeNavTargets` (or `config/integrity-dashboard.json`) are visited.
- Search reflection is tested with a harmless script string that is only checked for being echoed back, never executed.
- The Shopify storefront password (Integrity widget) is typed by a person; no script reads or stores it.

## 10. Where to change things (lookup)

| I want to ... | Go to |
|---|---|
| Add a client or site | New file in `projects/` (section 6.1) |
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

## 11. Known behaviour worth knowing

- Severity scoring is strict. The security audit reports an old jQuery as `critical` because the library scanner groups every vulnerable library on a page, even when the database rates the individual issue only medium. Review such findings before they reach a client.
- Header and script findings (CSP, SRI) are produced per audited page, so the same issue appears once per page; the Our Green House deck merges them.
- Lighthouse fallback (no `PAGESPEED_API_KEY`) is slow (3 to 4 minutes per page) and its numbers differ from PageSpeed.
- The UptimeRobot runner creates a monitor for a new host.
- The gift basket builder on Our Green House has a small script error in the page's own code; it is reported every month until the site owner fixes it.
- Removed at handover (still available in git history): `monitor.js`, `check_integrity_dashboard.js`, `crawl_audit.js`, `build-spacing-compliance-report.js`, the PageSpeed experiment scripts, `config/sites.json` (replaced by `projects/*.json`), and one-off Integrity helper scripts.

## 12. Findings, severity and statuses

Every runner returns findings with the same fields (defined in `lib/result.js`):

| Field | Meaning |
|---|---|
| `id` | Stable identifier, for example `dns-no-dmarc-record`. Month-over-month comparison and suppression match on it. For per-page findings the page is part of the id (`...-homepage`, `...-product`). |
| `runner`, `category` | Which runner produced it and the audit category (`security`, `performance`, `seo`, `availability`, ...). |
| `severity` | `critical`, `high`, `medium`, `low` or `info`. |
| `title`, `detail`, `evidence`, `recommendation` | The text. `detail` explains the risk; `evidence` quotes what was seen; `recommendation` says what to do. |
| `status` (added by the comparison) | `new`, `persisting` (with `openSince`), `resolved`, `suppressed`. |

Audit statuses in the run summary: `completed`, `failed` (the audit crashed or timed out; the others continue), `skipped` (excluded with `--only`/`--skip` or missing input), `disabled` (turned off in the project file, with a reason), `not_implemented` (cache, or functional for projects without a `storefront` block). All of these must be reported to the user honestly; never describe a failed or skipped audit as done.

## 13. Per-project facts and rules

Copied from `docs/PROJECT_CONTEXT.md` (which has the full history and decisions; keep both current).

- **Genpet** (`genpet.org`, BigCommerce). Companion app `app.genpet.org`: read-only navigation (Dashboard, Cron Status, Activity Logs, Detail Pricing approved). On the shared vendor platform used by the Genpet and PartsConnexion apps, `POST /api/users/singleUser` trips the write guardrail on the first authenticated page load. It is probably a "fetch my profile" call, but the guardrail stays strict on purpose, so the navigation pass stops after the Dashboard. This is expected, not a bug. Do not whitelist it without the user's sign-off.
- **PartsConnexion and AudioConnexion** (BigCommerce Stencil). PartsConnexion has a Heroku companion app and USD/CAD multi-currency (`?setCurrencyId=2` is USD, `1` is CAD; the check verifies real price recalculation; zero prices on the homepage are normal). AudioConnexion has neither. The memory and server-log slide is for PartsConnexion only (the backend serves both and is mentioned once). Desktop LCP and CLS come from the prompt (`--cwv`); mobile figures are not reported. `categoryScores` in the project file hold fixed accessibility, best-practices and SEO scores supplied by the user.
- **Integrity Reforestation** (Shopify app plus Heroku dashboard). No PageSpeed scores; never ask for them. Dashboard QA is read-only: never click Email Templates Edit, Delete, Send test mail or ADD NEW, or Logout. The Horizon theme widget capture is manual and needs the storefront password, typed by a person. The deck is built from `config/monthly-monitoring-input-<month>.json`; the dev fixes counted as fixed come from `config/dev-fixes/`. Never use the words "follow-up", "items still open" or "noted for follow-up" in any Integrity deliverable. Excluded from automated navigation by design: pages with live customer personal data, Users pages, bulk import/export, and Settings pages showing live API keys.
- **Our Green House** (BigCommerce). No scores. Read-only storefront audits and a plain-language deck from the template. The existing runners grade more strictly than the September report did, so October's counts are not comparable with September's (see section 11).
- **LidStyles**: legacy, archived data only.

Integrity monthly text block: the dev team sends text each month. Its sections map to the input JSON: A build cache maintenance (`buildCacheAnalysis`), B server performance and 24-hour usage (`performanceMetrics`, `last24HoursUsage`), C resolved incident (`incidents`), D SSL certificate (`sslSecurity`). The "Theme details" block is the source of truth for theme names and versions (`themeUpdateLog`, active theme wording). Copy numbers, URLs, dates and names exactly; never reuse evidence links or incident text from a previous month; anything the text does not cover must be asked for. Validate with `node scripts/validate-integrity-input.mjs --month <month>` and fix every error.

## 14. Report quality rules

- Reports go to clients: accurate, plain language, no invented number. A wrong claim is worse than an empty section.
- Say what was done and what it means for the business; avoid raw ids and jargon. Items that were not measured say "Not measured".
- Do not add default values to a generator. If a number looks wrong, trace it to its runner result (a silent fallback once made a report claim clean security headers that were missing).
- No emojis in reports, documents or code comments.
- Before sending: open the PDF/PPTX, check every slide, confirm month names, site names and counts, and that skipped or failed audits are stated.

## 15. Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `--dry-run` says a score is missing | The project needs Before/After scores (`inputs.performanceScores: required`). Ask the user; do not guess. |
| "No project claims the hostname" | The URL's host is not in any project's `domains`. Add it to the project file. |
| Browser audits fail to start | Run `node scripts/ensure-browser.mjs`; set `CHROMIUM_EXECUTABLE_PATH`; the launcher already passes `--no-sandbox` (see `lib/browser.js`). |
| DNS or SSL results empty behind a proxy | Set `DNS_MODE=doh` and `SSL_MODE=browser`, or set `HTTPS_PROXY`. |
| Performance audit is very slow | No `PAGESPEED_API_KEY`, so local Lighthouse runs (3 to 4 minutes per page). Set the key. |
| Deck has no PDF copy | Neither PowerPoint nor LibreOffice is available; the run says so. Install one, then `--reports-only`. |
| Companion-app audit stops after the Dashboard (Genpet, PartsConnexion) | Expected, see section 13. |
| Integrity deck refuses to build | The input JSON is missing or failed validation. Copy last month's file as the template, fill it from the pasted text, validate, re-run with `--reports-only`. |
| A finding you know is a false positive keeps appearing | Add it to `config/known-issues.json` (confirm with the team first). |
| Run was interrupted | Re-run; results are overwritten per runner and month. Use `--only` to repeat just what failed. |
| Timeout on a long audit | Raise `--timeout-min`. |
| A `*_result.json` is missing for a report | The matching audit did not run or failed; the report shows "Not measured". Re-run that audit. |
| Reports regenerate but numbers look old | `--reports-only` reads saved results; re-run the audit to refresh them. |

## 16. Glossary

- **Audit**: one category of checks (dns, ssl, security ...), a folder under `audits/`.
- **Runner**: the code under `runners/` that performs the checks and returns findings.
- **Finding**: one observation with a severity, evidence and recommendation.
- **Project**: one client, defined by one file in `projects/`. It can have several sites.
- **Site**: one hostname inside a project; its results folder is its `archiveKey`.
- **Companion app**: the client's authenticated dashboard (for example the Heroku admin app), audited read-only.
- **Storefront block**: the `storefront` section of a site that holds selectors and paths for the storefront audits.
- **History**: the committed monthly record used for month-over-month comparison.
- **Evidence**: screenshots saved by the functional and responsive audits and used in the Our Green House deck.
- **SRI**: Subresource Integrity, a hash that lets the browser verify an external script has not been altered.
- **CSP**: Content-Security-Policy, a header listing which sources the browser may load scripts from.
- **DMARC / SPF / DKIM**: DNS records that protect a domain's email from being forged.
- **LCP / CLS / TBT / FCP**: Core Web Vitals and related timings (largest content, layout shift, blocking time, first paint).

## 17. Handover checklist

1. `npm install`, `node scripts/ensure-browser.mjs`, `npm test` (all green).
2. Create `.env` from `.env.example` (get the keys from the account owner; never commit them).
3. `node engine/run-audit.js --url https://www.ourgreenhouse.com --month 2099-01 --dry-run`, then a real run with `--month 2099-01`, then delete the 2099-01 folders.
4. Read `CLAUDE.md` and `docs/PROJECT_CONTEXT.md` fully.
5. Confirm access to: the GitHub repository, UptimeRobot, the Google PageSpeed API key, and the companion app monitoring accounts.
