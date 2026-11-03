import { afterEach, describe, expect, it } from "bun:test";
import {
	type BuildHost,
	fetchBuild,
	isMuslLinuxForTest,
	parseBuildAnswer,
	resolveBuildHost,
} from "@oh-my-pi/pi-coding-agent/cli/build-service";
import { VERSION } from "@oh-my-pi/pi-utils";

const fileName = "omp-darwin-arm64";
const sha = (text: string) => Bun.SHA256.hash(text, "hex");

/** A well-formed `latest` answer, with `overrides` merged over the top level. */
function answer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		build: { id: "20261011-120000-abcdef0", version: "18.8.9", channel: "stable" },
		file: { name: fileName, platform: "macos", arch: "arm64", kind: "binary", size: 205_765_664, sha256: sha("new") },
		download: "https://r2.test/omp/18.8.9/omp-darwin-arm64?X-Amz-Signature=x",
		patch: {
			format: "file",
			from: "20261001-120000-1234567",
			from_sha256: sha("old"),
			size: 6_700_636,
			sha256: sha("patch"),
			url: "https://r2.test/patches/p?X-Amz-Signature=y",
		},
		...overrides,
	};
}

describe("build service answers", () => {
	it("keeps a complete file patch and the version the check named as installed", () => {
		const parsed = parseBuildAnswer(answer(), fileName, "18.8.8");

		expect(parsed).toEqual({
			version: "18.8.9",
			file: { name: fileName, size: 205_765_664, sha256: sha("new") },
			download: "https://r2.test/omp/18.8.9/omp-darwin-arm64?X-Amz-Signature=x",
			patch: {
				fromSha256: sha("old"),
				fromVersion: "18.8.8",
				size: 6_700_636,
				sha256: sha("patch"),
				url: "https://r2.test/patches/p?X-Amz-Signature=y",
			},
		});
	});

	it("rejects answers that cannot be installed safely", () => {
		const file = (fields: Record<string, unknown>) => ({ file: { ...(answer().file as object), ...fields } });
		expect(() => parseBuildAnswer(answer(file({ sha256: sha("new").toUpperCase() })), fileName)).toThrow(
			"invalid sha256",
		);
		expect(() => parseBuildAnswer(answer(file({ sha256: "abc" })), fileName)).toThrow("invalid sha256");
		expect(() => parseBuildAnswer(answer(file({ size: 0 })), fileName)).toThrow("invalid size");
		expect(() => parseBuildAnswer(answer(file({ name: "omp-darwin-x64" })), fileName)).toThrow(
			"omp-darwin-x64 is not omp-darwin-arm64",
		);
		expect(() => parseBuildAnswer(answer({ download: "http://r2.test/omp" }), fileName)).toThrow("no HTTPS download");
		expect(() => parseBuildAnswer(answer({ build: { version: "latest" } }), fileName)).toThrow("no valid version");
	});

	it("installs the whole file when the patch is incomplete or not a file patch", () => {
		const { url: _url, ...withoutUrl } = answer().patch as Record<string, unknown>;
		expect(parseBuildAnswer(answer({ patch: withoutUrl }), fileName).patch).toBeUndefined();
		expect(
			parseBuildAnswer(answer({ patch: { ...(answer().patch as object), format: "tree" } }), fileName).patch,
		).toBeUndefined();
		expect(
			parseBuildAnswer(answer({ patch: { ...(answer().patch as object), url: "http://r2.test/p" } }), fileName)
				.patch,
		).toBeUndefined();
	});
});

describe("build service targets", () => {
	it("maps platform, architecture, and libc to the service target and release file name", () => {
		expect(resolveBuildHost("darwin", "arm64", false)).toEqual({
			target: "macos-arm64",
			fileName: "omp-darwin-arm64",
		});
		expect(resolveBuildHost("linux", "x64", true)).toEqual({
			target: "linux-musl-x86_64",
			fileName: "omp-linux-musl-x64",
		});
		expect(resolveBuildHost("linux", "arm64", false)).toEqual({
			target: "linux-arm64",
			fileName: "omp-linux-arm64",
		});
		expect(resolveBuildHost("win32", "x64", false)).toEqual({
			target: "windows-x86_64",
			fileName: "omp-windows-x64.exe",
		});
	});

	it("does not mistake an installed musl loader for a glibc host", () => {
		expect(
			isMuslLinuxForTest({
				platform: "linux",
				alpineRelease: false,
				lddOutput: "ldd (Ubuntu GLIBC 2.39-0ubuntu8.7) 2.39",
			}),
		).toBe(false);
	});

	it("recognizes a musl host from ldd output", () => {
		expect(
			isMuslLinuxForTest({
				platform: "linux",
				alpineRelease: false,
				lddOutput: "musl libc (x86_64)",
			}),
		).toBe(true);
	});
});

