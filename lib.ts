import type {
	AssistantMessage,
	OpenAICompletionsCompat,
	ThinkingLevelMap,
	Usage,
} from "@earendil-works/pi-ai";

/*
 * The config `registerProvider` accepts is a union of chat, image, and
 * classifier models. This extension only produces chat models, so keep a
 * narrow structural type here instead of narrowing the union at every use.
 */
export interface NeuralwattModelConfig {
	id: string;
	name: string;
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	compat: OpenAICompletionsCompat;
}

/**
 * Provider reasoning contract from `metadata.reasoning` in the catalog. The
 * fields describe what the backend accepts and what the model honors:
 * `accepted_efforts` / `effort_aliases` are request-side, `supported_efforts`
 * is what actually changes behavior. `mandatory` means reasoning cannot be
 * disabled.
 */
export interface NeuralwattReasoningMetadata {
	mandatory?: boolean;
	default_enabled?: boolean;
	supported_efforts?: string[];
	default_effort?: string;
	accepted_efforts?: string[];
	effort_aliases?: Record<string, string>;
}

export interface NeuralwattApiModel {
	id: string;
	max_model_len?: number;
	metadata?: {
		display_name?: string;
		deprecated?: boolean;
		pricing?: {
			input_per_million?: number | null;
			output_per_million?: number | null;
			cached_input_per_million?: number | null;
			cached_output_per_million?: number | null;
			pricing_tbd?: boolean;
		};
		capabilities?: {
			vision?: boolean;
			reasoning?: boolean;
			reasoning_effort?: boolean;
			developer_role?: boolean;
		};
		reasoning?: NeuralwattReasoningMetadata;
		limits?: {
			max_context_length?: number | null;
			max_output_tokens?: number | null;
		};
	};
}

/** Raw `: energy` SSE comment payload. */
export interface EnergyPayload {
	energy_kwh?: number;
	energy_joules?: number;
	measurement_available?: boolean;
	attribution_method?: string;
}

/** Raw `: cost` SSE comment payload. */
export interface CostPayload {
	request_cost_usd?: number;
	cache_savings_usd?: number;
}

/** The two raw metadata payloads captured from a single response stream. */
export interface StreamEnergyRecord {
	energy?: EnergyPayload;
	cost?: CostPayload;
}

export const ENERGY_COST_ENTRY_TYPE = "neuralwatt-energy-cost";
export const SCHEMA_VERSION = 2;
export const RESPONSE_TELEMETRY_KIND = "response-telemetry";
export const LEGACY_ENERGY_KIND = "response-energy";
export const DEFAULT_RATE_USD_PER_KWH = 10;
export const DEFAULT_MAX_OUTPUT_TOKENS = 65_536;
export const DEFAULT_TOGGLE_SHORTCUT = "ctrl+shift+e";

export type AccountingMethod = "energy" | "token";

/**
 * Energy for one response. `reported` carries a finite, non-negative kWh
 * value (zero is meaningful). `missing` means no metadata was supplied;
 * `unavailable` means the provider said measurement was not available;
 * `invalid` means a value was present but not usable.
 */
export type EnergyReading =
	| {
			status: "reported";
			kwh: number;
			attributionMethod?: string;
			measurementAvailable?: boolean;
	  }
	| {
			status: "missing" | "unavailable" | "invalid";
			attributionMethod?: string;
			measurementAvailable?: boolean;
	  };

/** Cost for one response. `estimated` records the rate used at the time. */
export type CostReading =
	| { status: "reported"; usd: number }
	| { status: "estimated"; usd: number; rateUsdPerKwh: number }
	| { status: "missing" | "invalid" };

export interface SubscriptionSnapshot {
	plan?: string;
	status?: string;
	inOverage?: boolean;
}

export interface AccountContext {
	observedAt: string;
	accountingMethod?: AccountingMethod;
	subscription?: null | SubscriptionSnapshot;
}

/**
 * Versioned per-response telemetry. Absence of `account` means the account
 * context is unknown; `subscription: null` means a snapshot reported no
 * subscription. Missing values are never encoded as synthetic zeroes.
 */
export interface ResponseTelemetry {
	schemaVersion: 2;
	provider: "neuralwatt";
	kind: "response-telemetry";
	responseId?: string;
	modelId: string;
	recordedAt: string;
	energy: EnergyReading;
	cost: CostReading;
	account?: AccountContext;
}

/**
 * Legacy (v1) entry shape, still written by previous versions and read
 * without rewriting session files. It carries no schema version and no
 * response id.
 */
export interface LegacyEnergyCostEntry {
	provider: "neuralwatt";
	kind: "response-energy";
	energyKwh: number;
	energyJoules?: number;
	costUsd: number;
	costSource: "reported" | "energy-rate";
	rateUsdPerKwh?: number;
	accountingMethod: "energy";
	modelId?: string;
	measuredAt: string;
}

export interface Totals {
	/** Recorded responses, not a claim to count every provider request. */
	responses: number;
	energyKwh: number;
	energyJoules: number;
	/** Responses with a reported energy reading (including a reported zero). */
	energyReported: number;
	/** Responses whose energy reading was missing, unavailable, or invalid. */
	energyUnavailable: number;
	/** Reported plus estimated request cost. */
	costUsd: number;
	reportedCostUsd: number;
	estimatedCostUsd: number;
	reportedCostResponses: number;
	estimatedCostResponses: number;
	/** Responses with no usable cost reading. */
	costMissing: number;
}

interface ModelsListResponse {
	data?: NeuralwattApiModel[];
	scope?: string;
}

