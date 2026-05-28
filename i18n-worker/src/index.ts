/**
 * Ghost i18n cross-linking Worker
 *
 * Intercepts HTML responses on your-blog.com (FR) and en.your-blog.com (EN),
 * detects the pivot tag `hash-i18n-<id>` in the rendered body class, looks up
 * the matching translation on the other blog via the Ghost Content API
 * (proxied through the API_PROXY service binding — see ../api-proxy-worker/),
 * and injects:
 *   - <link rel="alternate" hreflang="..."> tags in <head>
 *   - <p class="gh-translation-notice"> after the article <h1>
 *
 * Failure modes are silent: any error short-circuits to returning the
 * original upstream response unchanged. Never break the site.
 */

interface Env {
	FR_SITE_URL: string;
	EN_SITE_URL: string;
	// Public URL of the EN blog as exposed to readers (subdirectory mount).
	// e.g. "https://your-blog.com/en". Translation URLs returned by the
	// Content API still use EN_SITE_URL (the Ghost-configured site URL,
	// `https://en.your-blog.com`); we rewrite them to EN_PUBLIC_URL before
	// emitting them in hreflang tags and the translation notice so that
	// internal cross-language links keep the visitor on the main domain
	// (and the browser doesn't treat them as external → new tab).
	EN_PUBLIC_URL: string;
	API_PROXY_URL: string;
	PROXY_SHARED_SECRET: string;
	// Shared secret with the subdir-fetcher Worker. When the fetcher hits
	// en.your-blog.com to fetch content for the subdirectory mount, it
	// sends `x-internal-bypass: <INTERNAL_BYPASS_SECRET>` so this Worker
	// knows to serve the page (with enrichment) instead of issuing the
	// public 301 redirect to your-blog.com/en/...
	INTERNAL_BYPASS_SECRET: string;
}

// Paths that must NOT be redirected from en.your-blog.com to
// your-blog.com/en/* — they are functional / internal endpoints, not SEO
// targets. Admin, Members API, theme assets, Ghost images, previews, etc.
const REDIRECT_WHITELIST_PREFIXES = [
	"/ghost/",
	"/members/",
	"/content/",
	"/assets/",
	"/p/",
	"/.well-known/",
];

interface Translation {
	url: string;
	title: string;
}

// Paths we never touch (non-article URLs served as HTML).
const SKIP_PATH_PREFIXES = [
	"/tag/",
	"/tags/",
	"/author/",
	"/authors/",
	"/p/", // Ghost preview URLs: /p/<uuid>/
	"/ghost/", // admin + Content API
	"/rss/",
	"/sitemap",
	"/robots.txt",
	"/members/",
	"/.well-known/",
];

// Regex on body class to extract the pivot id.
// Ghost renders <body class="post-template tag-hash-i18n-<id> ...">.
const PIVOT_TAG_REGEX = /tag-hash-i18n-([a-z0-9][a-z0-9-]*)/i;

