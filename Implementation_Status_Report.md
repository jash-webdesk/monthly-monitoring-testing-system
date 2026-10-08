# Monthly Monitoring System — Implementation Status Report

**Cross-referenced against:** `blueprint/Monthly Monitoring System - Blueprint.md` (v0.3)
**Verified against:** actual runner source code, not documentation claims — every status below was confirmed by reading or running the real code, not inferred from comments.
**Date:** 2026-08-12

## Legend

| Status | Meaning |
|---|---|
| ✅ **Implemented** | Real, working code performs this check today, verified against source |
| 🟡 **Partial** | Some real coverage exists, but meaningfully incomplete versus the blueprint spec |
| ⚪ **Pending** | Not built. Technically feasible with the current architecture — no external blocker |
| 🚫 **Not Feasible** | Blueprint itself scopes this as manual/human-only, or it requires access/tooling this system doesn't have (hosting APIs, registrar APIs, client-side SDK installs) |

---

## Pillar 1 — Uptime Monitoring

| Sub-check | Status | Notes |
|---|---|---|
| HTTP status / synthetic health check | ✅ | `runners/uptime.runner.js` |
| UptimeRobot API (30-day ratio, historical logs) | ✅ | Real API key configured in `.env`; live API call confirmed in code, not a stub |
| Response time (TTFB) | ✅ | Captured per request |
| Redirect chain count | ✅ | `redirectsCount` populated |
| TLS handshake timing | 🟡 | `tlsHandshakeMs` field exists in the metrics schema but is never assigned — always `null` |
| Severity thresholds (99.0% / 99.5% / 99.9%) | ✅ | Applied in finding generation |

**Overall: ✅ Implemented**, one dead metrics field.

---

## Pillar 2 — Performance Monitoring

| Sub-check | Status | Notes |
|---|---|---|
| PageSpeed Insights API (desktop + mobile) | ✅ | Primary data source |
| Median-of-3 sampling | ✅ | Built specifically to reduce single-run variance (a real problem hit early — mobile scores swung 13→61 across runs) |
| Core Web Vitals (LCP, CLS) | ✅ | |
| INP | 🟡 | Blueprint calls out INP as the 2024+ standard interaction metric; runner reports TBT (its lab proxy) — INP itself isn't captured |
| Lighthouse CLI fallback | ✅ | |
| Month-over-month score drift (±3pt gating) | ✅ | Logged and reported |
| "Before/after" baseline semantics | ✅ | As of 2026-08-12, `--stage before|after` captures a same-month pre/post-optimization baseline instead of conflating it with last month's archive |
| WebPageTest waterfall | 🚫 | Blueprint marks this "Manual" — not in scope for automation |

**Overall: ✅ Implemented**, INP not distinctly tracked (TBT used as proxy).

---

## Pillar 3 — Security Monitoring

| Sub-check | Status | Notes |
|---|---|---|
| Security response headers (CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, COOP) | ✅ | `runners/devtools.runner.js` |
| Cookie flags (HttpOnly, Secure, SameSite) | ✅ | Scoped to sensitive cookies only, matching the false-positive rule |
| JWT `alg:none` detection | ✅ | Correctly CRITICAL |
| SRI (missing integrity on external scripts) | ✅ | |
| **OWASP Top 10:2025 mapping** | ✅ *(fixed 2026-08-12)* | Previously findings used a mix of hardcoded, partially stale 2021-era codes that **contradicted** the correct mapping already sitting unused in `runners/lib/owasp.js`. Now every finding resolves its code via `getOwaspMapping()` — single source of truth |
| **Outdated library / CVE scanning (Retire.js)** | ✅ *(built 2026-08-12)* | `retire` was a listed dependency for months but never invoked anywhere. Now live: fetches every script a page loads, matches against the Retire.js CVE database. Already caught a real, previously undetected issue — PartsConnexion loading jQuery 1.7.2 (2012) with 5 CVEs |
| testssl.sh (TLS cipher/protocol deep scan) | ⚪ | Blueprint marks optional; not installed/wired in |
| Nuclei (active exploit scanning) | 🚫 | Blueprint requires explicit client sign-off before this can ever run — correctly never implemented |
| Sensitive path exposure (`/phpinfo.php`, `/server-status`) | ⚪ | Has an OWASP mapping entry (`security.sensitive-path-exposed`) but no runner logic checks for it |
| Redaction of tokens/cookies in evidence (truncate + `[redacted]`) | 🟡 | Not verified this session — evidence strings for cookies/JWTs currently show cookie *names*, not values, which is safe, but there's no explicit truncation utility enforcing this as a rule everywhere |

