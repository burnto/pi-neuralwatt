import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	type AssistantMessageEvent,
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
import {
	type AccountingMethod,
	type AccountContext,
	type CapturedRecord,
	type CatalogFetchResult,
	type CostPayload,
	DEFAULT_PRESETS,
	ENERGY_COST_ENTRY_TYPE,
	type EnergyPayload,
	type EquivalentPreset,
	MAX_PRESET_LABEL_LENGTH,
	MAX_PRESET_WATTS,
	type NeuralwattModelConfig,
	type NeuralwattSettings,
	type ResponseTelemetry,
	type StreamEnergyRecord,
	type SubscriptionSnapshot,
	THEME_COLORS,
	type Totals,
	addTelemetryToTotals,
	buildTelemetry,
	emptyTotals,
	findPreset,
	formatEquivalentDetail,
	formatJoules,
	formatStatusText,
	formatUsd,
	formatWh,
	isEnergyCostData,
	isFinitePositiveNumber,
	isNeuralwattChatCompletionsUrl,
	isOfflineValue,
	isSafeDisplayString,
	isValidKeyId,
	isValidPresetId,
	lastTelemetryFromEntries,
	mapModelsResponse,
	parseCachedModels,
	parseCommentPayload,
	parseSettings,
	pruneCaptures,
	readSseMetadata,
	resolveEffectiveRate,
	takeCaptureIndex,
	toResponseTelemetry,
	totalsFromEntries,
	truncateVisible,
	visibleWidth,
	withChargedCost,
} from "./lib.ts";

const BASE_URL = "https://api.neuralwatt.com/v1";
const PACKAGE_TITLE = "pi-neuralwatt";
const MODELS_CACHE_PATH = join(getAgentDir(), "cache", "neuralwatt-models.json");
const SETTINGS_PATH = join(getAgentDir(), "neuralwatt.json");
const STATUS_KEY = "neuralwatt-energy";
const ENERGY_MARK = "\u26A1\uFE0F"; // ⚡️ emoji presentation.
const FETCH_TIMEOUT_MS = 15_000;
const RECORD_WAIT_MS = 300;
const CACHE_VERSION = 2;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const QUOTA_TTL_MS = 5 * 60 * 1000;
const QUOTA_RETRY_MS = 30_000;
const MAX_ICON_WIDTH = 2;

