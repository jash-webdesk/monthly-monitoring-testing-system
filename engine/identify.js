import { loadProjects } from '../lib/config.js';

const strip = (h) => h.toLowerCase().replace(/^www\./, '');

/**
 * Maps a URL (or bare hostname) to a project and, when it has one, the monitored site inside it.
 * @param {string} urlOrHost
 * @returns {{ project: Object, site: Object|null, hostname: string, url: string }}
 * @throws if no project claims the hostname
 */
export function identifyProject(urlOrHost) {
  const withProto = /^https?:\/\//i.test(urlOrHost) ? urlOrHost : `https://${urlOrHost}`;
  let u;
  try { u = new URL(withProto); } catch { throw new Error(`Not a valid URL: "${urlOrHost}"`); }
  const host = strip(u.hostname);
  const projects = loadProjects();
  for (const project of projects) {
    const claims = new Set([...(project.domains ?? []), ...(project.sites ?? []).map((s) => s.hostname)].map(strip));
    if (claims.has(host)) {
      const site = (project.sites ?? []).find((s) => strip(s.hostname) === host) ?? (project.sites?.length === 1 ? project.sites[0] : null);
      return { project, site, hostname: site?.hostname ?? u.hostname, url: u.toString() };
    }
  }
  const known = projects.flatMap((p) => p.domains ?? []).join(', ');
  throw new Error(`No project configuration claims "${u.hostname}". Add it to a file in projects/ (known domains: ${known}).`);
}
