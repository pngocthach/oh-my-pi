import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import diff from "highlight.js/lib/languages/diff";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdownLanguage from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { Marked } from "marked";
import type { MouseEvent, ReactNode } from "react";
import { memo, useCallback, useMemo } from "react";

const REGISTERED_LANGUAGES = [
	["bash", bash],
	["diff", diff],
	["javascript", javascript],
	["json", json],
	["markdown", markdownLanguage],
	["python", python],
	["sql", sql],
	["typescript", typescript],
	["xml", xml],
	["yaml", yaml],
] as const;

for (const [name, language] of REGISTERED_LANGUAGES) hljs.registerLanguage(name, language);
hljs.registerAliases(["sh", "shell", "zsh"], { languageName: "bash" });
hljs.registerAliases(["js", "jsx", "mjs", "cjs"], { languageName: "javascript" });
hljs.registerAliases(["ts", "tsx", "mts", "cts"], { languageName: "typescript" });
hljs.registerAliases(["html", "svg"], { languageName: "xml" });
hljs.registerAliases(["yml"], { languageName: "yaml" });
hljs.registerAliases(["md", "mdx"], { languageName: "markdown" });

const LANGUAGE_ALIASES = new Map<string, string>([
	["sh", "bash"],
	["shell", "bash"],
	["zsh", "bash"],
	["js", "javascript"],
	["jsx", "javascript"],
	["mjs", "javascript"],
	["cjs", "javascript"],
	["ts", "typescript"],
	["tsx", "typescript"],
	["mts", "typescript"],
	["cts", "typescript"],
	["html", "xml"],
	["svg", "xml"],
	["yml", "yaml"],
	["md", "markdown"],
	["mdx", "markdown"],
]);

interface RenderedMarkdown {
	html: string;
	copies: Map<string, string>;
}

function escapeHtml(s: string): string {
	return s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}
function unescapeHtml(raw: string): string {
	const parseCodePoint = (value: number): string => {
		if (Number.isFinite(value) && value >= 0 && value <= 0x10ffff) {
			try {
				return String.fromCodePoint(value);
			} catch {}
		}
		return "";
	};

	return raw.replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-fA-F]+);/gi, (match, entity) => {
		const lower = entity.toLowerCase();
		switch (lower) {
			case "nbsp":
				return " ";
			case "lt":
				return "<";
			case "gt":
				return ">";
			case "quot":
				return '"';
			case "apos":
				return "'";
			case "amp":
				return "&";
			default: {
				if (lower.startsWith("#x")) {
					return parseCodePoint(Number.parseInt(lower.slice(2), 16));
				}
				if (lower.startsWith("#")) {
					return parseCodePoint(Number(lower.slice(1)));
				}
				return match;
			}
		}
	});
}
function safeHref(href: string): string | null {
	const trimmed = href.trim();
	if (/^(?:https?:|mailto:)/i.test(trimmed)) return trimmed;
	if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null; // unknown scheme (javascript:, data:, …)
	return trimmed; // relative / fragment
}

function normalizeFenceLanguage(raw: string | null | undefined): string | null {
	const token = raw?.trim().split(/\s+/, 1)[0]?.toLowerCase();
	if (!token) return null;
	const language = LANGUAGE_ALIASES.get(token) ?? token;
	return hljs.getLanguage(language) ? language : null;
}

function highlightCodeBlock(code: string, rawLang: string | null | undefined): string {
	const language = normalizeFenceLanguage(rawLang);
	if (language) {
		try {
			return hljs.highlight(code, { language, ignoreIllegals: true }).value;
		} catch {}
	}
	try {
		const auto = hljs.highlightAuto(code);
		if (auto.language) return auto.value;
	} catch {}
	return escapeHtml(code);
}

function renderCodeBlockHtml(code: string, rawLang: string | null | undefined, copyId: string): string {
	return [
		'<div class="tr-code-block">',
		`<button type="button" class="tr-code-copy" data-copy-id="${copyId}" title="copy code">Copy</button>`,
		`<pre><code class="hljs">${highlightCodeBlock(code, rawLang)}</code></pre>`,
		"</div>",
	].join("");
}

export async function copyMarkdownCode(text: string): Promise<boolean> {
	const clipboard = navigator.clipboard;
	if (!clipboard || typeof clipboard.writeText !== "function") return false;
	try {
		await clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
}

function renderMarkdownHtml(text: string): RenderedMarkdown {
	const copies = new Map<string, string>();
	let copySeq = 0;
	const md = new Marked({
		gfm: true,
		renderer: {
			// Raw HTML tokens (block + inline both arrive here) are escaped, never emitted.
			html({ text }) {
				const cleaned = text.replace(/<\/?(?:advisory|span|text)\b(?:\s[^>]*)?\s*\/?>/gi, "");
				if (cleaned === "") return "";
				return escapeHtml(unescapeHtml(cleaned));
			},
			link({ href, title, tokens }) {
				const inner = this.parser.parseInline(tokens);
				const url = safeHref(href);
				if (url === null) return inner;
				const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
				return `<a href="${escapeHtml(url)}"${titleAttr} target="_blank" rel="noopener">${inner}</a>`;
			},
			code({ text, lang }) {
				const copyId = `code-${copySeq++}`;
				copies.set(copyId, text);
				return renderCodeBlockHtml(text, lang, copyId);
			},
		},
		breaks: true,
	});
	try {
		return { html: md.parse(text, { async: false }), copies };
	} catch {
		return { html: escapeHtml(text), copies: new Map() };
	}
}

export const Markdown = memo(function Markdown({ text }: { text: string }): ReactNode {
	const rendered = useMemo(() => renderMarkdownHtml(text), [text]);

	const onClick = useCallback(
		async (event: MouseEvent<HTMLDivElement>) => {
			const target = event.target;
			if (!(target instanceof Element)) return;
			const button = target.closest("button[data-copy-id]");
			if (!(button instanceof HTMLButtonElement)) return;
			event.preventDefault();
			const copyId = button.dataset.copyId;
			if (!copyId) return;
			const code = rendered.copies.get(copyId);
			if (code === undefined) return;
			await copyMarkdownCode(code);
		},
		[rendered],
	);

	return <div className="tr-md" dangerouslySetInnerHTML={{ __html: rendered.html }} onClick={onClick} />;
});
