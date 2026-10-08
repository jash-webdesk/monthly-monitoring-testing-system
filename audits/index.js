import * as performance from './performance/index.js';
import * as security from './security/index.js';
import * as dns from './dns/index.js';
import * as ssl from './ssl/index.js';
import * as seo from './seo/index.js';
import * as aiCrawlers from './ai-crawlers/index.js';
import * as network from './network/index.js';
import * as currency from './currency/index.js';
import * as companionApp from './companion-app/index.js';
import * as functional from './functional/index.js';
import * as cache from './cache/index.js';

/** Registry in execution order. ai-crawlers runs after seo so it can reuse the crawl. */
export const AUDITS = [
  network, dns, ssl, seo, aiCrawlers, performance, security, currency, companionApp, functional, cache
].map((m) => ({ ...m.meta, run: m.run }));

export const CATEGORIES = AUDITS.map((a) => a.category);
