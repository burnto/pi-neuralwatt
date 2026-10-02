import {
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type FetchFunction,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	type AccountingMethod,
	EQUIVALENTS,
	ENERGY_COST_ENTRY_TYPE,
	type EnergyCostEntry,
	type EnergyPayload,
	type EquivalentId,
	type CostPayload,
	addEntryToTotals,
	emptyTotals,
	formatEquivalentDetail,
	formatJoules,
	formatStatusText,
	formatUsd,
	formatWh,
	isEnergyCostEntry,
	isFinitePositiveNumber,
	isNeuralwattChatCompletionsUrl,
	isThemeColorName,
	lastEntryFromEntries,
	makeEntry,
	mapModelsResponse,
	parseCommentPayload,
	parseSettings,
	resolveChargedCost,
	THEME_COLORS,
	totalsFromEntries,
	withChargedCost,
	type CatalogFetchResult,
	type NeuralwattModelConfig,
	type NeuralwattSettings,
	type StreamEnergyRecord,
	type Totals,
} from "./lib.ts";

const BASE_URL = "https://api.neuralwatt.com/v1";
const PACKAGE_TITLE = "pi-neuralwatt";
const MODELS_CACHE_PATH = join(
	getAgentDir(),
	"cache",
	"neuralwatt-models.json",
);
const SETTINGS_PATH = join(getAgentDir(), "neuralwatt.json");
const STATUS_KEY = "neuralwatt-energy";
const ENERGY_MARK = "\u26A1\uFE0E"; // ⚡︎ forced text presentation.
const FETCH_TIMEOUT_MS = 15_000;
const RECORD_WAIT_MS = 300;
const MAX_PENDING_RECORDS = 16;
const MAX_RECORD_AGE_MS = 60_000;

