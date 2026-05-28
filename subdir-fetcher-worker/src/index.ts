/**
 * Fetcher Worker — your-blog pair.
 *
 * Receives a path/method/headers/body from the subdir-proxy Worker (auth via
 * `x-fetcher-secret`), replays it against the Ghost origin
 * (`ORIGIN_URL` = https://en.your-blog.com), then rewrites the response so
 * that all references to `https://en.your-blog.com` become
 * `https://your-blog.com/en`.
 *
 * Lives on workers.dev — outside the your-blog.com zone — so its fetch to
 * the Ghost origin is a cross-zone subrequest and escapes the same-zone
 * Worker→Worker restriction (Cloudflare error 1042).
 *
 * Rewriting scope:
 *   - Response body: substring replace `ORIGIN_URL` → `PUBLIC_URL` for any
 *     content-type we treat as text (HTML / XML / JSON / CSS / JS / plain).
 *     Bypasses binary content (images, fonts, video, ...).
 *   - `Location` header (redirects from Ghost).
 *   - `Set-Cookie` Domain attribute (so cookies survive when the user agent
 *     sees the page as your-blog.com).
 *
 * Failure modes: any error → 502.
 */

interface Env {
	ORIGIN_URL: string;
	PUBLIC_URL: string;
	FETCHER_SHARED_SECRET: string;
	// Shared secret with the i18n Worker on en.your-blog.com/*. When the
	// i18n Worker sees the public 301 redirect (en.X.com → X.com/en) it
	// would otherwise also bounce our own origin fetches — so we pass this
	// secret as `x-internal-bypass` to mark the request as internal.
	INTERNAL_BYPASS_SECRET: string;
}

// Content types whose body we will rewrite. Everything else passes through
// untouched (images, fonts, etc.).
const REWRITABLE_CONTENT_TYPES = [
	"text/html",
	"text/plain",
	"text/css",
	"text/xml",
	"application/xml",
	"application/rss+xml",
	"application/atom+xml",
	"application/json",
	"application/ld+json",
	"application/javascript",
	"text/javascript",
];

// Headers we must NOT forward verbatim from the proxy to the origin
// (hop-by-hop, or set by the runtime).
const HEADERS_TO_DROP_TO_ORIGIN = new Set([
	"host",
	"cf-connecting-ip",
	"cf-ipcountry",
	"cf-ray",
	"cf-visitor",
	"cf-worker",
	"x-fetcher-secret",
	"x-internal-bypass",
	"x-original-host",
	"x-forwarded-host",
	"x-forwarded-proto",
	"content-length",
]);

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		// Auth.
		const provided = request.headers.get("x-fetcher-secret");
		if (!provided || provided !== env.FETCHER_SHARED_SECRET) {
			return new Response("forbidden", { status: 403 });
		}

		const incomingUrl = new URL(request.url);

		// Build origin URL: ORIGIN_URL + path + query.
		const originBase = env.ORIGIN_URL.replace(/\/+$/, "");
		const originTarget = `${originBase}${incomingUrl.pathname}${incomingUrl.search}`;

		// Forward headers minus hop-by-hop ones. Override Host to the origin's
		// host so Ghost recognizes the request.
		const originHeaders = new Headers();
		for (const [name, value] of request.headers.entries()) {
			if (HEADERS_TO_DROP_TO_ORIGIN.has(name.toLowerCase())) continue;
			originHeaders.set(name, value);
		}
		const originHost = new URL(env.ORIGIN_URL).host;
		originHeaders.set("host", originHost);
		// Bypass the public 301 redirect installed on en.X.com/* — see the
		// i18n Worker for the matching read of this header.
		originHeaders.set("x-internal-bypass", env.INTERNAL_BYPASS_SECRET);

		let originResponse: Response;
		try {
			originResponse = await fetch(originTarget, {
				method: request.method,
				headers: originHeaders,
				body:
					request.method === "GET" || request.method === "HEAD"
						? undefined
						: request.body,
				redirect: "manual",
			});
		} catch (err) {
			console.error("[subdir-fetcher] origin fetch failed:", err);
			return new Response("Bad gateway (fetcher)", {
				status: 502,
				headers: { "content-type": "text/plain; charset=utf-8" },
			});
		}

		// Rewrite headers (Location + Set-Cookie). Other headers pass through.
		const outHeaders = rewriteResponseHeaders(
			originResponse.headers,
			env.ORIGIN_URL,
			env.PUBLIC_URL,
		);

		// Decide if we rewrite the body.
		const contentType = (
			originResponse.headers.get("content-type") ?? ""
		).toLowerCase();
		const shouldRewriteBody = REWRITABLE_CONTENT_TYPES.some((t) =>
			contentType.includes(t),
		);

		if (!shouldRewriteBody) {
			// Pass body through untouched. Headers may still have been rewritten.
			return new Response(originResponse.body, {
				status: originResponse.status,
				statusText: originResponse.statusText,
				headers: outHeaders,
			});
		}

		// Buffer body for substring replacement. .text() decodes any
		// content-encoding (gzip/br) automatically — so we must drop
		// content-encoding and content-length from the response we re-emit.
		let body: string;
		try {
			body = await originResponse.text();
		} catch (err) {
			console.error("[subdir-fetcher] body read failed:", err);
			return new Response("Bad gateway (body)", {
				status: 502,
				headers: { "content-type": "text/plain; charset=utf-8" },
			});
		}

		const rewritten = rewriteBody(body, env.ORIGIN_URL, env.PUBLIC_URL);

		outHeaders.delete("content-encoding");
		outHeaders.delete("content-length");

		return new Response(rewritten, {
			status: originResponse.status,
			statusText: originResponse.statusText,
			headers: outHeaders,
		});
	},
} satisfies ExportedHandler<Env>;

