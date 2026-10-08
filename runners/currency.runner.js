/**
 * currency.runner.js — Multi-Currency (USD / CAD) Storefront Verification
 *
 * Verifies that switching the storefront's active currency actually changes what
 * customers see and pay — not just a label swap. Only runs for sites that declare
 * `currencies: ["USD", "CAD"]` in config/sites.json; every other site is a no-op.
 *
 * Confirmed via manual discovery against both partsconnexion.com and
 * audio-connexion.com (same Stencil theme, same mechanism on both):
 *   - Currency switch is a plain GET: `<url>?setCurrencyId=2` = USD, `?setCurrencyId=1` = CAD.
 *     No login, no dropdown-click choreography needed — just navigate.
 *   - Prices render as "USD $12.34" / "CAD $12.34" in product listings, PDPs, and cart.
 *   - Switching currencies produces a genuine numeric conversion, not a label swap —
 *     confirmed with a real product: USD $0.64 vs CAD $0.92 for the same SKU.
 *
 * This is a guest/anonymous session throughout — switching currency and adding an
 * item to a fresh guest cart is standard, expected storefront behaviour, not a
 * mutation of any real customer/order data. The flow never proceeds to checkout or
 * places an order (per blueprint Section 19.3 / Pillar 10 safety rules) — it stops
 * once the cart page's currency has been verified.
 */

import { launchChromium } from '../lib/browser.js';
import { createFinding, createRunnerResult, SEVERITY, CATEGORY } from '../lib/result.js';
import { logger } from '../lib/logger.js';

const RUNNER_NAME = 'currency';
const NAV_TIMEOUT_MS = 45_000;

// Confirmed against both partsconnexion.com and audio-connexion.com — same theme, same IDs.
const CURRENCY_IDS = { USD: 2, CAD: 1 };

/**
 * Extracts (currency, amount) pairs from a page's visible text.
 * Matches "USD $12.34" / "CAD $1,234.56" style price strings.
 *
 * @param {string} pageText
 * @returns {{currency: string, amount: number}[]}
 */
function extractPrices(pageText) {
  const matches = [...pageText.matchAll(/\b(USD|CAD)\s*\$\s*([\d,]+\.\d{2})/g)];
  return matches.map(m => ({ currency: m[1], amount: parseFloat(m[2].replace(/,/g, '')) }));
}

/**
 * Extracts one priced product per <article> card on a category/listing page,
 * keyed by its product URL so prices can be matched across a currency switch
 * even if listing order shifts between page loads.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{href: string, currency: string, amount: number}[]>}
 */