// Cache TTL for Content API lookups: 5 minutes.
const API_CACHE_TTL_SECONDS = 300;
// Version segment in the cache key — bump to invalidate everything.
const CACHE_VERSION = "v8";

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// === Subdirectory migration: 301 redirect en.X.com/* → X.com/en/* ===
		//
		// Only on the EN subdomain. Internal callers (the subdir-fetcher Worker
		// that mirrors en.X.com under X.com/en/*) bypass by sending the
		// INTERNAL_BYPASS_SECRET in `x-internal-bypass`.
		//
		// Whitelist: paths used for admin, Members API, assets, previews are
		// not redirected — they remain accessible on en.X.com directly.
		const isEnSite = url.hostname === new URL(env.EN_SITE_URL).hostname;
		if (isEnSite && !isInternalBypass(request, env) && !isRedirectWhitelisted(url.pathname)) {
			return redirectToPublicUrl(url, env.EN_PUBLIC_URL);
		}

		// Only GET/HEAD make sense for article pages.
		if (request.method !== "GET" && request.method !== "HEAD") {
			return fetch(request);
		}

		// Cheap early skip on path: don't even fetch+inspect for known non-article URLs.
		if (shouldSkipPath(url.pathname)) {
			return fetch(request);
		}

		// Fetch upstream (Ghost origin).
		const upstream = await fetch(request);

		// Only attempt to enrich HTML responses with a 2xx status.
		const contentType = upstream.headers.get("content-type") ?? "";
		if (!contentType.toLowerCase().includes("text/html")) {
			return upstream;
		}
		if (upstream.status < 200 || upstream.status >= 300) {
			return upstream;
		}

		// From here on, we attempt enrichment but always fall back gracefully.
		try {
			const html = await upstream.clone().text();

			const pivotMatch = html.match(PIVOT_TAG_REGEX);
			if (!pivotMatch) {
				// No pivot tag → not a translatable article. Pass through.
				return upstream;
			}
			const pivotId = pivotMatch[1];

			const sourceLang: "fr" | "en" = isEnSite ? "en" : "fr";
			const targetLang: "fr" | "en" = isEnSite ? "fr" : "en";

			// Look up the translation on the OTHER blog via the proxy Worker.
			const translation = await lookupTranslation({
				pivotId,
				targetLang,
				proxyUrl: env.API_PROXY_URL,
				proxySecret: env.PROXY_SHARED_SECRET,
				ctx,
			});

			if (!translation) {
				// Pivot tag present but no matching article on the other blog
				// (could be: not published yet, draft, unpublished, or API error).
				// Silent pass-through.
				return upstream;
			}

			// Rewrite the translation URL from the Ghost site URL (en.X.com) to
			// the public subdirectory URL (X.com/en). The Content API returns
			// URLs built from Ghost's configured site URL — we don't change
			// that config, so the rewrite happens here.
			const translationPublicUrl = toPublicTranslationUrl(
				translation.url,
				env.EN_SITE_URL,
				env.EN_PUBLIC_URL,
			);

			// Compute final hreflang URLs. The source URL is the canonical URL
			// of the page the visitor is currently on.
			const sourceUrl = canonicalUrlFor(request.url);
			const frUrl = sourceLang === "fr" ? sourceUrl : translationPublicUrl;
			const enUrl = sourceLang === "en" ? sourceUrl : translationPublicUrl;

			// Build the HTML snippets to inject.
			const headLinks = buildHreflangLinks(frUrl, enUrl);
			const noticeHtml = buildNoticeHtml(sourceLang, translationPublicUrl);

			// Re-emit the response through HTMLRewriter for clean injection.
			// We've buffered the body, so strip content-length (will change) and
			// content-encoding (we decoded by reading .text()).
			const newHeaders = new Headers(upstream.headers);
			newHeaders.delete("content-length");
			newHeaders.delete("content-encoding");

			return new HTMLRewriter()
				.on("head", new HeadInjector(headLinks))
				.on("h1.gh-article-title", new AfterH1Injector(noticeHtml))
				.transform(
					new Response(html, {
						status: upstream.status,
						statusText: upstream.statusText,
						headers: newHeaders,
					}),
				);
		} catch (err) {
			console.error("[ghost-i18n] worker error:", err);
			// Re-fetch since we may have consumed the body via clone().text()
			// — safer than returning the already-read upstream.
			return fetch(request);
		}
	},
} satisfies ExportedHandler<Env>;

// -- Helpers ---------------------------------------------------------------

/**
 * True if the request carries the internal bypass header with the right
 * secret. Used by the subdir-fetcher Worker so its origin pulls don't get
 * 301'd back to themselves.
 */
function isInternalBypass(request: Request, env: Env): boolean {
	const provided = request.headers.get("x-internal-bypass");
	return !!provided && provided === env.INTERNAL_BYPASS_SECRET;
}

/**
 * True if the path should NOT be 301-redirected from en.your-blog.com —
 * functional/internal endpoints (admin, members API, assets, previews).
 *
 * Matches both the prefix (e.g. "/ghost/foo") and the bare segment (e.g.
 * "/ghost", no trailing slash). Without the bare-segment match, a request
 * to en.X.com/ghost would get 301'd, and Ghost's own /ghost → /ghost/
 * redirect would then resolve relative to the wrong URL and land on the
 * FR admin instead of the EN one.
 */
function isRedirectWhitelisted(pathname: string): boolean {
	for (const prefix of REDIRECT_WHITELIST_PREFIXES) {
		if (pathname.startsWith(prefix)) return true;
		// Allow the prefix without its trailing slash as an exact match.
		const bare = prefix.replace(/\/+$/, "");
		if (bare !== "" && pathname === bare) return true;
	}
	return false;
}

/**
 * Build a 301 redirect from the EN subdomain URL to the public subdirectory
 * URL. Preserves path and query string.
 *
 * Example: https://en.your-blog.com/article/?utm=x
 *       → https://your-blog.com/en/article/?utm=x
 */
function redirectToPublicUrl(incoming: URL, publicBase: string): Response {
	const base = publicBase.replace(/\/+$/, "");
	const target = `${base}${incoming.pathname}${incoming.search}`;
	return Response.redirect(target, 301);
}

function shouldSkipPath(pathname: string): boolean {
	// Homepage and pagination of homepage.
	if (pathname === "/" || /^\/page\/\d+\/?$/.test(pathname)) {
		return true;
	}
	for (const prefix of SKIP_PATH_PREFIXES) {
		if (pathname.startsWith(prefix)) {
			return true;
		}
	}
	return false;
}

/**
 * Strip query string and fragment from a URL to get the canonical article URL.
 */
