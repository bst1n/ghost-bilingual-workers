# ghost-bilingual-workers

Four Cloudflare Workers that turn two separate Ghost instances into a
seamless bilingual site — no theme modifications, no third-party service,
no Ghost(Pro) required.

**What you get:**

- EN content served under your main domain (`your-blog.com/en/`) instead
  of a subdomain — the URL structure Google recommends for multilingual sites
- `<link rel="alternate" hreflang>` tags injected on every translated article
- A visible in-page "Read in English / Lire en français" notice under the
  article title
- `en.your-blog.com` 301-redirecting to `your-blog.com/en` for SEO consolidation
- Sitemap, RSS, and canonical URLs all rewritten to the subdirectory form

Everything runs at the edge. No round-trips to an external translation
service, no JavaScript payload, no theme changes.

---

## ⚠️ Prerequisites and constraints

Read this before starting.

1. **Two Ghost instances.** One per language, each with its own hosting,
   domain, and content. These Workers connect them — they do not create,
   sync, or translate content.

2. **Cloudflare on both domains.** Both `your-blog.com` and
   `en.your-blog.com` must be on Cloudflare (the free plan is fine).

3. **Manual translation workflow.** You write articles independently on
   each Ghost instance, then add a matching `#i18n-<id>` private tag to
   both. The Workers detect the link — they don't create it.

4. **`wrangler` CLI required.** Install with `npm i -g wrangler` or use
   `npx wrangler`.

5. **Cloudflare Workers free tier.** 100,000 requests/day. Sufficient for
   most blogs; check your traffic before deploying.

---

## How translations are linked

Add the **same** internal tag `#i18n-<id>` to the FR article and the EN
article (use any short unique id, e.g. `#i18n-climate-report`). Ghost
slugifies internal tags as `hash-*`, so the rendered `<body>` class will
contain `tag-hash-i18n-climate-report`. The i18n Worker detects this and
looks up the matching article via the Ghost Content API.

Article slugs stay independent — `/rapport-climatique/` on FR,
`/climate-report/` on EN. The tag does the matching.

---

## Architecture

```
         visitor
            │
            ▼
 ┌──────────────────────────────────────────────────────────┐
 │  your-blog.com/*      your-blog.com/en/*                 │
 │                                                          │
 │  ┌─────────────────┐   ┌──────────────────────────────┐  │
 │  │  i18n-worker    │   │  subdir-proxy-worker         │  │
 │  │  (hreflang +    │   │  (strips /en, forwards to    │  │
 │  │   301 redirect) │   │   fetcher over HTTPS)        │  │
 │  └────────┬────────┘   └──────────────┬───────────────┘  │
 │           │ HTTPS/workers.dev          │ HTTPS/workers.dev│
 │           │                            │                  │
 └───────────┼────────────────────────────┼──────────────────┘
             │                            │
             ▼                            ▼
  ┌──────────────────┐       ┌────────────────────────────┐
  │  api-proxy-      │       │  subdir-fetcher-worker     │
  │  worker          │       │  (fetches en.your-blog.com,│
  │  (Content API    │       │   rewrites all URLs to     │
  │   relay)         │       │   your-blog.com/en)        │
  └──────────────────┘       └────────────────────────────┘
             │                            │
             ▼                            ▼
    Ghost Content API           Ghost EN origin
    (FR or EN blog)             (en.your-blog.com)
```

### Why four Workers?