**Overall: ✅ Implemented and substantially improved this session** — was the weakest-verified pillar; now the most rigorously checked, with the OWASP mapping bug fixed and real CVE scanning added.

---

## Pillar 4 — SEO Monitoring

| Sub-check | Status | Notes |
|---|---|---|
| Sitemap.xml validation | ✅ | `runners/crawler.runner.js` |
| Broken links (4xx) | ✅ | |
| Core Web Vitals as SEO signal | ✅ | Via Lighthouse/PSI (Pillar 2) |
| Page title tags (missing/duplicate) | ⚪ | Not implemented — no function in crawler.runner.js checks titles |
| Meta descriptions (missing/duplicate) | ⚪ | Not implemented |
| Canonical tags | ⚪ | Not implemented |
| robots.txt disallow rules (general SEO, not just AI bots) | 🟡 | Only the AI-bot-specific check exists (see Pillar 4B) — a generic "is Googlebot blocked from key sections" check does not exist separately |
| Redirect chains (3+ hops) | ⚪ | Not implemented |
| H1 tag presence | ⚪ | Not implemented |
| Structured data (JSON-LD) validity | 🟡 | Presence-only check exists (see 4B) — does not validate schema *type correctness* (Product vs FAQPage vs Organization) or catch syntax errors distinctly |

**Overall: 🟡 Partial** — only sitemap + broken-link checks are real; title/meta/canonical/H1/redirect-chain checks named in the blueprint's core SEO table don't exist yet.

---

## Pillar 4B — GEO & AEO Monitoring

| Sub-check | Status | Notes |
|---|---|---|
| robots.txt AI-crawler rules (GPTBot, etc.) | ✅ | `auditGeoAeo()` in crawler.runner.js |
| JSON-LD schema presence | ✅ | Detects *whether* schemas exist |
| JSON-LD schema type/correctness (Product, FAQPage specifically) | 🟡 | Only counts schema block presence generically — doesn't verify required fields per type |
| Flesch readability score | ✅ | Real calculation from page text, not a stub |
| Readability finding threshold (< 30 = MEDIUM) | ⚪ | **Score is computed and stored in metrics but never checked against the blueprint's threshold — no finding is ever generated for poor readability** |
| Direct-answer formatting (bullets/tables presence) | 🟡 | `hasStructuredDataTables` is computed but never turned into a finding when false |

**Overall: 🟡 Partial** — the hardest part (real readability scoring) is done; the easier part (turning it into an actionable finding) isn't wired up.

---

## Pillar 5 — SSL / TLS Monitoring

| Sub-check | Status | Notes |
|---|---|---|
| Certificate expiry / issuer / hostname coverage | ✅ | `runners/ssl.runner.js`, via Node's TLS module |
| Self-signed detection | ✅ | |
| Expiry escalation thresholds (7d/30d/60d) | ✅ | |
| HSTS header | ✅ | (covered jointly with Pillar 3) |
| TLS protocol version check | ⚪ | Not implemented — no code inspects negotiated TLS version |
| Weak cipher suite detection (RC4/3DES/MD5) | ⚪ | Not implemented |
| testssl.sh / SSL Labs grade | ⚪ | Blueprint marks optional; not wired in |

**Overall: 🟡 Partial** — certificate lifecycle is solid; protocol/cipher-level checks (the deeper TLS analysis) don't exist without testssl.sh, which isn't installed.

---

## Pillar 6 — Domain & DNS Monitoring

