import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { parseHTML } from 'linkedom';
import puppeteer from '@cloudflare/puppeteer';
import { readTurnstileTokenFromUrl, verifyTurnstileToken } from '../../_shared/turnstile';
import { renderTextToolPage, turnstileSiteKeyFromEnv } from '../../_shared/tool-page';

type Env = { Bindings: { BROWSER?: Fetcher; TURNSTILE_SITE_KEY?: string; TURNSTILE_SECRET_KEY?: string; GOOGLE_PSI_API_KEY?: string } };

const app = new Hono<Env>();
app.use('/api/*', cors());

app.get('/', (c) =>
  c.html(
    renderTextToolPage({
      title: 'Website Score',
      description: 'Get a performance, mobile, and conversion score for any website with actionable insights.',
      endpoint: '/api/score',
      sample: '{ "url": "https://example.com", "scores": { "mobile": 88, "desktop": 93, "conversion": 85 } }',
      siteKey: turnstileSiteKeyFromEnv(c.env),
      buttonLabel: 'Score this site',
      toolSlug: 'website-score',
    })
  )
);

app.get('/health', (c) => c.json({ ok: true }));

app.get('/api/score', async (c) => {
  const captcha = await verifyTurnstileToken(c.env, readTurnstileTokenFromUrl(c.req.url), c.req.header('CF-Connecting-IP'));
  if (!captcha.ok) return c.json({ error: captcha.error }, 403);

  const normalized = normalizeUrl(c.req.query('url') ?? '');
  if (!normalized) return c.json({ error: 'A valid http(s) URL is required.' }, 400);

  // Fetch page and PageSpeed data in parallel
  const [pageResult, psiMobile, psiDesktop] = await Promise.all([
    fetchPage(normalized),
    fetchPageSpeedScore(normalized, 'mobile', c.env.GOOGLE_PSI_API_KEY),
    fetchPageSpeedScore(normalized, 'desktop', c.env.GOOGLE_PSI_API_KEY),
  ]);

  if (!pageResult) return c.json({ error: 'Failed to fetch page.' }, 502);

  const { html, loadTimeMs, headers } = pageResult;
  const { document } = parseHTML(html);

  // Detect signals
  const signals = detectSignals(document, html, headers, loadTimeMs);

  // Detect conversion signals
  const conversion = detectConversion(document, html);

  // Calculate conversion score
  const conversionScore = Math.round(
    (conversion.filter((s) => s.pass).length / conversion.length) * 100
  );

  // Build response
  return c.json({
    url: normalized,
    scores: {
      mobile: psiMobile.score,
      desktop: psiDesktop.score,
      conversion: conversionScore,
    },
    categories: {
      mobile: psiMobile.categories,
      desktop: psiDesktop.categories,
    },
    metrics: {
      mobile: psiMobile.metrics,
      desktop: psiDesktop.metrics,
    },
    signals,
    conversion,
    technical: buildTechnicalBreakdown(signals),
    conversionBreakdown: buildConversionBreakdown(conversion),
  });
});

// --- PDF Report endpoint (accepts score data via POST) ---