type AnyStreamSimple = (
	model: Model<string>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

interface ModelsCacheFile {
	version?: unknown;
	fetchedAt?: unknown;
	authenticated?: unknown;
	/** Fingerprint of the credential used to fetch the authenticated catalog. */
	credentialFingerprint?: unknown;
	models?: unknown;
}

interface CachedCatalog {
	models: NeuralwattModelConfig[];
	authenticated: boolean;
	fetchedAt: number;
	credentialFingerprint?: string;
}

interface QuotaResponse {
	balance?: {
		accounting_method?: string;
		subscription?: unknown;
	};
}

interface QuotaSnapshot {
	accountingMethod?: AccountingMethod;
	subscription?: null | SubscriptionSnapshot;
	observedAt: number;
}

interface SettingsWriteResult {
	ok: boolean;
	error?: string;
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

/** Stable, non-secret credential identity for cache invalidation. */
function fingerprintCredential(key: string | undefined): string | undefined {
	if (!key) return undefined;
	return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

async function readCachedModels(): Promise<CachedCatalog> {
	try {
		const parsed = JSON.parse(
			await readFile(MODELS_CACHE_PATH, "utf8"),
		) as ModelsCacheFile;
		/*
		 * Only trust a cache this package wrote. A missing or unknown version
		 * means the shape is not ours to interpret, so degrade to no cache
		 * rather than casting unknown data into model configs.
		 */
		if (parsed.version !== CACHE_VERSION) {
			return { models: [], authenticated: false, fetchedAt: 0 };
		}
		const fetchedAt =
			typeof parsed.fetchedAt === "string"
				? Date.parse(parsed.fetchedAt) || 0
				: 0;
		return {
			models: parseCachedModels(parsed),
			authenticated: parsed.authenticated === true,
			fetchedAt,
			credentialFingerprint:
				typeof parsed.credentialFingerprint === "string"
					? parsed.credentialFingerprint
					: undefined,
		};
	} catch {
		return { models: [], authenticated: false, fetchedAt: 0 };
	}
}

async function writeCachedModels(
	models: NeuralwattModelConfig[],
	authenticated: boolean,
	credentialFingerprint: string | undefined,
): Promise<void> {
	try {
		await mkdir(dirname(MODELS_CACHE_PATH), { recursive: true });
		await writeFile(
			MODELS_CACHE_PATH,
			`${JSON.stringify(
				{
					version: CACHE_VERSION,
					fetchedAt: new Date().toISOString(),
					authenticated,
					credentialFingerprint,
					models,
				},
				null,
				2,
			)}\n`,
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

async function writeSettingsFile(
	settings: NeuralwattSettings,
): Promise<SettingsWriteResult> {
	try {
		await mkdir(dirname(SETTINGS_PATH), { recursive: true });
		await writeFile(
			SETTINGS_PATH,
			`${JSON.stringify(settings, null, 2)}\n`,
			"utf8",
		);
		return { ok: true };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : "write failed",
		};
	}
}

function isOfflineMode(): boolean {
	return isOfflineValue(process.env.PI_OFFLINE);
}

/*
 * Best-effort startup key resolution. Pi's registry only becomes reachable
 * once a session context exists, but headless --model resolution happens
 * before session_start, so the authenticated catalog (with enrolled preview
 * models) must be fetchable at extension-load time. Mirrors pi's documented
 * key sources for this provider: NEURALWATT_API_KEY first, then a plain
 * api_key entry in auth.json. $-templated (env/shell-command) keys are never
 * sent as bearer tokens and degrade to the public catalog; the session-start
 * refresh with the registry-resolved key then upgrades. This is a documented
 * limitation of pre-session startup, not a substitute for the registry path.
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

async function fetchQuota(
	apiKey: string,
	signal?: AbortSignal,
): Promise<QuotaSnapshot> {
	const response = await neuralwattFetch("/quota", apiKey, signal);
	if (!response.ok) throw new Error(`/v1/quota returned HTTP ${response.status}`);
	const quota = (await response.json()) as QuotaResponse;
	const method = quota.balance?.accounting_method;
	const accountingMethod: AccountingMethod | undefined =
		method === "energy" || method === "token" ? method : undefined;
	return {
		accountingMethod,
		subscription: parseSubscription(quota.balance?.subscription),
		observedAt: Date.now(),
	};
}

/**
 * Reads `balance.subscription`, preserving unknown/null fields rather than
 * treating them as false. `null` means the snapshot reported no subscription.
 */
function parseSubscription(
	value: unknown,
): null | SubscriptionSnapshot | undefined {
	if (value === null) return null;
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	const subscription: SubscriptionSnapshot = {};
	if (typeof raw.plan === "string") subscription.plan = raw.plan;
	if (typeof raw.status === "string") subscription.status = raw.status;
	if (typeof raw.in_overage === "boolean") {
		subscription.inOverage = raw.in_overage;
	}
	return subscription;
}

/* ------------------------------------------------------------------ */
/* Stream tee                                                          */
/* ------------------------------------------------------------------ */

interface MetadataCapture {
	energy: EnergyPayload | undefined;
	cost: CostPayload | undefined;
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
	onCapture: (record: StreamEnergyRecord, responseId?: string) => void,
	onCaptureError: () => void,
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
		const capture: MetadataCapture = { energy: undefined, cost: undefined };
		let metadataTask: Promise<string | undefined> | undefined;
		let metadataAbort: AbortController | undefined;

		const wrappedFetch: FetchFunction = async (input, init) => {
			const response = await baseFetch(input, init);
			if (!isNeuralwattChatCompletionsUrl(input, providerOrigin)) return response;
			if (!response.ok || !response.body) return response;

			const [sdkBody, metadataBody] = response.body.tee();
			metadataAbort = new AbortController();
			metadataTask = readSseMetadata(
				metadataBody,
				(line) => {
					const parsed = parseCommentPayload(line);
					if (!parsed) return;
					if (parsed.kind === "energy") {
						capture.energy = parsed.value as EnergyPayload;
					}
					if (parsed.kind === "cost") {
						capture.cost = parsed.value as CostPayload;
					}
				},
				metadataAbort.signal,
			);
			return new Response(sdkBody, {
				headers: response.headers,
				status: response.status,
				statusText: response.statusText,
			});
		};

		const stream = base(model, context, { ...options, fetch: wrappedFetch });
		void forwardStream(stream, outer, async () => {
			let responseId: string | undefined;
			try {
				responseId = await joinMetadata(
					metadataTask,
					RECORD_WAIT_MS,
					metadataAbort,
				);
			} catch {
				onCaptureError();
			}
			onCapture({ energy: capture.energy, cost: capture.cost }, responseId);
		});
		return outer;
	};
}

/*
 * Joins metadata capture for at most `timeoutMs` and returns the response id.
 * Capture has already completed for most responses (the tee branch drains
 * alongside the SDK branch), so this returns immediately. On expiry the reader
 * is aborted so no tee branch keeps draining after its consumer stopped.
 */
async function joinMetadata(
	task: Promise<string | undefined> | undefined,
	timeoutMs: number,
	abort: AbortController | undefined,
): Promise<string | undefined> {
	if (!task) return undefined;
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, timeoutMs);
	});
	try {
		const result = await Promise.race([task, timeout.then(() => undefined)]);
		return typeof result === "string" ? result : undefined;
	} finally {
		if (timer) clearTimeout(timer);
		abort?.abort();
	}
}

function isTerminalStreamEvent(event: AssistantMessageEvent): boolean {
	return event.type === "done" || event.type === "error";
}

/*
 * Forwards the provider stream to pi unchanged, except that the terminal
 * `done`/`error` event is held until metadata capture has been joined. Pi emits
 * `message_end` as soon as it consumes that terminal event, and `message_end`
 * must be able to match the already-completed capture by response id. Without
 * this ordering, a late `: energy`/`: cost` tail races the terminal event and
 * the response is recorded as missing telemetry. Capture is finalized exactly
 * once; a stream that ends or throws without a terminal event still finalizes.
 */
function forwardStream(
	stream: AssistantMessageEventStream,
	outer: AssistantMessageEventStream,
	finalize: () => Promise<void>,
): void {
	void (async () => {
		let finalized = false;
		const runFinalize = async (): Promise<void> => {
			if (finalized) return;
			finalized = true;
			await finalize().catch(() => undefined);
		};
		try {
			for await (const event of stream) {
				if (isTerminalStreamEvent(event)) await runFinalize();
				outer.push(event);
			}
		} finally {
			await runFinalize();
			try {
				outer.end();
			} catch {
				// The outer stream can already be closed on abort.
			}
		}
	})();
}

function registerProvider(
	pi: ExtensionAPI,
	models: NeuralwattModelConfig[],
	onCapture: (record: StreamEnergyRecord, responseId?: string) => void,
	onCaptureError: () => void,
): boolean {
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
					streamSimple: wrapNeuralwattStreamSimple(
						baseStreamSimple,
						onCapture,
						onCaptureError,
					),
				}
			: {}),
	});
	return Boolean(baseStreamSimple);
}

