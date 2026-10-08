/**
 * ONE-TIME migration: config/sites.json  ->  projects/<project>.json
 * Keeps every non-score field exactly as it was. The hand-set Before/After "scores" blocks are NOT
 * carried into project configs any more (scores are supplied per run in the prompt); they are written
 * to scripts/data/legacy-scores.json so scripts/backfill-history.js can attach them to the months they
 * belonged to. Safe to re-run; it overwrites the generated files.
 */
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const sites = JSON.parse(fs.readFileSync(path.join(root, 'config/sites.json'), 'utf8')).sites;
const integrityDash = JSON.parse(fs.readFileSync(path.join(root, 'config/integrity-dashboard.json'), 'utf8'));
const get = (h) => { const s = sites.find((x) => x.hostname === h); if (!s) throw new Error('site not found: ' + h); return s; };

const legacyScores = {};
const siteEntry = (s) => {
  const { scores, ...rest } = s;
  if (scores) legacyScores[s.hostname] = scores;
  return { ...rest, archiveKey: s.hostname };
};

const baseAudits = () => ({
  performance: { enabled: true, pages: 'all', note: 'PageSpeed Insights, median of 3. Measurements are stored for trend analysis; reports show the Before/After scores supplied in the prompt.' },
  security: { enabled: true, pages: 'all', authenticatedPass: true, note: 'Chrome DevTools/CDP: security headers, cookies, SRI, console errors, vulnerable libraries. The authenticated pass runs only when STOREFRONT_USERNAME/STOREFRONT_PASSWORD are set.' },
  dns: { enabled: true },
  ssl: { enabled: true },
  seo: { enabled: true, note: 'Sitemap + crawl, canonical/robots/structured data, GEO/AEO readiness, multi-viewport layout.' },
  'ai-crawlers': { enabled: true, note: 'Derived from the seo crawl (robots.txt rules for GPTBot, Gemini, Claude, Perplexity ...).' },
  network: { enabled: true, note: 'Availability + response time (UptimeRobot when UPTIMEROBOT_API_KEY is set, live probe otherwise).' },
  functional: { enabled: false, reason: 'No generic storefront-journey runner exists yet (see docs/LIMITATIONS.md).' },
  'companion-app': { enabled: false },
  cache: { enabled: false, reason: 'Server/build-cache metrics are captured manually from the hosting dashboard; no API runner exists yet.' },
  currency: { enabled: false }
});

const SECRET = (env, purpose, required, scope = 'environment') => ({ env, purpose, required, scope });
const COMMON_SECRETS = [
  SECRET('PAGESPEED_API_KEY', 'Google PageSpeed Insights API (performance audit)', true),
  SECRET('UPTIMEROBOT_API_KEY', 'UptimeRobot read-only API key (30-day availability); optional - a live probe is used without it', false),
  SECRET('STOREFRONT_USERNAME', 'Storefront customer login for the authenticated security pass; optional', false),
  SECRET('STOREFRONT_PASSWORD', 'Storefront customer password for the authenticated security pass; optional', false)
];

const projects = [];

// ── PartsConnexion & AudioConnexion (two storefronts, one project) ────────────
{
  const parts = siteEntry(get('partsconnexion.com'));
  const audio = siteEntry(get('audio-connexion.com'));
  projects.push({
    schemaVersion: 1,
    id: 'parts-audio-connexion',
    name: 'PartsConnexion & AudioConnexion',
    client: 'Parts Connexion / Audio Connexion',
    platform: 'bigcommerce',
    domains: ['partsconnexion.com', 'www.partsconnexion.com', 'audio-connexion.com', 'www.audio-connexion.com', 'pcx-72af9e2f5ce4.herokuapp.com'],
    sites: [parts, audio],
    audits: {
      ...baseAudits(),
      'companion-app': { enabled: true, appliesTo: ['partsconnexion.com'], note: 'Heroku custom app (read-only nav pass, write-request guardrail). AudioConnexion has no companion app.' },
      currency: { enabled: true, appliesTo: ['partsconnexion.com', 'audio-connexion.com'], note: 'USD/CAD price recalculation on homepage, category and PDP (guest session; never checkout).' }
    },
    secrets: [...COMMON_SECRETS, SECRET('PARTSCONNEXION_CUSTOMAPP_USERNAME', 'PartsConnexion custom app login', true), SECRET('PARTSCONNEXION_CUSTOMAPP_PASSWORD', 'PartsConnexion custom app password', true)],
    reports: { technical: 'site-pdf', client: 'site-pptx' },
    reportMeta: { clientDisplayNames: { 'partsconnexion.com': 'PartsConnexion', 'audio-connexion.com': 'AudioConnexion' } }
  });
}

