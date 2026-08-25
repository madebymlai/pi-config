/**
 * web_search — Exa neural search.
 *
 * Exa ranks over its own index by meaning rather than keywords, so queries
 * should describe the ideal page ("blog post benchmarking X against Y") rather
 * than list search terms. Google's operator syntax — quoted phrases, -term,
 * site: — has no effect here, so the tool exposes Exa's structured filters
 * instead of composing an operator string.
 *
 * Cost: $0.007 per search, flat. Measured at count 1 and count 10 — both
 * billed the same, with highlights included. The $1/1k-pages content charge on
 * Exa's pricing page is for the standalone /contents endpoint, not for
 * `contents` requested inline here. So `count` is bounded by how much context
 * the results consume, not by spend. The figure Exa reports per call is
 * surfaced in the result anyway, so a pricing change shows up rather than
 * accumulating silently.
 *
 * Credentials: EXA_API_KEY, or `exa_api_key` in auth.json beside this file.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";

const EXA_ENDPOINT = "https://api.exa.ai/search";
const DEFAULT_COUNT = 8;
const MAX_COUNT = 25;

/**
 * Exa's six documented categories, each backed by its own curated index
 * (company pages, people, scholarly publications, news, personal sites, SEC
 * filings). `publication` is the one for research papers, preprints and
 * journal articles.
 *
 * Validated here because the API does NOT validate it: an unrecognised
 * category is silently accepted and the search runs unfiltered, with no error
 * and full billing. This list is the only thing that turns a typo into a
 * visible failure rather than quietly worse results.
 */
const CATEGORIES = [
	"company",
	"people",
	"publication",
	"news",
	"personal site",
	"financial report",
] as const;

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
	publishedDate?: string;
}

interface SearchArgs {
	query?: string;
	includeDomains?: string[];
	excludeDomains?: string[];
	category?: string;
	count?: number;
}

interface BuiltSearch {
	query: string;
	includeDomains: string[];
	excludeDomains: string[];
	category?: string;
}

const EXT_DIR = path.dirname(new URL(import.meta.url).pathname);
const AUTH_PATH = path.join(EXT_DIR, "auth.json");

function loadApiKey(): string | null {
	const fromEnv = process.env.EXA_API_KEY;
	if (fromEnv) return fromEnv;

	if (!fs.existsSync(AUTH_PATH)) return null;
	try {
		const config = JSON.parse(fs.readFileSync(AUTH_PATH, "utf-8"));
		const key = config.exa_api_key as string;
		if (key) return key;
	} catch {}
	return null;
}

/**
 * Reduce "https://example.com/docs/" and "site:example.com" alike to a bare
 * hostname. Exa matches subdomains, so whatever host survives here also covers
 * everything beneath it.
 */
function normalizeDomain(value: string): string | undefined {
	let domain = value.trim().replace(/^site:/i, "").trim();
	if (!domain) return undefined;

	try {
		const candidate = /^[a-z]+:\/\//i.test(domain) ? domain : `https://${domain}`;
		const url = new URL(candidate);
		if (url.hostname) domain = url.hostname;
	} catch {}

	return domain.replace(/\/+$/, "") || undefined;
}

function cleanDomains(values?: string[]): string[] {
	if (!values) return [];
	return values.map(normalizeDomain).filter((d): d is string => Boolean(d));
}

function buildSearch(args: SearchArgs): BuiltSearch {
	const query = args.query?.trim().replace(/\s+/g, " ");
	if (!query) throw new Error("'query' is required.");

	const category = args.category?.trim().toLowerCase();
	if (category && !(CATEGORIES as readonly string[]).includes(category)) {
		throw new Error(
			`Unknown category "${category}". Expected one of: ${CATEGORIES.join(", ")}.`,
		);
	}

	return {
		query,
		includeDomains: cleanDomains(args.includeDomains),
		excludeDomains: cleanDomains(args.excludeDomains),
		category,
	};
}

async function exaSearch(
	built: BuiltSearch,
	count: number,
	apiKey: string,
	signal?: AbortSignal,
): Promise<{ results: SearchResult[]; cost?: number }> {
	const body: Record<string, unknown> = {
		query: built.query,
		type: "fast",
		numResults: Math.min(count, MAX_COUNT),
		// Highlights give the model enough to choose which URLs are worth a
		// web_fetch. Full text is deliberately not requested: web_fetch already
		// extracts it locally for free, for only the pages actually chosen.
		contents: { highlights: true },
	};
	if (built.includeDomains.length > 0) body.includeDomains = built.includeDomains;
	if (built.excludeDomains.length > 0) body.excludeDomains = built.excludeDomains;
	if (built.category) body.category = built.category;

	const resp = await fetch(EXA_ENDPOINT, {
		method: "POST",
		headers: { "x-api-key": apiKey, "content-type": "application/json" },
		body: JSON.stringify(body),
		signal,
	});

	if (!resp.ok) {
		const text = await resp.text();
		throw new Error(`Exa API ${resp.status}: ${text.slice(0, 200)}`);
	}

	const data = (await resp.json()) as {
		results?: Array<{
			title?: string;
			url: string;
			highlights?: string[];
			publishedDate?: string;
		}>;
		costDollars?: { total?: number };
	};

	const results = (data.results ?? []).map((item) => ({
		title: item.title?.trim() || item.url,
		url: item.url,
		snippet: (item.highlights ?? []).join(" … ").replace(/\s+/g, " ").trim(),
		publishedDate: item.publishedDate,
	}));

	return { results, cost: data.costDollars?.total };
}