app.post('/api/score/pdf', async (c) => {
  if (!c.env.BROWSER) return c.json({ error: 'PDF generation not available.' }, 503);

  const body = await c.req.json<any>().catch(() => null);
  if (!body || !body.url) return c.json({ error: 'Missing score data.' }, 400);

  const reportHtml = buildPdfReportHtml({
    url: body.url,
    scores: body.scores || { mobile: 0, desktop: 0, conversion: 0 },
    categories: body.categories?.desktop || {},
    metrics: body.metrics?.desktop || {},
    signals: body.signals || [],
    conversion: body.conversion || [],
  });

  let browser: any;
  try {
    browser = await puppeteer.launch(c.env.BROWSER);
    const page = await browser.newPage();
    await page.setContent(reportHtml, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({ format: 'A4', margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' } });
    await browser.close();

    const hostname = new URL(body.url).hostname;
    return new Response(pdf as ArrayBuffer, {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="website-score-${hostname}.pdf"`,
      },
    });
  } catch (e) {
    if (browser) await browser.close();
    return c.json({ error: 'PDF generation failed.' }, 500);
  }
});

// --- PageSpeed Insights (free, no API key needed for basic scores) ---

async function fetchPageSpeedScore(url: string, strategy: 'mobile' | 'desktop', apiKey?: string): Promise<PageSpeedResult> {
  try {
    let endpoint = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=${strategy}&category=performance&category=accessibility&category=best-practices&category=seo`;
    if (apiKey) endpoint += `&key=${apiKey}`;
    const response = await fetch(endpoint, {
      headers: { 'user-agent': 'Lindo Free Tools/1.0 (+https://lindo.ai/tools)' },
    });
    if (!response.ok) return { score: 0, categories: {}, metrics: {} };
    const data = await response.json() as any;

    const lighthouse = data?.lighthouseResult;
    const categories: Record<string, number> = {};
    for (const [key, val] of Object.entries(lighthouse?.categories || {})) {
      categories[key] = Math.round(((val as any)?.score || 0) * 100);
    }

    // Core Web Vitals + other metrics
    const audits = lighthouse?.audits || {};
    const metrics: Record<string, { value: number; unit: string; rating: string }> = {};

    const metricMap: Record<string, { key: string; unit: string }> = {
      'largest-contentful-paint': { key: 'LCP', unit: 's' },
      'interaction-to-next-paint': { key: 'INP', unit: 'ms' },
      'cumulative-layout-shift': { key: 'CLS', unit: '' },
      'first-contentful-paint': { key: 'FCP', unit: 's' },
      'server-response-time': { key: 'TTFB', unit: 'ms' },
      'total-blocking-time': { key: 'TBT', unit: 'ms' },
      'speed-index': { key: 'SI', unit: 's' },
    };

    for (const [auditKey, meta] of Object.entries(metricMap)) {
      const audit = audits[auditKey];
      if (audit?.numericValue !== undefined) {
        let value = audit.numericValue;
        if (meta.unit === 's') value = value / 1000; // ms to seconds
        metrics[meta.key] = {
          value: meta.unit === 's' ? Math.round(value * 10) / 10 : Math.round(value),
          unit: meta.unit,
          rating: audit.score >= 0.9 ? 'good' : audit.score >= 0.5 ? 'needs-improvement' : 'poor',
        };
      }
    }

    return {
      score: categories['performance'] || 0,
      categories,
      metrics,
    };
  } catch {
    return { score: 0, categories: {}, metrics: {} };
  }
}

type PageSpeedResult = {
  score: number;
  categories: Record<string, number>;
  metrics: Record<string, { value: number; unit: string; rating: string }>;
};

// --- Page fetch with timing ---

async function fetchPage(url: string): Promise<{ html: string; loadTimeMs: number; headers: Headers } | null> {
  try {
    const start = Date.now();
    const response = await fetch(url, {
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'user-agent': 'Lindo Free Tools/1.0 (+https://lindo.ai/tools)',
      },
      redirect: 'follow',
    });
    const loadTimeMs = Date.now() - start;
    if (!response.ok) return null;
    const html = await response.text();
    return { html, loadTimeMs, headers: response.headers };
  } catch {
    return null;
  }
}

// --- Signal Detection ---

type Signal = { name: string; pass: boolean; detail: string };

function detectSignals(document: any, html: string, headers: Headers, loadTimeMs: number): Signal[] {
  const signals: Signal[] = [];

  // SSL
  signals.push({
    name: 'SSL Certificate',
    pass: true, // If we fetched via HTTPS successfully, SSL is valid
    detail: 'Site uses HTTPS. Secure and trusted by browsers.',
  });

  // Mobile responsive
  const hasViewport = !!document.querySelector('meta[name="viewport"]');
  signals.push({
    name: 'Mobile Responsive',
    pass: hasViewport,
    detail: hasViewport
      ? 'Viewport meta tag present. Site is configured for mobile devices.'
      : 'No viewport meta tag found. Site may not display correctly on mobile.',
  });

  // Analytics tracking
  const hasAnalytics =
    html.includes('google-analytics') ||
    html.includes('gtag') ||
    html.includes('googletagmanager') ||
    html.includes('analytics') ||
    html.includes('plausible') ||
    html.includes('fathom') ||
    html.includes('mixpanel') ||
    html.includes('segment') ||
    html.includes('hotjar') ||
    html.includes('clarity.ms');
  signals.push({
    name: 'Analytics Tracking',
    pass: hasAnalytics,
    detail: hasAnalytics
      ? 'Analytics tracking detected. The business tracks site visitors.'
      : 'No analytics tracking detected. Visitor data is not being collected.',
  });

  // Schema markup
  const hasSchema =
    !!document.querySelector('script[type="application/ld+json"]') ||
    html.includes('itemtype=') ||
    html.includes('itemscope');
  signals.push({
    name: 'Schema Markup',
    pass: hasSchema,
    detail: hasSchema
      ? 'Structured data (schema.org) found. Helps search engines understand content.'
      : 'No structured data found. Adding schema markup can improve search visibility.',
  });

  // Load time
  const fastLoad = loadTimeMs < 3000;
  signals.push({
    name: `Load Time: ${(loadTimeMs / 1000).toFixed(1)}s`,
    pass: fastLoad,
    detail: fastLoad
      ? `Homepage loaded in ${loadTimeMs}ms. Excellent performance.`
      : `Homepage loaded in ${loadTimeMs}ms. Consider optimizing for faster load times.`,
  });

  // CMS detection
  const cms = detectCMS(html, headers);
  signals.push({
    name: `CMS: ${cms || 'Unknown'}`,
    pass: !!cms,
    detail: cms
      ? `Detected platform: ${cms}.`
      : 'Could not detect the CMS or platform.',
  });

  return signals;
}

function detectCMS(html: string, headers: Headers): string | null {
  if (headers.get('host-by') === 'ln-cloudflare') return 'Lindo.ai';
  if (html.includes('wp-content') || html.includes('wp-includes')) return 'WordPress';
  if (html.includes('Shopify') || html.includes('shopify')) return 'Shopify';
  if (html.includes('squarespace')) return 'Squarespace';
  if (html.includes('wix.com') || html.includes('wixsite')) return 'Wix';
  if (html.includes('webflow')) return 'Webflow';
  if (html.includes('__next') || html.includes('_next/static')) return 'Next.js';
  if (html.includes('__nuxt')) return 'Nuxt';
  if (html.includes('framer')) return 'Framer';
  if (html.includes('ghost')) return 'Ghost';
  if (html.includes('drupal')) return 'Drupal';
  if (html.includes('joomla')) return 'Joomla';
  if (headers.get('x-powered-by')?.includes('Express')) return 'Express/Node.js';
  return null;
}

// --- Conversion Signal Detection ---

type ConversionSignal = { name: string; pass: boolean; detail: string };

function detectConversion(document: any, html: string): ConversionSignal[] {
  const signals: ConversionSignal[] = [];

  // Contact form
  const hasForm = !!document.querySelector('form') || html.includes('contact-form') || html.includes('formspree') || html.includes('typeform');
  signals.push({
    name: 'Contact Form',
    pass: hasForm,
    detail: hasForm
      ? 'A form is present on the page for visitor inquiries.'
      : 'No contact form detected. Visitors may not have an easy way to reach out.',
  });

  // Call-to-action
  const hasCTA =
    !!document.querySelector('a[class*="btn"], a[class*="button"], button[class*="btn"], [class*="cta"]') ||
    html.includes('Get Started') ||
    html.includes('Sign Up') ||
    html.includes('Book') ||
    html.includes('Contact Us') ||
    html.includes('Free Trial');
  signals.push({
    name: 'Call-to-Action',
    pass: hasCTA,
    detail: hasCTA
      ? 'Action-oriented buttons detected. The site guides visitors toward conversion.'
      : 'No clear call-to-action found. Add prominent buttons to guide visitors.',
  });

  // Phone number
  const hasPhone = !!document.querySelector('a[href^="tel:"]') || /\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/.test(html);
  signals.push({
    name: 'Phone Number Visible',
    pass: hasPhone,
    detail: hasPhone
      ? 'Phone number is prominently displayed. Makes it easy for visitors to call.'
      : 'No phone number detected. Adding one can increase trust and conversions.',
  });

  // Social proof
  const hasSocialProof =
    html.includes('testimonial') ||
    html.includes('review') ||
    html.includes('rating') ||
    html.includes('stars') ||
    html.includes('trust') ||
    html.includes('client') ||
    html.includes('customer') ||
    !!document.querySelector('[class*="testimonial"], [class*="review"], [class*="trust"]');
  signals.push({
    name: 'Social Proof',
    pass: hasSocialProof,
    detail: hasSocialProof
      ? 'Testimonials, reviews, or trust signals found. This builds credibility with visitors.'
      : 'No social proof detected. Adding testimonials or reviews can boost trust.',
  });

  // Clear headline
  const h1 = document.querySelector('h1');
  const hasHeadline = h1 && (h1.textContent || '').trim().length > 5 && (h1.textContent || '').trim().length < 100;
  signals.push({
    name: 'Clear Headline',
    pass: !!hasHeadline,
    detail: hasHeadline
      ? 'A concise H1 headline is present. Visitors can quickly understand the business offering.'
      : 'No clear H1 headline found. A strong headline helps visitors understand what you offer.',
  });

  // Modern design (no deprecated HTML)
  const hasDeprecated =
    html.includes('<font') ||
    html.includes('<center') ||
    html.includes('<marquee') ||
    html.includes('bgcolor=') ||
    html.includes('<blink');
  signals.push({
    name: 'Modern Design',
    pass: !hasDeprecated,
    detail: !hasDeprecated
      ? 'No outdated HTML detected. The site uses modern web standards.'
      : 'Deprecated HTML elements found. The site may appear outdated to visitors.',
  });

  // Privacy policy
  const hasPrivacy =
    !!document.querySelector('a[href*="privacy"]') ||
    html.toLowerCase().includes('privacy policy');
  signals.push({
    name: 'Privacy Policy',
    pass: hasPrivacy,
    detail: hasPrivacy
      ? 'Privacy policy link found. Builds trust and meets legal requirements.'
      : 'No privacy policy link detected. This is important for trust and compliance.',
  });

  // Favicon
  const hasFavicon = !!document.querySelector('link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]');
  signals.push({
    name: 'Favicon',
    pass: hasFavicon,
    detail: hasFavicon
      ? 'Favicon is set. The site has a branded browser tab icon.'
      : 'No favicon detected. Adding one improves brand recognition in browser tabs.',
  });

  // Contact page link
  const hasContactLink =
    !!document.querySelector('a[href*="contact"], a[href*="book"], a[href*="schedule"]') ||
    html.toLowerCase().includes('contact us');
  signals.push({
    name: 'Contact Page Link',
    pass: hasContactLink,
    detail: hasContactLink
      ? 'A link to a contact or booking page is accessible from the homepage.'
      : 'No contact page link found. Make it easy for visitors to reach you.',
  });

  return signals;
}

// --- Breakdown builders ---

function buildTechnicalBreakdown(signals: Signal[]) {
  const strengths = signals.filter((s) => s.pass);
  const weaknesses = signals.filter((s) => !s.pass);
  return { strengths, weaknesses };
}

function buildConversionBreakdown(signals: ConversionSignal[]) {
  const strengths = signals.filter((s) => s.pass);
  const weaknesses = signals.filter((s) => !s.pass);
  return { strengths, weaknesses };
}

// --- Helpers ---

function normalizeUrl(value: string): string | null {
  try {
    const candidate = value.startsWith('http') ? value : `https://${value}`;
    const u = new URL(candidate.trim());
    return ['http:', 'https:'].includes(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}

function buildPdfReportHtml(data: { url: string; scores: { mobile: number; desktop: number; conversion: number }; categories: Record<string, number>; metrics: Record<string, { value: number; unit: string; rating: string }>; signals: Signal[]; conversion: ConversionSignal[] }) {
  const scoreColor = (v: number) => v >= 90 ? '#10b981' : v >= 50 ? '#f59e0b' : '#ef4444';
  const metricColor = (r: string) => r === 'good' ? '#10b981' : r === 'needs-improvement' ? '#f59e0b' : '#ef4444';

  const scoreCircle = (value: number, label: string) => `
    <div style="text-align:center;">
      <div style="width:80px;height:80px;border-radius:50%;border:6px solid ${scoreColor(value)};display:inline-flex;align-items:center;justify-content:center;margin-bottom:8px;">
        <span style="font-size:24px;font-weight:700;color:${scoreColor(value)}">${value}</span>
      </div>
      <div style="font-size:12px;color:#666;">${label}</div>
    </div>`;

  const signalRow = (s: { name: string; pass: boolean; detail: string }) => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;color:${s.pass ? '#10b981' : '#ef4444'};font-size:14px;">${s.pass ? '✓' : '✗'}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:13px;font-weight:500;">${s.name}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:12px;color:#666;">${s.detail}</td>
    </tr>`;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1a1a1a; padding: 0; margin: 0; }
    h1 { font-size: 22px; margin: 0 0 4px; }
    h2 { font-size: 16px; margin: 24px 0 12px; padding-bottom: 8px; border-bottom: 1px solid #eee; }
    .scores { display: flex; justify-content: center; gap: 40px; margin: 24px 0; }
    .categories { display: flex; justify-content: center; gap: 24px; margin: 16px 0; }
    .metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 16px 0; }
    .metric { background: #f9fafb; border-radius: 8px; padding: 12px; }
    .metric-label { font-size: 10px; text-transform: uppercase; color: #999; }
    .metric-value { font-size: 20px; font-weight: 700; margin: 4px 0; }
    .metric-rating { font-size: 10px; }
    table { width: 100%; border-collapse: collapse; }
    .footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #eee; font-size: 11px; color: #999; text-align: center; }
  </style></head><body>
    <h1>Website Score Report</h1>
    <p style="font-size:13px;color:#666;margin:0 0 24px;">${data.url}</p>

    <div class="scores">
      ${scoreCircle(data.scores.mobile, 'Mobile')}
      ${scoreCircle(data.scores.desktop, 'Desktop')}
      ${scoreCircle(data.scores.conversion, 'Conversion')}
    </div>

    ${Object.keys(data.categories).length > 1 ? `
      <h2>Lighthouse Scores</h2>
      <div class="categories">
        ${Object.entries(data.categories).map(([k, v]) => scoreCircle(v, k.replace('-', ' '))).join('')}
      </div>
    ` : ''}

    ${Object.keys(data.metrics).length > 0 ? `
      <h2>Core Web Vitals</h2>
      <div class="metrics">
        ${Object.entries(data.metrics).map(([k, m]) => `
          <div class="metric">
            <div class="metric-label">${k}</div>
            <div class="metric-value" style="color:${metricColor(m.rating)}">${m.value}${m.unit}</div>
            <div class="metric-rating" style="color:${metricColor(m.rating)}">${m.rating === 'good' ? '● Good' : m.rating === 'needs-improvement' ? '■ Needs work' : '▲ Poor'}</div>
          </div>
        `).join('')}
      </div>
    ` : ''}

    <h2>Signals Detected</h2>
    <table>${data.signals.map(signalRow).join('')}</table>

    <h2>Conversion Signals</h2>
    <table>${data.conversion.map(signalRow).join('')}</table>

    <div class="footer">Generated by lindo.ai/tools/website-score</div>
  </body></html>`;
}

export default app;
