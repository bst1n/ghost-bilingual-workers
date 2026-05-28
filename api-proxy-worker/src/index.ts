/**
 * API proxy Worker for ghost-subdir-i18n.
 *
 * Exposed only via Service Binding (not a public HTTP route). The main Worker
 * calls this one to look up a translation on the Ghost Content API — done from
 * here so the fetch() is not subject to Cloudflare's same-zone Worker→Worker
 * restriction (which causes HTTP 500s when the main Worker tries to call
 * en.your-blog.com/ghost/api/... directly).
 *
 * Protocol over the Service Binding (RPC-style fetch):
 *   GET https://proxy/lookup?pivot=<id>&lang=<fr|en>
 *
 * Response body (JSON):
 *   - `{"url": "...", "title": "..."}` if a translation is found
 *   - `null` if no translation exists
 *
 * The proxy NEVER exposes the API key — it only takes the pivot id and target
 * language and selects the appropriate key internally.
 */

interface Env {
	FR_SITE_URL: string;
	EN_SITE_URL: string;
	FR_CONTENT_API_KEY: string;
	EN_CONTENT_API_KEY: string;
	PROXY_SHARED_SECRET: string;
}

interface Translation {
	url: string;
	title: string;
}

const API_TIMEOUT_MS = 3000;

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		// Authenticate: only requests with the shared secret are served.
		const provided = request.headers.get("x-proxy-secret");
		if (!provided || provided !== env.PROXY_SHARED_SECRET) {
			return new Response("forbidden", { status: 403 });
		}

		const url = new URL(request.url);
		if (url.pathname !== "/lookup") {
			return new Response("not found", { status: 404 });
		}

		const pivotId = url.searchParams.get("pivot");
		const lang = url.searchParams.get("lang");

		if (!pivotId || (lang !== "fr" && lang !== "en")) {
			return new Response("bad request: need ?pivot=<id>&lang=<fr|en>", {
				status: 400,
			});
		}

		// Defensive: reject any pivot id with non-slug characters to avoid
		// injection into the API URL.
		if (!/^[a-z0-9][a-z0-9-]*$/i.test(pivotId)) {
			return new Response("bad pivot id", { status: 400 });
		}

		const targetSiteUrl = lang === "fr" ? env.FR_SITE_URL : env.EN_SITE_URL;
		const targetApiKey =
			lang === "fr" ? env.FR_CONTENT_API_KEY : env.EN_CONTENT_API_KEY;

		try {
			const translation = await lookup({
				pivotId,
				siteUrl: targetSiteUrl,
				apiKey: targetApiKey,
			});

			return new Response(JSON.stringify(translation), {
				headers: { "Content-Type": "application/json" },
			});
		} catch (err) {
			console.error("[api-proxy] lookup failed:", err);
			// Even on error, return a null payload — the main Worker will
			// short-circuit to passing the original HTML through.
			return new Response("null", {
				headers: { "Content-Type": "application/json" },
				status: 200,
			});
		}
	},
} satisfies ExportedHandler<Env>;

async function lookup(params: {
	pivotId: string;
	siteUrl: string;
	apiKey: string;
}): Promise<Translation | null> {
	const { pivotId, siteUrl, apiKey } = params;
	const tagSlug = `hash-i18n-${pivotId}`;

	const apiUrl =
		`${siteUrl.replace(/\/+$/, "")}/ghost/api/content/posts/` +
		`?filter=${encodeURIComponent(`tag:${tagSlug}`)}` +
		`&fields=${encodeURIComponent("url,title")}` +
		`&limit=1` +
		`&key=${encodeURIComponent(apiKey)}`;

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

	try {
		const res = await fetch(apiUrl, {
			method: "GET",
			signal: controller.signal,
			headers: {
				"User-Agent": "ghost-i18n-api-proxy/1.0",
				Accept: "application/json",
			},
		});

		if (!res.ok) {
			console.error(`[api-proxy] non-OK status ${res.status} for ${tagSlug}`);
			return null;
		}

		const data = (await res.json()) as {
			posts?: Array<{ url?: string; title?: string }>;
		};
		const post = data.posts?.[0];
		if (post?.url && post.title) {
			return { url: post.url, title: post.title };
		}
		return null;
	} finally {
		clearTimeout(timeoutId);
	}
}
