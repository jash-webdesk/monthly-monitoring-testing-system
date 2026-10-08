# AGENTS.md — Monthly Monitoring Testing System

## Project Overview

AI-assisted monthly monitoring for existing live eCommerce sites: performance,
security headers, DNS/SSL, uptime, SEO/crawl, and — where configured — custom-app
health and multi-currency (USD/CAD) storefront verification. Produces a client-facing
PDF/PPTX report with month-over-month diffing.

**Not for:** new builds, redesigns, migrations, one-time audits.
**Only for:** recurring monthly monitoring of sites already live and in `config/sites.json`.

---

## Architecture

```
Layer 1 — Runners (runners/*.runner.js)   Collect facts only. No severity, no interpretation.
Layer 2 — lib/differ.js                    Deterministic month-over-month diff (new/persisting/
                                            resolved/suppressed) + score drift. Rule-based, not AI.
Layer 3 — report/generator.js              Builds client PDF (+ generate_ppt_report.js for PPTX).
```

Orchestrated by `monitor.js`. Runners never throw — catch and return an `info`-severity
"Runner error" finding so the rest of the pipeline keeps going.

## Project Structure

```
monitor.js                  ← entry point
config/
  sites.json                 ← site registry (platform, currencies, customApp block, scores baseline)
  known-issues.json          ← confirmed false positives per hostname, matched by finding id
lib/
  archive.js                 ← save/load per-runner JSON to results/<host>/<month>/
  config.js, differ.js, logger.js, result.js (finding schema + SEVERITY/CATEGORY enums)
runners/
  uptime, dns, ssl, crawler, lighthouse, devtools   ← always run
  customapp.runner.js        ← only if site has a `customApp` block
  currency.runner.js         ← only if site declares "currencies": ["USD","CAD"]
  lib/owasp.js                ← OWASP Top 10 mapping helper
report/
  generator.js                ← HTML → PDF via Playwright; filename: <slug>-<YYYY>-<MM>-report.pdf
results/<hostname>/<YYYY-MM>/ ← <runner>_result.json, raw.json, diff_result.json, report files
```

---

## Finding format (lib/result.js — `createFinding()`)

```js
{ id, runner, category, severity, title, detail, evidence, recommendation,
  owasp: null, wcag: null, status: 'new' }   // status is overwritten by differ.js
```
`SEVERITY`: critical|high|medium|low|info. `CATEGORY`: performance|security|accessibility|
functional|dns|ssl|uptime|custom_app. `id` must be stable across runs — differ.js matches on it.

## Known Issues

`config/known-issues.json` is keyed by hostname; each entry needs `id`, `reason`,
`confirmedBy`, `confirmedDate`. Suppressor matches on `id`, never on title.

## Custom App & Currency runners — safety rules

- **Custom app** (`runners/customapp.runner.js`): authenticated nav is restricted to a
  human-approved `safeNavTargets` list per site. Every POST/PUT/PATCH/DELETE observed
  after login is a CRITICAL finding and aborts the pass — do not add exceptions without
  explicit user sign-off, even for requests that look benign.
- **Currency** (`runners/currency.runner.js`): guest/anonymous session only. Verifies
  homepage, category, and PDP prices actually recalculate (not just relabel) across
  USD/CAD. Never proceeds to checkout or places an order.
- Before wiring either runner against a new site, do live discovery first (BrowserMCP or
  similar) — do not guess selectors/URLs/mechanisms.

## Running

```bash
node monitor.js --url https://partsconnexion.com/                  # full audit + report
node monitor.js --url https://partsconnexion.com/ --phase dns      # single phase
node monitor.js --url https://partsconnexion.com/ --report-only    # regenerate report from archive only
node monitor.js --url https://partsconnexion.com/ --report-only \
  --prev-desktop N --prev-mobile N --curr-desktop N --curr-mobile N  # one-off score override
```
`--report-only` never re-measures — it's the safe way to regenerate a report without
touching archived data. A full run or `--phase lighthouse` re-measures PageSpeed live and
overwrites archived scores.

## Coding Standards

- Node.js v22+, ESM (`import`/named exports only, no default exports).
- Async/await, no `.then()` chains.
- No `console.log` in runners — use `lib/logger.js`.
- JSDoc on exported functions; validate inputs at the top of each runner.

## Report tone

Plain English for clients. Not: *"OWASP A05 misconfiguration detected."*
Prefer: *"The site is missing a Content Security Policy header, so an injected script
could run freely in your customers' browsers."*

---

*Keep this file in sync with the actual code — if a claim here can't be found by grepping
the codebase, fix the doc, don't trust it.*