type AnyStreamSimple = (
	model: Model<string>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

interface ModelsCacheFile {
	version?: unknown;
	fetchedAt?: unknown;
	authenticated?: unknown;
	models?: unknown;
}

export interface CachedCatalog {
	models: NeuralwattModelConfig[];
	authenticated: boolean;
}

interface QuotaResponse {
	balance?: {
		accounting_method?: string;
	};
}

interface CapturedRecord {
	record: StreamEnergyRecord;
	responseId?: string;
	capturedAt: number;
}

function combineSignals(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
	return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

async function neuralwattFetch(
	path: string,
	apiKey?: string,
	signal?: AbortSignal,
): Promise<Response> {
	const headers: Record<string, string> = {
		Referer: "https://pi.dev",
		"X-Title": PACKAGE_TITLE,
	};
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
	return fetch(`${BASE_URL}${path}`, {
		headers,
		signal: combineSignals(signal),
	});
}

async function readCachedModels(): Promise<CachedCatalog> {
	try {
		const parsed = JSON.parse(
			await readFile(MODELS_CACHE_PATH, "utf8"),
		) as ModelsCacheFile;
		const models = Array.isArray(parsed.models)
			? (parsed.models as NeuralwattModelConfig[])
			: [];
		return { models, authenticated: parsed.authenticated === true };
	} catch {
		return { models: [], authenticated: false };
	}
}

async function writeCachedModels(
	models: NeuralwattModelConfig[],
	authenticated: boolean,
): Promise<void> {
	try {
		await mkdir(dirname(MODELS_CACHE_PATH), { recursive: true });
		await writeFile(
			MODELS_CACHE_PATH,
			`${JSON.stringify({ version: 1, fetchedAt: new Date().toISOString(), authenticated, models }, null, 2)}\n`,
			"utf8",
		);
	} catch {
		// Cache writes are best-effort. A missing cache only affects offline startup.
	}
}

async function readSettingsFile(): Promise<NeuralwattSettings> {
	try {
		return parseSettings(JSON.parse(await readFile(SETTINGS_PATH, "utf8")));
	} catch {
		return parseSettings(undefined);
	}
}

async function writeSettingsFile(settings: NeuralwattSettings): Promise<void> {
	try {
		await mkdir(dirname(SETTINGS_PATH), { recursive: true });
		await writeFile(
			SETTINGS_PATH,
			`${JSON.stringify(settings, null, 2)}\n`,
			"utf8",
		);
	} catch {
		// Settings writes are best-effort; the in-memory copy still applies.
	}
}

function isOfflineMode(): boolean {
	return process.env.PI_OFFLINE === "1" || process.env.PI_OFFLINE === "true";
}

function currentRateUsdPerKwh(settings: NeuralwattSettings): number {
	const envRate = Number(process.env.NEURALWATT_USD_PER_KWH);
	return isFinitePositiveNumber(envRate) ? envRate : settings.fallbackRateUsdPerKwh;
}

/*
 * Best-effort startup key resolution. Pi's registry only becomes reachable
 * once a session context exists, but headless --model resolution happens
 * before session_start, so the authenticated catalog (with enrolled preview
 * models) must be fetchable at extension-load time. Mirrors pi's documented
 * key sources for this provider: NEURALWATT_API_KEY first, then a plain
 * api_key entry in auth.json. $-templated (env/shell-command) keys and every
 * error path degrade to the public catalog; the session-start refresh with
 * the registry-resolved key then upgrades.
 */
async function resolveStartupApiKey(): Promise<string | undefined> {
	if (process.env.NEURALWATT_API_KEY) return process.env.NEURALWATT_API_KEY;
	try {
		const parsed = JSON.parse(
			await readFile(join(getAgentDir(), "auth.json"), "utf8"),
		) as Record<string, { type?: unknown; key?: unknown } | undefined>;
		const credential = parsed?.neuralwatt;
		if (credential?.type !== "api_key" || typeof credential.key !== "string")
			return undefined;
		return credential.key.includes("$") ? undefined : credential.key;
	} catch {
		return undefined;
	}
}

async function fetchModels(apiKey?: string): Promise<CatalogFetchResult> {
	const response = await neuralwattFetch("/models", apiKey);
	if (!response.ok)
		throw new Error(`/v1/models returned HTTP ${response.status}`);
	const catalog = mapModelsResponse(await response.json());
	if (catalog.models.length === 0)
		throw new Error("/v1/models returned no usable models");
	return catalog;
}

function registerProvider(
	pi: ExtensionAPI,
	models: NeuralwattModelConfig[],
	onRecord: (record: StreamEnergyRecord, responseId?: string) => void,
): void {
	const provider = getApiProvider("openai-completions");
	const baseStreamSimple = provider?.streamSimple as AnyStreamSimple | undefined;
	pi.registerProvider("neuralwatt", {
		name: "Neuralwatt",
		baseUrl: BASE_URL,
		apiKey: "$NEURALWATT_API_KEY",
		api: "openai-completions",
		authHeader: true,
		headers: {
			Referer: "https://pi.dev",
			"X-Title": PACKAGE_TITLE,
		},
		models,
		...(baseStreamSimple
			? {
					streamSimple: wrapNeuralwattStreamSimple(baseStreamSimple, onRecord),
				}
			: {}),
	});
}

/*
 * Reads the response body alongside the provider SDK and returns the
 * completion id plus any energy/cost SSE comments. Neuralwatt sends metadata
 * as `: energy {...}` / `: cost {...}` comment lines, which the SDK drops.
 */
async function readSseMetadata(
	stream: ReadableStream<Uint8Array>,
	onComment: (line: string) => void,
): Promise<string | undefined> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let responseId: string | undefined;
	const handleLine = (line: string) => {
		if (!responseId && line.startsWith("data:")) {
			const payload = line.slice(5).trim();
			if (payload && payload !== "[DONE]") {
				try {
					const parsed = JSON.parse(payload) as { id?: unknown };
					if (typeof parsed.id === "string" && parsed.id) {
						responseId = parsed.id;
					}
				} catch {
					// Partial or non-JSON data lines are not interesting here.
				}
			}
		}
		if (line.startsWith(":")) onComment(line.slice(1).trim());
	};
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split(/\r?\n/);
			buffer = lines.pop() ?? "";
			for (const line of lines) handleLine(line);
		}
		buffer += decoder.decode();
		if (buffer) handleLine(buffer);
	} finally {
		reader.releaseLock();
	}
	return responseId;
}

