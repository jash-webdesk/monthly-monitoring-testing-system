/**
 * Values for the DNS rows of the client reports, derived only from the dns runner result.
 * A record set that is missing or empty is reported as "Not available": it is never replaced by a
 * provider name, a default count, or a "present" claim. An empty list cannot be told apart from a
 * failed lookup, so it is not reported as "none found" either.
 */
export const DNS_NOT_AVAILABLE = 'Not available';

/**
 * @param {Object|null|undefined} dnsResult - dns runner result envelope
 * @returns {{ nsText: string, mxText: string, aText: string, spfText: string,
 *            spfPresent: boolean|null, dmarcPresent: boolean|null, dkimPresent: boolean|null, recordCount: number|null }}
 */
export function describeDns(dnsResult) {
  const m = dnsResult?.metrics ?? null;
  const hasResult = Boolean(m);
  const nonEmpty = (list) => (Array.isArray(list) && list.length > 0 ? list : null);
  const ns = nonEmpty(m?.nsRecords);
  const mx = nonEmpty(m?.mxRecords);
  const a = nonEmpty(m?.aRecords);
  const recordCount = hasResult
    ? [m.aRecords, m.aaaaRecords, m.cnameRecords, m.mxRecords, m.nsRecords, m.txtRecords]
        .reduce((total, list) => total + (Array.isArray(list) ? list.length : 0), 0)
    : null;

  return {
    nsText: ns ? ns.join(', ') : DNS_NOT_AVAILABLE,
    mxText: mx ? mx.map(r => `${r.exchange} (Priority ${r.priority})`).join(', ') : DNS_NOT_AVAILABLE,
    aText: hasResult ? (a ? 'Resolving correctly' : 'Not found') : DNS_NOT_AVAILABLE,
    spfText: hasResult ? (m.spf ? 'In place' : 'Not found') : DNS_NOT_AVAILABLE,
    spfPresent: hasResult ? !!m.spf : null,
    dmarcPresent: hasResult ? !!m.dmarc : null,
    dkimPresent: hasResult ? !!m.dkim : null,
    recordCount
  };
}