export interface CatalogFetchResult {
	models: NeuralwattModelConfig[];
	authenticated: boolean;
}

/*
 * Neuralwatt's /v1/models returns only the public catalog without an API
 * key; enrolled private/preview models appear only on authenticated requests.
 * The response `scope` field ("public" | "customer") says which catalog came
 * back — a request that silently lost its credentials still returns HTTP 200
 * with the public catalog, so `authenticated` must come from scope, not from
 * whether we attempted to send a key.
 */
export function mapModelsResponse(body: unknown): CatalogFetchResult {
	const parsed = body as ModelsListResponse;
	const models = (parsed.data ?? [])
		.map(mapApiModel)
		.filter((model): model is NeuralwattModelConfig => model !== null);
	return { models, authenticated: parsed.scope === "customer" };
}

export function emptyTotals(): Totals {
	return {
		responses: 0,
		energyKwh: 0,
		energyJoules: 0,
		energyReported: 0,
		energyUnavailable: 0,
		costUsd: 0,
		reportedCostUsd: 0,
		estimatedCostUsd: 0,
		reportedCostResponses: 0,
		estimatedCostResponses: 0,
		costMissing: 0,
	};
}

export function asPrice(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: 0;
}

/** Pi thinking levels other than "off". */
const PI_REASONING_LEVELS = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

/**
 * Maps Neuralwatt's `metadata.reasoning` contract onto Pi's `ThinkingLevelMap`.
 *
 * Pi sends the mapped value as `reasoning_effort`; `null` disables a level.
 * Pi's `getSupportedThinkingLevels` treats an *undefined* entry as supported
 * for `off`/`minimal`/`low`/`medium`/`high`, so a level we cannot confirm must
 * be listed explicitly as `null` rather than omitted. `xhigh`/`max` differ:
 * they only appear when a value is defined.
 *
 * Pi exposes no public per-model "default thinking level" in the model config,
 * so `metadata.reasoning.default_enabled` / `default_effort` cannot be honored
 * here. Pi chooses the active level from its own global or per-model thinking
 * setting (defaulting to `medium`) and clamps it with this map; the provider
 * cannot inject a model-specific default. Those fields are therefore
 * documented as an accepted limitation, not silently reinterpreted.
 */
export function buildThinkingLevelMap(
	model: NeuralwattApiModel,
): ThinkingLevelMap | undefined {
	const caps = model.metadata?.capabilities;
	if (caps?.reasoning !== true) return undefined;

	const meta = model.metadata?.reasoning;
	if (!meta) {
		/*
		 * Conservative fallback for catalogs written before `metadata.reasoning`.
		 * Without the contract we only claim the endpoints (`high`, `max`) plus
		 * `off`; every other Pi level is explicitly disabled. Omitting them would
		 * let Pi default them to "supported" and send unsupported efforts.
		 */
		if (caps.reasoning_effort === true) {
			return {
				off: "none",
				minimal: null,
				low: null,
				medium: null,
				high: "high",
				xhigh: null,
				max: "max",
			};
		}
		return {
			off: null,
			minimal: null,
			low: null,
			medium: null,
			high: null,
			xhigh: null,
			max: null,
		};
	}

	const accepted = new Set(meta.accepted_efforts ?? []);
	const supported = new Set(meta.supported_efforts ?? []);
	const aliases = meta.effort_aliases ?? {};

	const resolve = (level: string): string | null => {
		let effort: string | undefined = level;
		if (Object.hasOwn(aliases, level)) effort = aliases[level];
		else if (!accepted.has(level) && !supported.has(level)) return null;
		if (effort === undefined) return null;
		if (Object.hasOwn(aliases, effort)) effort = aliases[effort];
		if (supported.size > 0 && !supported.has(effort)) return null;
		return effort;
	};

	const map: ThinkingLevelMap = {};
	for (const level of PI_REASONING_LEVELS) {
		map[level] = resolve(level);
	}
	map.off = meta.mandatory === true ? null : resolve("none");
	return map;
}

export function mapApiModel(
	model: NeuralwattApiModel,
): NeuralwattModelConfig | null {
	const metadata = model.metadata;
	if (metadata?.deprecated || metadata?.pricing?.pricing_tbd) return null;

	const caps = metadata?.capabilities;
	const pricing = metadata?.pricing;
	const limits = metadata?.limits;
	const reasoning = caps?.reasoning === true;
	const compat: OpenAICompletionsCompat = {
		maxTokensField: "max_tokens",
	};
	if (caps?.developer_role !== true) compat.supportsDeveloperRole = false;
	if (caps?.reasoning_effort === true) compat.supportsReasoningEffort = true;
	if (reasoning) compat.requiresReasoningContentOnAssistantMessages = true;

	return {
		id: model.id,
		name: metadata?.display_name ?? model.id,
		reasoning,
		thinkingLevelMap: buildThinkingLevelMap(model),
		input: caps?.vision === true ? ["text", "image"] : ["text"],
		cost: {
			input: asPrice(pricing?.input_per_million),
			output: asPrice(pricing?.output_per_million),
			cacheRead: asPrice(pricing?.cached_input_per_million),
			cacheWrite: asPrice(pricing?.cached_output_per_million),
		},
		contextWindow: model.max_model_len ?? limits?.max_context_length ?? 131_072,
		maxTokens: limits?.max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
		compat,
	};
}

/*
 * Cached catalogs are read from disk before registration in every session, so
 * a corrupt or partially written cache must degrade to "no models" instead of
 * being cast into model configs unchecked.
 */