/* ------------------------------------------------------------------ */
/* Rendering helpers                                                   */
/* ------------------------------------------------------------------ */

function describeTelemetry(telemetry: ResponseTelemetry): string {
	const energy =
		telemetry.energy.status === "reported"
			? formatWh(telemetry.energy.kwh)
			: `no energy (${telemetry.energy.status})`;
	let cost: string;
	if (telemetry.cost.status === "reported") {
		cost = formatUsd(telemetry.cost.usd);
	} else if (telemetry.cost.status === "estimated") {
		cost = `${formatUsd(telemetry.cost.usd)} (est. at $${telemetry.cost.rateUsdPerKwh}/kWh)`;
	} else {
		cost = `no cost (${telemetry.cost.status})`;
	}
	return `${energy} \u00B7 ${cost}`;
}

function telemetryLineText(telemetry: ResponseTelemetry): string {
	const parts: string[] = [];
	parts.push(
		telemetry.energy.status === "reported"
			? formatWh(telemetry.energy.kwh)
			: "no energy",
	);
	if (telemetry.cost.status === "reported") {
		parts.push(formatUsd(telemetry.cost.usd));
	} else if (telemetry.cost.status === "estimated") {
		parts.push(`${formatUsd(telemetry.cost.usd)} est.`);
	}
	return `${ENERGY_MARK} ${parts.join(" \u00B7 ")}`;
}

/* ------------------------------------------------------------------ */
/* Preset input validation                                             */
/* ------------------------------------------------------------------ */

function isValidPresetLabel(value: string): boolean {
	return isSafeDisplayString(value.trim(), MAX_PRESET_LABEL_LENGTH);
}

function isValidPresetIcon(value: string): boolean {
	const trimmed = value.trim();
	if (trimmed === "") return true;
	if (!isSafeDisplayString(trimmed, 8, { allowEmpty: true })) return false;
	return visibleWidth(trimmed) <= MAX_ICON_WIDTH;
}

function isValidPresetWatts(value: number): boolean {
	return isFinitePositiveNumber(value) && value <= MAX_PRESET_WATTS;
}

/* ------------------------------------------------------------------ */
/* Extension                                                           */
/* ------------------------------------------------------------------ */