function forwardStream(
	stream: AssistantMessageEventStream,
	outer: AssistantMessageEventStream,
	finalize: () => Promise<void>,
): void {
	void (async () => {
		try {
			for await (const event of stream) outer.push(event);
		} finally {
			await finalize().catch(() => undefined);
			try {
				outer.end();
			} catch {
				// The outer stream can already be closed on abort.
			}
		}
	})();
}

/*
 * Wraps the provider stream to tee out Neuralwatt's SSE metadata. The tee is
 * scoped through `options.fetch` rather than a global fetch patch, so
 * concurrent requests from other providers or sessions are unaffected. The
 * captured record is matched to the finalized assistant message by its
 * completion id, which keeps pi's cache-warm requests (collected with
 * `.result()` and no message_end) from being counted against a real response.
 */
function wrapNeuralwattStreamSimple(
	base: AnyStreamSimple,
	onRecord: (record: StreamEnergyRecord, responseId?: string) => void,
): AnyStreamSimple {
	return (model, context, options = {}) => {
		const outer = createAssistantMessageEventStream();
		let providerOrigin: string | undefined;
		try {
			providerOrigin = new URL(model.baseUrl ?? BASE_URL).origin;
		} catch {
			// Unparseable baseUrl must not break streaming; energy sniffing is skipped.
		}
		const baseFetch = (options.fetch ?? globalThis.fetch) as FetchFunction;
		let energy: EnergyPayload | undefined;
		let cost: CostPayload | undefined;
		let metadataTask: Promise<string | undefined> | undefined;

		const wrappedFetch: FetchFunction = async (input, init) => {
			const response = await baseFetch(input, init);
			if (!isNeuralwattChatCompletionsUrl(input, providerOrigin)) return response;
			if (!response.ok || !response.body) return response;

			const [sdkBody, metadataBody] = response.body.tee();
			metadataTask = readSseMetadata(metadataBody, (line) => {
				const parsed = parseCommentPayload(line);
				if (!parsed) return;
				if (parsed.kind === "energy") energy = parsed.value as EnergyPayload;
				if (parsed.kind === "cost") cost = parsed.value as CostPayload;
			});
			return new Response(sdkBody, {
				headers: response.headers,
				status: response.status,
				statusText: response.statusText,
			});
		};

		const stream = base(model, context, { ...options, fetch: wrappedFetch });
		void forwardStream(stream, outer, async () => {
			const responseId = await metadataTask?.catch(() => undefined);
			if (energy || cost) onRecord({ energy, cost }, responseId);
		});
		return outer;
	};
}

async function fetchAccountingMethod(
	ctx: ExtensionContext,
): Promise<AccountingMethod | undefined> {
	const apiKey = await ctx.modelRegistry.getApiKeyForProvider("neuralwatt");
	if (!apiKey) return undefined;
	const response = await neuralwattFetch("/quota", apiKey, ctx.signal);
	if (!response.ok) return undefined;
	const quota = (await response.json()) as QuotaResponse;
	const method = quota.balance?.accounting_method;
	return method === "energy" || method === "token" ? method : undefined;
}

