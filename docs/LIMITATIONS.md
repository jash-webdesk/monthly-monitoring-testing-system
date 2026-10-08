# Limitations and unverified assumptions

Honest list of what the system does not do yet, and what has not been proven in a real cloud session.

## Not implemented
- **functional audit** (add to cart, cart drawer, checkout up to payment, widget capture on the Shopify Horizon theme). The engine registers it and reports `not_implemented`. The Integrity widget capture also needs the Shopify storefront password, which a person must enter.
- **cache audit** (server and build-cache metrics). These come from hosting dashboards; there is no API runner.
- **Integrity client deck input.** The deck needs `config/monthly-monitoring-input-<month>.json` (theme update log, widget screenshot links, dev-team notes). The engine stops with a clear message if it is missing; it does not invent content.

## Not yet verified in the cloud (documented behaviour only)
- Playwright's browser download inside the cloud VM is not documented. `scripts/ensure-browser.mjs` tries the download and falls back to `@sparticuz/chromium`. If both fail, browser-based audits (security, SEO crawl, currency, companion apps, SSL fallback, report PDFs) cannot run. Run `node scripts/cloud-preflight.mjs` first to know.
- All traffic leaves through an HTTP/HTTPS proxy. fetch, https, Chromium, DNS (DNS-over-HTTPS) and SSL reading (through the browser) are routed accordingly and tested locally against a stand-in proxy. A TLS-inspecting proxy would make SSL results unreliable; preflight warns if the certificate issuer looks unusual.
- Client sites need the environment network level Full (or a custom allowlist).

## Platform limits
- No documented way to download files directly from a cloud session. Delivery is by git: reports are pushed to a `claude/...` branch and linked in the reply.
- Foreground commands time out after about 2 minutes (max 10); the audit must run as a background task with log polling. A full audit can take several minutes per site.
- Environment variables are plain text, visible to anyone who can edit the environment. Use dedicated, low-privilege monitoring accounts.
- Routines (scheduled cloud runs) have a 1 hour minimum interval and push only to `claude/` branches. Fully unattended monthly runs are possible but not configured.
- Sessions are private to one account; a teammate cannot continue your session.

## Known data caveats
- Performance Before/After scores come from the prompt. PageSpeed measurements are stored for trending but never override supplied scores.
- Companion-app runners abort every write request after login. Genpet has a known unresolved guardrail trip (POST /api/users/singleUser); do not whitelist it without sign-off.
- LidStyles is kept as a legacy project only so archived data keeps working.

## Running without secrets (tested locally with `--no-env`)
`node engine/run-audit.js ... --no-env` (or `MM_NO_DOTENV=1`) ignores `.env`, which rehearses a cloud session with no variables set. Result on Genpet: network used the live probe instead of UptimeRobot, performance fell back to the local Lighthouse CLI instead of the PageSpeed API, security ran the guest pass only, and the companion app ran its unauthenticated health check with an info finding. All completed.
- The Lighthouse fallback is slow (about 3 to 4 minutes per page) and its numbers differ from PageSpeed. Reports still show the scores from the prompt. Set `PAGESPEED_API_KEY` for quick runs.
- In the cloud the fallback uses the engine's Playwright Chromium (`CHROME_PATH` is set for it). This has not been run in a real cloud session.
- When variables are set in the cloud environment, every runner reads them directly from the process environment; no `.env` file is needed.