| Sub-check | Status | Notes |
|---|---|---|
| A / AAAA / CNAME / MX / NS records | ✅ | `runners/dns.runner.js` |
| SPF (presence + `+all` over-permissiveness) | ✅ | |
| DKIM (probes common selectors) | ✅ | Blueprint itself flags this as needing onboarding-configured selector names for full reliability — current implementation guesses common ones, a reasonable middle ground |
| DMARC (presence + policy strength) | ✅ | |
| Domain registration expiry | 🚫 | Blueprint itself marks this "Manual Verification Required" (not all registrar APIs available, WHOIS privacy blocks it) — correctly unimplemented |
| Custom-app subdomain DNS handling (Heroku vs client-owned) | ✅ | Correctly skips DNS/SPF/DMARC recommendations for shared-platform domains the client can't control, added this project |

**Overall: ✅ Implemented** — the one gap (domain expiry) is explicitly scoped as manual in the blueprint itself, not a real gap.

---

## Pillar 7 — Backup Monitoring

| Sub-check | Status | Notes |
|---|---|---|
| Backup frequency / last-successful-backup timestamp | ⚪ | No code anywhere in the repo touches hosting provider APIs, SSH, or offsite storage |
| Storage location (offsite verification) | ⚪ | Not implemented |
| Retention period | ⚪ | Not implemented |
| Restoration test | 🚫 | Blueprint marks this "Manual Verification Required" by design (a file existing doesn't prove it restores) |
| File + database coverage | ⚪ | Not implemented |

**Overall: ⚪ Pending — zero automated coverage.** The client-facing PDF/PPT currently displays "Backup Monitoring: Secured" — **this is cosmetic report copy only, not backed by any check.** Worth flagging: this is the one place the report currently asserts something the system doesn't verify at all.

---

## Pillar 8 — Error Monitoring

| Sub-check | Status | Notes |
|---|---|---|
| HTTP 5xx during page load | ✅ | `runners/devtools.runner.js`, via CDP network log |
| HTTP 4xx (missing resources) | ✅ | Filters known-noisy patterns (favicon, beacon, ping) |
| JavaScript console errors | ✅ | CDP console listener |
| Failed API calls | ✅ | Covered by the general network-error capture |
| Broken images/resources | ✅ | Covered by 4xx detection generically (not image-type-specific severity) |
| Sentry / Bugsnag / LogRocket integration | 🚫 | Blueprint lists these as requiring client-side SDK install — correctly out of this system's automated scope |

**Overall: ✅ Implemented.**

---

## Pillar 9 — Analytics Monitoring

| Sub-check | Status | Notes |
|---|---|---|
| GTM container presence | ✅ | `runners/devtools.runner.js` DOM scan |
| GA4 tag presence | ✅ | |
| Meta Pixel presence | ✅ | |
| Cookie consent banner presence | ✅ | |
| GTM/GA4 tag *firing* (network request confirmation) | 🟡 | Only DOM/script presence is checked — not confirmed that `google-analytics.com/g/collect` actually fires |
| Purchase event on order confirmation | ⚪ | Not implemented — blueprint itself flags this as needing a controlled test checkout, reviewer: QA Engineer |
| Add-to-cart event | ⚪ | Not implemented |
| Container/Measurement ID correctness | ⚪ | Presence is checked, not whether the ID matches the expected value |
| Tracking-before-consent violation | ⚪ | Not implemented |
| Duplicate purchase events | ⚪ | Not implemented |
| PII in analytics URLs | ⚪ | Not implemented |
| Consent banner mobile responsiveness | ⚪ | Not implemented |
| Privacy policy link presence | ⚪ | Not implemented |

**Overall: 🟡 Partial** — covers "is the tag present," not "is it actually collecting correct, compliant data," which is most of what this pillar promises.

---

## Pillar 10 — Functional Journey Monitoring

| Sub-check | Status | Notes |
|---|---|---|
| Search flow | ⚪ | No generic implementation for any site |
| Product filters | ⚪ | Not implemented |
| Add to cart | 🟡 | Only exists for the 2 currency-configured sites (Parts/Audio Connexion), as part of currency verification — not a general-purpose check for every site. **Currently broken**: the "Add to Cart" click fails because the button is hover-reveal-only in this theme |
| Checkout entry (redirect verification, no order placement) | ⚪ | Not implemented anywhere |
| User login | 🟡 | Implemented, but only for **custom-app** logins (GenPet, Parts Connexion), not the primary storefront login flow the blueprint describes |

**Overall: 🟡 Partial, and the weakest-covered pillar relative to its blueprint spec.** What exists is real (not fabricated) but narrow — 2 of 5 named checks have any coverage at all, and one of those two is a known open bug.

---

## Pillar 11 — Accessibility *(named in blueprint, no detailed spec section written)*

| Sub-check | Status | Notes |
|---|---|---|
| axe-core WCAG scans | ⚪ | `@axe-core/playwright` is a listed dependency in `package.json` — **never imported or invoked anywhere in the codebase.** Same dead-dependency pattern that Retire.js had before this session's fix |

**Overall: ⚪ Pending — zero coverage**, despite being counted in the health-score weighting table (2%) and referenced in the roadmap as "next."

---

## Visual Regression *(named in blueprint module list, no detailed spec section written)*

| Sub-check | Status | Notes |
|---|---|---|
| Screenshot capture per page | ✅ | Screenshots ARE taken (guest/auth passes, custom-app nav pages) |
| Screenshot **comparison** (pixel diff vs. baseline) | ⚪ | No diffing library (pixelmatch/resemble/etc.) is used anywhere — screenshots are captured for human review, not automatically compared |

**Overall: ⚪ Pending** for the actual "regression" half of visual regression — screenshot capture is a real building block already in place.

---

## Cross-Cutting Architecture (Sections 11, 15, 16, 19 of the blueprint)

| Component | Status | Notes |
|---|---|---|
| Standardized finding format (Section 15) | 🟡 | Core fields match (`id`/`runner`/`category`/`severity`/`title`/`detail`/`evidence`/`recommendation`/`owasp`/`wcag`/`status`) — but the blueprint's fuller schema (`fingerprint`, `runner_version`, `site_id`, `run_id`, `owasp_version`, `cause_confidence`, `coverage_status`, `occurrence_count`) is **not** implemented; current IDs serve the fingerprinting role instead |
| Month-over-month lifecycle (Section 16) | 🟡 | `new`/`persisting`/`resolved` implemented in `lib/differ.js`. Blueprint's fuller state machine (`resolved_pending`, `not_tested`, `inconclusive`, `accepted_risk`, `reopened`) is **not** implemented — a runner failure currently isn't distinguished from a genuinely fixed issue |
| Health Score (3-value: Score / Risk Rating / Coverage Confidence) | ⚪ | Not implemented as specified — reports show individual pillar findings and a performance before/after score, not a single gated 0–100 health score with the blueprint's override rules |
| AI Layer (executive summary, evidence-based hypotheses, compound risk chains) | ⚪ | Not implemented — no AI analysis layer exists; report generation is template-driven from raw findings, not AI-synthesized |
| Known-issues suppression | ✅ | `config/known-issues.json`, matched on finding ID |
| Production safety rules (Section 19.3) | ✅ | Followed in practice — write-guardrails on custom-app monitoring, no checkout/order placement, guest-session-only currency testing |

---

## Summary

| Pillar | Status |
|---|---|
| 1. Uptime | ✅ Implemented |
| 2. Performance | ✅ Implemented |
| 3. Security | ✅ Implemented *(most improved this session)* |
| 4. SEO | 🟡 Partial |
| 4B. GEO/AEO | 🟡 Partial |
| 5. SSL | 🟡 Partial |
| 6. DNS | ✅ Implemented |
| 7. Backup | ⚪ **Pending — zero coverage, but reported as "Secured"** |
| 8. Error Monitoring | ✅ Implemented |
| 9. Analytics | 🟡 Partial |
| 10. Functional Journey | 🟡 Partial *(weakest pillar)* |
| 11. Accessibility | ⚪ Pending — zero coverage |
| Visual Regression | ⚪ Pending — capture only, no diffing |
| AI Analysis Layer | ⚪ Not implemented |
| Health Score (3-value) | ⚪ Not implemented |

**Solid ground:** Uptime, Performance, Security (now the strongest pillar after today's OWASP/Retire.js work), DNS, Error Monitoring.
**Biggest gaps relative to what's promised:** Backup Monitoring (zero automation behind a report line that says "Secured"), Accessibility (dead dependency, never wired in), Functional Journey Monitoring (2 of 5 checks, one broken), the AI analysis/health-score layer (Phase 2/3 of the blueprint's own roadmap — never started).