export function isNeuralwattModelConfig(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const model = value as Partial<NeuralwattModelConfig>;
	if (typeof model.id !== "string" || model.id.length === 0) return false;
	if (typeof model.name !== "string" || typeof model.reasoning !== "boolean")
		return false;
	if (!Array.isArray(model.input)) return false;
	if (!model.input.every((item) => item === "text" || item === "image"))
		return false;
	const cost = model.cost as Partial<NeuralwattModelConfig["cost"]> | undefined;
	if (!cost || typeof cost !== "object") return false;
	if (![cost.input, cost.output, cost.cacheRead, cost.cacheWrite].every(
		(item) => typeof item === "number" && Number.isFinite(item),
	)) {
		return false;
	}
	if (
		typeof model.contextWindow !== "number" ||
		!Number.isFinite(model.contextWindow) ||
		model.contextWindow <= 0
	) {
		return false;
	}
	if (
		typeof model.maxTokens !== "number" ||
		!Number.isFinite(model.maxTokens) ||
		model.maxTokens <= 0
	) {
		return false;
	}
	if (!model.compat || typeof model.compat !== "object") return false;
	return true;
}

export function parseCachedModels(raw: unknown): NeuralwattModelConfig[] {
	if (!raw || typeof raw !== "object") return [];
	const models = (raw as { models?: unknown }).models;
	if (!Array.isArray(models)) return [];
	return models.filter(isNeuralwattModelConfig) as NeuralwattModelConfig[];
}

export function isFinitePositiveNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function isFiniteNonNegativeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/*
 * Pi treats PI_OFFLINE as set when it is "1", "true", or "yes"
 * (case-insensitive); see pi's CLI help and its own offline checks. Matching
 * that here keeps extension-owned discovery requests suppressed exactly when
 * Pi considers itself offline.
 */
export function isOfflineValue(value: unknown): boolean {
	if (typeof value !== "string" || value === "") return false;
	const normalized = value.toLowerCase();
	return value === "1" || normalized === "true" || normalized === "yes";
}

export function isNeuralwattChatCompletionsUrl(
	input: string | URL | Request,
	providerOrigin: string | undefined,
): boolean {
	let rawUrl: string;
	if (typeof input === "string") rawUrl = input;
	else if (input instanceof URL) rawUrl = input.toString();
	else rawUrl = input.url;
	try {
		const url = new URL(rawUrl);
		return (
			url.origin === providerOrigin && url.pathname.endsWith("/chat/completions")
		);
	} catch {
		return false;
	}
}

export function parseCommentPayload(
	line: string,
): { kind: "energy" | "cost"; value: unknown } | undefined {
	const text = line.trim();
	const match = /^(energy|cost)\s+(\{.*\})$/s.exec(text);
	if (!match) return undefined;
	try {
		return { kind: match[1] as "energy" | "cost", value: JSON.parse(match[2]) };
	} catch {
		return undefined;
	}
}

/*
 * Reads the response body alongside the provider SDK and returns the
 * completion id plus any energy/cost SSE comments. Neuralwatt sends metadata
 * as `: energy {...}` / `: cost {...}` comment lines, which the SDK drops.
 * Any read error or abort ends the loop; the reader lock is always released so
 * the tee branch cannot keep draining after its consumer stops.
 */
export async function readSseMetadata(
	stream: ReadableStream<Uint8Array>,
	onComment: (line: string) => void,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let responseId: string | undefined;
	const onAbort = () => {
		try {
			void reader.cancel().catch(() => undefined);
		} catch {
			// The reader was already released after normal completion.
		}
	};
	if (signal) {
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	}
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
	} catch {
		// Aborted or failed streams simply end metadata capture. The response
		// itself is owned by the SDK branch and is unaffected.
	} finally {
		signal?.removeEventListener("abort", onAbort);
		try {
			reader.releaseLock();
		} catch {
			// The reader may already be released.
		}
	}
	return responseId;
}

/** A completed per-response capture awaiting its `message_end`. */
export interface CapturedRecord {
	record: StreamEnergyRecord;
	responseId?: string;
	capturedAt: number;
}

export const MAX_PENDING_RECORDS = 16;
export const MAX_RECORD_AGE_MS = 60_000;

/** Drops expired and excess captures in place. */
export function pruneCaptures(
	captures: CapturedRecord[],
	now: number,
	maxAgeMs = MAX_RECORD_AGE_MS,
	maxRecords = MAX_PENDING_RECORDS,
): void {
	const cutoff = now - maxAgeMs;
	for (let i = captures.length - 1; i >= 0; i--) {
		if (captures[i].capturedAt < cutoff) captures.splice(i, 1);
	}
	while (captures.length > maxRecords) captures.shift();
}

/*
 * Matches a finished foreground message to its capture by response id only.
 * A capture without a response id, or a message without one, never pairs —
 * interleaved cache-warmer traffic cannot be consumed by the next real
 * response.
 */
export function takeCaptureIndex(
	captures: readonly CapturedRecord[],
	responseId: string | undefined,
	now: number,
	maxAgeMs = MAX_RECORD_AGE_MS,
): number {
	if (!responseId) return -1;
	const cutoff = now - maxAgeMs;
	return captures.findIndex(
		(captured) =>
			captured.capturedAt >= cutoff && captured.responseId === responseId,
	);
}

/*
 * Builds a telemetry record from the captured metadata. Never fabricates a
 * billable request: a missing energy or cost reading is recorded as missing so
 * coverage and provenance stay explicit.
 */
