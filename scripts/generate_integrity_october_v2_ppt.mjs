import pptxgen from 'pptxgenjs';
import fs from 'node:fs';
import path from 'node:path';

// Output paths
const OUT_DIR = path.resolve('results/integrity-reforestation/2026-10');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
const OUT_PPTX = path.join(OUT_DIR, 'Monthly_Monitoring_Report_October_2026_v2.pptx');
const ROOT_PPTX = path.resolve('Monthly_Monitoring_Report_October_2026_v2.pptx');

console.log('Generating October 2026 v2 PPTX presentation matching exact PDF layout...');

const pptx = new pptxgen();
pptx.defineLayout({ name: 'WIDE_16_9', width: 13.333, height: 7.5 });
pptx.layout = 'WIDE_16_9';

pptx.author = 'WebDesk Solution Maintenance & QA Team';
pptx.company = 'WebDesk Solution';
pptx.title = 'Integrity Reforestation — October 2026 Development & Storefront QA Report';

// Brand Design Constants
const COLOR_BG = 'FFFFFF';
const COLOR_CARD_BG = 'F8FAFC';
const COLOR_TEXT_DARK = '0F172A';
const COLOR_BRAND_BLUE = '0EA5E9';
const COLOR_BRAND_SECONDARY = '075985';
const COLOR_SUCCESS_GREEN = '10B981';
const COLOR_MUTED = '64748B';
const COLOR_BORDER = 'E2E8F0';

const logoExists = fs.existsSync('white-logo.png');

function setBackground(slide) {
  slide.background = { color: COLOR_BG };
}

function addLogo(slide) {
  if (logoExists) {
    slide.addImage({ path: 'white-logo.png', x: 10.6, y: 0.35, w: 2.0, h: 0.85 });
  }
}

function eyebrow(slide, text) {
  slide.addText(text, {
    x: 0.8, y: 0.45, w: 9.5, h: 0.35,
    fontSize: 13, bold: true, color: COLOR_BRAND_BLUE, fontFace: 'Plus Jakarta Sans'
  });
}

function heading(slide, text) {
  slide.addText(text, {
    x: 0.8, y: 0.85, w: 9.5, h: 0.55,
    fontSize: 26, bold: true, color: COLOR_TEXT_DARK, fontFace: 'Outfit'
  });
}