// -- Helpers --------------------------------------------------------------

/**
 * Rewrite all occurrences of the origin URL to the public URL inside the body.
 *
 * Covers:
 *   - `https://en.your-blog.com`     → `https://your-blog.com/en`
 *   - `http://en.your-blog.com`      → `https://your-blog.com/en`   (uplift to https)
 *   - `//en.your-blog.com`           → `//your-blog.com/en`         (protocol-relative)
 *   - root-relative attrs `="/foo"`    → `="/en/foo"`   (href/src/action/...)
 *   - bare host `en.your-blog.com`   → left alone (high false-positive risk in content)
 *
 * The bare-host case is intentionally not rewritten: it would touch article
 * text that mentions the domain by name. Acceptable trade-off — the 301 on
 * the old subdomain catches any link that slips through.
 *
 * Root-relative rewriting is required because Ghost themes emit internal
 * post/page links as `href="/<slug>/"` (no host). Without rewriting, the
 * browser would resolve them against `your-blog.com` (no /en prefix) and
 * exit the proxy.
 *
 * The mount path (`/en`) is derived from PUBLIC_URL. If PUBLIC_URL is
 * `https://your-blog.com/en`, the mount path is `/en`. If PUBLIC_URL is
 * `https://your-blog.com` (no subpath), no root-relative rewriting occurs.
 */
function rewriteBody(body: string, originUrl: string, publicUrl: string): string {
	const originHttps = originUrl; // expected: https://en.<...>
	const originHttp = originUrl.replace(/^https:/, "http:");
	const originProtoRel = originUrl.replace(/^https?:/, "");
	const publicHttps = publicUrl;
	const publicProtoRel = publicUrl.replace(/^https?:/, "");

	let out = body
		.split(originHttps).join(publicHttps)
		.split(originHttp).join(publicHttps)
		.split(originProtoRel).join(publicProtoRel);

	// Extract mount path from PUBLIC_URL (e.g. "https://your-blog.com/en" → "/en").
	const mountPath = new URL(publicUrl).pathname.replace(/\/+$/, "");
	if (mountPath !== "") {
		out = rewriteRootRelativeAttrs(out, mountPath);
	}

	return out;
}

/**
 * Prefix root-relative URLs in URL-bearing attributes with the mount path.
 *
 * Matches: `<attr>="/X"` or `<attr>='/X'` where:
 *   - `<attr>` is one of href, src, action, formaction, poster
 *   - the value starts with a single `/`
 *   - the value does NOT start with `//` (protocol-relative — handled elsewhere)
 *   - the value does NOT already start with the mount path
 *
 * srcset is excluded for now: it has comma-separated multi-URL syntax that
 * needs a different parser. Ghost rarely uses root-relative srcset (it emits
 * absolute URLs for responsive images), but if it surfaces we add a dedicated
 * pass.
 */
function rewriteRootRelativeAttrs(body: string, mountPath: string): string {
	// Escape mountPath for safe inclusion in the negative lookahead.
	const escapedMount = mountPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	// Match: (attr)("|')(/) where / is not followed by / or by the mount path.
	// Capture quote char so we restore it.
	const re = new RegExp(
		`\\b(href|src|action|formaction|poster)=(["'])/(?!/|${escapedMount}/|${escapedMount}["'])`,
		"g",
	);
	return body.replace(re, `$1=$2${mountPath}/`);
}

/**
 * Rewrite response headers:
 *   - Location: substitute origin URL with public URL.
 *   - Set-Cookie: strip Domain attribute (or rewrite to bare public host).
 *
 * All other headers pass through.
 */
function rewriteResponseHeaders(
	src: Headers,
	originUrl: string,
	publicUrl: string,
): Headers {
	const out = new Headers();
	const originHost = new URL(originUrl).host;
	const publicHost = new URL(publicUrl).host;

	for (const [name, value] of src.entries()) {
		const lname = name.toLowerCase();
		if (lname === "location") {
			out.set(
				name,
				value
					.replace(originUrl, publicUrl)
					.replace(originUrl.replace(/^https:/, "http:"), publicUrl),
			);
		} else if (lname === "set-cookie") {
			out.append(name, rewriteSetCookie(value, originHost, publicHost));
		} else {
			out.append(name, value);
		}
	}
	return out;
}

/**
 * Rewrite the Domain= attribute of a Set-Cookie value.
 *
 * If Domain is set to the origin host (e.g. `en.your-blog.com` or
 * `.en.your-blog.com`), we drop it. A cookie with no Domain attribute
 * defaults to the request's host (the public host as the browser sees it),
 * which is what we want.
 *
 * If Domain is set to something else (3rd-party cookie? misconfig?), we
 * leave it alone.
 */
function rewriteSetCookie(
	cookieValue: string,
	originHost: string,
	_publicHost: string,
): string {
	// Match Domain attribute (case-insensitive, optional leading dot).
	const domainRegex = /;\s*Domain=\.?([^;]+)/i;
	const match = cookieValue.match(domainRegex);
	if (!match) return cookieValue;

	const cookieDomain = match[1].trim().toLowerCase();
	if (cookieDomain === originHost.toLowerCase()) {
		// Drop the whole Domain attribute — cookie will default to public host.
		return cookieValue.replace(domainRegex, "");
	}
	return cookieValue;
}