function formatResults(results: SearchResult[]): string {
	if (results.length === 0) return "No results found.";
	return results
		.map((r, i) => {
			const date = r.publishedDate ? ` (${r.publishedDate.slice(0, 10)})` : "";
			return `${i + 1}. ${r.title}${date}\n   ${r.url}\n   ${r.snippet}`;
		})
		.join("\n\n");
}

function formatCost(cost?: number): string {
	return cost === undefined ? "" : `$${cost.toFixed(4)}`;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web via Exa, which ranks by meaning over its own index. Describe the ideal page in the query rather than listing keywords. Optionally restrict or exclude domains, or filter to a content category. Returns title, URL, publication date, and a relevance snippet.",
		promptSnippet:
			"Search the web by describing the ideal page, with optional domain filters and a content category. Use one tool call per search angle.",
		promptGuidelines: [
			"Write the query as a description of the page you want ('blog post comparing X and Y performance'), not as keywords. This is a neural index, so Google operators such as quotes, minus signs, and site: do nothing.",
			"Use one web_search tool call per search angle instead of batching multiple searches into one call.",
			"Prefer the category filter over wording the query to imply a source type. It is a hard filter, not a hint: the same query under 'publication' returns only journals, under 'company' only vendor sites.",
			"Do not combine category with includeDomains. Some categories back onto their own curated index and reject domain restrictions outright, so pick one or the other.",
			"Results are not billed individually, but they do consume context. Raise count when a search needs breadth; lower it when only the top hit matters.",
		],

		parameters: Type.Object({
			query: Type.String({
				description:
					"Description of the ideal page, in natural language. Prefer 'in-depth guide to X configuration' over 'X config'.",
			}),
			includeDomains: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Restrict results to these domains. Subdomains are included, so 'example.com' also matches docs.example.com; pass the bare domain rather than a specific host to cover a whole site.",
				}),
			),
			excludeDomains: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Drop results from these domains. Subdomains are included, so 'example.com' also drops m.example.com.",
				}),
			),
			category: Type.Optional(
				Type.Union(
					CATEGORIES.map((c) => Type.Literal(c)),
					{
						description:
							"Restrict to a kind of page: 'publication' for papers, preprints and journal articles, 'news' for reporting, 'company' for vendor pages, 'people' for profiles, 'financial report' for SEC filings.",
					},
				),
			),
			count: Type.Optional(
				Type.Number({
					description: `Number of results (default: ${DEFAULT_COUNT}, max: ${MAX_COUNT}). Costs the same at any value; the tradeoff is context size.`,
					minimum: 1,
					maximum: MAX_COUNT,
				}),
			),
		}),

		async execute(_toolCallId, params: SearchArgs, signal) {
			const apiKey = loadApiKey();
			if (!apiKey) {
				throw new Error(
					`Missing Exa API key. Set EXA_API_KEY, or create ${AUTH_PATH} from auth.example.json. Get a key from https://dashboard.exa.ai`,
				);
			}

			const count = params.count ?? DEFAULT_COUNT;
			const built = buildSearch(params);
			const { results, cost } = await exaSearch(built, count, apiKey, signal);

			return {
				content: [{ type: "text" as const, text: formatResults(results) }],
				details: {
					query: built.query,
					includeDomains: built.includeDomains,
					excludeDomains: built.excludeDomains,
					category: built.category,
					resultCount: results.length,
					cost,
				},
			};
		},

		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const { count, ...searchArgs } = args as SearchArgs;

			try {
				const built = buildSearch(searchArgs);
				const display =
					built.query.length > 70 ? built.query.slice(0, 67) + "..." : built.query;
				const lines = [
					theme.fg("toolTitle", theme.bold("search ")) +
						theme.fg("accent", `"${display}"`),
				];

				const filters = [
					built.category ? `category: ${built.category}` : "",
					built.includeDomains.length > 0 ? `only: ${built.includeDomains.join(", ")}` : "",
					built.excludeDomains.length > 0 ? `not: ${built.excludeDomains.join(", ")}` : "",
					count && count !== DEFAULT_COUNT ? `count: ${count}` : "",
				].filter(Boolean);
				if (filters.length > 0) lines.push(theme.fg("dim", `  ${filters.join(" · ")}`));

				text.setText(lines.join("\n"));
				return text;
			} catch {
				text.setText(
					theme.fg("toolTitle", theme.bold("search ")) +
						theme.fg("error", "(invalid query)"),
				);
				return text;
			}
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);

			if (isPartial) {
				text.setText(theme.fg("warning", "Searching…"));
				return text;
			}

			if (context.isError) {
				const msg = result.content.find((c) => c.type === "text")?.text || "Error";
				text.setText(theme.fg("error", msg));
				return text;
			}

			const details = result.details as {
				query?: string;
				resultCount?: number;
				cost?: number;
			};
			const spend = formatCost(details?.cost);
			const status =
				theme.fg("success", `${details?.resultCount ?? 0} results`) +
				(spend ? theme.fg("dim", `  ${spend}`) : "");

			if (!expanded) {
				text.setText(status);
				return text;
			}

			const content = result.content.find((c) => c.type === "text")?.text || "";
			const preview = content.length > 500 ? content.slice(0, 500) + "..." : content;
			const queryLine = details?.query ? theme.fg("dim", `query: ${details.query}`) : "";
			text.setText([status, queryLine, theme.fg("dim", preview)].filter(Boolean).join("\n"));
			return text;
		},
	});
}
