import { runDevtools } from '../../runners/devtools.runner.js';
import { logger } from '../../lib/logger.js';
import { runPerPage, combine, save } from '../_shared.js';

export const meta = { category: 'security', runners: ['devtools'], description: 'Chrome DevTools/CDP: security headers, cookies, SRI, console and network errors, vulnerable libraries, per page.' };

/** Credentials for this site only, read from the environment names in the project config. Null means guest-only. */
function storefrontCredentials(siteConfig) {
  const l = siteConfig.storefrontLogin;
  const username = l?.usernameEnv ? process.env[l.usernameEnv] : null;
  const password = l?.passwordEnv ? process.env[l.passwordEnv] : null;
  return username && password ? { username, password, loginPath: l.loginPath } : null;
}

export async function run(ctx) {
  const credentials = storefrontCredentials(ctx.siteConfig);
  if (!credentials) logger.info(`  No storefront login configured for ${ctx.hostname}; running the guest pass only.`);
  const merged = await runPerPage(ctx, (url) => runDevtools(url, ctx.hostname, ctx.month, null, credentials));
  const result = combine(ctx, 'devtools', merged);
  save(ctx, 'devtools', result);
  return { status: 'completed', runners: [result], findings: result.findings, metrics: result.metrics };
}