export default async function (pi: ExtensionAPI) {
	const settings = await readSettingsFile();
	const cachedModels = await readCachedModels();
	let currentAccountingMethod: AccountingMethod | undefined;
	let accountingMethodFetch: Promise<AccountingMethod | undefined> | undefined;
	let currentCtx: ExtensionContext | undefined;
	let totals: Totals = emptyTotals();
	let lastEntry: EnergyCostEntry | undefined;

	const pending: CapturedRecord[] = [];
	const pushCaptured = (
		record: StreamEnergyRecord,
		responseId: string | undefined,
	): void => {
		const cutoff = Date.now() - MAX_RECORD_AGE_MS;
		for (let i = pending.length - 1; i >= 0; i--) {
			if (pending[i].capturedAt < cutoff) pending.splice(i, 1);
		}
		pending.push({ record, responseId, capturedAt: Date.now() });
		while (pending.length > MAX_PENDING_RECORDS) pending.shift();
	};
	const findPendingIndex = (responseId: string | undefined): number => {
		const cutoff = Date.now() - MAX_RECORD_AGE_MS;
		if (responseId) {
			return pending.findIndex(
				(captured) =>
					captured.capturedAt >= cutoff && captured.responseId === responseId,
			);
		}
		return pending.findIndex(
			(captured) => captured.capturedAt >= cutoff && !captured.responseId,
		);
	};
	const takeCaptured = async (
		responseId: string | undefined,
		timeoutMs: number,
	): Promise<StreamEnergyRecord | undefined> => {
		let index = findPendingIndex(responseId);
		const deadline = Date.now() + timeoutMs;
		while (index < 0 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
			index = findPendingIndex(responseId);
		}
		if (index < 0) return undefined;
		return pending.splice(index, 1)[0].record;
	};

	const rateUsdPerKwh = (): number => currentRateUsdPerKwh(settings);

	const setStatus = (
		ctx: ExtensionContext | undefined,
		accountingMethod: AccountingMethod | undefined,
	): void => {
		if (!ctx?.hasUI) return;
		if (ctx.model?.provider !== "neuralwatt" || accountingMethod !== "energy") {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const text = formatStatusText(totals, lastEntry, settings, ENERGY_MARK);
		if (text === undefined) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(settings.energyColor, text));
	};

	const ensureAccountingMethod = async (
		ctx: ExtensionContext,
	): Promise<AccountingMethod | undefined> => {
		if (currentAccountingMethod) return currentAccountingMethod;
		if (!accountingMethodFetch) {
			accountingMethodFetch = fetchAccountingMethod(ctx)
				.catch(() => undefined)
				.finally(() => {
					accountingMethodFetch = undefined;
				});
		}
		currentAccountingMethod = await accountingMethodFetch;
		setStatus(ctx, currentAccountingMethod);
		return currentAccountingMethod;
	};

	/*
	 * Responses reach here after the stream is done. Detection already ran on
	 * session_start / model_select / before_provider_request, so this only
	 * joins an in-flight check and never starts a new network round-trip.
	 */
	const resolveAccountingMethodForResponse =
		async (): Promise<AccountingMethod | undefined> => {
			if (currentAccountingMethod) return currentAccountingMethod;
			if (accountingMethodFetch) {
				currentAccountingMethod = await accountingMethodFetch;
			}
			return currentAccountingMethod;
		};

	registerProvider(pi, cachedModels.models, pushCaptured);
	/*
	 * /v1/models only lists enrolled private/preview models (e.g.
	 * deepseek-v4-pro) on authenticated requests, so the key must ride along.
	 * Headless --model resolution happens before session_start, so the
	 * authenticated catalog must be fetchable at extension-load time via
	 * resolveStartupApiKey. An authenticated cached catalog is never
	 * clobbered by the smaller public catalog; fetches on the unauthenticated
	 * path only run when nothing better is available, and the session-start
	 * refresh upgrades to the registry-resolved key.
	 */
	let fetchedPublicCatalog = false;
	let fetchedAuthenticatedCatalog = false;
	const refreshModels = async (apiKey: string | undefined): Promise<void> => {
		if (fetchedAuthenticatedCatalog) return;
		if (!apiKey && (fetchedPublicCatalog || cachedModels.authenticated)) return;
		try {
			const catalog = await fetchModels(apiKey);
			await writeCachedModels(catalog.models, catalog.authenticated);
			registerProvider(pi, catalog.models, pushCaptured);
			if (catalog.authenticated) fetchedAuthenticatedCatalog = true;
			else fetchedPublicCatalog = true;
		} catch {
			// Cached models, if any, remain registered. Without cache, the provider is still present but empty.
		}
	};
	if (!isOfflineMode()) await refreshModels(await resolveStartupApiKey());

	if (typeof pi.registerEntryRenderer === "function") {
		pi.registerEntryRenderer<EnergyCostEntry>(
			ENERGY_COST_ENTRY_TYPE,
			(entry, _options, theme) => {
				if (!settings.perResponseLine) return undefined;
				const data = entry.data;
				if (!isEnergyCostEntry(data)) return undefined;
				const suffix = data.costSource === "energy-rate" ? " est." : "";
				const text = `${ENERGY_MARK}${formatWh(data.energyKwh)} \u00B7 ${formatUsd(data.costUsd)}${suffix}`;
				return {
					render: () => [theme.fg(settings.energyColor, text)],
					invalidate: () => {},
				};
			},
		);
	}

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		const branch = ctx.sessionManager.getBranch();
		totals = totalsFromEntries(branch);
		lastEntry = lastEntryFromEntries(branch);
		if (!isOfflineMode() && !fetchedAuthenticatedCatalog) {
			let apiKey: string | undefined;
			try {
				apiKey = await ctx.modelRegistry.getApiKeyForProvider("neuralwatt");
			} catch {
				// Key lookup is best-effort; the public catalog remains registered.
			}
			if (apiKey) await refreshModels(apiKey);
		}
		if (ctx.model?.provider === "neuralwatt") await ensureAccountingMethod(ctx);
		setStatus(ctx, currentAccountingMethod);
	});

	pi.on("model_select", async (_event, ctx) => {
		currentCtx = ctx;
		if (ctx.model?.provider === "neuralwatt") await ensureAccountingMethod(ctx);
		setStatus(ctx, currentAccountingMethod);
	});

	pi.on("before_provider_request", async (_event, ctx) => {
		currentCtx = ctx;
		if (ctx.model?.provider === "neuralwatt") await ensureAccountingMethod(ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const record = await takeCaptured(event.message.responseId, RECORD_WAIT_MS);
		if (!record) return;
		currentCtx = ctx;
		const method = await resolveAccountingMethodForResponse();
		const charged = resolveChargedCost(record, method, rateUsdPerKwh());
		const entry = makeEntry(record, method, rateUsdPerKwh(), event.message.model);
		if (entry) {
			totals = addEntryToTotals(totals, entry);
			lastEntry = entry;
			try {
				pi.appendEntry(ENERGY_COST_ENTRY_TYPE, entry);
			} catch {
				// The session may have been replaced mid-stream; totals rebuild
				// from persisted entries on the next session_start.
			}
			setStatus(ctx, method);
		}
		if (settings.patchPiCost && charged) {
			return { message: withChargedCost(event.message, charged.costUsd) };
		}
	});

	pi.on("session_shutdown", () => {
		setStatus(currentCtx, undefined);
		currentCtx = undefined;
	});

	pi.registerCommand("neuralwatt:cost", {
		description: "Show Neuralwatt session energy and charged cost",
		handler: async (_args, ctx) => {
			currentCtx = ctx;
			const branch = ctx.sessionManager.getBranch();
			totals = totalsFromEntries(branch);
			lastEntry = lastEntryFromEntries(branch);
			if (ctx.model?.provider === "neuralwatt") await ensureAccountingMethod(ctx);
			setStatus(ctx, currentAccountingMethod);

			if (currentAccountingMethod === "token") {
				ctx.ui.notify(
					"Neuralwatt account uses token accounting; pi's normal cost indicator applies, with reported request costs when available.",
					"info",
				);
				return;
			}
			if (currentAccountingMethod !== "energy") {
				ctx.ui.notify(
					"Neuralwatt energy accounting is not active or could not be detected yet.",
					"warning",
				);
				return;
			}

			const lines = [
				`Session energy: ${formatWh(totals.energyKwh)} (${formatJoules(totals.energyJoules)})`,
				`Charged cost: ${formatUsd(totals.costUsd)}`,
				`Requests: ${totals.requests} \u00B7 ${totals.reportedCostRequests} reported \u00B7 ${totals.estimatedCostRequests} estimated at $${rateUsdPerKwh()}/kWh`,
			];
			if (lastEntry) {
				lines.push(
					`Last response: ${formatWh(lastEntry.energyKwh)} \u00B7 ${formatUsd(lastEntry.costUsd)}${lastEntry.costSource === "energy-rate" ? " (est.)" : ""}`,
				);
			}
			const equivalents = settings.equivalents
				.map((id) => formatEquivalentDetail(totals.energyKwh, id))
				.filter((line): line is string => line !== undefined);
			if (equivalents.length > 0) {
				lines.push("Equivalent:");
				lines.push(...equivalents);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	const editEquivalents = async (ctx: ExtensionContext): Promise<void> => {
		const ids = Object.keys(EQUIVALENTS) as EquivalentId[];
		for (;;) {
			const labels = ids.map(
				(id) =>
					`${settings.equivalents.includes(id) ? "[x]" : "[ ]"} ${EQUIVALENTS[id].label}`,
			);
			const picked = await ctx.ui.select("Equivalents (toggle)", [
				...labels,
				"Done",
			]);
			if (!picked || picked === "Done") return;
			const index = labels.indexOf(picked);
			if (index < 0) continue;
			const id = ids[index];
			settings.equivalents = settings.equivalents.includes(id)
				? settings.equivalents.filter((value) => value !== id)
				: [...settings.equivalents, id];
			await writeSettingsFile(settings);
		}
	};

	pi.registerCommand("neuralwatt:settings", {
		description: "Configure the Neuralwatt energy indicator",
		handler: async (_args, ctx) => {
			for (;;) {
				const choice = await ctx.ui.select("Neuralwatt settings", [
					`Energy in footer: ${settings.energyStatus}`,
					`Energy color: ${settings.energyColor}`,
					`Equivalents: ${settings.equivalents.length > 0 ? settings.equivalents.join(", ") : "off"}`,
					`Pi footer cost: ${settings.patchPiCost ? "charged" : "token estimate"}`,
					`Transcript line per response: ${settings.perResponseLine ? "on" : "off"}`,
					`Fallback rate: $${settings.fallbackRateUsdPerKwh}/kWh`,
					"Done",
				]);
				if (!choice || choice === "Done") break;
				if (choice.startsWith("Energy in footer")) {
					const picked = await ctx.ui.select("Energy in footer", [
						"session",
						"last",
						"both",
						"off",
					]);
					if (
						picked === "session" ||
						picked === "last" ||
						picked === "both" ||
						picked === "off"
					) {
						settings.energyStatus = picked;
					}
				} else if (choice.startsWith("Energy color")) {
					const picked = await ctx.ui.select("Energy color", [...THEME_COLORS]);
					if (isThemeColorName(picked)) settings.energyColor = picked;
				} else if (choice.startsWith("Equivalents")) {
					await editEquivalents(ctx);
				} else if (choice.startsWith("Pi footer cost")) {
					settings.patchPiCost = !settings.patchPiCost;
				} else if (choice.startsWith("Transcript line")) {
					settings.perResponseLine = !settings.perResponseLine;
				} else if (choice.startsWith("Fallback rate")) {
					const input = await ctx.ui.input(
						"Fallback energy rate (USD per kWh)",
						String(settings.fallbackRateUsdPerKwh),
					);
					const parsed = Number(input);
					if (isFinitePositiveNumber(parsed)) {
						settings.fallbackRateUsdPerKwh = parsed;
					}
				}
				await writeSettingsFile(settings);
				setStatus(ctx, currentAccountingMethod);
			}
		},
	});
}
