/**
 * Standalone binaries come only from pngocthach/oh-my-pi. Stable selects the
 * newest non-prerelease; canary selects the newest published release (including
 * prereleases). Only the first 100 GitHub releases are considered. A release
 * is installable only when it has the expected platform binary and a
 * SHA256SUMS.txt entry for that exact asset. GitHub releases provide whole
 * binaries only; this updater does not offer delta patches.
 */
import * as fs from "node:fs";
import { $env, APP_NAME, isRecord, VERSION } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import {
	isTimeoutError,
	isUnsupportedProxyError,
	unsupportedProxyMessage,
	withTimeoutSignal,
} from "../utils/fetch-timeout";

export type UpdateChannel = "stable" | "canary";

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** GitHub release API endpoint used when `PI_BUILD_URL` is unset. */
export const DEFAULT_BUILD_URL = "https://api.github.com/repos/pngocthach/oh-my-pi";

const BUILD_CHECK_TIMEOUT_MS = 30_000;

/** Fork's release API endpoint: `PI_BUILD_URL` when set, else {@link DEFAULT_BUILD_URL}. */
export function buildServiceUrl(): string {
	const configured = ($env.PI_BUILD_URL ?? "").trim().replace(/\/+$/, "");
	return configured || DEFAULT_BUILD_URL;
}

/** Where this host's published standalone release binary lives. */
export interface BuildHost {
	/** Host target, e.g. `macos-arm64` or `linux-musl-x86_64`. */
	target: string;
	/** Name of the release asset (e.g. `omp-darwin-arm64`). */
	fileName: string;
}

/** The build service target and file name for a platform, architecture, and libc. */
export function resolveBuildHost(platform: NodeJS.Platform, arch: string, musl: boolean): BuildHost {
	let targetOs: string;
	let fileOs: string;
	switch (platform) {
		case "darwin":
			targetOs = "macos";
			fileOs = "darwin";
			break;
		case "linux":
			targetOs = musl ? "linux-musl" : "linux";
			fileOs = targetOs;
			break;
		case "win32":
			targetOs = "windows";
			fileOs = "windows";
			break;
		default:
			throw new Error(`Unsupported platform: ${platform}`);
	}
	let targetArch: string;
	switch (arch) {
		case "x64":
			targetArch = "x86_64";
			break;
		case "arm64":
			targetArch = "arm64";
			break;
		default:
			throw new Error(`Unsupported architecture: ${arch}`);
	}
	return {
		target: `${targetOs}-${targetArch}`,
		fileName: `${APP_NAME}-${fileOs}-${arch}${platform === "win32" ? ".exe" : ""}`,
	};
}

/**
 * Detect a musl-libc Linux host (Alpine, Void-musl) so self-update replaces a
 * musl binary with the musl build instead of the glibc one, which would fail
 * to start on the next run. The loader file alone is not sufficient: glibc
 * hosts may have musl installed for cross-compilation.
 */
interface MuslDetectionOptions {
	platform: NodeJS.Platform;
	alpineRelease: boolean;
	lddOutput: string;
}

function isMuslLinux(options: MuslDetectionOptions): boolean {
	if (options.platform !== "linux") return false;
	return options.alpineRelease || /\bmusl\b/i.test(options.lddOutput);
}

/** Test seam for libc detection. */
export function isMuslLinuxForTest(options: MuslDetectionOptions): boolean {
	return isMuslLinux(options);
}

async function detectLddOutput(): Promise<string> {
	try {
		const result = await $`ldd --version`.quiet().nothrow();
		return `${result.stdout.toString("utf-8")}\n${result.stderr.toString("utf-8")}`;
	} catch {
		return "";
	}
}

let currentHost: Promise<BuildHost> | undefined;

/** This host's {@link BuildHost}, detected once per process. */
export function currentBuildHost(): Promise<BuildHost> {
	currentHost ??= (async () => {
		const platform = process.platform;
		const musl =
			platform === "linux" &&
			isMuslLinux({
				platform,
				alpineRelease: fs.existsSync("/etc/alpine-release"),
				lddOutput: await detectLddOutput(),
			});
		return resolveBuildHost(platform, process.arch, musl);
	})();
	return currentHost;
}