export default async function (pi: ExtensionAPI) {
	const settings = await readSettingsFile();
	const cachedCatalog = await readCachedModels();

	let currentCtx: ExtensionContext | undefined;
	let totals: Totals = emptyTotals();
	let lastTelemetry: ResponseTelemetry | undefined;
	let baseProviderAvailable = true;
	let captureErrorNotified = false;

	const captures: CapturedRecord[] = [];
	/* Response ids already recorded on this branch, so a repeated message_end
	 * cannot append a duplicate (including a spurious missing-telemetry entry). */
	const recordedResponseIds = new Set<string>();
	const pushCapture = (
		record: StreamEnergyRecord,
		responseId: string | undefined,
	): void => {
		const now = Date.now();
		pruneCaptures(captures, now);
		captures.push({ record, responseId, capturedAt: now });
		pruneCaptures(captures, now);
	};
	const notifyCaptureError = (ctx: ExtensionContext | undefined): void => {
		if (captureErrorNotified) return;
		captureErrorNotified = true;
		ctx?.ui.notify(
			"Neuralwatt energy metadata could not be captured for one response. Telemetry will be recorded as unavailable; the model response is unaffected.",
			"warning",
		);
	};

	let quotaSnapshot: QuotaSnapshot | undefined;
	let quotaInflight: Promise<QuotaSnapshot | undefined> | undefined;
	let quotaFailedAt = 0;
	let credentialFingerprint: string | undefined = fingerprintCredential(
		await resolveStartupApiKey(),
	);
	/*
	 * A cached authenticated catalog is trusted only when it was fetched with
	 * the credential resolvable at startup. A mismatch — including a templated
	 * credential that cannot be resolved until session_start — discards the
	 * private models. Clearing the "authenticated" protection alongside the
	 * models is essential: otherwise a later public refresh is rejected and the
	 * provider registers with zero models.
	 */
	const cacheCredentialMismatch =
		cachedCatalog.authenticated &&
		cachedCatalog.credentialFingerprint !== undefined &&
		cachedCatalog.credentialFingerprint !== credentialFingerprint;

	const accountContext = (): AccountContext | undefined => {
		if (!quotaSnapshot) return undefined;
		const context: AccountContext = {
			observedAt: new Date(quotaSnapshot.observedAt).toISOString(),
		};
		if (quotaSnapshot.accountingMethod) {
			context.accountingMethod = quotaSnapshot.accountingMethod;
		}
		if (quotaSnapshot.subscription !== undefined) {
			context.subscription = quotaSnapshot.subscription;
		}
		return context;
	};

	const effectiveRate = (): number =>
		resolveEffectiveRate(settings, process.env.NEURALWATT_USD_PER_KWH).rateUsdPerKwh;

	/*
	 * Account lookup is best-effort enrichment, not a prerequisite for
	 * recording telemetry. One in-flight request is shared; a successful
	 * snapshot is cached for five minutes and a failure backs off 30 s.
	 * Offline mode suppresses every extension-owned discovery request.
	 */
	const ensureQuota = async (
		ctx: ExtensionContext,
		{ force = false }: { force?: boolean } = {},
	): Promise<QuotaSnapshot | undefined> => {
		if (isOfflineMode()) return quotaSnapshot;
		const now = Date.now();
		if (!force && quotaSnapshot && now - quotaSnapshot.observedAt < QUOTA_TTL_MS) {
			return quotaSnapshot;
		}
		if (quotaInflight) return quotaInflight;
		if (!force && quotaFailedAt && now - quotaFailedAt < QUOTA_RETRY_MS) {
			return quotaSnapshot;
		}
		quotaInflight = (async () => {
			try {
				const apiKey = await ctx.modelRegistry.getApiKeyForProvider("neuralwatt");
				if (!apiKey) return quotaSnapshot;
				const snapshot = await fetchQuota(apiKey, ctx.signal);
				quotaSnapshot = snapshot;
				quotaFailedAt = 0;
				return snapshot;
			} catch {
				quotaFailedAt = Date.now();
				return quotaSnapshot;
			} finally {
				quotaInflight = undefined;
			}
		})();
		return quotaInflight;
	};

	let registeredAuthenticated =
		cachedCatalog.authenticated && !cacheCredentialMismatch;
	let refreshedAuthenticated = false;

	const refreshModels = async (apiKey: string | undefined): Promise<void> => {
		if (refreshedAuthenticated) return;
		const fingerprint = fingerprintCredential(apiKey);
		try {
			const catalog = await fetchModels(apiKey);
			/*
			 * Decide from the returned scope, not from whether a key was sent.
			 * A refresh that returns only the public catalog must never clobber
			 * an authenticated one.
			 */
			if (registeredAuthenticated && !catalog.authenticated) return;
			if (catalog.authenticated) refreshedAuthenticated = true;
			registeredAuthenticated = catalog.authenticated;
			await writeCachedModels(catalog.models, catalog.authenticated, fingerprint);
			baseProviderAvailable = registerProvider(
				pi,
				catalog.models,
				pushCapture,
				() => notifyCaptureError(currentCtx),
			);
		} catch {
			// Cached models, if any, remain registered. Without cache, the provider
			// is still present but empty.
		}
	};

	const setStatus = (ctx: ExtensionContext | undefined): void => {
		const target = ctx ?? currentCtx;
		if (!target?.hasUI) return;
		if (target.model?.provider !== "neuralwatt") {
			target.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const text = formatStatusText(totals, lastTelemetry, settings, ENERGY_MARK);
		if (text === undefined) {
			target.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		// Recolored on each call; there is no theme event, so a theme change is
		// picked up on the next session/model/response/toggle event.
		target.ui.setStatus(STATUS_KEY, target.ui.theme.fg(settings.energyColor, text));
	};

	const clearStatus = (): void => {
		currentCtx?.ui.setStatus(STATUS_KEY, undefined);
	};

	const rebuildFromBranch = (ctx: ExtensionContext): void => {
		const branch = ctx.sessionManager.getBranch();
		totals = totalsFromEntries(branch);
		lastTelemetry = lastTelemetryFromEntries(branch);
		recordedResponseIds.clear();
		for (const entry of branch) {
			if (
				entry.type !== "custom" ||
				entry.customType !== ENERGY_COST_ENTRY_TYPE ||
				!isEnergyCostData(entry.data)
			) {
				continue;
			}
			const responseId = toResponseTelemetry(entry.data).responseId;
			if (responseId) recordedResponseIds.add(responseId);
		}
	};

	const saveAndRefresh = async (ctx: ExtensionContext): Promise<void> => {
		const saved = await writeSettingsFile(settings);
		setStatus(ctx);
		if (!saved.ok) {
			ctx.ui.notify(
				`Saving settings failed (${saved.error}). The change applies in memory until restart.`,
				"warning",
			);
		}
	};

	const applyVisibility = async (
		ctx: ExtensionContext,
		enabled: boolean,
	): Promise<void> => {
		settings.energyUiEnabled = enabled;
		const saved = await writeSettingsFile(settings);
		setStatus(ctx);
		if (!saved.ok) {
			ctx.ui.notify(
				`Energy UI ${enabled ? "shown" : "hidden"}, but saving settings failed (${saved.error}). The change applies until restart.`,
				"warning",
			);
			return;
		}
		const parts = [`Energy UI ${enabled ? "on" : "off"}.`];
		if (settings.perResponseLine) {
			parts.push(
				enabled
					? "Existing history annotations refresh on /reload."
					: "Energy UI hidden; existing history annotations refresh on /reload.",
			);
		}
		ctx.ui.notify(parts.join(" "), "info");
	};

	/* ------------------------ provider setup ------------------------- */
	const cacheModels = cacheCredentialMismatch ? [] : cachedCatalog.models;
	baseProviderAvailable = registerProvider(
		pi,
		cacheModels,
		pushCapture,
		() => notifyCaptureError(currentCtx),
	);

	const cacheUsable = cacheModels.length > 0;
	if (!isOfflineMode()) {
		const startupKey = await resolveStartupApiKey();
		if (cacheUsable) {
			// Cache-first: never block startup on a refresh when a usable cache exists.
			void refreshModels(startupKey);
		} else {
			await refreshModels(startupKey);
		}
	}

	/* ---------------------- entry renderer --------------------------- */
	if (typeof pi.registerEntryRenderer === "function") {
		pi.registerEntryRenderer<unknown>(
			ENERGY_COST_ENTRY_TYPE,
			(entry, _options, theme) => {
				if (!settings.energyUiEnabled || !settings.perResponseLine) {
					return undefined;
				}
				if (!isEnergyCostData(entry.data)) return undefined;
				const telemetry = toResponseTelemetry(entry.data);
				return {
					render: (width: number) => {
						const safeWidth = Number.isFinite(width) && width > 0 ? width : 80;
						const text = truncateVisible(telemetryLineText(telemetry), safeWidth);
						return [theme.fg(settings.energyColor, text)];
					},
					invalidate: () => {},
				};
			},
		);
	}

	/* ---------------------------- hooks ------------------------------ */
	pi.on("session_start", async (event, ctx) => {
		currentCtx = ctx;
		rebuildFromBranch(ctx);

		let apiKey: string | undefined;
		try {
			apiKey = await ctx.modelRegistry.getApiKeyForProvider("neuralwatt");
		} catch {
			apiKey = undefined;
		}
		const fingerprint = fingerprintCredential(apiKey);
		if (
			fingerprint &&
			credentialFingerprint &&
			fingerprint !== credentialFingerprint
		) {
			// Known credential change: clear account-specific state.
			quotaSnapshot = undefined;
			quotaFailedAt = 0;
			refreshedAuthenticated = false;
			registeredAuthenticated = false;
			credentialFingerprint = fingerprint;
		} else if (fingerprint) {
			credentialFingerprint = fingerprint;
		}

		const cacheFresh =
			registeredAuthenticated &&
			Date.now() - cachedCatalog.fetchedAt < CACHE_TTL_MS;
		if (!isOfflineMode() && !cacheFresh) void refreshModels(apiKey);
		if (ctx.model?.provider === "neuralwatt") {
			void ensureQuota(ctx, { force: event.reason !== "startup" }).then(() =>
				setStatus(ctx),
			);
		}
		setStatus(ctx);
		if (!baseProviderAvailable && ctx.model?.provider === "neuralwatt") {
			ctx.ui.notify(
				"Neuralwatt is registered, but pi's openai-completions provider is unavailable, so response energy cannot be captured.",
				"warning",
			);
		}
	});

	pi.on("session_tree", (_event, ctx) => {
		currentCtx = ctx;
		rebuildFromBranch(ctx);
		setStatus(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		currentCtx = ctx;
		if (ctx.model?.provider === "neuralwatt") {
			void ensureQuota(ctx).then(() => setStatus(ctx));
		} else {
			setStatus(ctx);
		}
	});

	pi.on("before_provider_request", (_event, ctx) => {
		currentCtx = ctx;
		if (ctx.model?.provider === "neuralwatt") void ensureQuota(ctx);
	});

	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		// Unrelated providers must not wait for metadata or receive a patch.
		if (message.role !== "assistant") return;
		if (message.provider !== "neuralwatt") return;
		if (message.stopReason === "error" || message.stopReason === "aborted") return;
		/* A completed response is recorded once. A repeated message_end for an
		 * already-recorded response id (retry/duplicate delivery) is ignored. */
		if (message.responseId && recordedResponseIds.has(message.responseId)) {
			return undefined;
		}
		currentCtx = ctx;

		const now = Date.now();
		pruneCaptures(captures, now);
		const index = takeCaptureIndex(captures, message.responseId, now);
		const captured = index >= 0 ? captures.splice(index, 1)[0] : undefined;
		const telemetry = buildTelemetry(captured?.record ?? {}, {
			modelId: message.model,
			responseId: message.responseId,
			accountingMethod: quotaSnapshot?.accountingMethod,
			account: accountContext(),
			rateUsdPerKwh: effectiveRate(),
		});
		totals = addTelemetryToTotals(totals, telemetry);
		lastTelemetry = telemetry;
		if (message.responseId) recordedResponseIds.add(message.responseId);
		try {
			pi.appendEntry(ENERGY_COST_ENTRY_TYPE, telemetry);
		} catch {
			// The session may have been replaced mid-stream; totals rebuild from
			// persisted entries on the next session_start.
		}
		setStatus(ctx);
		if (
			settings.patchPiCost &&
			(telemetry.cost.status === "reported" ||
				telemetry.cost.status === "estimated")
		) {
			return { message: withChargedCost(message, telemetry.cost.usd) };
		}
		return undefined;
	});

	pi.on("session_shutdown", () => {
		clearStatus();
		currentCtx = undefined;
		captures.length = 0;
		recordedResponseIds.clear();
	});

	/* ------------------------- shortcut ------------------------------ */
	if (settings.toggleShortcut && isValidKeyId(settings.toggleShortcut)) {
		pi.registerShortcut(
			settings.toggleShortcut as Parameters<ExtensionAPI["registerShortcut"]>[0],
			{
				description: "Toggle the Neuralwatt energy UI",
				handler: async (ctx) => {
					await applyVisibility(ctx, !settings.energyUiEnabled);
				},
			},
		);
	}

	/* -------------------- settings commands -------------------------- */
	const editRate = async (ctx: ExtensionContext): Promise<void> => {
		const effective = resolveEffectiveRate(
			settings,
			process.env.NEURALWATT_USD_PER_KWH,
		);
		const input = await ctx.ui.input(
			`Fallback energy rate (USD per kWh) - effective $${effective.rateUsdPerKwh}/kWh from ${effective.source}`,
			String(settings.fallbackRateUsdPerKwh),
		);
		if (input === undefined) return;
		const parsed = Number(input.trim());
		if (!isFinitePositiveNumber(parsed)) {
			ctx.ui.notify(
				`"${input}" is not a valid positive rate; the saved value is unchanged.`,
				"warning",
			);
			return;
		}
		settings.fallbackRateUsdPerKwh = parsed;
		await saveAndRefresh(ctx);
	};

	const editEquivalents = async (ctx: ExtensionContext): Promise<void> => {
		for (;;) {
			const presets = settings.equivalentPresets;
			const labels = presets.map(
				(preset) =>
					`${settings.equivalents.includes(preset.id) ? "[x]" : "[ ]"} ${preset.icon} ${preset.label} (${preset.watts} W)`,
			);
			const picked = await ctx.ui.select("Enabled equivalents (toggle)", [
				...labels,
				"Done",
			]);
			if (!picked || picked === "Done") return;
			const index = labels.indexOf(picked);
			if (index < 0) continue;
			const id = presets[index].id;
			settings.equivalents = settings.equivalents.includes(id)
				? settings.equivalents.filter((value) => value !== id)
				: [...settings.equivalents, id];
			await saveAndRefresh(ctx);
		}
	};

	const defaultPresets = (): EquivalentPreset[] =>
		DEFAULT_PRESETS.map((preset) => ({ ...preset }));

	const presetSummary = (preset: EquivalentPreset): string =>
		`${preset.icon} ${preset.label} \u00B7 ${preset.watts} W (${preset.id})`;

	const addPreset = async (ctx: ExtensionContext): Promise<void> => {
		const id = await ctx.ui.input("New preset id (letters, digits, - or _)");
		if (id === undefined) return;
		const trimmedId = id.trim();
		if (!isValidPresetId(trimmedId)) {
			ctx.ui.notify("Invalid preset id.", "warning");
			return;
		}
		if (findPreset(settings.equivalentPresets, trimmedId)) {
			ctx.ui.notify(`Preset "${trimmedId}" already exists.`, "warning");
			return;
		}
		const label = await ctx.ui.input("Preset label");
		if (label === undefined) return;
		if (!isValidPresetLabel(label)) {
			ctx.ui.notify("Invalid label: use a single, control-free line.", "warning");
			return;
		}
		const icon = await ctx.ui.input("Preset icon (optional)", "\u{1F50C}");
		if (icon === undefined) return;
		if (!isValidPresetIcon(icon)) {
			ctx.ui.notify("Invalid icon: use a single, control-free line.", "warning");
			return;
		}
		const wattsInput = await ctx.ui.input("Power in watts (constant draw)", "100");
		if (wattsInput === undefined) return;
		const watts = Number(wattsInput.trim());
		if (!isValidPresetWatts(watts)) {
			ctx.ui.notify("Invalid power: enter a positive number of watts.", "warning");
			return;
		}
		settings.equivalentPresets = [
			...settings.equivalentPresets,
			{ id: trimmedId, icon: icon.trim(), label: label.trim(), watts },
		];
		await saveAndRefresh(ctx);
	};

	const editPreset = async (
		ctx: ExtensionContext,
		preset: EquivalentPreset,
	): Promise<void> => {
		const choice = await ctx.ui.select(`Edit ${preset.id}`, [
			"Edit label",
			"Edit icon",
			"Edit watts",
			"Remove preset",
			"Back",
		]);
		if (!choice || choice === "Back") return;
		if (choice === "Remove preset") {
			const confirmed = await ctx.ui.confirm(
				`Remove "${preset.label}"?`,
				"This deletes the preset definition and disables it. This cannot be undone.",
			);
			if (!confirmed) return;
			settings.equivalentPresets = settings.equivalentPresets.filter(
				(candidate) => candidate.id !== preset.id,
			);
			settings.equivalents = settings.equivalents.filter(
				(id) => id !== preset.id,
			);
			await saveAndRefresh(ctx);
			return;
		}
		const next = { ...preset };
		if (choice === "Edit label") {
			const input = await ctx.ui.input("Preset label", preset.label);
			if (input === undefined) return;
			if (!isValidPresetLabel(input)) {
				ctx.ui.notify("Invalid label.", "warning");
				return;
			}
			next.label = input.trim();
		} else if (choice === "Edit icon") {
			const input = await ctx.ui.input("Preset icon", preset.icon);
			if (input === undefined) return;
			if (!isValidPresetIcon(input)) {
				ctx.ui.notify("Invalid icon.", "warning");
				return;
			}
			next.icon = input.trim();
		} else if (choice === "Edit watts") {
			const input = await ctx.ui.input("Power in watts", String(preset.watts));
			if (input === undefined) return;
			const watts = Number(input.trim());
			if (!isValidPresetWatts(watts)) {
				ctx.ui.notify("Invalid power.", "warning");
				return;
			}
			next.watts = watts;
		}
		settings.equivalentPresets = settings.equivalentPresets.map((candidate) =>
			candidate.id === preset.id ? next : candidate,
		);
		await saveAndRefresh(ctx);
	};

	const editPresets = async (ctx: ExtensionContext): Promise<void> => {
		for (;;) {
			const presets = settings.equivalentPresets;
			const labels = presets.map((preset) => presetSummary(preset));
			const choice = await ctx.ui.select("Comparison presets", [
				...labels,
				"Add preset",
				"Restore defaults",
				"Done",
			]);
			if (!choice || choice === "Done") return;
			if (choice === "Add preset") {
				await addPreset(ctx);
				continue;
			}
			if (choice === "Restore defaults") {
				const confirmed = await ctx.ui.confirm(
					"Restore default comparison presets?",
					"This replaces the entire preset list, including your edits. Enabled equivalents are kept where their id still exists.",
				);
				if (!confirmed) continue;
				settings.equivalentPresets = defaultPresets();
				const ids = new Set(settings.equivalentPresets.map((preset) => preset.id));
				settings.equivalents = settings.equivalents.filter((id) => ids.has(id));
				await saveAndRefresh(ctx);
				continue;
			}
			const index = labels.indexOf(choice);
			if (index < 0) continue;
			await editPreset(ctx, presets[index]);
		}
	};

	const buildCostReport = (ctx: ExtensionContext): string => {
		const rate = resolveEffectiveRate(
			settings,
			process.env.NEURALWATT_USD_PER_KWH,
		);
		const lines: string[] = [];
		const costResponses =
			totals.reportedCostResponses + totals.estimatedCostResponses;
		const partial =
			totals.energyReported < totals.responses ||
			costResponses < totals.responses;

		lines.push(`Recorded responses: ${totals.responses}`);
		lines.push(
			`Reported energy: ${formatWh(totals.energyKwh)} (${formatJoules(totals.energyJoules)}) \u00B7 available for ${totals.energyReported} of ${totals.responses}`,
		);
		lines.push(
			`Cost: ${formatUsd(totals.costUsd)} reported cost + estimates \u00B7 ${totals.reportedCostResponses} reported, ${totals.estimatedCostResponses} estimated \u00B7 available for ${costResponses} of ${totals.responses}`,
		);
		lines.push(
			`Fallback/comparison rate: $${rate.rateUsdPerKwh}/kWh (${rate.source === "environment" ? "NEURALWATT_USD_PER_KWH" : "saved setting"})`,
		);
		if (partial) {
			lines.push(
				"Partial: missing values are not counted as zero, so totals only cover responses with usable metadata.",
			);
		}
		if (lastTelemetry) {
			lines.push(`Last response: ${describeTelemetry(lastTelemetry)}`);
		}
		const account = accountContext();
		if (account?.accountingMethod) {
			lines.push(`Account accounting method: ${account.accountingMethod}`);
		}
		if (account?.subscription) {
			const sub = account.subscription;
			const details = [
				sub.plan ? `plan ${sub.plan}` : undefined,
				sub.status ? `status ${sub.status}` : undefined,
				sub.inOverage === true ? "in overage" : undefined,
			]
				.filter((part): part is string => part !== undefined)
				.join(", ");
			lines.push(`Subscription: ${details || "reported"}`);
		}
		if (
			totals.energyReported > 0 &&
			(account?.subscription || account?.accountingMethod === "token")
		) {
			const equivalent = totals.energyKwh * rate.rateUsdPerKwh;
			const coverage =
				totals.energyReported < totals.responses
					? " (partial energy coverage)"
					: "";
			lines.push(
				`Energy-rate equivalent: ~${formatUsd(equivalent)} at $${rate.rateUsdPerKwh}/kWh${coverage}`,
			);
			lines.push(
				"Excludes account allowances and may differ from actual pay-as-you-go pricing because of flex discounts and caps.",
			);
		}
		const equivalents = settings.equivalents
			.map((id) => {
				const preset = findPreset(settings.equivalentPresets, id);
				return preset
					? formatEquivalentDetail(totals.energyKwh, preset)
					: undefined;
			})
			.filter((line): line is string => line !== undefined);
		if (equivalents.length > 0) {
			lines.push("Approximate equivalents:");
			lines.push(...equivalents);
		}
		if (!settings.energyUiEnabled) {
			lines.push("Energy UI is hidden; this report does not turn it on.");
		}
		if (ctx.model?.provider !== "neuralwatt") {
			lines.push(
				"Note: the active model is not Neuralwatt; showing this session's stored records.",
			);
		}
		return lines.join("\n");
	};

	pi.registerCommand("neuralwatt:energy-ui", {
		description: "Show or hide the Neuralwatt energy UI",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "" || arg === "toggle") {
				await applyVisibility(ctx, !settings.energyUiEnabled);
				return;
			}
			if (arg === "on") {
				await applyVisibility(ctx, true);
				return;
			}
			if (arg === "off") {
				await applyVisibility(ctx, false);
				return;
			}
			ctx.ui.notify("Usage: /neuralwatt:energy-ui [on|off]", "warning");
		},
	});

	pi.registerCommand("neuralwatt:cost", {
		description: "Show Neuralwatt session energy and reported cost",
		handler: async (_args, ctx) => {
			currentCtx = ctx;
			rebuildFromBranch(ctx);
			if (ctx.model?.provider === "neuralwatt") {
				await ensureQuota(ctx, { force: true });
			}
			setStatus(ctx);
			ctx.ui.notify(buildCostReport(ctx), "info");
		},
	});

	pi.registerCommand("neuralwatt:settings", {
		description: "Configure the Neuralwatt energy indicator",
		handler: async (_args, ctx) => {
			for (;;) {
				const choice = await ctx.ui.select("Neuralwatt settings", [
					`Energy UI: ${settings.energyUiEnabled ? "on" : "off"}`,
					`Energy indicator: ${settings.energyStatus}`,
					`Energy color: ${settings.energyColor}`,
					`Equivalents: ${settings.equivalents.length > 0 ? settings.equivalents.join(", ") : "off"}`,
					`Comparison presets: ${settings.equivalentPresets.length}`,
					`Pi footer cost: ${settings.patchPiCost ? "reported/estimated" : "pi token estimate"}`,
					`Transcript line per response: ${settings.perResponseLine ? "on" : "off"}`,
					`Fallback rate: $${settings.fallbackRateUsdPerKwh}/kWh`,
					`Toggle shortcut: ${settings.toggleShortcut ?? "disabled"}`,
					"Done",
				]);
				if (!choice || choice === "Done") break;
				if (choice.startsWith("Energy UI")) {
					await applyVisibility(ctx, !settings.energyUiEnabled);
					continue;
				}
				if (choice.startsWith("Energy indicator")) {
					const picked = await ctx.ui.select("Energy indicator", [
						"session",
						"last",
						"both",
					]);
					if (picked === "session" || picked === "last" || picked === "both") {
						settings.energyStatus = picked;
					}
				} else if (choice.startsWith("Energy color")) {
					const samples = THEME_COLORS.map((color) => ({
						color,
						label: `${color.padEnd(8)} ${ctx.ui.theme.fg(color, `${ENERGY_MARK} 1.42 Wh`)}`,
					}));
					const picked = await ctx.ui.select(
						"Energy color",
						samples.map((sample) => sample.label),
					);
					const match = samples.find((sample) => sample.label === picked);
					if (match) settings.energyColor = match.color;
				} else if (choice.startsWith("Equivalents")) {
					await editEquivalents(ctx);
					continue;
				} else if (choice.startsWith("Comparison presets")) {
					await editPresets(ctx);
					continue;
				} else if (choice.startsWith("Pi footer cost")) {
					settings.patchPiCost = !settings.patchPiCost;
				} else if (choice.startsWith("Transcript line")) {
					settings.perResponseLine = !settings.perResponseLine;
				} else if (choice.startsWith("Fallback rate")) {
					await editRate(ctx);
					continue;
				} else if (choice.startsWith("Toggle shortcut")) {
					ctx.ui.notify(
						`Shortcut ${settings.toggleShortcut ?? "is disabled"}. Extension shortcuts are registered at load; use /reload or restart after editing neuralwatt.json.`,
						"info",
					);
					continue;
				}
				await saveAndRefresh(ctx);
			}
		},
	});
}
