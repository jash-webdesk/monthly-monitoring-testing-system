import { runDevtools } from '../../runners/devtools.runner.js';
import { runPerPage, combine, save } from '../_shared.js';

export const meta = { category: 'security', runners: ['devtools'], description: 'Chrome DevTools/CDP: security headers, cookies, SRI, console and network errors, vulnerable libraries, per page.' };

export async function run(ctx) {
  const merged = await runPerPage(ctx, (url) => runDevtools(url, ctx.hostname, ctx.month, null));
  const result = combine(ctx, 'devtools', merged);
  save(ctx, 'devtools', result);
  return { status: 'completed', runners: [result], findings: result.findings, metrics: result.metrics };
}
