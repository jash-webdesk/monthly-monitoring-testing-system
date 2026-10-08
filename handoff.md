# Monthly Monitoring System — Session Handoff & Project State

**Document Purpose:** Accurate technical handoff of what is actually built and verified in this codebase, plus known gaps and next steps.
**Last Updated:** August 11, 2026
**Note on prior versions of this file:** An earlier version of this document (from a different agent session) described a "Custom App Auto-Discovery Architecture" using a `customApps` array field with `checkCors`/`monitoredEndpoints`/etc. **That was never implemented — it was aspirational documentation presented as if it were real.** Verified via full codebase grep before this rewrite: zero code anywhere reads those field names. Do not trust claims in this file (or any handoff) without checking the actual source — see the "Verify before trusting this file" note at the bottom.

---

## 1. Architecture

Three layers, kept strictly separate:
- **Layer 1 — Data Collection:** Node.js runners in `runners/` gather facts only (`uptime`, `dns`, `ssl`, `crawler`, `lighthouse`, `devtools`, `customapp`, `currency`). No severity assignment, no interpretation, no chaining.
- **Layer 2 — Deterministic Analysis:** `lib/differ.js` computes month-over-month finding lifecycle (`new`/`persisting`/`resolved`/`suppressed`) and score drift. Rule-based, not AI.
- **Layer 3 — Report Generation:** `report/generator.js` builds the client PDF; `generate_ppt_report.js` builds the PowerPoint.

Orchestrated by `monitor.js`, invoked as `node monitor.js --url <url> [--phase <name>] [--month YYYY-MM] [--report-only]`.

---

## 2. Site Portfolio

| Site | Platform | Custom App? | Multi-Currency? |
|---|---|---|---|
| **PartsConnexion** (`partsconnexion.com`) | BigCommerce + Heroku Custom App | **YES** (`pcx-72af9e2f5ce4.herokuapp.com`) | **46 → 67** | **34 → 64** | Audits Heroku Custom App, USD/CAD Multi-Currency, and GraphQL unbatched requests. |
| **AudioConnexion** (`audio-connexion.com`) | BigCommerce (Stencil) | **NO** | **45 → 56** | **41 → 47** | Audits USD/CAD Multi-Currency and GraphQL unbatched requests. |
| **Genpet** (`genpet.org`) | BigCommerce + Makeswift | **YES** (`app.genpet.org`) | **68 → 90** (Home) / **70 → 97** (About) | **55 → 64** (Home) / **70 → 74** (About) | Audits `app.genpet.org` companion app, Homepage & About Us CWV, and authenticated routes. |
| **LidStyles** (`www.lidstyles.com`) | Magento 2 | **NO** | **60 → 74** | **41 → 55** | Audits Varnish FPC debug headers, Magento admin security, and static assets. |

---

## 3. Custom App Monitoring — real schema, real status

**Runner:** `runners/customapp.runner.js`. **Config:** a `customApp` object (singular) on the site's entry in `config/sites.json` — auto-detected, zero manual flags needed for sites without one.

```json
"customApp": {
  "enabled": true,
  "hostname": "app.genpet.org",
  "url": "https://app.genpet.org/",
  "auth": {
    "usernameEnvVar": "GENPET_CUSTOMAPP_USERNAME",
    "passwordEnvVar": "GENPET_CUSTOMAPP_PASSWORD",
    "loginUrl": "https://app.genpet.org/new/login/",
    "usernameSelector": "input[placeholder=\"email\"]",
    "passwordSelector": "#auth-login-v2-password",
    "submitSelector": "button:has-text(\"Login\")"
  },
  "safeNavTargets": [ { "label": "Dashboard", "url": "..." }, ... ],
  "discoveryApprovedBy": "client (chat approval)",
  "discoveryApprovedAt": "2026-08-11"
}
```

### What it checks
1. Unauthenticated: reachability/response-time, SSL cert on the app's own hostname, DNS (skipped automatically if the app's hostname doesn't share a registrable domain with the primary site — e.g. Heroku's domain — since DNS/SPF recommendations would be unactionable there).
2. Authenticated: logs in (session cached in `.cache/customapp-sessions/<hostname>.json`, gitignored, reused until it expires — avoids hitting the login form every run), then visits **only** the human-approved `safeNavTargets` list via `page.goto()` — never clicks or fills anything else.
3. **Safety guardrail:** every HTTP request observed after login is checked via CDP. Any `POST`/`PUT`/`PATCH`/`DELETE` is a CRITICAL finding and aborts the remaining nav pass immediately.

### genpet.org — fully built and validated
Login mechanics confirmed live (MUI form; the guessed `input[type="email"]` was wrong, real selector is `input[placeholder="email"]`). Approved nav list: **Dashboard, Cron Status, Activity Logs, Detail Pricing**. Explicitly excluded from any automated list: **Settings** (renders live BigCommerce API Key/Token/Client Secret in plaintext — would leak into report screenshots), **Customer Approval/List and Products** (live PII/inventory with inline-editable widgets directly in the grid), **Uploads** (file-upload capability).

**Open item:** every run flags `POST /api/users/singleUser` as an "unexpected write request" (CRITICAL). Almost certainly a benign post-login "fetch my profile" call, but the user explicitly could not confirm this, so **do not add an exception without their sign-off** — this is intentional, not a bug.

