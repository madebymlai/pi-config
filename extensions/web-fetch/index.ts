import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { Defuddle } from "defuddle/node";

const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_RESPONSE_SIZE = 5 * 1024 * 1024;
const MAX_PDF_SIZE = 20 * 1024 * 1024;
const MIN_USEFUL_CONTENT = 500;

/**
 * Upper bound on what reaches the model. The HTTP limits above bound the
 * download; this bounds the context. A long man page or changelog extracts to
 * a quarter of a million characters — roughly 60k tokens from a single tool
 * call — which is a bigger problem than any extraction-quality difference.
 * 48 KiB matches the allowance the subagent extension used for the same job.
 */
const MAX_OUTPUT_CHARS = 48 * 1024;
/**
 * Room reserved for the continuation marker, whose length depends on the very
 * offsets it reports. Reserving a fixed slice avoids that circularity at the
 * cost of a few unused bytes.
 */
const MARKER_BUDGET = 160;

// ── Types ────────────────────────────────────────────────────────────

interface FetchResult {
	url: string;
	title: string;
	content: string;
	error: string | null;
}

// ── PDF Extraction ───────────────────────────────────────────────────

function isPDF(url: string, contentType?: string): boolean {
	if (contentType?.includes("application/pdf")) return true;
	try {
		return new URL(url).pathname.toLowerCase().endsWith(".pdf");
	} catch {
		return false;
	}
}

async function extractPDF(
	buffer: ArrayBuffer,
	url: string,
): Promise<FetchResult> {
	const { getDocumentProxy } = await import("unpdf");
	const pdf = await getDocumentProxy(new Uint8Array(buffer));

	const metadata = await pdf.getMetadata();
	const metadataInfo =
		metadata.info && typeof metadata.info === "object"
			? (metadata.info as Record<string, unknown>)
			: null;

	const metaTitle =
		typeof metadataInfo?.Title === "string"
			? metadataInfo.Title.trim()
			: "";
	const metaAuthor =
		typeof metadataInfo?.Author === "string"
			? metadataInfo.Author.trim()
			: "";

	let urlTitle = "document";
	try {
		const { basename } = await import("node:path");
		urlTitle =
			basename(new URL(url).pathname, ".pdf")
				.replace(/[_-]+/g, " ")
				.trim() || "document";
	} catch {
		/* ignore */
	}
	const title = metaTitle || urlTitle;

	const maxPages = Math.min(pdf.numPages, 100);
	const pages: string[] = [];
	for (let i = 1; i <= maxPages; i++) {
		const page = await pdf.getPage(i);
		const textContent = await page.getTextContent();
		const pageText = textContent.items
			.map((item: unknown) => (item as { str?: string }).str || "")
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();
		if (pageText) pages.push(pageText);
	}

	const lines: string[] = [
		`# ${title}`,
		"",
		`> Source: ${url}`,
		`> Pages: ${pdf.numPages}${pdf.numPages > maxPages ? ` (extracted first ${maxPages})` : ""}`,
	];
	if (metaAuthor) lines.push(`> Author: ${metaAuthor}`);
	lines.push("", "---", "");
	lines.push(pages.join("\n\n"));

	if (pdf.numPages > maxPages) {
		lines.push(
			"",
			"---",
			"",
			`*[Truncated: Only first ${maxPages} of ${pdf.numPages} pages extracted]*`,
		);
	}

	return { url, title, content: lines.join("\n"), error: null };
}

// ── Helpers ──────────────────────────────────────────────────────────

function isLikelyJSRendered(html: string): boolean {
	const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
	if (!bodyMatch) return false;
	const textContent = bodyMatch[1]
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, "")
		.replace(/\s+/g, " ")
		.trim();
	const scriptCount = (html.match(/<script/gi) || []).length;
	return textContent.length < 500 && scriptCount > 3;
}

