// One-time patch: adds "inputs" and "context" blocks to projects/*.json (kept as a record of how they were added).
const fs = require('fs');
const path = require('path');
const dir = path.resolve(__dirname, '../projects');
const patch = {
  'parts-audio-connexion': {
    inputs: { performanceScores: 'required', scoresPerSite: true, notes: 'The URL selects PartsConnexion or AudioConnexion; use --all-sites to run both. Scores are Before/After per page and viewport and differ per site.' },
    context: 'Two BigCommerce storefronts (partsconnexion.com and audio-connexion.com) managed as one project. Performance Before/After scores are supplied manually in every prompt (any number of pages, mobile and desktop). PartsConnexion has a Heroku companion app and USD/CAD multi-currency. AudioConnexion has no companion app.'
  },
  genpet: {
    inputs: { performanceScores: 'required', scoresPerSite: false, notes: 'Scores are Before/After per page and viewport, for example Homepage and About Us.' },
    context: 'Single BigCommerce storefront (genpet.org) with the app.genpet.org companion dashboard (authenticated, read-only). Performance Before/After scores are supplied manually in every prompt.'
  },
  'integrity-reforestation': {
    inputs: { performanceScores: 'not-applicable', scoresPerSite: false, optional: ['config/monthly-monitoring-input-<month>.json for the client deck (theme update log, widget screenshot links, dev-team notes)'], notes: 'There is no scored storefront. Do NOT ask for PageSpeed Before/After scores for this project.' },
    context: 'Shopify public app (Tree Contribution widget) plus a Heroku admin dashboard. The monthly audit is the read-only dashboard QA, security checks of the dashboard login page, and the widget audit on the Horizon theme. No PageSpeed scores are used. The test store is storefront-password protected, so the widget capture cannot run unattended.'
  },
  lidstyles: {
    inputs: { performanceScores: 'required', scoresPerSite: false, notes: 'Legacy project kept for archived history.' },
    context: 'Legacy Magento storefront. Kept so existing archives and reports keep working.'
  }
};
for (const [id, extra] of Object.entries(patch)) {
  const f = path.join(dir, id + '.json');
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  fs.writeFileSync(f, JSON.stringify({ ...j, ...extra }, null, 2) + '\n');
}
console.log('patched', Object.keys(patch).join(', '));