export function buildTelemetry(
	record: StreamEnergyRecord,
	options: {
		modelId: string;
		responseId?: string;
		accountingMethod?: AccountingMethod;
		account?: AccountContext;
		rateUsdPerKwh: number;
		recordedAt?: string;
	},
): ResponseTelemetry {
	return {
		schemaVersion: SCHEMA_VERSION,
		provider: "neuralwatt",
		kind: RESPONSE_TELEMETRY_KIND,
		...(options.responseId ? { responseId: options.responseId } : {}),
		modelId: options.modelId,
		recordedAt: options.recordedAt ?? new Date().toISOString(),
		energy: readEnergy(record.energy),
		cost: readCost(record.cost, record.energy, options),
		...(options.account ? { account: options.account } : {}),
	};
}

function readEnergy(payload: EnergyPayload | undefined): EnergyReading {
	if (!payload) return { status: "missing" };
	if (payload.measurement_available === false) {
		const method = payload.attribution_method;
		return typeof method === "string"
			? { status: "unavailable", attributionMethod: method }
			: { status: "unavailable" };
	}
	const kwh = payload.energy_kwh;
	if (kwh === undefined) return { status: "missing" };
	if (!isFiniteNonNegativeNumber(kwh)) return { status: "invalid" };
	const reading: EnergyReading = { status: "reported", kwh };
	if (typeof payload.attribution_method === "string") {
		reading.attributionMethod = payload.attribution_method;
	}
	if (typeof payload.measurement_available === "boolean") {
		reading.measurementAvailable = payload.measurement_available;
	}
	return reading;
}

function readCost(
	payload: CostPayload | undefined,
	energy: EnergyPayload | undefined,
	options: {
		accountingMethod?: AccountingMethod;
		rateUsdPerKwh: number;
	},
): CostReading {
	const reported = payload?.request_cost_usd;
	if (reported !== undefined) {
		if (!isFiniteNonNegativeNumber(reported)) return { status: "invalid" };
		return { status: "reported", usd: reported };
	}
	/*
	 * Fallback estimates are only defined for a confirmed energy-billing
	 * account with usable reported energy. A token or unknown account keeps
	 * Pi's own estimate rather than receiving an energy-rate figure.
	 */
	const kwh = energy?.energy_kwh;
	if (options.accountingMethod !== "energy") return { status: "missing" };
	if (
		energy?.measurement_available === false ||
		!isFiniteNonNegativeNumber(kwh) ||
		!isFinitePositiveNumber(options.rateUsdPerKwh)
	) {
		return { status: "missing" };
	}
	return {
		status: "estimated",
		usd: kwh * options.rateUsdPerKwh,
		rateUsdPerKwh: options.rateUsdPerKwh,
	};
}

export function isResponseTelemetry(value: unknown): value is ResponseTelemetry {
	if (!value || typeof value !== "object") return false;
	const entry = value as Partial<ResponseTelemetry>;
	if (entry.schemaVersion !== SCHEMA_VERSION) return false;
	if (entry.provider !== "neuralwatt") return false;
	if (entry.kind !== RESPONSE_TELEMETRY_KIND) return false;
	if (typeof entry.modelId !== "string") return false;
	if (typeof entry.recordedAt !== "string") return false;
	if (!isEnergyReading(entry.energy)) return false;
	if (!isCostReading(entry.cost)) return false;
	if (entry.account !== undefined && !isAccountContext(entry.account)) return false;
	return true;
}

export function isEnergyReading(value: unknown): value is EnergyReading {
	if (!value || typeof value !== "object") return false;
	const reading = value as Partial<EnergyReading>;
	if (reading.status === "reported") {
		return isFiniteNonNegativeNumber((reading as { kwh?: unknown }).kwh);
	}
	return (
		reading.status === "missing" ||
		reading.status === "unavailable" ||
		reading.status === "invalid"
	);
}

export function isCostReading(value: unknown): value is CostReading {
	if (!value || typeof value !== "object") return false;
	const reading = value as Partial<CostReading>;
	if (reading.status === "reported") {
		return isFiniteNonNegativeNumber((reading as { usd?: unknown }).usd);
	}
	if (reading.status === "estimated") {
		return (
			isFiniteNonNegativeNumber((reading as { usd?: unknown }).usd) &&
			isFinitePositiveNumber((reading as { rateUsdPerKwh?: unknown }).rateUsdPerKwh)
		);
	}
	return reading.status === "missing" || reading.status === "invalid";
}

function isAccountContext(value: unknown): value is AccountContext {
	if (!value || typeof value !== "object") return false;
	const account = value as Partial<AccountContext>;
	if (typeof account.observedAt !== "string") return false;
	if (
		account.accountingMethod !== undefined &&
		account.accountingMethod !== "energy" &&
		account.accountingMethod !== "token"
	) {
		return false;
	}
	if (account.subscription !== undefined && account.subscription !== null) {
		const sub = account.subscription as Record<string, unknown>;
		if (typeof sub !== "object") return false;
		if (sub.plan !== undefined && typeof sub.plan !== "string") return false;
		if (sub.status !== undefined && typeof sub.status !== "string") return false;
		if (sub.inOverage !== undefined && typeof sub.inOverage !== "boolean")
			return false;
	}
	return true;
}

export function isLegacyEnergyEntry(
	value: unknown,
): value is LegacyEnergyCostEntry {
	if (!value || typeof value !== "object") return false;
	const entry = value as Partial<LegacyEnergyCostEntry>;
	if (
		entry.provider !== "neuralwatt" ||
		entry.kind !== LEGACY_ENERGY_KIND ||
		entry.accountingMethod !== "energy"
	) {
		return false;
	}
	if (!isFinitePositiveNumber(entry.energyKwh)) return false;
	if (!isFiniteNonNegativeNumber(entry.costUsd)) return false;
	if (entry.costSource === "energy-rate") {
		return isFinitePositiveNumber(entry.rateUsdPerKwh);
	}
	return entry.costSource === "reported";
}