function extractHeadingTitle(text: string): string | null {
	const match = text.match(/^#{1,2}\s+(.+)/m);
	if (!match) return null;
	const cleaned = match[1].replace(/\*+/g, "").trim();
	return cleaned || null;
}

// ── Main HTTP Extraction ─────────────────────────────────────────────

async function fetchAndExtract(
	url: string,
	signal?: AbortSignal,
): Promise<FetchResult> {
	try {
		new URL(url);
	} catch {
		return { url, title: "", content: "", error: "Invalid URL" };
	}

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort);

	try {
		const response = await fetch(url, {
			signal: controller.signal,
			headers: {
				"User-Agent": USER_AGENT,
				Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
				"Accept-Language": "en-US,en;q=0.9",
				"Cache-Control": "no-cache",
				"Sec-Fetch-Dest": "document",
				"Sec-Fetch-Mode": "navigate",
				"Sec-Fetch-Site": "none",
				"Sec-Fetch-User": "?1",
				"Upgrade-Insecure-Requests": "1",
			},
		});

		if (!response.ok) {
			return {
				url, title: "", content: "",
				error: `HTTP ${response.status}: ${response.statusText}`,
			};
		}

		const contentType = response.headers.get("content-type") || "";
		const contentLengthHeader = response.headers.get("content-length");
		const isPDFContent = isPDF(url, contentType);
		const maxSize = isPDFContent ? MAX_PDF_SIZE : MAX_RESPONSE_SIZE;

		if (contentLengthHeader) {
			const contentLength = parseInt(contentLengthHeader, 10);
			if (contentLength > maxSize) {
				return {
					url, title: "", content: "",
					error: `Response too large (${Math.round(contentLength / 1024 / 1024)}MB)`,
				};
			}
		}

		if (isPDFContent) {
			const buffer = await response.arrayBuffer();
			return await extractPDF(buffer, url);
		}

		if (
			contentType.includes("application/octet-stream") ||
			contentType.includes("image/") ||
			contentType.includes("audio/") ||
			contentType.includes("video/") ||
			contentType.includes("application/zip")
		) {
			return {
				url, title: "", content: "",
				error: `Unsupported content type: ${contentType.split(";")[0]}`,
			};
		}

		const text = await response.text();
		const isHTML =
			contentType.includes("text/html") ||
			contentType.includes("application/xhtml+xml");

		if (!isHTML) {
			const title =
				extractHeadingTitle(text) ??
				new URL(url).pathname.split("/").pop() ??
				url;
			return { url, title, content: text, error: null };
		}

		// Defuddle emits markdown directly, so no HTML→markdown step follows.
		const article = await Defuddle(text, url, { markdown: true });
		const extracted = article?.content ?? "";

		if (extracted.length < MIN_USEFUL_CONTENT) {
			const why = isLikelyJSRendered(text)
				? "Page appears to be JavaScript-rendered (content loads dynamically)"
				: "Could not extract readable content from this page";
			return {
				url,
				title: article?.title || "",
				content: extracted,
				error: `${why}\n\nTry a different URL for the same content, or web_search for an alternative source.`,
			};
		}

		return {
			url,
			title: article?.title || "",
			content: extracted,
			error: null,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { url, title: "", content: "", error: message };
	} finally {
		clearTimeout(timeoutId);
		signal?.removeEventListener("abort", onAbort);
	}
}

// ── Extension Registration ───────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch a web page and extract readable content as clean markdown. Handles HTML, PDFs, and plain text. Output is capped; a longer page reports the offset to continue from, so the rest can be read with follow-up calls.",
		promptSnippet:
			"Fetch a URL and extract readable content as markdown. Supports HTML pages, PDFs, and plain text.",

		promptGuidelines: [
			`Output is capped at ${MAX_OUTPUT_CHARS} characters. When a page is longer the result says so and reports the offset to continue from — read the next window with the same url and that offset, rather than refetching from the start.`,
			"Only page through a document when the part you need is genuinely further in. A more specific URL, or a search for the section, is usually cheaper than reading a long page end to end.",
		],

		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch" }),
			offset: Type.Optional(
				Type.Number({
					description:
						"Character offset to start from, for reading past the output cap. Use the offset reported by a previous truncated fetch. Defaults to 0.",
					minimum: 0,
				}),
			),
		}),

		async execute(_toolCallId, params, signal) {
			const result = await fetchAndExtract(params.url, signal);

			if (result.error) {
				throw new Error(`${params.url}: ${result.error}`);
			}

			const header = result.title
				? `# ${result.title}\n\nSource: ${result.url}\n\n---\n\n`
				: "";
			const body = header + result.content;
			const total = body.length;
			const requested = Math.max(0, params.offset ?? 0);
			const start = Math.min(requested, total);

			if (start >= total && total > 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `[nothing to read at offset ${requested}: this document is ${total} characters]`,
						},
					],
					details: { url: result.url, title: result.title, chars: total, offset: start, returned: 0, hasMore: false },
				};
			}

			const fits = total - start <= MAX_OUTPUT_CHARS;
			const end = fits ? total : start + MAX_OUTPUT_CHARS - MARKER_BUDGET;
			const hasMore = end < total;
			const marker = hasMore
				? `\n\n[truncated: showing characters ${start}-${end} of ${total}. Continue with the same url and offset: ${end}]`
				: "";

			return {
				content: [{ type: "text" as const, text: body.slice(start, end) + marker }],
				details: {
					url: result.url,
					title: result.title,
					chars: total,
					offset: start,
					returned: end - start,
					hasMore,
				},
			};
		},

		renderCall(args, theme, context) {
			const text =
				(context.lastComponent as Text | undefined) ??
				new Text("", 0, 0);
			const { url } = args as { url?: string };
			if (!url) {
				text.setText(
					theme.fg("toolTitle", theme.bold("fetch ")) +
						theme.fg("error", "(no URL)"),
				);
				return text;
			}
			const display =
				url.length > 70 ? url.slice(0, 67) + "..." : url;
			text.setText(
				theme.fg("toolTitle", theme.bold("fetch ")) +
					theme.fg("accent", display),
			);
			return text;
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			const text =
				(context.lastComponent as Text | undefined) ??
				new Text("", 0, 0);

			if (isPartial) {
				text.setText(theme.fg("warning", "Fetching…"));
				return text;
			}

			if (context.isError) {
				const msg =
					result.content.find((c) => c.type === "text")?.text ||
					"Error";
				text.setText(theme.fg("error", msg));
				return text;
			}

			const details = result.details as {
				title?: string;
				chars?: number;
				offset?: number;
				returned?: number;
				hasMore?: boolean;
			};

			const title = details?.title || "Untitled";
			const chars = details?.chars ?? 0;
			const offset = details?.offset ?? 0;
			const returned = details?.returned ?? chars;
			const window =
				details?.hasMore || offset > 0
					? ` (${offset}-${offset + returned} of ${chars} chars)`
					: ` (${chars} chars)`;
			const status =
				theme.fg("success", title) +
				theme.fg("muted", window) +
				(details?.hasMore ? theme.fg("warning", " more available") : "");

			if (!expanded) {
				text.setText(status);
				return text;
			}

			const content =
				result.content.find((c) => c.type === "text")?.text || "";
			const preview =
				content.length > 500
					? content.slice(0, 500) + "..."
					: content;
			text.setText(status + "\n" + theme.fg("dim", preview));
			return text;
		},
	});
}
