import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Minimal fake Pi harness. It records provider registrations and the event
 * handlers the extension subscribes to, which is enough to exercise the
 * catalog/credential lifecycle at the integration boundary rather than only
 * through pure helpers.
 */
interface RegisteredProvider {
	id: string;
	models: { id: string }[];
}

interface FakePi {
	providers: RegisteredProvider[];
	handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
	registerProvider: (id: string, config: { models: { id: string }[] }) => void;
	on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
	registerCommand: () => void;
	registerShortcut: () => void;
	registerEntryRenderer: () => void;
}

function fingerprint(key: string): string {
	return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

function apiModel(id: string) {
	return {
		id,
		max_model_len: 131_072,
		metadata: {
			display_name: id,
			pricing: {
				input_per_million: 0.4,
				output_per_million: 3,
				cached_input_per_million: 0.2,
				cached_output_per_million: 0.2,
			},
			capabilities: { reasoning: true, reasoning_effort: true },
			limits: { max_context_length: 131_072, max_output_tokens: 65_536 },
		},
	};
}

function cachedModel(id: string) {
	return {
		id,
		name: id,
		reasoning: true,
		input: ["text"],
		cost: { input: 0.4, output: 3, cacheRead: 0.2, cacheWrite: 0.2 },
		contextWindow: 131_072,
		maxTokens: 65_536,
		compat: { maxTokensField: "max_tokens" },
	};
}

let agentDir: string;

beforeEach(async () => {
	agentDir = await mkdtemp(join(tmpdir(), "neuralwatt-it-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.NEURALWATT_API_KEY;
	delete process.env.PI_OFFLINE;
	delete process.env.NEURALWATT_USD_PER_KWH;
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
	delete process.env.PI_CODING_AGENT_DIR;
});

async function writeForeignAuthenticatedCache(): Promise<void> {
	await mkdir(join(agentDir, "cache"), { recursive: true });
	await writeFile(
		join(agentDir, "cache", "neuralwatt-models.json"),
		JSON.stringify({
			version: 2,
			fetchedAt: new Date().toISOString(),
			authenticated: true,
			credentialFingerprint: fingerprint("old-account-key"),
			models: [cachedModel("private-old")],
		}),
	);
}

async function writeCache(version: unknown, ids: string[]): Promise<void> {
	await mkdir(join(agentDir, "cache"), { recursive: true });
	await writeFile(
		join(agentDir, "cache", "neuralwatt-models.json"),
		JSON.stringify({
			version,
			fetchedAt: new Date().toISOString(),
			authenticated: false,
			models: ids.map(cachedModel),
		}),
	);
}

/** auth.json with a shell/env template, so startup resolution cannot use it. */
async function writeTemplatedAuth(): Promise<void> {
	await writeFile(
		join(agentDir, "auth.json"),
		JSON.stringify({
			neuralwatt: { type: "api_key", key: "$NEURALWATT_API_KEY_FROM_SHELL" },
		}),
	);
}

function fakePi(): FakePi {
	const providers: RegisteredProvider[] = [];
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	return {
		providers,
		handlers,
		registerProvider: (id, config) => {
			providers.push({ id, models: config.models });
		},
		on: (event, handler) => {
			handlers.set(event, handler);
		},
		registerCommand: () => {},
		registerShortcut: () => {},
		registerEntryRenderer: () => {},
	};
}

function stubCatalogFetch(
	resolve: (apiKey: string | undefined) => { scope: string; ids: string[] },
): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			const auth = (init?.headers as Record<string, string> | undefined)
				?.Authorization;
			const apiKey = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
			if (!url.endsWith("/models")) {
				return new Response("not found", { status: 404 });
			}
			const { scope, ids } = resolve(apiKey);
			return new Response(JSON.stringify({ scope, data: ids.map(apiModel) }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}),
	);
}

function lastModels(pi: FakePi): string[] {
	return pi.providers.at(-1)?.models.map((model) => model.id) ?? [];
}

async function loadExtension(pi: FakePi): Promise<void> {
	const extension = (await import("../index.ts")).default;
	await extension(pi as never);
}

describe("catalog/credential lifecycle", () => {
	it("registers the public catalog when a foreign authenticated cache is discarded", async () => {
		await writeForeignAuthenticatedCache();
		await writeTemplatedAuth();
		stubCatalogFetch(() => ({ scope: "public", ids: ["public-model"] }));

		const pi = fakePi();
		await loadExtension(pi);

		expect(lastModels(pi)).toContain("public-model");
	});

	it("refreshes with the registry key after discarding a stale authenticated cache", async () => {
		await writeForeignAuthenticatedCache();
		await writeTemplatedAuth();
		stubCatalogFetch(() => ({ scope: "public", ids: ["public-model"] }));

		const pi = fakePi();
		await loadExtension(pi);

		// Session start resolves a real key from the registry, which must not be
		// suppressed by the stale authenticated cache's freshness.
		stubCatalogFetch((apiKey) =>
			apiKey === "registry-key"
				? { scope: "customer", ids: ["private-registry"] }
				: { scope: "public", ids: ["public-model"] },
		);
		const ctx = {
			hasUI: false,
			model: undefined,
			modelRegistry: {
				getApiKeyForProvider: async () => "registry-key",
			},
			sessionManager: { getBranch: () => [] },
			ui: { setStatus: () => {}, notify: () => {} },
			signal: undefined,
		};
		await pi.handlers.get("session_start")?.({ reason: "startup" }, ctx);
		await vi.waitFor(() => {
			expect(lastModels(pi)).toContain("private-registry");
		});
	});

	it("ignores a cache written by an unknown schema version", async () => {
		await writeCache(1, ["stale-model"]);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("network down");
			}),
		);

		const pi = fakePi();
		await loadExtension(pi);

		expect(lastModels(pi)).toEqual([]);
	});

	it("uses a current-version cache offline", async () => {
		await writeCache(2, ["cached-model"]);
		process.env.PI_OFFLINE = "yes";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("offline");
			}),
		);

		const pi = fakePi();
		await loadExtension(pi);

		expect(lastModels(pi)).toContain("cached-model");
	});
});