/** Any persisted `neuralwatt-energy-cost` payload, new or legacy. */
export function isEnergyCostData(
	value: unknown,
): value is ResponseTelemetry | LegacyEnergyCostEntry {
	return isResponseTelemetry(value) || isLegacyEnergyEntry(value);
}

/**
 * Normalizes a legacy entry into the current schema in memory. Session files
 * are never rewritten and legacy provenance gaps stay unknown.
 */
export function toResponseTelemetry(
	value: ResponseTelemetry | LegacyEnergyCostEntry,
): ResponseTelemetry {
	if (isResponseTelemetry(value)) return value;
	const energy: EnergyReading = { status: "reported", kwh: value.energyKwh };
	const cost: CostReading =
		value.costSource === "reported"
			? { status: "reported", usd: value.costUsd }
			: {
					status: "estimated",
					usd: value.costUsd,
					rateUsdPerKwh: value.rateUsdPerKwh ?? DEFAULT_RATE_USD_PER_KWH,
				};
	return {
		schemaVersion: SCHEMA_VERSION,
		provider: "neuralwatt",
		kind: RESPONSE_TELEMETRY_KIND,
		modelId: value.modelId ?? "unknown",
		recordedAt: value.measuredAt,
		energy,
		cost,
		account: { observedAt: value.measuredAt, accountingMethod: "energy" },
	};
}

export function addTelemetryToTotals(
	totals: Totals,
	telemetry: ResponseTelemetry,
): Totals {
	const next: Totals = {
		...totals,
		responses: totals.responses + 1,
	};
	if (telemetry.energy.status === "reported") {
		const kwh = telemetry.energy.kwh;
		next.energyKwh = totals.energyKwh + kwh;
		next.energyJoules = totals.energyJoules + kwh * 3_600_000;
		next.energyReported = totals.energyReported + 1;
	} else {
		next.energyUnavailable = totals.energyUnavailable + 1;
	}
	if (telemetry.cost.status === "reported") {
		next.costUsd = totals.costUsd + telemetry.cost.usd;
		next.reportedCostUsd = totals.reportedCostUsd + telemetry.cost.usd;
		next.reportedCostResponses = totals.reportedCostResponses + 1;
	} else if (telemetry.cost.status === "estimated") {
		next.costUsd = totals.costUsd + telemetry.cost.usd;
		next.estimatedCostUsd = totals.estimatedCostUsd + telemetry.cost.usd;
		next.estimatedCostResponses = totals.estimatedCostResponses + 1;
	} else {
		next.costMissing = totals.costMissing + 1;
	}
	return next;
}

/*
 * Totals follow the active branch. Rebuilding from every entry in the session
 * file would double-count history abandoned by rewind/fork.
 */
export function totalsFromEntries(
	entries: Iterable<{ type?: string; customType?: string; data?: unknown }>,
): Totals {
	let totals = emptyTotals();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== ENERGY_COST_ENTRY_TYPE)
			continue;
		if (!isEnergyCostData(entry.data)) continue;
		totals = addTelemetryToTotals(totals, toResponseTelemetry(entry.data));
	}
	return totals;
}

export function lastTelemetryFromEntries(
	entries: Iterable<{ type?: string; customType?: string; data?: unknown }>,
): ResponseTelemetry | undefined {
	let last: ResponseTelemetry | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== ENERGY_COST_ENTRY_TYPE)
			continue;
		if (!isEnergyCostData(entry.data)) continue;
		last = toResponseTelemetry(entry.data);
	}
	return last;
}

/*
 * Replaces the token-priced cost on a finalized assistant message with what
 * Neuralwatt actually charged. Pi sums `usage.cost.total` for the footer, so
 * this makes the built-in session cost reflect the bill. Sub-costs are scaled
 * proportionally to keep per-request breakdowns and HTML exports consistent;
 * those sub-costs are allocations, not provider-reported billing breakdowns.
 */
export function withChargedCost(
	message: AssistantMessage,
	costUsd: number,
): AssistantMessage {
	const { cost } = message.usage;
	const tokenTotal = cost.total;
	const scaled: Usage["cost"] =
		tokenTotal > 0
			? {
					input: cost.input * (costUsd / tokenTotal),
					output: cost.output * (costUsd / tokenTotal),
					cacheRead: cost.cacheRead * (costUsd / tokenTotal),
					cacheWrite: cost.cacheWrite * (costUsd / tokenTotal),
					total: costUsd,
				}
			: { input: costUsd, output: 0, cacheRead: 0, cacheWrite: 0, total: costUsd };
	return { ...message, usage: { ...message.usage, cost: scaled } };
}

export function formatUsd(value: number): string {
	if (value > 0 && value < 0.00001) return "<$0.00001";
	if (value > 0 && value < 0.01) return `$${value.toFixed(5)}`;
	return `$${value.toFixed(2)}`;
}

export function formatWh(kwh: number): string {
	const wh = kwh * 1000;
	if (wh === 0) return "0 Wh";
	if (wh > 0 && wh < 0.001) return `${(wh * 1000).toFixed(3)} mWh`;
	if (wh < 1) return `${wh.toFixed(3)} Wh`;
	return `${wh.toFixed(2)} Wh`;
}

export function formatJoules(joules: number): string {
	if (joules >= 1000) return `${(joules / 1000).toFixed(2)} kJ`;
	return `${joules.toFixed(2)} J`;
}