async function extractCategoryProducts(page) {
  return page.evaluate(() => {
    const articles = Array.from(document.querySelectorAll('article'));
    return articles
      .map(article => {
        const text = article.innerText || '';
        const match = text.match(/\b(USD|CAD)\s*\$\s*([\d,]+\.\d{2})/);
        const link = article.querySelector('figure a[href], h3 a[href], h1 a[href], h2 a[href]');
        if (!match || !link || !/^https?:\/\//.test(link.getAttribute('href') || '')) return null;
        return { href: link.href, currency: match[1], amount: parseFloat(match[2].replace(/,/g, '')) };
      })
      .filter(Boolean);
  });
}

/**
 * Runs the multi-currency verification for a site.
 *
 * @param {string} url - Full homepage URL, e.g. "https://partsconnexion.com/"
 * @param {Object} siteConfig - Full site config (must include .currencies)
 * @returns {Promise<Object>} Runner result envelope
 */
export async function runCurrency(url, siteConfig) {
  logger.runnerStart(RUNNER_NAME);

  const currencies = siteConfig?.currencies;
  if (!Array.isArray(currencies) || !currencies.includes('USD') || !currencies.includes('CAD')) {
    logger.info('  Multi-currency not configured for this site — skipping.');
    return createRunnerResult(RUNNER_NAME, url, [], { skipped: true });
  }

  const findings = [];
  const metrics = {
    url,
    homepage: { usdPricesFound: 0, cadPricesFound: 0, switcherReflectsUsd: false, switcherReflectsCad: false },
    category: { url: null, usdPricesFound: 0, cadPricesFound: 0, productsCompared: 0, numericChangeVerified: false },
    productDetail: { usdPrice: null, cadPrice: null, numericChangeVerified: false },
    cart: { addedInCad: false, cadPersistedOnCartPage: false }
  };

  let browser = null;
  try {
    browser = await launchChromium({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (compatible; MonthlyMonitor/1.0; +https://webdesksolution.com/)'
    });
    const page = await context.newPage();

    const withCurrency = (targetUrl, currencyId) =>
      targetUrl + (targetUrl.includes('?') ? '&' : '?') + `setCurrencyId=${currencyId}`;

    // ── Homepage: baseline USD, then switch to CAD ──────────────────
    await page.goto(withCurrency(url, CURRENCY_IDS.USD), { waitUntil: 'networkidle', timeout: NAV_TIMEOUT_MS });
    const homepageUsdText = await page.evaluate(() => document.body.innerText);
    const homepageUsdPrices = extractPrices(homepageUsdText);
    metrics.homepage.usdPricesFound = homepageUsdPrices.length;
    metrics.homepage.switcherReflectsUsd = homepageUsdText.includes('USD');

    // The homepage's "Best Sellers" tiles link to CATEGORY pages, not individual
    // products (confirmed via manual discovery) — find one, visit it, then discover
    // an actual priced product from its listing rather than hardcoding a category
    // slug that could go stale if the catalog is reorganised.
    const categoryLink = await page.evaluate((origin) => {
      const excluded = ['/wishlist.php', '/cart.php', '/login.php', '/contact', '/brands/', '/tools/', '/kits/', '/search/', '/deals/', '/categories/', 'setCurrencyId'];
      const link = Array.from(document.querySelectorAll('a[href]')).find(a => {
        const href = a.getAttribute('href') || '';
        if (!href.startsWith(origin)) return false;
        if (href.includes('?') || href.includes('#')) return false; // excludes the currency switcher's own links etc.
        if (excluded.some(p => href.includes(p))) return false;
        // Category slugs are a single path segment, e.g. "/rca-connectors/" —
        // filters out multi-segment product/utility URLs.
        const path = href.slice(origin.length).replace(/^\/|\/$/g, '');
        return path.length > 0 && !path.includes('/') && a.textContent.trim().length > 0;
      });
      return link ? link.href : null;
    }, new URL(url).origin);

    let productLink = null;
    let categoryUsdProducts = [];
    if (categoryLink) {
      metrics.category.url = categoryLink;

      // ── Category listing: baseline USD, then switch to CAD ────────
      await page.goto(withCurrency(categoryLink, CURRENCY_IDS.USD), { waitUntil: 'networkidle', timeout: NAV_TIMEOUT_MS });
      categoryUsdProducts = await extractCategoryProducts(page);
      metrics.category.usdPricesFound = categoryUsdProducts.length;
      productLink = categoryUsdProducts[0]?.href ?? null;

      if (categoryUsdProducts.length > 0) {
        await page.goto(withCurrency(categoryLink, CURRENCY_IDS.CAD), { waitUntil: 'networkidle', timeout: NAV_TIMEOUT_MS });
        const categoryCadProducts = await extractCategoryProducts(page);
        metrics.category.cadPricesFound = categoryCadProducts.filter(p => p.currency === 'CAD').length;

        if (metrics.category.cadPricesFound === 0) {
          findings.push(createFinding({
            id:             'currency-switcher-failed-category',
            runner:         RUNNER_NAME,
            category:       CATEGORY.FUNCTIONAL,
            severity:       SEVERITY.HIGH,
            title:          'Currency switcher did not reflect CAD on the category page',
            detail:         `Navigating ${categoryLink} with the CAD currency parameter did not result in CAD-labelled prices in the product listing, even though USD prices were present before switching. Customers browsing this category in CAD may still be shown USD pricing.`,
            evidence:       `USD-priced products found: ${categoryUsdProducts.length} | CAD-priced products found after switching: ${metrics.category.cadPricesFound}`,
            recommendation: 'Verify the currency switcher/cookie logic on the category/listing template — confirm setCurrencyId is being honoured for guest sessions.'
          }));
        } else {
          // The real bug this check exists to catch: prices relabelled CAD without
          // being recalculated. Match products by URL (order can shift between loads)
          // and compare the numeric amount for each product present in both passes.
          const cadByHref = new Map(categoryCadProducts.map(p => [p.href, p]));
          const compared = categoryUsdProducts
            .map(usdProduct => ({ usdProduct, cadProduct: cadByHref.get(usdProduct.href) }))
            .filter(pair => pair.cadProduct);
          metrics.category.productsCompared = compared.length;

          const unchanged = compared.filter(({ usdProduct, cadProduct }) => usdProduct.amount === cadProduct.amount);
          metrics.category.numericChangeVerified = compared.length > 0 && unchanged.length < compared.length;

          if (compared.length > 0 && unchanged.length === compared.length) {
            findings.push(createFinding({
              id:             'currency-price-not-recalculated-category',
              runner:         RUNNER_NAME,
              category:       CATEGORY.FUNCTIONAL,
              severity:       SEVERITY.HIGH,
              title:          'Category page prices are labelled CAD but the numbers did not change from USD',
              detail:         `${categoryLink} shows identical numeric prices under both USD and CAD labels for all ${compared.length} product(s) compared. This means the currency label changed but the underlying prices were not recalculated — customers would be shown a CAD symbol while the amount still reflects the USD price.`,
              evidence:       compared.slice(0, 3).map(({ usdProduct, cadProduct }) => `${usdProduct.href}: USD ${usdProduct.amount} vs CAD ${cadProduct.amount}`).join(' | '),
              recommendation: 'Check the category/listing template and pricing rule/exchange-rate configuration in BigCommerce — currency conversion is not being applied to listing prices.'
            }));
          }
        }
      } else {
        logger.warn('  Category page has no priced products — skipped category currency validation.');
      }
    }

    await page.goto(withCurrency(url, CURRENCY_IDS.CAD), { waitUntil: 'networkidle', timeout: NAV_TIMEOUT_MS });
    const homepageCadText = await page.evaluate(() => document.body.innerText);
    const homepageCadPrices = extractPrices(homepageCadText);
    metrics.homepage.cadPricesFound = homepageCadPrices.length;
    metrics.homepage.switcherReflectsCad = homepageCadText.includes('CAD');

    // Only a real signal if the homepage actually shows priced products (some homepage
    // layouts are pure category tiles/banners with no price grid at all — 0 prices in
    // both currencies just means "not applicable", not a switcher failure). And the
    // switcher badge itself (e.g. "USD"/"CAD" nav link) always contains the currency
    // code even when unclicked, so require an actual price-count regression, not just
    // presence of the word "CAD" anywhere on the page.
    const homepagePricesExpected = homepageUsdPrices.length > 0;
    if (homepagePricesExpected && homepageCadPrices.length === 0) {
      findings.push(createFinding({
        id:             'currency-switcher-failed-homepage',
        runner:         RUNNER_NAME,
        category:       CATEGORY.FUNCTIONAL,
        severity:       SEVERITY.HIGH,
        title:          'Currency switcher did not reflect CAD on the homepage',
        detail:         'Navigating with the CAD currency parameter did not result in CAD-labelled prices appearing on the homepage, even though USD prices were present before switching. Customers selecting CAD may still be shown USD pricing.',
        evidence:       `USD prices found: ${homepageUsdPrices.length} | CAD prices found after switching: ${homepageCadPrices.length}`,
        recommendation: 'Verify the currency switcher/cookie logic on the homepage template — confirm setCurrencyId is being honoured for guest sessions.'
      }));
    }

    // ── Product detail page: verify prices actually recalculate, not just relabel ──
    if (productLink) {
      await page.goto(withCurrency(productLink, CURRENCY_IDS.USD), { waitUntil: 'networkidle', timeout: NAV_TIMEOUT_MS });
      const pdpUsdText = await page.evaluate(() => document.body.innerText);
      const pdpUsdPrices = extractPrices(pdpUsdText);
      metrics.productDetail.usdPrice = pdpUsdPrices[0]?.amount ?? null;

      await page.goto(withCurrency(productLink, CURRENCY_IDS.CAD), { waitUntil: 'networkidle', timeout: NAV_TIMEOUT_MS });
      const pdpCadText = await page.evaluate(() => document.body.innerText);
      const pdpCadPrices = extractPrices(pdpCadText);
      metrics.productDetail.cadPrice = pdpCadPrices[0]?.amount ?? null;

      if (!pdpCadText.includes('CAD') || pdpCadPrices.length === 0) {
        findings.push(createFinding({
          id:             'currency-switcher-failed-pdp',
          runner:         RUNNER_NAME,
          category:       CATEGORY.FUNCTIONAL,
          severity:       SEVERITY.HIGH,
          title:          'Currency switcher did not reflect CAD on the product detail page',
          detail:         `Product page ${productLink} did not show CAD-labelled pricing after switching currency.`,
          evidence:       `Found ${pdpCadPrices.length} CAD-labelled price(s) on ${productLink}`,
          recommendation: 'Verify the product template reads the active currency for its price display, not a cached/default value.'
        }));
      } else if (metrics.productDetail.usdPrice !== null && metrics.productDetail.cadPrice !== null) {
        // The real bug this check exists to catch: a page that swaps the CAD *label*
        // without actually recalculating the *price* — same number, wrong currency claim.
        metrics.productDetail.numericChangeVerified = metrics.productDetail.usdPrice !== metrics.productDetail.cadPrice;
        if (!metrics.productDetail.numericChangeVerified) {
          findings.push(createFinding({
            id:             'currency-price-not-recalculated-pdp',
            runner:         RUNNER_NAME,
            category:       CATEGORY.FUNCTIONAL,
            severity:       SEVERITY.HIGH,
            title:          'Product price is labelled CAD but the number did not change from USD',
            detail:         `${productLink} shows an identical numeric price (${metrics.productDetail.usdPrice}) under both USD and CAD labels. This means the currency label changed but the underlying price was not recalculated — customers would be charged the USD amount while shown a CAD symbol.`,
            evidence:       `USD price: ${metrics.productDetail.usdPrice} | CAD price: ${metrics.productDetail.cadPrice}`,
            recommendation: 'Check the product pricing rule/exchange-rate configuration for this product in BigCommerce — the currency conversion is not being applied.'
          }));
        }
      }

      // ── Cart: add the product while in CAD, verify the cart page reflects CAD ──
      try {
        const addToCartLink = page.locator('a:has-text("Add to Cart"), button:has-text("Add to Cart")').first();
        if (await addToCartLink.count() > 0) {
          await addToCartLink.click();
          await page.waitForTimeout(2000); // allow the AJAX add-to-cart to complete
          metrics.cart.addedInCad = true;

          const cartUrl = new URL('/cart.php', productLink).toString();
          await page.goto(cartUrl, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT_MS });
          const cartText = await page.evaluate(() => document.body.innerText);
          const cartPrices = extractPrices(cartText);
          metrics.cart.cadPersistedOnCartPage = cartText.includes('CAD') && cartPrices.some(p => p.currency === 'CAD');

          if (!metrics.cart.cadPersistedOnCartPage) {
            findings.push(createFinding({
              id:             'currency-cart-persistence-failed',
              runner:         RUNNER_NAME,
              category:       CATEGORY.FUNCTIONAL,
              severity:       SEVERITY.CRITICAL,
              title:          'Cart reverted to a different currency after adding a CAD-priced item',
              detail:         'An item was added to the cart while the storefront was set to CAD, but the cart page did not show CAD pricing. A customer shopping in CAD could reach checkout believing they are being charged in one currency while actually being charged in another — a direct financial/trust risk.',
              evidence:       `Cart page text ${cartText.includes('CAD') ? 'contains' : 'does not contain'} "CAD"; CAD-labelled prices found: ${cartPrices.filter(p => p.currency === 'CAD').length}`,
              recommendation: 'Check cart/session currency persistence — the selected currency must carry through to the cart and checkout, not just product pages.'
            }));
          }
        } else {
          logger.warn('  No "Add to Cart" control found on product page — skipped cart persistence check.');
        }
      } catch (err) {
        logger.warn(`  Cart currency check failed: ${err.message}`);
      }
    } else {
      logger.warn('  Could not discover a product link from the homepage — skipped PDP and cart currency checks.');
    }

    await context.close();
  } catch (err) {
    findings.push(createFinding({
      id:             'currency-check-failed',
      runner:         RUNNER_NAME,
      category:       CATEGORY.FUNCTIONAL,
      severity:       SEVERITY.MEDIUM,
      title:          'Multi-currency verification could not complete',
      detail:         'An unexpected error interrupted the currency verification pass — results below may be partial.',
      evidence:       `Error: ${err.message}`,
      recommendation: 'Re-run the currency phase; if this persists, the storefront markup may have changed since this check was last verified.'
    }));
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
  }

  const result = createRunnerResult(RUNNER_NAME, url, findings, metrics);
  logger.runnerDone(RUNNER_NAME, findings.length);
  return result;
}
