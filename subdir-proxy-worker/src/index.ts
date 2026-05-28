/**
 * Subdirectory proxy Worker — your-blog pair.
 *
 * Attached to route `your-blog.com/en/*`. For each incoming request:
 *   1. Strip the `/en` prefix from the path.
 *   2. Forward the request to the fetcher Worker (over HTTPS, on workers.dev),
 *      passing the stripped path + original method/body/headers.
 *   3. Return the fetcher's response unchanged.
 *
 * The fetcher Worker is the one that talks to the Ghost origin
 * (en.your-blog.com) and does body/header rewriting. This Worker is only a
 * thin "route adapter" — it exists because the public URL must be on the
 * your-blog.com zone, but a fetch to en.your-blog.com from this zone
 * trips Cloudflare's same-zone Worker→Worker restriction (error 1042).
 *
 * Failure modes:
 *   - On any error contacting the fetcher, returns 502 with a short body.
 *     We never silently fall through to anything else — there is no upstream
 *     to fall back to from this side.
 */

interface Env {
	FETCHER_URL: string;
	FETCHER_SHARED_SECRET: string;
}

// Edge cache TTL for proxied responses (seconds). Tunable — short enough that
// new content surfaces quickly, long enough to amortize the fetcher hop for
// recurring visitors at the same Cloudflare PoP.
const CACHE_TTL_SECONDS = 300; // 5 min

// Paths we never cache — functional / dynamic endpoints. After /en is
// stripped, these are the upstream paths to skip.
const SKIP_CACHE_PATH_PREFIXES = [
	"/members/", // Portal & Members API
	"/ghost/", // admin + Content API (Content API has its own cache layer)
	"/p/", // preview pages
];

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// Strip the /en prefix. Routes guarantee we're on /en/*, but be defensive.
		let path = url.pathname;
		if (path === "/en" || path === "/en/") {
			path = "/";
		} else if (path.startsWith("/en/")) {
			path = path.slice(3); // remove "/en", keep leading "/"
		} else {
			// Should not happen given the route, but pass through to root.
			path = "/";
		}

		// Decide whether this request is cacheable.
		const cacheable = isCacheable(request, path);
		const cache = caches.default;
		// Cache key uses the public URL (the route we're attached to), which is
		// unique per article — no collision with other Workers.
		const cacheKey = new Request(request.url, { method: "GET" });

		// Try cache first.
		if (cacheable) {
			const cached = await cache.match(cacheKey);
			if (cached) {
				// Tag the response so we can see cache hits in DevTools / curl.
				const headers = new Headers(cached.headers);
				headers.set("x-subdir-cache", "HIT");
				return new Response(cached.body, {
					status: cached.status,
					statusText: cached.statusText,
					headers,
				});
			}
		}

		// Build the fetcher URL: <FETCHER_URL><path>?<original query>
		const fetcherBase = env.FETCHER_URL.replace(/\/+$/, "");
		const fetcherTarget = `${fetcherBase}${path}${url.search}`;

		// Forward method, headers, body. Headers passed as-is (the fetcher will
		// decide what to forward to origin); we add the auth secret.
		const fwdHeaders = new Headers(request.headers);
		fwdHeaders.set("x-fetcher-secret", env.FETCHER_SHARED_SECRET);
		// Preserve the original Host so the fetcher can build correct absolute
		// URLs when rewriting (and so any logging is meaningful).
		fwdHeaders.set("x-original-host", url.host);

		let fetcherResponse: Response;
		try {
			fetcherResponse = await fetch(fetcherTarget, {
				method: request.method,
				headers: fwdHeaders,
				body:
					request.method === "GET" || request.method === "HEAD"
						? undefined
						: request.body,
				redirect: "manual",
			});
		} catch (err) {
			console.error("[subdir-proxy] fetcher call failed:", err);
			return new Response("Bad gateway (subdir proxy)", {
				status: 502,
				headers: { "content-type": "text/plain; charset=utf-8" },
			});
		}

		// Store cacheable successful responses in the edge cache.
		if (cacheable && shouldCacheResponse(fetcherResponse)) {
			// Build a cache copy with our TTL — overrides whatever Ghost set.
			const cacheCopy = new Response(fetcherResponse.clone().body, {
				status: fetcherResponse.status,
				statusText: fetcherResponse.statusText,
				headers: new Headers(fetcherResponse.headers),
			});
			cacheCopy.headers.set(
				"cache-control",
				`public, s-maxage=${CACHE_TTL_SECONDS}`,
			);
			// Browser doesn't need to know we cache at the edge — strip its
			// cache-control hint and let it stay default.
			ctx.waitUntil(cache.put(cacheKey, cacheCopy));
		}

		// Tag MISS for observability.
		const outHeaders = new Headers(fetcherResponse.headers);
		outHeaders.set("x-subdir-cache", cacheable ? "MISS" : "BYPASS");
		return new Response(fetcherResponse.body, {
			status: fetcherResponse.status,
			statusText: fetcherResponse.statusText,
			headers: outHeaders,
		});
	},
} satisfies ExportedHandler<Env>;

// -- Helpers --------------------------------------------------------------

/**
 * A request is cacheable when:
 *   - method is GET
 *   - no cookies (logged-in visitors should get live content)
 *   - upstream path is not on the skip list
 */
function isCacheable(request: Request, upstreamPath: string): boolean {
	if (request.method !== "GET") return false;
	if (request.headers.get("cookie")) return false;
	for (const prefix of SKIP_CACHE_PATH_PREFIXES) {
		if (upstreamPath.startsWith(prefix)) return false;
	}
	return true;
}

/**
 * A response is cacheable when:
 *   - status is 200
 *   - it doesn't set cookies (those would be personalized)
 */
function shouldCacheResponse(response: Response): boolean {
	if (response.status !== 200) return false;
	if (response.headers.get("set-cookie")) return false;
	return true;
}
