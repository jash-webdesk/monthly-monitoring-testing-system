# Project context and history

Background a new session needs and cannot get from the code alone. Keep this file current: when you learn something durable (a decision, a gotcha, a client rule), add it here and commit it.

## What this is
WebDesk Solution's monthly monitoring service for client websites and apps. Each month an audit runs for each project, and two reports are produced: a technical report (PDF, issue by issue) and a client report (PowerPoint deck, plus a PDF copy, in plain language for non-technical readers). The same engine serves every project; per-project differences live in `projects/*.json`.

## Who and how
- The user (jash-webdesk, WebDesk Solution) runs the service and sends the reports to clients. Reports must be accurate and in plain business language; a wrong claim in a client report is worse than an empty section.
- Do not use emojis in docs, reports or code comments.
- Verify before building. Check real selectors, URLs and mechanisms against the live site (or the real source) before writing automation; never guess. If a document says something is "already built", grep the code to confirm.
- Report outcomes faithfully. Failed, skipped, disabled or not-implemented audits are stated plainly, never hidden or described as done.

## Output conventions
- Technical report = PDF (`report/generator.js`, or the Integrity technical report). Client report = PowerPoint deck (`generate_ppt_report.js`, or the Integrity deck) plus a PDF copy of the deck.
- Performance Before/After scores are the user's own hand-run PageSpeed numbers, supplied in every prompt. Reports must show those numbers. Measured PageSpeed values are stored for trending only and never replace supplied scores. Before = the day the month's audit starts, before that month's fixes; After = once the month's fixes are done (not last month versus this month).
- Plain-language rule for client material: say what was fixed and what it means for the business. Avoid raw technical ids, jargon and negative-only "0 of 6" framing. Unmeasured items say "Not measured"; never invent a number or a clean bill of health.
- Before trusting a `something?.metrics?.key ?? true` pattern in a report generator, confirm the runner actually fills that key. A silent fallback once made reports claim a clean security audit while real headers were missing.

## Safety boundaries (client production sites)
- A client's own storefront, in a logged-out guest session: switching currency and adding to the cart are fine (same as any shopper). Never check out, never place an order.
- Any admin panel, custom backend or third-party app is high risk by default. Companion-app runners are read-only: every non-GET request after login is aborted and reported critical. Do not add an exception for any write request without the user's explicit, fresh confirmation.
- Known: on the shared vendor platform used by the Genpet and PartsConnexion apps, `POST /api/users/singleUser` trips the write guardrail on the first authenticated page load. It is probably a "fetch my profile" call, but the user declined to confirm that, so the guardrail stays strict on purpose. Consequence: the navigation pass stops after the Dashboard each run. This is expected, not a bug.
- Never type a real password into an interactive browser tool, even if told it is allowed. Logins go through the project's own scripts using environment variables. The Shopify storefront password for Integrity is entered by the user.
- Excluded from automated navigation by design: pages showing live customer PII with inline-editable widgets, Users pages, bulk import/export (file upload), and Settings pages that render live API keys in plain text.
- Secrets never go in git. Logins come from environment variables listed in `.env.example`; a missing login means a guest run or a skipped step, never a failure.

## Projects
- **Genpet** (`genpet.org`, BigCommerce). Companion app `app.genpet.org` (Material UI login at `/new/login/`; username field `input[placeholder="email"]`; read-only nav pass; Dashboard, Cron Status, Activity Logs, Detail Pricing approved).
- **PartsConnexion and AudioConnexion** (`partsconnexion.com`, `audio-connexion.com`, BigCommerce Stencil). PartsConnexion has a Heroku companion app (same vendor template as Genpet; Dashboard, Cron Status, Activity Logs, Automatic Discount approved). AudioConnexion does not share that app despite the footer branding. Both have USD/CAD multi-currency: the switch is `?setCurrencyId=2` (USD) or `1` (CAD); the check verifies real price recalculation on homepage, category and product pages. The homepage shows no price grid, so zero prices there is normal. The cart-persistence check still does not work (hover-only "Add to Cart" button); a known open item. A security fix for two SRI scripts (jQuery 1.7.2, jQuery.Marquee) is verified on PartsConnexion only; AudioConnexion still lacks them.
- **Integrity Reforestation** (Shopify public app "Tree Contribution" widget plus Heroku admin dashboard `integrity-dashboard-bf73ab673f4c.herokuapp.com`, NextAuth login). No PageSpeed scores; never ask for them. The month's audit is read-only dashboard QA (Dashboard, Stores Listing and each store, Email Templates, Email Logs; 83+ checks) plus a Horizon-theme widget audit done by hand. Never click Email Templates Edit, Delete, Send test mail or ADD NEW, or Logout. No screenshots or recipient emails are saved from the dashboard run.
  - Dashboard shows `$2.00 CAD` per tree; relevant to wording on the widget functional-check line.
  - Email Logs and Stores date ranges take both a start and an end date by clicking two days in one calendar. An earlier "only a start date" finding was a false positive; never report it.
  - Where results were filed: the custom-app QA belongs in the OCTOBER 2026 report (filed once under September by mistake and corrected). The September deck has no custom-app content. The October re-test after the dev team's fixes found 3 of 11 items fixed; the baseline is kept as `integrity_dashboard_baseline_pre-fix.json` so reports show before and after.
  - The client deck is built from `config/monthly-monitoring-input-<month>.json`. Most of its operations content comes from a text block the dev team sends each month (build cache, server metrics, incident, SSL certificate); see "Integrity Reforestation: the monthly text block" in `CLAUDE.md`. The September report is the reference for how that text maps to the deck.
  - The October input file has no operations section yet (the supplied text was September's). Widget screenshots for the Horizon theme (48 images) were captured earlier in a local session; the repo has no script for that capture, and it needs the storefront password.
- **LidStyles**: legacy; kept so archived data keeps working.

## State of the build (update as it changes)
- Engine, audit modules, history, reports, spreadsheet batch runner, prompt builder, delivery page and cloud scripts exist and are unit tested (`npm test`).
- Verified locally: all eight enabled audits for Genpet end to end, month-over-month comparison, technical PDF, client deck and deck PDF, per-site scores, per-site logins with guest fallback.
- Not verified in a real cloud session: browser install, LibreOffice install (deck PDF), the egress proxy behaviour, whether the Artifact tool exists there, and whether its Save buttons work. `docs/FIRST_CLOUD_RUN.md` is the test plan; record results in `docs/LIMITATIONS.md`.
- Not implemented: functional (storefront journeys, widget capture) and cache audits.
- Legacy entry points (`monitor.js`, `check_integrity_dashboard.js`, `generate_*.js`) still work and are what the engine calls. Prefer the engine.

## Working in the cloud
- The session starts from a fresh clone: no `.env`, no `results/`, no earlier conversations, no local auto-memory. Everything durable must be in this repo.
- Foreground commands time out after about two minutes; run audits as background tasks and poll the log.
- Use a fake month such as `2099-01` for any test, and delete it afterwards so real results are never overwritten or committed.
- Deliver by committing `reports/`, `history/`, `inputs/` and `config/dev-notes/` to a `claude/` branch. Never force-push, and do not push to `main` unless asked.