/*
 * Duration split into primary and secondary units. A zero secondary unit is
 * dropped so 2h00 renders as 2h. Compact joins with no separator (2h10);
 * spaced joins with a space and repeats the secondary unit (2h 10m).
 */
function splitSeconds(totalSeconds: number): {
	value: number;
	unit: "h" | "m" | "s";
	remainder?: { value: number; unit: "m" | "s" };
} {
	if (!Number.isFinite(totalSeconds) || totalSeconds <= 0)
		return { value: 0, unit: "s" };
	const seconds = Math.round(totalSeconds);
	if (seconds < 60) return { value: seconds, unit: "s" };
	const minutes = Math.floor(seconds / 60);
	const remSeconds = seconds % 60;
	if (minutes < 60) {
		return remSeconds === 0
			? { value: minutes, unit: "m" }
			: { value: minutes, unit: "m", remainder: { value: remSeconds, unit: "s" } };
	}
	const hours = Math.floor(minutes / 60);
	const remMinutes = minutes % 60;
	return remMinutes === 0
		? { value: hours, unit: "h" }
		: { value: hours, unit: "h", remainder: { value: remMinutes, unit: "m" } };
}

/*
 * A positive sub-second duration must never render as an exact zero. Anything
 * under a second, including values that would round to 0s, shows `<1s`.
 */
export function formatDurationSeconds(
	totalSeconds: number,
	style: "compact" | "spaced" = "compact",
): string {
	if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "0s";
	if (totalSeconds < 1) return "<1s";
	const { value, unit, remainder } = splitSeconds(totalSeconds);
	if (!remainder) return `${value}${unit}`;
	const padded = String(remainder.value).padStart(2, "0");
	return style === "compact"
		? `${value}${unit}${padded}`
		: `${value}${unit} ${padded}${remainder.unit}`;
}

export interface EquivalentPreset {
	id: string;
	icon: string;
	label: string;
	watts: number;
}

/*
 * Default editable comparison presets. `brain` is approximate whole-brain
 * metabolic power (not electrical consumption); `led` is a defined 10 W
 * electrical load; `kettle` is the manufacturer-rated input while heating
 * (Comfee CKT003: 120V~ 60Hz, 1500W), not a measured boil cycle.
 */
export const DEFAULT_PRESETS: readonly EquivalentPreset[] = [
	{ id: "brain", icon: "\u{1F9E0}", label: "Human brain", watts: 20 },
	{ id: "led", icon: "\u{1F4A1}", label: "10 W LED bulb", watts: 10 },
	{ id: "kettle", icon: "\u{1FAD6}", label: "1,500 W electric kettle", watts: 1500 },
];

export const MAX_PRESET_WATTS = 10_000_000;
export const MAX_PRESET_LABEL_LENGTH = 48;
const MAX_PRESET_ICON_LENGTH = 8;

/** Presentation fields must be single-line, control-free, and bounded. */
export function isSafeDisplayString(
	value: unknown,
	maxLength: number,
	{ allowEmpty = false }: { allowEmpty?: boolean } = {},
): value is string {
	if (typeof value !== "string") return false;
	if (!allowEmpty && value.length === 0) return false;
	if (value.length > maxLength) return false;
	if (hasUnsafeCharacters(value)) return false;
	return true;
}

/*
 * Rejects C0/C1 control characters, DEL, and the ESC/CSI introducers used by
 * ANSI escape sequences. Checked by code point rather than a control-character
 * regex so the intent is explicit and lint-clean.
 */
function hasUnsafeCharacters(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (codePoint < 0x20 || codePoint === 0x7f) return true;
		if (codePoint >= 0x80 && codePoint <= 0x9f) return true;
	}
	return false;
}

const KEY_MODIFIERS = ["ctrl", "shift", "alt", "super"] as const;
const KEY_SPECIAL = new Set([
	"escape",
	"esc",
	"enter",
	"return",
	"tab",
	"space",
	"backspace",
	"delete",
	"insert",
	"clear",
	"home",
	"end",
	"pageUp",
	"pageDown",
	"up",
	"down",
	"left",
	"right",
	...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);
const KEY_SYMBOLS = new Set(
	"`-=[]\\;',./!@#$%^&*()_+|~{}:<>?".split(""),
);

/**
 * Validates Pi's KeyId syntax (modifiers joined by `+`, then a base key).
 * Syntax validity does not establish terminal support: a `ctrl+shift+…`
 * binding only fires under the Kitty protocol or modifyOtherKeys.
 */
export function isValidKeyId(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0) return false;
	const parts = value.split("+");
	if (parts.some((part) => part.length === 0)) return false;
	const base = parts.at(-1) ?? "";
	const modifiers = parts.slice(0, -1);
	if (modifiers.length !== new Set(modifiers).size) return false;
	if (
		!modifiers.every((modifier) =>
			(KEY_MODIFIERS as readonly string[]).includes(modifier),
		)
	) {
		return false;
	}
	if (KEY_SPECIAL.has(base)) return true;
	if (/^[a-z0-9]$/.test(base)) return true;
	return KEY_SYMBOLS.has(base);
}

export function isValidPresetId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 48 &&
		/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)
	);
}

export function isValidEquivalentPreset(
	value: unknown,
): value is EquivalentPreset {
	if (!value || typeof value !== "object") return false;
	const preset = value as Partial<EquivalentPreset>;
	if (!isValidPresetId(preset.id)) return false;
	if (!isSafeDisplayString(preset.label, MAX_PRESET_LABEL_LENGTH)) return false;
	if (!isSafeDisplayString(preset.icon, MAX_PRESET_ICON_LENGTH, { allowEmpty: true }))
		return false;
	if (
		!isFinitePositiveNumber(preset.watts) ||
		(preset.watts as number) > MAX_PRESET_WATTS
	) {
		return false;
	}
	return true;
}