function card(slide, x, y, w, h, bg = COLOR_CARD_BG, border = COLOR_BORDER, radius = 0.08) {
  slide.addShape(pptx.shapes.ROUNDED_RECTANGLE, {
    x, y, w, h, fill: { color: bg }, line: { color: border, width: 1 }, rectRadius: radius
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SLIDE 1: COVER
// ─────────────────────────────────────────────────────────────────────────
const s1 = pptx.addSlide();
setBackground(s1);
if (logoExists) {
  s1.addImage({ path: 'white-logo.png', x: 0.8, y: 0.8, w: 2.2, h: 0.95 });
}
s1.addText('Monthly Storefront Monitoring & Maintenance Report', {
  x: 0.8, y: 2.6, w: 11.5, h: 1.1,
  fontSize: 34, bold: true, color: COLOR_TEXT_DARK, fontFace: 'Outfit', lineSpacing: 40
});
s1.addText('Integrity Reforestation — October 2026 Development & Storefront QA Report', {
  x: 0.8, y: 4.0, w: 11.5, h: 0.5,
  fontSize: 16, color: COLOR_BRAND_BLUE, fontFace: 'Plus Jakarta Sans'
});
s1.addShape(pptx.shapes.RECTANGLE, {
  x: 0.8, y: 4.75, w: 2.5, h: 0.07, fill: { color: COLOR_BRAND_BLUE }, line: { width: 0 }
});
s1.addText('Prepared by WebDesk Solution Maintenance & QA Team', {
  x: 0.8, y: 5.5, w: 11.0, h: 0.35,
  fontSize: 12, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans'
});
s1.addText('https://test-demo-store-801srwej.myshopify.com', {
  x: 0.8, y: 5.9, w: 11.0, h: 0.35,
  fontSize: 12, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans'
});

// ─────────────────────────────────────────────────────────────────────────
// SLIDE 2: EXECUTIVE SUMMARY
// ─────────────────────────────────────────────────────────────────────────
const s2 = pptx.addSlide();
setBackground(s2); addLogo(s2);
eyebrow(s2, 'Executive Summary');
heading(s2, 'October 2026 Monitoring Overview');
s2.addText(
  "During the October 2026 monthly monitoring cycle, we conducted comprehensive storefront testing for the Integrity Reforestation Tree Contribution Widget on the newly activated Craft theme (v16.1.0). Testing covered product pages, native dialog cart drawers, and cart pages across desktop, tablet, and mobile viewports. In addition, we executed end-to-end read-only regression testing on the Integrity Custom Admin Dashboard. This cycle we tested the Integrity custom app dashboard end to end in read-only mode (96 checks across the Dashboard, Stores Listing, Email Templates and Email Logs): store, tree and contribution figures agree across the dashboard and every store page. After the dev team's fixes the checks were repeated: 10 of 10 earlier items are fixed.",
  {
    x: 0.8, y: 1.5, w: 11.7, h: 1.6,
    fontSize: 12.5, color: COLOR_TEXT_DARK, fontFace: 'Plus Jakarta Sans', lineSpacing: 19
  }
);

// 3 Stat Cards
const statY = 3.6, statH = 2.2;
card(s2, 0.8, statY, 3.65, statH);
s2.addText('96', { x: 0.8, y: statY + 0.3, w: 3.65, h: 0.9, fontSize: 48, bold: true, color: '0284C7', align: 'center', fontFace: 'Outfit' });
s2.addText('Automated Checks Run', { x: 0.8, y: statY + 1.35, w: 3.65, h: 0.4, fontSize: 13, color: COLOR_MUTED, align: 'center', fontFace: 'Plus Jakarta Sans' });

card(s2, 4.82, statY, 3.65, statH);
s2.addText('86', { x: 4.82, y: statY + 0.3, w: 3.65, h: 0.9, fontSize: 48, bold: true, color: '0284C7', align: 'center', fontFace: 'Outfit' });
s2.addText('Checks Passed', { x: 4.82, y: statY + 1.35, w: 3.65, h: 0.4, fontSize: 13, color: COLOR_MUTED, align: 'center', fontFace: 'Plus Jakarta Sans' });

card(s2, 8.85, statY, 3.65, statH);
s2.addText('10', { x: 8.85, y: statY + 0.3, w: 3.65, h: 0.9, fontSize: 48, bold: true, color: '10B981', align: 'center', fontFace: 'Outfit' });
s2.addText('Issues Fixed', { x: 8.85, y: statY + 1.35, w: 3.65, h: 0.4, fontSize: 13, color: COLOR_MUTED, align: 'center', fontFace: 'Plus Jakarta Sans' });

// ─────────────────────────────────────────────────────────────────────────
// SLIDE 3: CUSTOM APP DASHBOARD: COVERAGE & RESULTS
// ─────────────────────────────────────────────────────────────────────────
const s3 = pptx.addSlide();
setBackground(s3); addLogo(s3);
eyebrow(s3, 'Custom App Testing');
heading(s3, 'Custom App Dashboard: Coverage & Results');

// Left: Donut Card
card(s3, 0.8, 1.6, 4.0, 4.8);
s3.addText('CHECKS RUN', { x: 1.0, y: 1.8, w: 3.6, h: 0.25, fontSize: 10, bold: true, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });
s3.addChart(pptx.charts.DOUGHNUT, [{ name: 'Checks', labels: ['Passed', 'Issues fixed'], values: [86, 10] }], {
  x: 0.9, y: 2.1, w: 3.8, h: 2.9, holeSize: 68, chartColors: ['10B981', 'F59E0B'],
  showLegend: false, showPercent: false, showValue: false, showLabel: false, showTitle: false, dataBorder: { pt: 2, color: 'FFFFFF' }
});
s3.addText('96', { x: 0.9, y: 3.0, w: 3.8, h: 0.65, fontSize: 38, bold: true, color: COLOR_TEXT_DARK, align: 'center', fontFace: 'Outfit' });
s3.addText('automated checks', { x: 0.9, y: 3.65, w: 3.8, h: 0.3, fontSize: 11, color: COLOR_MUTED, align: 'center', fontFace: 'Plus Jakarta Sans' });

s3.addShape(pptx.shapes.OVAL, { x: 1.3, y: 5.25, w: 0.16, h: 0.16, fill: { color: '10B981' }, line: { width: 0 } });
s3.addText('Passed 86', { x: 1.55, y: 5.18, w: 1.3, h: 0.3, fontSize: 10, bold: true, color: COLOR_TEXT_DARK, fontFace: 'Plus Jakarta Sans' });
s3.addShape(pptx.shapes.OVAL, { x: 2.85, y: 5.25, w: 0.16, h: 0.16, fill: { color: 'F59E0B' }, line: { width: 0 } });
s3.addText('Issues fixed 10', { x: 3.1, y: 5.18, w: 1.5, h: 0.3, fontSize: 10, bold: true, color: COLOR_TEXT_DARK, fontFace: 'Plus Jakarta Sans' });
s3.addText('Read-only: nothing was added, changed, deleted or sent.', { x: 0.9, y: 5.75, w: 3.8, h: 0.45, fontSize: 9.5, italic: true, color: COLOR_MUTED, align: 'center', fontFace: 'Plus Jakarta Sans' });

// Right Table
const hdCell = (t) => ({ text: t, options: { bold: true, fill: { color: 'F1F5F9' }, fontSize: 10 } });
const rows3 = [
  [hdCell('Area'), hdCell('What we checked'), hdCell('Checks'), hdCell('Passed'), hdCell('Items')],
  [
    { text: 'Dashboard', options: { bold: true, fontSize: 10 } },
    { text: 'Summary cards, 30-day charts, Top 5 Contributors, Recent Contributions (paging, page size, Refresh), totals cross-checked against Stores Listing', options: { fontSize: 8.5, color: COLOR_MUTED } },
    { text: '17', options: { fontSize: 10, align: 'center' } },
    { text: '16', options: { fontSize: 10, align: 'center', color: COLOR_SUCCESS_GREEN, bold: true } },
    { text: '1', options: { fontSize: 10, align: 'center', color: 'B45309', bold: true } }
  ],
  [
    { text: 'Stores Listing', options: { bold: true, fontSize: 10 } },
    { text: 'Columns, search, Status and Plan filters, page size and paging, date range, layout at 1280 / 1440 / 1920 px', options: { fontSize: 8.5, color: COLOR_MUTED } },
    { text: '28', options: { fontSize: 10, align: 'center' } },
    { text: '24', options: { fontSize: 10, align: 'center', color: COLOR_SUCCESS_GREEN, bold: true } },
    { text: '4', options: { fontSize: 10, align: 'center', color: 'B45309', bold: true } }
  ],
  [
    { text: 'Store Detail (View)', options: { bold: true, fontSize: 10 } },
    { text: 'View on every store: sections, name/plan/trees/contribution vs list, Install History, Financial Breakdown buttons', options: { fontSize: 8.5, color: COLOR_MUTED } },
    { text: '17', options: { fontSize: 10, align: 'center' } },
    { text: '15', options: { fontSize: 10, align: 'center', color: COLOR_SUCCESS_GREEN, bold: true } },
    { text: '1', options: { fontSize: 10, align: 'center', color: 'B45309', bold: true } }
  ],
  [
    { text: 'Email Templates', options: { bold: true, fontSize: 10 } },
    { text: 'Columns, expected template codes, statuses, keyword search, empty state, paging (read-only)', options: { fontSize: 8.5, color: COLOR_MUTED } },
    { text: '10', options: { fontSize: 10, align: 'center' } },
    { text: '10', options: { fontSize: 10, align: 'center', color: COLOR_SUCCESS_GREEN, bold: true } },
    { text: '—', options: { fontSize: 10, align: 'center', color: COLOR_MUTED } }
  ],
  [
    { text: 'Email Logs', options: { bold: true, fontSize: 10 } },
    { text: 'Columns, recipients, status filter (Sent/Failed), search, paging, date range calendar, row View details', options: { fontSize: 8.5, color: COLOR_MUTED } },
    { text: '24', options: { fontSize: 10, align: 'center' } },
    { text: '22', options: { fontSize: 10, align: 'center', color: COLOR_SUCCESS_GREEN, bold: true } },
    { text: '2', options: { fontSize: 10, align: 'center', color: 'B45309', bold: true } }
  ]
];
s3.addTable(rows3, {
  x: 5.1, y: 1.6, w: 7.4, fontSize: 9.5, fontFace: 'Plus Jakarta Sans',
  border: { color: COLOR_BORDER, width: 1 }, autoPage: false,
  colW: [1.4, 3.8, 0.7, 0.8, 0.7]
});

// Bottom 3 Cards
const bottomCards = [
  { label: 'DATA ACCURACY', val: 'Verified', note: 'Totals match on every page', color: '10B981' },
  { label: 'WRITE REQUESTS', val: '0', note: 'Nothing was changed', color: '10B981' },
  { label: 'STORES OPENED', val: '10', note: 'via the View button', color: '0EA5E9' }
];
bottomCards.forEach((c, idx) => {
  const cx = 5.1 + idx * 2.5;
  card(s3, cx, 5.0, 2.4, 1.4);
  s3.addText(c.label, { x: cx + 0.15, y: 5.1, w: 2.1, h: 0.25, fontSize: 8, bold: true, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });
  s3.addText(c.val, { x: cx + 0.15, y: 5.35, w: 2.1, h: 0.45, fontSize: 20, bold: true, color: c.color, fontFace: 'Outfit' });
  s3.addText(c.note, { x: cx + 0.15, y: 5.85, w: 2.1, h: 0.45, fontSize: 9, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });
});

// ─────────────────────────────────────────────────────────────────────────
// SLIDE 4: RE-TEST AFTER THE DEV TEAM FIXES
// ─────────────────────────────────────────────────────────────────────────
const s4 = pptx.addSlide();
setBackground(s4); addLogo(s4);
eyebrow(s4, 'Custom App Testing');
heading(s4, 'Re-test After the Dev Team Fixes');

// Left: Donut Card
card(s4, 0.8, 1.6, 4.0, 4.8);
s4.addText('ITEMS REPORTED EARLIER', { x: 1.0, y: 1.8, w: 3.6, h: 0.25, fontSize: 10, bold: true, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });
s4.addChart(pptx.charts.DOUGHNUT, [{ name: 'Items', labels: ['Fixed', 'Still open'], values: [10, 0] }], {
  x: 0.9, y: 2.1, w: 3.8, h: 2.9, holeSize: 68, chartColors: ['10B981', 'E2E8F0'],
  showLegend: false, showPercent: false, showValue: false, showLabel: false, showTitle: false, dataBorder: { pt: 2, color: 'FFFFFF' }
});
s4.addText('10 of 10', { x: 0.9, y: 3.0, w: 3.8, h: 0.65, fontSize: 34, bold: true, color: COLOR_TEXT_DARK, align: 'center', fontFace: 'Outfit' });
s4.addText('items fixed', { x: 0.9, y: 3.65, w: 3.8, h: 0.3, fontSize: 11, color: COLOR_MUTED, align: 'center', fontFace: 'Plus Jakarta Sans' });

// Legend
s4.addShape(pptx.shapes.OVAL, { x: 1.3, y: 5.25, w: 0.16, h: 0.16, fill: { color: '10B981' }, line: { width: 0 } });
s4.addText('Fixed 10', { x: 1.55, y: 5.18, w: 1.3, h: 0.3, fontSize: 10, bold: true, color: COLOR_TEXT_DARK, fontFace: 'Plus Jakarta Sans' });
s4.addShape(pptx.shapes.OVAL, { x: 2.85, y: 5.25, w: 0.16, h: 0.16, fill: { color: 'E2E8F0' }, line: { width: 0 } });
s4.addText('Still open 0', { x: 3.1, y: 5.18, w: 1.5, h: 0.3, fontSize: 10, bold: true, color: COLOR_TEXT_DARK, fontFace: 'Plus Jakarta Sans' });

// Right: 10 items
const items10 = [
  'Stores status filter and status column use different wording',
  'Stores plan filter is missing the "Professional" plan',
  'The "View" button on Stores Listing is cut off on common screen widths (1280,…',
  'The Email Logs calendar is cut off at the right edge of the screen',
  'Some Stores Listing column headings are cut off',
  'Some Dashboard table headings are cut off',
  'Stores Listing row numbers restart on every page',
  'The date filter on Stores Listing cannot be closed with the keyboard',
  'Install History lists the same event twice',
  'The date filter on Email Logs cannot be closed with the keyboard'
];

items10.forEach((item, idx) => {
  const iy = 1.6 + idx * 0.44;
  s4.addShape(pptx.shapes.OVAL, { x: 5.2, y: iy + 0.04, w: 0.24, h: 0.24, fill: { color: '10B981' }, line: { width: 0 } });
  s4.addText('✓', { x: 5.2, y: iy + 0.04, w: 0.24, h: 0.24, fontSize: 9.5, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle', fontFace: 'Plus Jakarta Sans' });
  s4.addText(item, { x: 5.55, y: iy, w: 5.7, h: 0.32, fontSize: 9.5, bold: true, color: COLOR_TEXT_DARK, valign: 'middle', fontFace: 'Plus Jakarta Sans' });
  s4.addShape(pptx.shapes.ROUNDED_RECTANGLE, { x: 11.4, y: iy + 0.04, w: 1.1, h: 0.24, fill: { color: 'ECFDF5' }, line: { color: '10B981', width: 1 }, rectRadius: 0.12 });
  s4.addText('Fixed', { x: 11.4, y: iy + 0.04, w: 1.1, h: 0.24, fontSize: 8.5, bold: true, color: '047857', align: 'center', valign: 'middle', fontFace: 'Plus Jakarta Sans' });
});
s4.addText('Each earlier item was repeated against the live dashboard after the dev team reported their fixes.', {
  x: 5.2, y: 6.2, w: 7.3, h: 0.3, fontSize: 9, italic: true, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans'
});

// ─────────────────────────────────────────────────────────────────────────
// SLIDE 5: MONTHLY MONITORING WORK COMPLETED
// ─────────────────────────────────────────────────────────────────────────
const s5 = pptx.addSlide();
setBackground(s5); addLogo(s5);
eyebrow(s5, 'Development & Storefront Maintenance Updates');
heading(s5, 'Monthly Monitoring Work Completed');
s5.addText('Development work completed this month, as reported by the development team.', {
  x: 0.8, y: 1.45, w: 11.5, h: 0.35, fontSize: 12, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans'
});

const devCards = [
  {
    tag: 'Custom App Dashboard',
    title: 'Resend Email option for failed emails',
    body: 'Added a Resend Email option for failed emails in the Email Logs module. The resend was tested by sending a test email, and the team confirmed it works as expected. Screenshots: Dashboard , Email Inbox',
    impact: 'Impact: Failed notification emails can be sent again from the dashboard without re-creating them.'
  },
  {
    tag: 'Storefront Theme Compatibility',
    title: 'Beyond theme compatibility',
    body: 'Added compatibility for the Beyond theme for the Tree Contribution widget.',
    impact: 'Impact: The widget works on stores using the Beyond theme.'
  },
  {
    tag: 'Staging Environment',
    title: 'Staging environment for the app and dashboard',
    body: 'Staging set up for the app and dashboard on Heroku, with a separate database copied from live (live was not changed). Shopify, API, authentication and dashboard connections configured; an authentication issue after merging was fixed. Staging dashboard: https://integrity-staging-dashboard-e835e93f2351.herokuapp.com',
    impact: 'Impact: Future changes can be tested on staging before they go to production.'
  }
];

devCards.forEach((c, idx) => {
  const cy = 1.95 + idx * 1.62;
  card(s5, 0.8, cy, 11.7, 1.45);
  s5.addShape(pptx.shapes.ROUNDED_RECTANGLE, { x: 0.8, y: cy, w: 0.12, h: 1.45, fill: { color: '0284C7' }, line: { width: 0 }, rectRadius: 0.04 });
  s5.addText(c.tag, { x: 1.15, y: cy + 0.12, w: 11.0, h: 0.22, fontSize: 9.5, bold: true, color: '0284C7', fontFace: 'Plus Jakarta Sans' });
  s5.addText(c.title, { x: 1.15, y: cy + 0.34, w: 11.0, h: 0.3, fontSize: 14, bold: true, color: COLOR_TEXT_DARK, fontFace: 'Outfit' });
  s5.addText(c.body, { x: 1.15, y: cy + 0.65, w: 11.0, h: 0.42, fontSize: 10, color: COLOR_TEXT_DARK, fontFace: 'Plus Jakarta Sans', lineSpacing: 13 });
  s5.addText(c.impact, { x: 1.15, y: cy + 1.1, w: 11.0, h: 0.25, fontSize: 9.5, bold: true, color: '047857', fontFace: 'Plus Jakarta Sans' });
});

// ─────────────────────────────────────────────────────────────────────────
// SLIDE 6: WIDGET ARCHITECTURE & FUNCTIONAL VALIDATION
// ─────────────────────────────────────────────────────────────────────────
const s6 = pptx.addSlide();
setBackground(s6); addLogo(s6);
eyebrow(s6, 'Multi-Device Storefront & Widget Audit');
heading(s6, 'Widget Architecture & Functional Validation');
s6.addText('Integrity Reforestation Tree Contribution Widget (.tdw-card)', {
  x: 0.8, y: 1.45, w: 11.5, h: 0.35, fontSize: 12, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans'
});

s6.addText('FUNCTIONAL STATUS', { x: 0.8, y: 2.2, w: 11.7, h: 0.25, fontSize: 10, bold: true, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });
s6.addText('100% Passed (Pricing, Line Items, Cart Recalculation)', {
  x: 0.8, y: 2.5, w: 11.7, h: 0.55, fontSize: 24, bold: true, color: '10B981', fontFace: 'Outfit'
});

const checks6 = [
  'Dropdown selection (1 Tree / $1.43, 2 Trees / $2.86, 5 Trees / $7.15)',
  'Dynamic CTA button calculation and labeling',
  'Seamless cart line item addition and subtotal/tax recalculation',
  'Native OS 2.0 cart drawer (<dialog>) and cart page integration'
];

checks6.forEach((txt, idx) => {
  const cy = 3.4 + idx * 0.72;
  s6.addShape(pptx.shapes.OVAL, { x: 0.8, y: cy + 0.04, w: 0.32, h: 0.32, fill: { color: '10B981' }, line: { width: 0 } });
  s6.addText('✓', { x: 0.8, y: cy + 0.04, w: 0.32, h: 0.32, fontSize: 12, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle', fontFace: 'Plus Jakarta Sans' });
  s6.addText(txt, { x: 1.3, y: cy, w: 11.0, h: 0.4, fontSize: 13, bold: true, color: COLOR_TEXT_DARK, valign: 'middle', fontFace: 'Plus Jakarta Sans' });
});

// ─────────────────────────────────────────────────────────────────────────
// SLIDE 7: STOREFRONT TOUCHPOINTS VERIFIED
// ─────────────────────────────────────────────────────────────────────────
const s7 = pptx.addSlide();
setBackground(s7); addLogo(s7);
eyebrow(s7, 'Multi-Device Storefront & Widget Audit');
heading(s7, 'Storefront Touchpoints Verified');

const touchpoints = [
  { num: '1', title: 'Product Page (PDP)', desc: 'Widget renders cleanly below the Buy it now button.' },
  { num: '2', title: 'Cart Drawer', desc: 'Native dialog slide-out drawer with tree widget rendered above checkout.' },
  { num: '3', title: 'Cart Page', desc: 'Line item and tree contribution widget verified below order summary.' }
];

touchpoints.forEach((tp, idx) => {
  const tx = 0.8 + idx * 4.0;
  card(s7, tx, 2.0, 3.7, 3.8);
  s7.addShape(pptx.shapes.OVAL, { x: tx + 1.45, y: 2.4, w: 0.8, h: 0.8, fill: { color: '0284C7' }, line: { width: 0 } });
  s7.addText(tp.num, { x: tx + 1.45, y: 2.4, w: 0.8, h: 0.8, fontSize: 24, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle', fontFace: 'Outfit' });
  s7.addText(tp.title, { x: tx + 0.2, y: 3.4, w: 3.3, h: 0.4, fontSize: 15, bold: true, color: COLOR_TEXT_DARK, align: 'center', fontFace: 'Outfit' });
  s7.addText(tp.desc, { x: tx + 0.2, y: 3.9, w: 3.3, h: 1.2, fontSize: 11, color: COLOR_MUTED, align: 'center', fontFace: 'Plus Jakarta Sans', lineSpacing: 16 });
});

// ─────────────────────────────────────────────────────────────────────────
// SLIDE 8: FREE THEME RELEASES THIS CYCLE
// ─────────────────────────────────────────────────────────────────────────
const s8 = pptx.addSlide();
setBackground(s8); addLogo(s8);
eyebrow(s8, 'Shopify Theme Updates');
heading(s8, 'Free Theme Releases This Cycle');
s8.addText('Shopify released maintenance updates for its modern theme collection. We audited Craft (v16.1.0), which is currently active on this store.', {
  x: 0.8, y: 1.45, w: 11.5, h: 0.35, fontSize: 12, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans'
});

// Version card left
card(s8, 0.8, 2.0, 4.0, 2.8);
s8.addText('v15.5.0 → v16.1.0', { x: 1.0, y: 2.2, w: 3.6, h: 0.5, fontSize: 20, bold: true, color: COLOR_BRAND_SECONDARY, fontFace: 'Outfit' });
s8.addText('WHAT CHANGED', { x: 1.0, y: 2.85, w: 3.6, h: 0.25, fontSize: 9.5, bold: true, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });
s8.addText('Customer account experience changes', { x: 1.0, y: 3.15, w: 3.6, h: 0.6, fontSize: 13, bold: true, color: COLOR_TEXT_DARK, fontFace: 'Plus Jakarta Sans' });

// Themes grid right
card(s8, 5.1, 2.0, 7.4, 2.8);
s8.addText('THEMES UPDATED (10)', { x: 5.3, y: 2.2, w: 7.0, h: 0.25, fontSize: 9.5, bold: true, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });

const pillsRow1 = [
  { name: 'Dawn ✓', tested: true },
  { name: 'Crave ✓', tested: true },
  { name: 'Craft ✓', tested: true },
  { name: 'Origin', tested: false },
  { name: 'Publisher', tested: false }
];
const pillsRow2 = [
  { name: 'Refresh', tested: false },
  { name: 'Ride', tested: false },
  { name: 'Sense', tested: false },
  { name: 'Taste', tested: false },
  { name: 'Rise', tested: false }
];

[pillsRow1, pillsRow2].forEach((row, rIdx) => {
  const ry = 2.6 + rIdx * 0.65;
  row.forEach((p, cIdx) => {
    const px = 5.3 + cIdx * 1.4;
    const bg = p.tested ? 'ECFDF5' : 'FFFBEB';
    const border = p.tested ? '10B981' : 'F59E0B';
    const textCol = p.tested ? '047857' : 'B45309';
    s8.addShape(pptx.shapes.ROUNDED_RECTANGLE, { x: px, y: ry, w: 1.28, h: 0.42, fill: { color: bg }, line: { color: border, width: 1 }, rectRadius: 0.21 });
    s8.addText(p.name, { x: px, y: ry, w: 1.28, h: 0.42, fontSize: 10, bold: true, color: textCol, align: 'center', valign: 'middle', fontFace: 'Plus Jakarta Sans' });
  });
});

s8.addShape(pptx.shapes.OVAL, { x: 5.3, y: 4.15, w: 0.16, h: 0.16, fill: { color: '10B981' }, line: { width: 0 } });
s8.addText('Green — Tested this cycle', { x: 5.55, y: 4.08, w: 2.6, h: 0.3, fontSize: 9.5, bold: true, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });
s8.addShape(pptx.shapes.OVAL, { x: 8.3, y: 4.15, w: 0.16, h: 0.16, fill: { color: 'F59E0B' }, line: { width: 0 } });
s8.addText('Orange — Pending (queued for an upcoming cycle)', { x: 8.55, y: 4.08, w: 3.8, h: 0.3, fontSize: 9.5, bold: true, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });

// Bottom Callout Card
card(s8, 0.8, 5.15, 11.7, 1.25, 'FFFFFF', '86EFAC');
s8.addText('✓ Craft (v16.0.0) is actively published on this store. Full Tree Contribution Widget compatibility, dynamic cart math, and multi-device responsive testing were executed — visual evidence and results on the following pages.', {
  x: 1.1, y: 5.3, w: 11.1, h: 0.9, fontSize: 11.5, bold: true, color: '047857', fontFace: 'Plus Jakarta Sans', lineSpacing: 18
});

// ─────────────────────────────────────────────────────────────────────────
// SLIDE 9: THEME: BEYOND (PAID THEME TRIAL)
// ─────────────────────────────────────────────────────────────────────────
const s9 = pptx.addSlide();
setBackground(s9); addLogo(s9);
eyebrow(s9, 'Theme: Beyond (Paid Theme Trial)');
heading(s9, 'Beyond');
s9.addText('We have also tested the Beyond theme along with its compatibility with widget', {
  x: 0.8, y: 1.45, w: 6.0, h: 0.35, fontSize: 12, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans'
});

// Table on Left
const rowsBeyond = [
  [hdCell('Device'), hdCell('Viewport'), hdCell('Status')],
  [{ text: 'Samsung Galaxy S24', options: { fontSize: 10, bold: true } }, { text: '360 x 780', options: { fontSize: 10 } }, { text: 'VERIFIED', options: { fontSize: 10, bold: true, color: COLOR_SUCCESS_GREEN } }],
  [{ text: 'iPhone 13 / 14 / 15', options: { fontSize: 10, bold: true } }, { text: '390 x 844', options: { fontSize: 10 } }, { text: 'VERIFIED', options: { fontSize: 10, bold: true, color: COLOR_SUCCESS_GREEN } }],
  [{ text: 'iPhone 15 Pro Max', options: { fontSize: 10, bold: true } }, { text: '430 x 932', options: { fontSize: 10 } }, { text: 'VERIFIED', options: { fontSize: 10, bold: true, color: COLOR_SUCCESS_GREEN } }],
  [{ text: 'iPad Portrait', options: { fontSize: 10, bold: true } }, { text: '768 x 1024', options: { fontSize: 10 } }, { text: 'VERIFIED', options: { fontSize: 10, bold: true, color: COLOR_SUCCESS_GREEN } }],
  [{ text: 'iPad Air / Pro', options: { fontSize: 10, bold: true } }, { text: '820 x 1180', options: { fontSize: 10 } }, { text: 'VERIFIED', options: { fontSize: 10, bold: true, color: COLOR_SUCCESS_GREEN } }],
  [{ text: 'iPad Landscape', options: { fontSize: 10, bold: true } }, { text: '1024 x 768', options: { fontSize: 10 } }, { text: 'VERIFIED', options: { fontSize: 10, bold: true, color: COLOR_SUCCESS_GREEN } }],
  [{ text: 'Desktop Display', options: { fontSize: 10, bold: true } }, { text: '1280 x 800', options: { fontSize: 10 } }, { text: 'VERIFIED', options: { fontSize: 10, bold: true, color: COLOR_SUCCESS_GREEN } }]
];

s9.addTable(rowsBeyond, {
  x: 0.8, y: 2.0, w: 5.6, fontSize: 10, fontFace: 'Plus Jakarta Sans',
  border: { color: COLOR_BORDER, width: 1 }, autoPage: false,
  colW: [2.5, 1.6, 1.5]
});

// Beyond images on Right
const beyondImg1 = 'results/integrity-reforestation/2026-10/extracted_pdf_images/img_1.jpg'; // PDP preview
const beyondImg2 = 'results/integrity-reforestation/2026-10/extracted_pdf_images/img_2.jpg'; // Widget snippet
const beyondImg0 = 'results/integrity-reforestation/2026-10/extracted_pdf_images/img_0.jpg'; // Cart drawer

if (fs.existsSync(beyondImg1)) {
  s9.addImage({ path: beyondImg1, x: 8.8, y: 1.6, w: 2.4, h: 2.6 });
}
if (fs.existsSync(beyondImg2)) {
  s9.addImage({ path: beyondImg2, x: 7.0, y: 2.8, w: 1.7, h: 1.4 });
}
if (fs.existsSync(beyondImg0)) {
  s9.addImage({ path: beyondImg0, x: 6.8, y: 4.4, w: 5.7, h: 2.4 });
}

// ─────────────────────────────────────────────────────────────────────────
// SLIDE 10: THEME: CRAFT (16.1.0) — MULTI-DEVICE RESPONSIVE MATRIX
// ─────────────────────────────────────────────────────────────────────────
const s10 = pptx.addSlide();
setBackground(s10); addLogo(s10);
eyebrow(s10, 'Theme: Craft (16.1.0)');
heading(s10, 'Craft — Multi-Device Responsive Matrix');

const linkCell = (t) => ({ text: t, options: { fontSize: 10, color: '0284C7', bold: true, align: 'center' } });
const rowsCraft = [
  [hdCell('Device'), hdCell('Viewport'), hdCell('Status'), hdCell('PDP'), hdCell('Cart'), hdCell('Cart Popup'), hdCell('Drawer')],
  [{ text: 'Samsung Galaxy S24', options: { fontSize: 10, bold: true } }, { text: '360 x 780', options: { fontSize: 10 } }, { text: 'VERIFIED', options: { fontSize: 10, bold: true, color: COLOR_SUCCESS_GREEN } }, linkCell('View'), linkCell('View'), { text: '—', options: { align: 'center', color: COLOR_MUTED } }, linkCell('View')],
  [{ text: 'iPhone 13 / 14 / 15', options: { fontSize: 10, bold: true } }, { text: '390 x 844', options: { fontSize: 10 } }, { text: 'VERIFIED', options: { fontSize: 10, bold: true, color: COLOR_SUCCESS_GREEN } }, linkCell('View'), linkCell('View'), { text: '—', options: { align: 'center', color: COLOR_MUTED } }, linkCell('View')],
  [{ text: 'iPhone 15 Pro Max', options: { fontSize: 10, bold: true } }, { text: '430 x 932', options: { fontSize: 10 } }, { text: 'VERIFIED', options: { fontSize: 10, bold: true, color: COLOR_SUCCESS_GREEN } }, linkCell('View'), linkCell('View'), { text: '—', options: { align: 'center', color: COLOR_MUTED } }, linkCell('View')],
  [{ text: 'iPad Portrait', options: { fontSize: 10, bold: true } }, { text: '768 x 1024', options: { fontSize: 10 } }, { text: 'VERIFIED', options: { fontSize: 10, bold: true, color: COLOR_SUCCESS_GREEN } }, linkCell('View'), linkCell('View'), { text: '—', options: { align: 'center', color: COLOR_MUTED } }, linkCell('View')],
  [{ text: 'iPad Air / Pro', options: { fontSize: 10, bold: true } }, { text: '820 x 1180', options: { fontSize: 10 } }, { text: 'VERIFIED', options: { fontSize: 10, bold: true, color: COLOR_SUCCESS_GREEN } }, linkCell('View'), linkCell('View'), { text: '—', options: { align: 'center', color: COLOR_MUTED } }, linkCell('View')],
  [{ text: 'iPad Landscape', options: { fontSize: 10, bold: true } }, { text: '1024 x 768', options: { fontSize: 10 } }, { text: 'VERIFIED', options: { fontSize: 10, bold: true, color: COLOR_SUCCESS_GREEN } }, linkCell('View'), linkCell('View'), { text: '—', options: { align: 'center', color: COLOR_MUTED } }, linkCell('View')],
  [{ text: 'Desktop Display', options: { fontSize: 10, bold: true } }, { text: '1280 x 800', options: { fontSize: 10 } }, { text: 'VERIFIED', options: { fontSize: 10, bold: true, color: COLOR_SUCCESS_GREEN } }, linkCell('View'), linkCell('View'), { text: '—', options: { align: 'center', color: COLOR_MUTED } }, linkCell('View')]
];

s10.addTable(rowsCraft, {
  x: 0.8, y: 1.8, w: 11.7, fontSize: 10, fontFace: 'Plus Jakarta Sans',
  border: { color: COLOR_BORDER, width: 1 }, autoPage: false,
  colW: [2.5, 1.8, 1.6, 1.45, 1.45, 1.45, 1.45]
});

// ─────────────────────────────────────────────────────────────────────────
// SLIDES 11–16: CRAFT THEME: WIDGET SCREENSHOTS
// Exact coordinates measured directly from Monthly_Monitoring_Report_October_2026_v2.pdf
// ─────────────────────────────────────────────────────────────────────────
const craftBase = 'results/integrity-reforestation/2026-10/screenshots/craft';

const exactSlides = [
  {
    title: 'Product page (1 of 2)',
    labels: ['Desktop 1280 x 800', 'Tablet 1024 x 768', 'Tablet 820 x 1180', 'Tablet 768 x 1024'],
    images: [
      { path: `${craftBase}/product-page/desktop/craft_pdp_fullpage_desktop_1280x800.png`, x: 0.81, y: 2.35, w: 2.42, h: 4.65 },
      { path: `${craftBase}/product-page/tablet/craft_pdp_fullpage_tablet_1024x768.png`, x: 4.08, y: 2.35, w: 2.07, h: 4.65 },
      { path: `${craftBase}/product-page/tablet/craft_pdp_fullpage_tablet_820x1180.png`, x: 7.60, y: 2.35, w: 1.22, h: 4.65 },
      { path: `${craftBase}/product-page/tablet/craft_pdp_fullpage_tablet_768x1024.png`, x: 10.71, y: 2.35, w: 1.19, h: 4.65 }
    ]
  },
  {
    title: 'Product page (2 of 2)',
    labels: ['Mobile 430 x 932', 'Mobile 414 x 896', 'Mobile 390 x 844', 'Mobile 360 x 780'],
    images: [
      { path: `${craftBase}/product-page/mobile/craft_pdp_fullpage_mobile_430x932.png`, x: 1.66, y: 2.35, w: 0.72, h: 4.65 },
      { path: `${craftBase}/product-page/mobile/craft_pdp_fullpage_mobile_414x896.png`, x: 4.77, y: 2.35, w: 0.69, h: 4.65 },
      { path: `${craftBase}/product-page/mobile/craft_pdp_fullpage_mobile_390x844.png`, x: 7.88, y: 2.35, w: 0.66, h: 4.65 },
      { path: `${craftBase}/product-page/mobile/craft_pdp_fullpage_mobile_360x780.png`, x: 11.00, y: 2.35, w: 0.61, h: 4.65 }
    ]
  },
  {
    title: 'Cart drawer (1 of 2)',
    labels: ['Desktop 1280 x 800', 'Tablet 1024 x 768', 'Tablet 820 x 1180', 'Tablet 768 x 1024'],
    images: [
      { path: `${craftBase}/cart-drawer/desktop/craft_drawer_viewport_desktop_1280x800.png`, x: 0.60, y: 3.79, w: 2.85, h: 1.78 },
      { path: `${craftBase}/cart-drawer/tablet/craft_drawer_viewport_tablet_1024x768.png`, x: 3.70, y: 3.61, w: 2.85, h: 2.13 },
      { path: `${craftBase}/cart-drawer/tablet/craft_drawer_viewport_tablet_820x1180.png`, x: 6.79, y: 2.63, w: 2.85, h: 4.09 },
      { path: `${craftBase}/cart-drawer/tablet/craft_drawer_viewport_tablet_768x1024.png`, x: 9.88, y: 2.78, w: 2.85, h: 3.79 }
    ]
  },
  {
    title: 'Cart drawer (2 of 2)',
    labels: ['Mobile 430 x 932', 'Mobile 414 x 896', 'Mobile 390 x 844', 'Mobile 360 x 780'],
    images: [
      { path: `${craftBase}/cart-drawer/mobile/craft_drawer_viewport_mobile_430x932.png`, x: 0.95, y: 2.35, w: 2.15, h: 4.65 },
      { path: `${craftBase}/cart-drawer/mobile/craft_drawer_viewport_mobile_414x896.png`, x: 4.04, y: 2.35, w: 2.15, h: 4.65 },
      { path: `${craftBase}/cart-drawer/mobile/craft_drawer_viewport_mobile_390x844.png`, x: 7.14, y: 2.35, w: 2.15, h: 4.65 },
      { path: `${craftBase}/cart-drawer/mobile/craft_drawer_viewport_mobile_360x780.png`, x: 10.23, y: 2.35, w: 2.15, h: 4.65 }
    ]
  },
  {
    title: 'Cart page (1 of 2)',
    labels: ['Desktop 1280 x 800', 'Tablet 1024 x 768', 'Tablet 820 x 1180', 'Tablet 768 x 1024'],
    images: [
      { path: `${craftBase}/cart-page/desktop/craft_cart_fullpage_desktop_1280x800.png`, x: 0.60, y: 3.11, w: 2.85, h: 3.13 },
      { path: `${craftBase}/cart-page/tablet/craft_cart_fullpage_tablet_1024x768.png`, x: 3.70, y: 2.74, w: 2.85, h: 3.86 },
      { path: `${craftBase}/cart-page/tablet/craft_cart_fullpage_tablet_820x1180.png`, x: 6.79, y: 2.41, w: 2.85, h: 4.53 },
      { path: `${craftBase}/cart-page/tablet/craft_cart_fullpage_tablet_768x1024.png`, x: 9.93, y: 2.35, w: 2.75, h: 4.65 }
    ]
  },
  {
    title: 'Cart page (2 of 2)',
    labels: ['Mobile 430 x 932', 'Mobile 414 x 896', 'Mobile 390 x 844', 'Mobile 360 x 780'],
    images: [
      { path: `${craftBase}/cart-page/mobile/craft_cart_fullpage_mobile_430x932.png`, x: 1.28, y: 2.35, w: 1.48, h: 4.65 },
      { path: `${craftBase}/cart-page/mobile/craft_cart_fullpage_mobile_414x896.png`, x: 4.45, y: 2.35, w: 1.34, h: 4.65 },
      { path: `${craftBase}/cart-page/mobile/craft_cart_fullpage_mobile_390x844.png`, x: 7.59, y: 2.35, w: 1.25, h: 4.65 },
      { path: `${craftBase}/cart-page/mobile/craft_cart_fullpage_mobile_360x780.png`, x: 10.74, y: 2.35, w: 1.14, h: 4.65 }
    ]
  }
];

// Label center positions matching the PDF exactly
const labelCenters = [
  { x: 0.60, w: 2.85 },
  { x: 3.70, w: 2.85 },
  { x: 6.80, w: 2.85 },
  { x: 9.90, w: 2.85 }
];

exactSlides.forEach((scSlide) => {
  const s = pptx.addSlide();
  setBackground(s);
  eyebrow(s, 'Craft theme: widget screenshots');
  heading(s, scSlide.title);

  // Labels across the 4 columns
  scSlide.labels.forEach((lbl, idx) => {
    const col = labelCenters[idx];
    s.addText(lbl, {
      x: col.x, y: 1.85, w: col.w, h: 0.35,
      fontSize: 13, bold: true, color: '334155', align: 'center', fontFace: 'Outfit'
    });
  });

  // Images placed with exact PDF coordinates & true proportions
  scSlide.images.forEach((img) => {
    if (fs.existsSync(img.path)) {
      s.addImage({
        path: img.path,
        x: img.x,
        y: img.y,
        w: img.w,
        h: img.h
      });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// SLIDE 17: THANK YOU!
// ─────────────────────────────────────────────────────────────────────────
const s17 = pptx.addSlide();
setBackground(s17); addLogo(s17);

s17.addText('Thank You!', {
  x: 0.8, y: 2.2, w: 11.5, h: 0.8,
  fontSize: 38, bold: true, color: COLOR_TEXT_DARK, fontFace: 'Outfit'
});
s17.addText('We are committed to maintaining, future-proofing, and optimizing your storefront.', {
  x: 0.8, y: 3.2, w: 11.5, h: 0.5,
  fontSize: 15, bold: true, color: '0284C7', fontFace: 'Plus Jakarta Sans'
});
s17.addText('If you have questions regarding this report, please connect with your account engineer.', {
  x: 0.8, y: 3.9, w: 11.5, h: 0.4,
  fontSize: 12, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans'
});

// Office Cards
card(s17, 0.8, 5.0, 5.6, 1.4);
s17.addText('United States Office', { x: 1.1, y: 5.2, w: 5.0, h: 0.3, fontSize: 13, bold: true, color: COLOR_TEXT_DARK, fontFace: 'Outfit' });
s17.addText('98 Cutter Mill Rd, Great Neck, NY 11021, USA', { x: 1.1, y: 5.6, w: 5.0, h: 0.4, fontSize: 11, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });

card(s17, 6.9, 5.0, 5.6, 1.4);
s17.addText('Canada Office', { x: 7.2, y: 5.2, w: 5.0, h: 0.3, fontSize: 13, bold: true, color: COLOR_TEXT_DARK, fontFace: 'Outfit' });
s17.addText('150 King Street W, Toronto, ON M5H 1J9, Canada', { x: 7.2, y: 5.6, w: 5.0, h: 0.4, fontSize: 11, color: COLOR_MUTED, fontFace: 'Plus Jakarta Sans' });

// ─────────────────────────────────────────────────────────────────────────
// WRITE FILES
// ─────────────────────────────────────────────────────────────────────────
await pptx.writeFile({ fileName: OUT_PPTX });
console.log('Successfully saved to:', OUT_PPTX);

// Also mirror to root
fs.copyFileSync(OUT_PPTX, ROOT_PPTX);
console.log('Successfully mirrored to:', ROOT_PPTX);