// ── Genpet ────────────────────────────────────────────────────────────────────
{
  const genpet = siteEntry(get('genpet.org'));
  projects.push({
    schemaVersion: 1,
    id: 'genpet',
    name: 'Genpet',
    client: 'Genpet',
    platform: 'bigcommerce',
    domains: ['genpet.org', 'www.genpet.org', 'app.genpet.org'],
    sites: [genpet],
    audits: {
      ...baseAudits(),
      'companion-app': { enabled: true, appliesTo: ['genpet.org'], note: 'app.genpet.org dashboard (read-only nav pass, write-request guardrail). POST /api/users/singleUser is a known unresolved guardrail trip; do NOT whitelist without explicit sign-off.' }
    },
    secrets: [...COMMON_SECRETS, SECRET('GENPET_CUSTOMAPP_USERNAME', 'Genpet custom app login', true), SECRET('GENPET_CUSTOMAPP_PASSWORD', 'Genpet custom app password', true)],
    reports: { technical: 'site-pdf', client: 'site-pptx' },
    reportMeta: {}
  });
}

// ── Integrity Reforestation (Shopify app + admin dashboard; no monitored storefront domain) ──
{
  const dashHost = new URL(integrityDash.baseUrl).hostname;
  projects.push({
    schemaVersion: 1,
    id: 'integrity-reforestation',
    name: 'Integrity Reforestation',
    client: 'Integrity Reforestation',
    platform: 'shopify-app',
    domains: [dashHost, 'test-demo-store-801srwej.myshopify.com'],
    sites: [{
      hostname: dashHost,
      archiveKey: 'integrity-reforestation',
      name: 'Integrity Reforestation',
      platform: 'shopify-app',
      timeout: 30000,
      retries: 2,
      notes: 'Shopify public app (Tree Contribution widget) + Heroku admin dashboard. The test store is storefront-password protected.',
      pages: { dashboard: integrityDash.baseUrl + '/login' },
      storeUrl: 'https://test-demo-store-801srwej.myshopify.com',
      companionApp: { kind: 'integrity-dashboard', configFile: 'config/integrity-dashboard.json' }
    }],
    audits: {
      ...baseAudits(),
      performance: { enabled: false, reason: 'No scored storefront pages for this project.' },
      security: { enabled: true, pages: 'all', authenticatedPass: false, note: 'Unauthenticated login page of the admin dashboard only.' },
      dns: { enabled: false, reason: 'Dashboard is on a shared herokuapp.com domain; DNS findings would not be actionable.' },
      seo: { enabled: false, reason: 'Admin dashboard is not a public site.' },
      'ai-crawlers': { enabled: false, reason: 'Admin dashboard is not a public site.' },
      'companion-app': { enabled: true, note: 'Read-only dashboard QA (83+ checks); every non-GET request is aborted in the browser and reported critical.' },
      functional: { enabled: false, reason: 'Shopify widget capture (Product page / cart drawer / cart page, 8 device sizes) needs the storefront password and has no runner in the repo yet (see docs/LIMITATIONS.md).' }
    },
    secrets: [
      SECRET('INTEGRITY_CUSTOMAPP_USERNAME', 'Admin dashboard login (use a dedicated read-only monitoring user)', true),
      SECRET('INTEGRITY_CUSTOMAPP_PASSWORD', 'Admin dashboard password', true),
      SECRET('INTEGRITY_STORE_PASSWORD', 'Shopify storefront password for the widget capture (not used by any runner yet)', false)
    ],
    reports: { technical: 'integrity-technical-pdf', client: 'integrity-deck' },
    reportMeta: { monthlyInputPattern: 'config/monthly-monitoring-input-{month}.json' }
  });
}

// ── LidStyles (kept so its archived history and reports keep working) ─────────
{
  const lid = siteEntry(get('www.lidstyles.com'));
  projects.push({
    schemaVersion: 1,
    id: 'lidstyles',
    name: 'LidStyles',
    client: 'LidStyles',
    status: 'legacy',
    platform: 'magento',
    domains: ['lidstyles.com', 'www.lidstyles.com'],
    sites: [lid],
    audits: baseAudits(),
    secrets: COMMON_SECRETS.slice(0, 2),
    reports: { technical: 'site-pdf', client: 'site-pptx' },
    reportMeta: {}
  });
}

fs.mkdirSync(path.join(root, 'projects'), { recursive: true });
fs.mkdirSync(path.join(root, 'scripts/data'), { recursive: true });
const FILE = { 'parts-audio-connexion': 'parts-audio-connexion.json', genpet: 'genpet.json', 'integrity-reforestation': 'integrity-reforestation.json', lidstyles: 'lidstyles.json' };
for (const p of projects) fs.writeFileSync(path.join(root, 'projects', FILE[p.id]), JSON.stringify(p, null, 2) + '\n');
fs.writeFileSync(path.join(root, 'scripts/data/legacy-scores.json'), JSON.stringify(legacyScores, null, 2) + '\n');
console.log('wrote', projects.map((p) => `projects/${FILE[p.id]}`).join(', '));
console.log('legacy scores kept for:', Object.keys(legacyScores).join(', '));