/** Validates and de-duplicates a preset catalog by id, preserving order. */
export function sanitizePresets(value: unknown): EquivalentPreset[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const seen = new Set<string>();
	const out: EquivalentPreset[] = [];
	for (const item of value) {
		if (!isValidEquivalentPreset(item)) continue;
		if (seen.has(item.id)) continue;
		seen.add(item.id);
		out.push({
			id: item.id,
			icon: item.icon,
			label: item.label,
			watts: item.watts,
		});
	}
	return out;
}

export function findPreset(
	presets: readonly EquivalentPreset[],
	id: string,
): EquivalentPreset | undefined {
	return presets.find((preset) => preset.id === id);
}

/** Seconds a constant `watts` load would take to consume `kwh`. */
export function equivalentSeconds(
	kwh: number,
	watts: number,
): number | undefined {
	if (!isFiniteNonNegativeNumber(kwh) || !isFinitePositiveNumber(watts))
		return undefined;
	return (kwh * 3_600_000) / watts;
}

export function formatEquivalent(
	kwh: number,
	preset: EquivalentPreset,
): string | undefined {
	const seconds = equivalentSeconds(kwh, preset.watts);
	if (seconds === undefined) return undefined;
	const duration = formatDurationSeconds(seconds, "compact");
	return preset.icon ? `${preset.icon} ${duration}` : duration;
}

export function formatEquivalentDetail(
	kwh: number,
	preset: EquivalentPreset,
): string | undefined {
	const seconds = equivalentSeconds(kwh, preset.watts);
	if (seconds === undefined) return undefined;
	const duration = formatDurationSeconds(seconds, "spaced");
	return preset.icon
		? `${preset.icon} ${duration} ${preset.label}`
		: `${duration} ${preset.label}`;
}

export type EnergyStatusMode = "session" | "last" | "both";

export const THEME_COLORS = [
	"dim",
	"muted",
	"text",
	"accent",
	"success",
	"warning",
	"error",
] as const;

export type ThemeColorName = (typeof THEME_COLORS)[number];

export interface NeuralwattSettings {
	settingsVersion: 2;
	/** Master switch for extension-owned automatic energy UI. */
	energyUiEnabled: boolean;
	energyStatus: EnergyStatusMode;
	energyColor: ThemeColorName;
	/** Ordered list of enabled preset ids. */
	equivalents: string[];
	/** Editable preset catalog; an absent field means defaults. */
	equivalentPresets: EquivalentPreset[];
	patchPiCost: boolean;
	perResponseLine: boolean;
	fallbackRateUsdPerKwh: number;
	/** KeyId string, or null to disable. Applied on load only. */
	toggleShortcut: string | null;
}

export const DEFAULT_SETTINGS: NeuralwattSettings = {
	settingsVersion: 2,
	energyUiEnabled: true,
	energyStatus: "session",
	energyColor: "dim",
	equivalents: [],
	equivalentPresets: DEFAULT_PRESETS.map((preset) => ({ ...preset })),
	patchPiCost: true,
	perResponseLine: false,
	fallbackRateUsdPerKwh: DEFAULT_RATE_USD_PER_KWH,
	toggleShortcut: DEFAULT_TOGGLE_SHORTCUT,
};

function isEnergyStatusMode(value: unknown): value is EnergyStatusMode {
	return value === "session" || value === "last" || value === "both";
}

export function isThemeColorName(value: unknown): value is ThemeColorName {
	return (
		typeof value === "string" &&
		(THEME_COLORS as readonly string[]).includes(value)
	);
}

/*
 * Settings parsing never throws and never returns a partially applied
 * catalog. Prototype-chain keys are ignored by copying onto a fresh object and
 * reading unknown fields from a plain record.
 */
export function parseSettings(raw: unknown): NeuralwattSettings {
	const settings: NeuralwattSettings = {
		...DEFAULT_SETTINGS,
		equivalents: [...DEFAULT_SETTINGS.equivalents],
		equivalentPresets: DEFAULT_SETTINGS.equivalentPresets.map((preset) => ({
			...preset,
		})),
	};
	if (!raw || typeof raw !== "object") return settings;
	const value = raw as Record<string, unknown>;

	/*
	 * `equivalentPresets` is catalog identity, not presentation. An absent
	 * field means defaults; an explicitly empty array means an intentionally
	 * empty catalog.
	 */
	const presets = sanitizePresets(value.equivalentPresets);
	if (presets !== undefined) settings.equivalentPresets = presets;

	const presetIds = new Set(settings.equivalentPresets.map((preset) => preset.id));
	if (Array.isArray(value.equivalents)) {
		const seen = new Set<string>();
		settings.equivalents = value.equivalents.filter((id): id is string => {
			if (!isValidPresetId(id) || seen.has(id)) return false;
			if (!presetIds.has(id)) return false;
			seen.add(id);
			return true;
		});
	}

	const legacyStatus = value.energyStatus;
	if (typeof value.energyUiEnabled === "boolean") {
		settings.energyUiEnabled = value.energyUiEnabled;
	}
	if (isEnergyStatusMode(legacyStatus)) {
		settings.energyStatus = legacyStatus;
	} else if (legacyStatus === "off") {
		/*
		 * `off` was a second competing visibility switch. Fold it into the
		 * master switch and keep a concrete status mode underneath so toggling
		 * back on restores a sensible value.
		 */
		settings.energyUiEnabled = false;
		settings.energyStatus = "session";
	} else {
		settings.energyStatus = "session";
	}

	if (isThemeColorName(value.energyColor)) settings.energyColor = value.energyColor;
	if (typeof value.patchPiCost === "boolean") settings.patchPiCost = value.patchPiCost;
	if (typeof value.perResponseLine === "boolean") {
		settings.perResponseLine = value.perResponseLine;
	}
	if (isFinitePositiveNumber(value.fallbackRateUsdPerKwh)) {
		settings.fallbackRateUsdPerKwh = value.fallbackRateUsdPerKwh;
	}
	if (value.toggleShortcut === null) settings.toggleShortcut = null;
	else if (typeof value.toggleShortcut === "string") {
		settings.toggleShortcut = value.toggleShortcut;
	}
	return settings;
}