function canonicalUrlFor(rawUrl: string): string {
	const u = new URL(rawUrl);
	u.search = "";
	u.hash = "";
	if (!u.pathname.endsWith("/")) {
		u.pathname += "/";
	}
	return u.toString();
}

function buildHreflangLinks(frUrl: string, enUrl: string): string {
	// x-default ALWAYS points to the FR site (reference language per briefing).
	return (
		`<link rel="alternate" hreflang="fr" href="${escapeAttr(frUrl)}">\n` +
		`<link rel="alternate" hreflang="en" href="${escapeAttr(enUrl)}">\n` +
		`<link rel="alternate" hreflang="x-default" href="${escapeAttr(frUrl)}">`
	);
}

function buildNoticeHtml(sourceLang: "fr" | "en", targetUrl: string): string {
	// Notice text is written in the SOURCE language (the language the reader is in).
	const label =
		sourceLang === "fr"
			? "Lire en anglais"
			: "Read in French";
	return (
		`<p class="gh-translation-notice">` +
		`<a href="${escapeAttr(targetUrl)}">${escapeText(label)}</a>` +
		`</p>`
	);
}

/**
 * Rewrite a translation URL returned by the Content API.
 *
 * The Content API returns post URLs built from Ghost's configured site URL
 * (e.g. `https://en.your-blog.com/<slug>/`). After subdirectory migration,
 * the public URL of the same content is `https://your-blog.com/en/<slug>/`.
 * We rewrite the prefix without changing Ghost's config.
 *
 * If the URL does not start with the site URL (unexpected), it is returned
 * unchanged.
 */
function toPublicTranslationUrl(
	rawUrl: string,
	siteUrl: string,
	publicUrl: string,
): string {
	const trimmedSite = siteUrl.replace(/\/+$/, "");
	const trimmedPublic = publicUrl.replace(/\/+$/, "");
	if (rawUrl.startsWith(trimmedSite)) {
		return trimmedPublic + rawUrl.slice(trimmedSite.length);
	}
	return rawUrl;
}

function escapeAttr(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function escapeText(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Look up a translation on the target blog, with a 5-minute edge cache.
 *
 * Dispatches to the api-proxy Worker over HTTPS (workers.dev) instead of a
 * Service Binding: Service Bindings propagate the calling Worker's zone
 * context, which still hits Cloudflare's same-zone Worker→Worker restriction
 * (the two Ghost blogs share the your-blog.com zone, and the main Worker
 * is on both routes). A real cross-zone HTTPS hop is the only reliable way
 * to escape that restriction.
 */
async function lookupTranslation(params: {
	pivotId: string;
	targetLang: "fr" | "en";
	proxyUrl: string;
	proxySecret: string;
	ctx: ExecutionContext;
}): Promise<Translation | null> {
	const { pivotId, targetLang, proxyUrl, proxySecret, ctx } = params;

	const cacheKeyUrl = `https://i18n-cache.local/${CACHE_VERSION}/${targetLang}/${encodeURIComponent(pivotId)}`;
	const cache = caches.default;
	const cached = await cache.match(cacheKeyUrl);
	if (cached) {
		try {
			const json = (await cached.json()) as Translation | null;
			return json;
		} catch {
			// fall through to refetch on parse error
		}
	}

	const fullProxyUrl =
		`${proxyUrl.replace(/\/+$/, "")}/lookup` +
		`?pivot=${encodeURIComponent(pivotId)}` +
		`&lang=${targetLang}`;

	let result: Translation | null = null;
	try {
		const res = await fetch(fullProxyUrl, {
			method: "GET",
			headers: { "x-proxy-secret": proxySecret },
		});
		if (res.ok) {
			result = (await res.json()) as Translation | null;
		} else {
			console.error(
				`[ghost-i18n] proxy returned ${res.status} for pivot=${pivotId}`,
			);
		}
	} catch (err) {
		console.error("[ghost-i18n] proxy lookup failed:", err);
		// result stays null
	}

	// Cache result for 5 minutes — including misses, so we don't hammer the
	// API for not-yet-published translations.
	const cacheResponse = new Response(JSON.stringify(result), {
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": `public, max-age=${API_CACHE_TTL_SECONDS}`,
		},
	});
	ctx.waitUntil(cache.put(cacheKeyUrl, cacheResponse));

	return result;
}

// -- HTMLRewriter element handlers ----------------------------------------

class HeadInjector {
	constructor(private linksHtml: string) {}

	element(el: Element): void {
		// Append at the end of <head> (just before </head>).
		el.append(`\n${this.linksHtml}\n`, { html: true });
	}
}

class AfterH1Injector {
	private done = false;
	constructor(private noticeHtml: string) {}

	element(el: Element): void {
		// Defensive: only inject after the first h1.gh-article-title.
		if (this.done) return;
		this.done = true;
		el.after(`\n${this.noticeHtml}\n`, { html: true });
	}
}