If both Ghost blogs share the same Cloudflare zone (e.g. `your-blog.com`
and `en.your-blog.com` both on the `your-blog.com` zone), Cloudflare
blocks any Worker-to-Worker fetch on that zone with an opaque HTTP 500
([error 1042](https://developers.cloudflare.com/workers/observability/errors/#runtime-errors)).
This affects both the Content API lookup and the subdirectory proxying.

The workaround is to put the "outbound" workers (`api-proxy-worker` and
`subdir-fetcher-worker`) on `workers.dev` — outside your zone — so their
outbound fetches are cross-zone and succeed. The zone-bound workers
(`i18n-worker` and `subdir-proxy-worker`) reach them over HTTPS, auth-gated
by a shared secret.

Things that look like they'd fix the same-zone problem but don't:

| Attempt | Why it fails |
|---------|-------------|
| `global_fetch_strictly_public` flag | Causes the main pass-through `fetch(request)` to also route through the Worker → infinite loop → 503 on every request |
| Service Binding to a proxy Worker | Service Bindings propagate the calling Worker's zone context, so the proxy's outbound fetch is still same-zone — same 500 |
| Custom Domain instead of Route | Requires deleting the DNS record that points to Ghost origin — breaks Ghost |

---

## Repo layout

```
ghost-bilingual-workers/
├── i18n-worker/              # main Worker — on your-blog.com/* and en.your-blog.com/*
│   ├── src/index.ts          # hreflang injection + 301 redirect en.X.com → X.com/en
│   ├── wrangler.jsonc
│   ├── package.json
│   └── tsconfig.json
├── api-proxy-worker/         # workers.dev only — relays Ghost Content API calls
│   ├── src/index.ts
│   ├── wrangler.jsonc
│   ├── package.json
│   └── tsconfig.json
├── subdir-proxy-worker/      # on your-blog.com/en/* — strips /en, forwards to fetcher
│   ├── src/index.ts
│   ├── wrangler.jsonc
│   ├── package.json
│   └── tsconfig.json
└── subdir-fetcher-worker/    # workers.dev only — fetches Ghost EN origin, rewrites URLs
    ├── src/index.ts
    ├── wrangler.jsonc
    ├── package.json
    └── tsconfig.json
```

---

## Setup

### 1. Clone

```bash
git clone https://github.com/bst1n/ghost-bilingual-workers.git my-blog-i18n
cd my-blog-i18n
```

Install dependencies in each worker directory:

```bash
for d in i18n-worker api-proxy-worker subdir-proxy-worker subdir-fetcher-worker; do
  (cd $d && npm install)
done
```

### 2. Authenticate with Cloudflare

```bash
cd i18n-worker && npx wrangler login && cd ..
```

### 3. Configure `wrangler.jsonc` in each worker

Replace the placeholders in each `wrangler.jsonc`:

| Placeholder | Replace with |
|-------------|-------------|
| `your-blog.com` | your FR Ghost domain |
| `en.your-blog.com` | your EN Ghost domain |
| `your-account` | your Cloudflare account subdomain (visible after first `wrangler deploy`) |

Worker names (`ghost-subdir-i18n`, `ghost-subdir-proxy`, etc.) can also be
renamed to match your project.

### 4. Deploy `api-proxy-worker` (first — its URL is needed by `i18n-worker`)

Generate shared secrets:

```bash
PROXY_SECRET=$(openssl rand -base64 32)
BYPASS_SECRET=$(openssl rand -base64 32)
FETCHER_SECRET=$(openssl rand -base64 32)
```

Deploy and set secrets:

```bash
cd api-proxy-worker
npx wrangler deploy
echo "<your-FR-content-api-key>" | npx wrangler secret put FR_CONTENT_API_KEY
echo "<your-EN-content-api-key>" | npx wrangler secret put EN_CONTENT_API_KEY
echo "$PROXY_SECRET"             | npx wrangler secret put PROXY_SHARED_SECRET
cd ..
```

Ghost Content API keys: Ghost admin → Settings → Integrations →
Add custom integration → copy the Content API Key. Create one per blog.

Note the `workers.dev` URL printed after deploy. Make sure it matches
`API_PROXY_URL` in `i18n-worker/wrangler.jsonc`.

### 5. Deploy `subdir-fetcher-worker`

```bash
cd subdir-fetcher-worker
npx wrangler deploy
echo "$FETCHER_SECRET" | npx wrangler secret put FETCHER_SHARED_SECRET
echo "$BYPASS_SECRET"  | npx wrangler secret put INTERNAL_BYPASS_SECRET
cd ..
```

Note the `workers.dev` URL and make sure it matches `FETCHER_URL` in
`subdir-proxy-worker/wrangler.jsonc`.

### 6. Deploy `subdir-proxy-worker`

```bash
cd subdir-proxy-worker
npx wrangler deploy
echo "$FETCHER_SECRET" | npx wrangler secret put FETCHER_SHARED_SECRET
cd ..
```

### 7. Deploy `i18n-worker`

```bash
cd i18n-worker
npx wrangler deploy
echo "$PROXY_SECRET"   | npx wrangler secret put PROXY_SHARED_SECRET
echo "$BYPASS_SECRET"  | npx wrangler secret put INTERNAL_BYPASS_SECRET
cd ..
```

---

## CSS for the translation notice

The Workers inject a `<p class="gh-translation-notice">` after the article
`<h1>`. Add this to Ghost admin → Settings → Code Injection → Site Header
on **both** blogs:

```html
<style>
.gh-translation-notice {
  margin: 1rem 0 2rem;
  padding: 0.8rem 1rem;
  background: #f5f5f5;
  border-left: 3px solid #888;
  font-style: italic;
  font-size: 0.9em;
}
.gh-translation-notice a {
  color: inherit;
  text-decoration: underline;
}
</style>
```

---

## Validation

Pick an article tagged `#i18n-<id>` with its translation published on the
other blog:

```bash
# hreflang tags (expect 3 lines: fr, en, x-default)
curl -s https://your-blog.com/<slug>/ | grep 'hreflang'

# translation notice (expect 1 line)
curl -s https://your-blog.com/<slug>/ | grep 'gh-translation-notice'

# EN content served under subdirectory (expect Ghost HTML)
curl -s https://your-blog.com/en/<slug>/ | grep '<title>'

# sitemap URLs (expect your-blog.com/en/...)
curl -s https://your-blog.com/en/sitemap-posts.xml | grep '<loc>' | head -5
```

Then in **Google Search Console** → URL Inspection → "View tested page" →
HTML: the three hreflang lines should appear in the rendered source.

---

## Theme dependency

The i18n Worker uses one theme-specific selector:

```ts
.on("h1.gh-article-title", ...)
```

`gh-article-title` is the class on the article `<h1>` in the official
Ghost themes **Source** and **Casper**. If your theme uses a different
class, edit this selector in `i18n-worker/src/index.ts`.

---

## Behaviour reference

| Situation | Worker behaviour |
|-----------|-----------------|
| Non-HTML response (assets, RSS, sitemap, JSON) | Pass through |
| Path is `/`, `/tag/...`, `/author/...`, `/ghost/...` | Pass through |
| HTML article without `#i18n-*` tag | Pass through |
| HTML article with `#i18n-*` but no translation published | Pass through (miss cached 5 min) |
| Proxy or fetcher down / API error | Pass through, error logged |
| Request to `en.your-blog.com` (admin, assets, preview) | Served directly, not redirected |
| Request to `en.your-blog.com` (any article) | 301 → `your-blog.com/en/...` |

---

## License

MIT. Use freely.