export interface EffectiveRate {
	rateUsdPerKwh: number;
	source: "environment" | "settings";
}

/** Resolves the effective fallback/comparison rate and where it came from. */
export function resolveEffectiveRate(
	settings: Pick<NeuralwattSettings, "fallbackRateUsdPerKwh">,
	envValue: unknown,
): EffectiveRate {
	const parsed =
		typeof envValue === "string" && envValue.trim() !== ""
			? Number(envValue)
			: Number.NaN;
	if (isFinitePositiveNumber(parsed)) {
		return { rateUsdPerKwh: parsed, source: "environment" };
	}
	return { rateUsdPerKwh: settings.fallbackRateUsdPerKwh, source: "settings" };
}

export function formatStatusText(
	totals: Totals,
	last: ResponseTelemetry | undefined,
	settings: NeuralwattSettings,
	mark = "\u26A1\uFE0F",
): string | undefined {
	if (!settings.energyUiEnabled) return undefined;
	const usingLast = settings.energyStatus === "last";

	const lastReported = last?.energy.status === "reported" ? last.energy.kwh : 0;
	const energyKwh = usingLast ? lastReported : totals.energyKwh;
	const parts = [`${mark} ${formatWh(energyKwh)}`];

	if (settings.energyStatus === "both" && last?.energy.status === "reported") {
		parts.push(`(+${formatWh(last.energy.kwh)})`);
	}
	if (!usingLast) {
		for (const id of settings.equivalents) {
			const preset = findPreset(settings.equivalentPresets, id);
			if (!preset) continue;
			const equivalent = formatEquivalent(totals.energyKwh, preset);
			if (equivalent) parts.push(`\u00B7 ${equivalent}`);
		}
	}
	return parts.join(" ");
}

/*
 * Width-aware truncation. Pi exposes width helpers in its nested pi-tui
 * dependency; this package implements a small grapheme-aware equivalent in
 * pure logic so custom preset labels and emoji respect the terminal without a
 * new dependency. Wide and emoji graphemes count as two cells.
 */
function graphemeWidth(grapheme: string): number {
	const codePoints = [...grapheme];
	if (codePoints.length === 0) return 0;
	let base = 0;
	let wide = false;
	for (const character of codePoints) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (isCombiningMark(codePoint)) continue;
		if (isWideCodePoint(codePoint)) wide = true;
		else base += 1;
	}
	// An emoji or wide sequence occupies two cells regardless of extra ZWJ parts.
	return wide ? 2 : base;
}

function isCombiningMark(codePoint: number): boolean {
	return (
		(codePoint >= 0x0300 && codePoint <= 0x036f) ||
		(codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
		(codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
		(codePoint >= 0xfe20 && codePoint <= 0xfe2f) ||
		codePoint === 0xfe0f ||
		codePoint === 0x200d
	);
}

function isWideCodePoint(codePoint: number): boolean {
	return (
		(codePoint >= 0x1100 && codePoint <= 0x115f) ||
		(codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
		(codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
		(codePoint >= 0xf900 && codePoint <= 0xfaff) ||
		(codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
		(codePoint >= 0xff00 && codePoint <= 0xff60) ||
		(codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
		(codePoint >= 0x1f000 && codePoint <= 0x1faff) ||
		(codePoint >= 0x20000 && codePoint <= 0x3fffd)
	);
}

export function visibleWidth(text: string): number {
	let width = 0;
	for (const grapheme of segmentGraphemes(text)) width += graphemeWidth(grapheme);
	return width;
}

function segmentGraphemes(text: string): string[] {
	// SAFETY: Segmenter is standard in every Node version Pi supports; the cast
	// only narrows the lib typing (ES2023 here) so the optional path typechecks.
	const segmenter = (
		Intl as {
			Segmenter?: new (
				locale?: string,
				options?: { granularity: string },
			) => { segment: (input: string) => Iterable<{ segment: string }> };
		}
	).Segmenter;
	if (segmenter) {
		const instance = new segmenter(undefined, { granularity: "grapheme" });
		return Array.from(instance.segment(text), (item) => item.segment);
	}
	return [...text];
}

export function truncateVisible(
	text: string,
	maxWidth: number,
	ellipsis = "\u2026",
): string {
	if (maxWidth <= 0) return "";
	if (visibleWidth(text) <= maxWidth) return text;
	const ellipsisWidth = visibleWidth(ellipsis);
	let width = 0;
	let out = "";
	for (const grapheme of segmentGraphemes(text)) {
		const next = width + graphemeWidth(grapheme);
		if (next + ellipsisWidth > maxWidth) break;
		out += grapheme;
		width = next;
	}
	return `${out}${ellipsis}`;
}
