# Website Score

Get mobile, desktop, and conversion scores for any public website with a small Cloudflare Worker.

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lindoai/website-score)

## Features

- mobile and desktop performance scores via Google PageSpeed Insights
- Lighthouse category scores (Performance, Accessibility, Best Practices, SEO)
- Core Web Vitals (LCP, INP, CLS, FCP, TTFB, TBT, SI)
- signal detection (SSL, mobile, analytics, schema, load time, CMS)
- conversion audit (CTA, contact form, phone, social proof, headline, privacy, favicon)
- CMS detection (WordPress, Shopify, Webflow, Next.js, Lindo.ai, and more)

## Local development

```bash
npm install
npm run dev
npm run typecheck
```

## Deploy

```bash
npm run deploy
```

## Production env

- `TURNSTILE_SITE_KEY`
- `TURNSTILE_SECRET_KEY`
- `GOOGLE_PSI_API_KEY` (optional, for higher PageSpeed API quota)

## API

### GET `/api/score?url=https://example.com`

Returns JSON:

```json
{
  "url": "https://example.com",
  "scores": {
    "mobile": 73,
    "desktop": 88,
    "conversion": 78
  },
  "categories": {
    "mobile": { "performance": 73, "accessibility": 95, "best-practices": 81, "seo": 92 },
    "desktop": { "performance": 88, "accessibility": 95, "best-practices": 81, "seo": 92 }
  },
  "metrics": {
    "desktop": {
      "LCP": { "value": 1.2, "unit": "s", "rating": "good" },
      "CLS": { "value": 0, "unit": "", "rating": "good" },
      "FCP": { "value": 0.5, "unit": "s", "rating": "good" },
      "TTFB": { "value": 120, "unit": "ms", "rating": "good" },
      "TBT": { "value": 50, "unit": "ms", "rating": "good" },
      "SI": { "value": 0.8, "unit": "s", "rating": "good" }
    }
  },
  "signals": [
    { "name": "SSL Certificate", "pass": true, "detail": "Site uses HTTPS." },
    { "name": "Mobile Responsive", "pass": true, "detail": "Viewport meta tag present." }
  ],
  "conversion": [
    { "name": "Call-to-Action", "pass": true, "detail": "Action-oriented buttons detected." },
    { "name": "Contact Form", "pass": false, "detail": "No contact form detected." }
  ],
  "technical": { "strengths": [...], "weaknesses": [...] },
  "conversionBreakdown": { "strengths": [...], "weaknesses": [...] }
}
```