### partsconnexion.com — config scaffolded, discovery not started
Health/SSL checks work; DNS correctly skipped (Heroku-owned domain). No `safeNavTargets` yet — needs its own supervised discovery pass (same process as genpet.org) once the user wants to proceed.

---

## 4. Multi-Currency Verification (USD/CAD) — built, partially validated

**Runner:** `runners/currency.runner.js`. **Config:** `"currencies": ["USD", "CAD"]` on the site entry — auto-detected. Findings use `CATEGORY.FUNCTIONAL` and flow into the **existing generic pipeline** (Executive Summary highlights + Action Plan table) — **deliberately no dedicated report section**, per explicit user design choice.

### Confirmed mechanism (identical on both sites — same Stencil theme)
- Switch currency: append `?setCurrencyId=2` (USD) or `?setCurrencyId=1` (CAD) to any URL. No dropdown-click needed.
- Prices render as `USD $12.34` / `CAD $12.34`.
- The check verifies the price actually **recalculates numerically**, not just the label — this is the core value: a page that swaps "CAD" onto an unchanged USD number would be silently wrong to a human eyeballing it, but this check catches it. Confirmed working live: partsconnexion.com showed USD $20.00 → CAD $28.88 for the same product, correctly detected as a genuine conversion (no false finding raised).
- Guest/anonymous session throughout. Adding an item to cart is treated as safe (not a mutation of real data) — the flow stops at the cart page, never proceeds to checkout, per blueprint Pillar 10 safety rules.

### What's validated
Homepage and product-detail-page price verification, on both partsconnexion.com and audio-connexion.com — no crashes, no false positives after two rounds of fixes (see below).

### What's NOT working yet
**Cart persistence check.** The "Add to Cart" link is found by the Playwright locator but fails Playwright's actionability check as "not visible" — most likely this theme only reveals the button on card hover (CSS `:hover`-gated visibility). Needs: hover over the product card (or scroll it into view) before attempting the click, or use a forced click that bypasses the visibility check. This was left unresolved when the session ended — **pick this up first** when multi-currency work resumes.

### Bugs already fixed this session (don't reintroduce)
1. Product-link discovery originally looked at the homepage's "Best Sellers" tiles — those link to **category** pages, not individual products, so 0 prices found there is normal/expected, not a switcher failure. Fixed to discover a category link first, then a real priced product from that category's listing.
2. The category-link discovery heuristic ("same-origin link, not a known utility path, single path segment") initially matched the currency switcher's own `?setCurrencyId=` links, since query strings don't count as path segments. Fixed by explicitly excluding any href containing `?` or `#`.
3. The homepage-price-mismatch finding originally fired whenever CAD prices found = 0, without checking whether USD prices were ever present. Since the homepage doesn't show a price grid at all (just category tiles), this was a guaranteed false positive on every run. Fixed to only fire when USD prices were present but CAD prices came back empty (a genuine regression signal).

---

## 5. Core pipeline fixes (stable, from earlier in this session)
- Performance score auto-detection reads last month's real archived Lighthouse/PSI data instead of requiring `--prev-desktop`/`--prev-mobile` flags or static config.
- `lib/differ.js`'s month-over-month diffing (new/persisting/resolved) is wired into `monitor.js` and saved to `results/<host>/<month>/diff_result.json`.
- `saveRawResults()` in `lib/archive.js` **merges** with existing `raw.json` instead of overwriting — running a single `--phase` no longer destroys other runners' data for that month.
- Median-of-3 PSI sampling in `runners/lighthouse.runner.js` to reduce single-run variance (a real problem: same URL returned mobile scores of 13, 37, 48, and 61 across separate manual checks).
- PDF report page-numbering converted to a running counter (was hardcoded, had a duplicate "Page 7" bug); `box-decoration-break: clone` added so multi-page sections get consistent margins.
- PowerPoint report filenames dynamically format Month and Year from the audit `month` argument (`generate_ppt_report.js`), producing `PartsConnexion_Monthly_Optimization_Report_August_2026.pptx` for August audits instead of hardcoded `July_2026`.

---

## 6. How to run

```bash
# Full audit + report for any site
node monitor.js --url https://partsconnexion.com/
node monitor.js --url https://audio-connexion.com/
node monitor.js --url https://genpet.org/
node monitor.js --url https://www.lidstyles.com/

# Single phase (merges into existing raw.json, doesn't clobber other runners)
node monitor.js --url https://partsconnexion.com/ --phase currency
node monitor.js --url https://genpet.org/ --phase customapp

# Regenerate report only, from already-archived data
node monitor.js --url https://partsconnexion.com/ --report-only
```

---

## 7. Verify before trusting this file

This document itself could go stale or be wrong. Before relying on any specific claim here for further work:
- Config schema claims → read `config/sites.json` directly.
- "What's built" claims → grep the actual runner file, don't assume the description above is complete.
- Score/status numbers → re-run the relevant phase; don't treat anything above as current data, only as a map of what exists.

*Handoff reflects verified state as of session end. Multi-currency cart-persistence check and partsconnexion.com's custom-app discovery are the two clear next steps.*