/** The answered build's file for this host. */
export interface BuildFile {
	name: string;
	size: number;
	/** Lowercase hex SHA-256. */
	sha256: string;
}

/** HDiffPatch single-stream patch (`HDIFFSF20`) from an installed file to {@link BuildFile}. */
export interface BuildPatch {
	/** Lowercase hex SHA-256 of the file the patch applies to. */
	fromSha256: string;
	/** Version the check named as installed (`from_version`), for progress output. */
	fromVersion?: string;
	size: number;
	/** Lowercase hex SHA-256 of the patch itself. */
	sha256: string;
	/** Presigned HTTPS URL of the patch. */
	url: string;
}

/** A checked build service answer. */
export interface BuildAnswer {
	version: string;
	file: BuildFile;
	/** Presigned HTTPS URL of the whole file, valid for minutes. */
	download: string;
	patch?: BuildPatch;
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function isSize(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isSha256(value: unknown): value is string {
	return typeof value === "string" && SHA256_HEX.test(value);
}

function isHttpsUrl(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		return new URL(value).protocol === "https:";
	} catch {
		return false;
	}
}

/** The answer's patch when it is a complete `file` patch; anything else installs the whole file. */
function parseBuildPatch(patch: unknown, fromVersion: string | undefined): BuildPatch | undefined {
	if (!isRecord(patch) || patch.format !== "file") return undefined;
	if (!isSha256(patch.from_sha256) || !isSize(patch.size) || !isSha256(patch.sha256) || !isHttpsUrl(patch.url)) {
		return undefined;
	}
	return { fromSha256: patch.from_sha256, fromVersion, size: patch.size, sha256: patch.sha256, url: patch.url };
}

/**
 * Check a build service answer for the file named `fileName`.
 *
 * Throws when the answer cannot be installed safely: a version that is not
 * semver, a file other than `fileName`, a size or SHA-256 that is not exact,
 * or a download that is not HTTPS. A `patch` is kept only when it is a
 * complete `format: "file"` patch; any other patch is dropped, not an error.
 * `fromVersion` is the `from_version` the check sent.
 */
export function parseBuildAnswer(body: unknown, fileName: string, fromVersion?: string): BuildAnswer {
	if (!isRecord(body) || !isRecord(body.build)) throw new Error("answer has no build");
	const version = body.build.version;
	if (typeof version !== "string" || !SEMVER.test(version)) throw new Error("build has no valid version");
	const file = body.file;
	if (!isRecord(file)) throw new Error("answer has no file");
	if (file.name !== fileName) throw new Error(`answered file ${String(file.name)} is not ${fileName}`);
	if (!isSize(file.size)) throw new Error(`${fileName} has an invalid size`);
	if (!isSha256(file.sha256)) throw new Error(`${fileName} has an invalid sha256`);
	if (!isHttpsUrl(body.download)) throw new Error(`${fileName} has no HTTPS download`);
	return {
		version,
		file: { name: fileName, size: file.size, sha256: file.sha256 },
		download: body.download,
		patch: parseBuildPatch(body.patch, fromVersion),
	};
}

/** Which build to ask for: the newest on a channel, or one exact version. */
export type BuildSelector = { channel: UpdateChannel } | { version: string };

export interface FetchBuildOptions {
	/** Retained for caller compatibility; GitHub releases provide no delta patches. */
	fromVersion?: string;
	timeoutMs?: number;
	fetchImpl?: Fetch;
	/** Defaults to {@link currentBuildHost}. */
	host?: BuildHost;
}

/** Ask the fork's GitHub releases for this host's checked standalone binary. */
export async function fetchBuild(selector: BuildSelector, options: FetchBuildOptions = {}): Promise<BuildAnswer> {
	const host = options.host ?? (await currentBuildHost());
	const origin = buildServiceUrl();
	const timeoutMs = options.timeoutMs ?? BUILD_CHECK_TIMEOUT_MS;
	const fetchImpl = options.fetchImpl ?? fetch;
	const what = `${APP_NAME} ${"channel" in selector ? `${selector.channel} build` : `build ${selector.version}`} for ${host.target}`;
	const signal = withTimeoutSignal(timeoutMs);
	const headers = { Accept: "application/vnd.github+json", "User-Agent": `${APP_NAME}/${VERSION}` };
	const mapError = (err: unknown): unknown => {
		if (isTimeoutError(err)) {
			return new Error(`Timed out asking ${origin} for the ${what} after ${Math.round(timeoutMs / 1000)}s`, {
				cause: err,
			});
		}
		if (isUnsupportedProxyError(err)) return new Error(unsupportedProxyMessage(), { cause: err });
		return err;
	};

	const repositoryPath = new URL(DEFAULT_BUILD_URL).pathname;
	if (new URL(origin).pathname !== repositoryPath) {
		throw new Error(`Standalone releases must come from pngocthach/oh-my-pi; invalid release endpoint ${origin}`);
	}

	let releasesResponse: Response;
	let releases: unknown;
	try {
		const url = new URL(`${origin}/releases`);
		url.searchParams.set("per_page", "100");
		releasesResponse = await fetchImpl(url, { headers, signal });
		releases = await releasesResponse.json();
	} catch (err) {
		throw mapError(err);
	}
	if (!releasesResponse.ok) {
		throw new Error(`${origin} answered ${releasesResponse.status} ${releasesResponse.statusText} for the ${what}`);
	}
	if (!Array.isArray(releases)) throw new Error(`Invalid GitHub release list from ${origin}`);

	const validReleases = releases.filter(
		(release): release is Record<string, unknown> =>
			isRecord(release) && release.draft !== true && typeof release.tag_name === "string",
	);
	const release =
		"version" in selector
			? validReleases.find(item => item.tag_name === selector.version || item.tag_name === `v${selector.version}`)
			: validReleases.find(item => selector.channel === "canary" || item.prerelease !== true);
	if (!release) throw new Error(`No ${what} is published by pngocthach/oh-my-pi yet.`);
	const tag = release.tag_name as string;
	const version = tag.startsWith("v") ? tag.slice(1) : tag;
	if (!SEMVER.test(version)) throw new Error(`Invalid release tag ${tag} from ${origin}`);
	if (!Array.isArray(release.assets)) throw new Error(`Release ${tag} from ${origin} has no assets`);
	const assets = release.assets.filter(
		(asset): asset is Record<string, unknown> => isRecord(asset) && typeof asset.name === "string",
	);
	const binary = assets.find(asset => asset.name === host.fileName);
	const sums = assets.find(asset => asset.name === "SHA256SUMS.txt");
	if (
		!binary ||
		!sums ||
		!isSize(binary.size) ||
		!isHttpsUrl(binary.browser_download_url) ||
		!isHttpsUrl(sums.browser_download_url)
	) {
		throw new Error(`Release ${tag} from pngocthach/oh-my-pi is missing ${host.fileName} or SHA256SUMS.txt`);
	}

	let sumsResponse: Response;
	let sumsText: string;
	try {
		sumsResponse = await fetchImpl(sums.browser_download_url, {
			headers: { Accept: "text/plain", "User-Agent": `${APP_NAME}/${VERSION}` },
			signal,
		});
		sumsText = await sumsResponse.text();
	} catch (err) {
		throw mapError(err);
	}
	if (!sumsResponse.ok) {
		throw new Error(`Could not read SHA256SUMS.txt for release ${tag}: ${sumsResponse.status} ${sumsResponse.statusText}`);
	}
	const escapedName = host.fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const checksum = new RegExp(`^([0-9a-f]{64}) [ *]${escapedName}$`, "m").exec(sumsText)?.[1];
	if (!checksum) throw new Error(`SHA256SUMS.txt for release ${tag} has no valid checksum for ${host.fileName}`);
	return {
		version,
		file: { name: host.fileName, size: binary.size, sha256: checksum },
		download: binary.browser_download_url,
		patch: undefined,
	};
}