describe("fetchBuild", () => {
	const host: BuildHost = { target: "macos-arm64", fileName };
	const previousUrl = process.env.PI_BUILD_URL;
	const checksum = sha("fork release binary");
	const release = (tag: string, flags: Record<string, unknown> = {}) => ({
		tag_name: tag,
		draft: false,
		prerelease: false,
		...flags,
		assets: [
			{ name: fileName, size: 1234, browser_download_url: `https://release.test/${tag}/${fileName}` },
			{
				name: "SHA256SUMS.txt",
				size: 80,
				browser_download_url: `https://release.test/${tag}/SHA256SUMS.txt`,
			},
		],
	});
	const fetchReleases =
		(releases: unknown[], sumsText = `${checksum}  ${fileName}\n`) =>
		async (input: string | URL | Request) => {
			const url = String(input);
			if (url.endsWith("/releases?per_page=100")) return Response.json(releases);
			if (url.endsWith("/SHA256SUMS.txt")) return new Response(sumsText);
			throw new Error(`Unexpected request ${url}`);
		};

	afterEach(() => {
		if (previousUrl === undefined) delete process.env.PI_BUILD_URL;
		else process.env.PI_BUILD_URL = previousUrl;
	});

	it("uses the fork's stable GitHub release and requires its checksum asset", async () => {
		delete process.env.PI_BUILD_URL;
		const requests: string[] = [];
		const build = await fetchBuild(
			{ channel: "stable" },
			{
				host,
				fetchImpl: async input => {
					requests.push(String(input));
					return fetchReleases([release("v18.9.0", { prerelease: true }), release("v18.8.9")])(
						input as string | URL | Request,
					);
				},
			},
		);

		expect(requests[0]).toBe("https://api.github.com/repos/pngocthach/oh-my-pi/releases?per_page=100");
		expect(build).toEqual({
			version: "18.8.9",
			file: { name: fileName, size: 1234, sha256: checksum },
			download: `https://release.test/v18.8.9/${fileName}`,
			patch: undefined,
		});
	});

	it("selects the newest canary and supports exact versions", async () => {
		process.env.PI_BUILD_URL = "https://github.test/repos/pngocthach/oh-my-pi";
		const fetchImpl = fetchReleases([release("v18.9.0-canary.1", { prerelease: true }), release("v18.8.9")]);
		const canary = await fetchBuild({ channel: "canary" }, { host, fetchImpl });
		const exact = await fetchBuild({ version: "18.8.9" }, { host, fetchImpl });
		expect(canary.version).toBe("18.9.0-canary.1");
		expect(exact.version).toBe("18.8.9");
	});

	it("rejects a release without this platform's binary or a valid matching checksum", async () => {
		await expect(
			fetchBuild(
				{ channel: "stable" },
				{ host, fetchImpl: fetchReleases([{ ...release("v18.8.9"), assets: [] }]) },
			),
		).rejects.toThrow("missing omp-darwin-arm64 or SHA256SUMS.txt");
		await expect(
			fetchBuild(
				{ channel: "stable" },
				{ host, fetchImpl: fetchReleases([release("v18.8.9")], `${sha("another binary")}  omp-darwin-x64\n`) },
			),
		).rejects.toThrow("no valid checksum for omp-darwin-arm64");
	});

	it("does not fall back to an upstream release when the fork has none", async () => {
		await expect(fetchBuild({ channel: "stable" }, { host, fetchImpl: fetchReleases([]) })).rejects.toThrow(
			"published by pngocthach/oh-my-pi",
		);
	});

	it("rejects an upstream repository endpoint even when configured", async () => {
		process.env.PI_BUILD_URL = "https://api.github.com/repos/can1357/oh-my-pi";
		await expect(fetchBuild({ channel: "stable" }, { host, fetchImpl: fetchReleases([]) })).rejects.toThrow(
			"Standalone releases must come from pngocthach/oh-my-pi",
		);
	});
});
