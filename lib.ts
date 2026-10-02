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

export const ENERGY_COST_ENTRY_TYPE = "neuralwatt-energy-cost";
export const DEFAULT_RATE_USD_PER_KWH = 10;
export const DEFAULT_MAX_OUTPUT_TOKENS = 65_536;

export type AccountingMethod = "energy" | "token";
export type CostSource = "reported" | "energy-rate";

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
		limits?: {
			max_context_length?: number | null;
			max_output_tokens?: number | null;
		};
	};
}

export interface EnergyPayload {
	energy_kwh?: number;
	energy_joules?: number;
	measurement_available?: boolean;
	attribution_method?: string;
}

export interface CostPayload {
	request_cost_usd?: number;
	cache_savings_usd?: number;
}

export interface StreamEnergyRecord {
	energy?: EnergyPayload;
	cost?: CostPayload;
}

export interface ChargedCost {
	costUsd: number;
	source: CostSource;
}

export interface EnergyCostEntry {
	provider: "neuralwatt";
	kind: "response-energy";
	energyKwh: number;
	energyJoules?: number;
	costUsd: number;
	costSource: CostSource;
	/** Only present when the cost came from the fallback energy rate. */
	rateUsdPerKwh?: number;
	accountingMethod: "energy";
	modelId?: string;
	measuredAt: string;
}

export interface Totals {
	requests: number;
	energyKwh: number;
	energyJoules: number;
	costUsd: number;
	reportedCostRequests: number;
	estimatedCostRequests: number;
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
		requests: 0,
		energyKwh: 0,
		energyJoules: 0,
		costUsd: 0,
		reportedCostRequests: 0,
		estimatedCostRequests: 0,
	};
}

export function asPrice(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: 0;
}

export function buildThinkingLevelMap(
	model: NeuralwattApiModel,
): ThinkingLevelMap | undefined {
	const caps = model.metadata?.capabilities;
	if (caps?.reasoning !== true) return undefined;
	if (caps.reasoning_effort === true) {
		return {
			off: "none",
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			xhigh: "max",
		};
	}
	return {
		minimal: null,
		low: null,
		medium: "medium",
		high: null,
		xhigh: null,
	};
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

export function isFinitePositiveNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function isFiniteNonNegativeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isNeuralwattChatCompletionsUrl(
	input: string | URL | Request,
	providerOrigin: string | undefined,
): boolean {
	const rawUrl =
		typeof input === "string"
			? input
			: input instanceof URL
				? input.toString()
				: input.url;
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
 * Neuralwatt reports the charged cost for every response in a `: cost` SSE
 * comment: measured energy times the flex multiplier times the account's
 * $/kWh, capped at the token price for the request. That figure is the source
 * of truth; the energy-rate fallback only covers responses whose comment is
 * missing.
 */
export function resolveChargedCost(
	record: StreamEnergyRecord,
	accountingMethod: AccountingMethod | undefined,
	rateUsdPerKwh: number,
): ChargedCost | undefined {
	const reported = record.cost?.request_cost_usd;
	if (isFiniteNonNegativeNumber(reported)) {
		return { costUsd: reported, source: "reported" };
	}
	if (accountingMethod !== "energy") return undefined;
	const energyKwh = record.energy?.energy_kwh;
	if (!isFinitePositiveNumber(energyKwh)) return undefined;
	return { costUsd: energyKwh * rateUsdPerKwh, source: "energy-rate" };
}

export function makeEntry(
	record: StreamEnergyRecord,
	accountingMethod: AccountingMethod | undefined,
	rateUsdPerKwh: number,
	modelId?: string,
): EnergyCostEntry | undefined {
	if (accountingMethod !== "energy") return undefined;
	const energyKwh = record.energy?.energy_kwh;
	if (!isFinitePositiveNumber(energyKwh)) return undefined;
	const charged = resolveChargedCost(record, accountingMethod, rateUsdPerKwh);
	if (!charged) return undefined;
	const energyJoules = record.energy?.energy_joules;
	return {
		provider: "neuralwatt",
		kind: "response-energy",
		energyKwh,
		...(isFinitePositiveNumber(energyJoules) ? { energyJoules } : {}),
		costUsd: charged.costUsd,
		costSource: charged.source,
		...(charged.source === "energy-rate" ? { rateUsdPerKwh } : {}),
		accountingMethod: "energy",
		...(modelId ? { modelId } : {}),
		measuredAt: new Date().toISOString(),
	};
}

/*
 * Replaces the token-priced cost on a finalized assistant message with what
 * Neuralwatt actually charged. Pi sums `usage.cost.total` for the footer, so
 * this makes the built-in session cost reflect the bill. Sub-costs are scaled
 * proportionally to keep per-request breakdowns and HTML exports consistent.
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

export function isEnergyCostEntry(value: unknown): value is EnergyCostEntry {
	if (!value || typeof value !== "object") return false;
	const entry = value as Partial<EnergyCostEntry>;
	if (
		entry.provider !== "neuralwatt" ||
		entry.kind !== "response-energy" ||
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

export function addEntryToTotals(
	totals: Totals,
	entry: EnergyCostEntry,
): Totals {
	return {
		requests: totals.requests + 1,
		energyKwh: totals.energyKwh + entry.energyKwh,
		energyJoules:
			totals.energyJoules + (entry.energyJoules ?? entry.energyKwh * 3_600_000),
		costUsd: totals.costUsd + entry.costUsd,
		reportedCostRequests:
			totals.reportedCostRequests + (entry.costSource === "reported" ? 1 : 0),
		estimatedCostRequests:
			totals.estimatedCostRequests + (entry.costSource === "energy-rate" ? 1 : 0),
	};
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
		if (!isEnergyCostEntry(entry.data)) continue;
		totals = addEntryToTotals(totals, entry.data);
	}
	return totals;
}

export function lastEntryFromEntries(
	entries: Iterable<{ type?: string; customType?: string; data?: unknown }>,
): EnergyCostEntry | undefined {
	let last: EnergyCostEntry | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== ENERGY_COST_ENTRY_TYPE)
			continue;
		if (!isEnergyCostEntry(entry.data)) continue;
		last = entry.data;
	}
	return last;
}

export function formatUsd(value: number): string {
	if (value > 0 && value < 0.00001) return "<$0.00001";
	if (value < 0.01) return `$${value.toFixed(5)}`;
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

export type EquivalentId = keyof typeof EQUIVALENTS;

/*
 * Everyday comparisons for accumulated session energy. Rates are energy per
 * minute of the activity. Doomscrolling is the commonly cited ~25 W
 * phone-plus-network figure; a human brain runs on about 20 W.
 */
export const EQUIVALENTS = {
	doomscroll: {
		label: "doomscrolling",
		icon: "\u{1F4F1}",
		description: "doomscrolling on an iPhone 15",
		whPerMinute: 0.416,
	},
	brain: {
		label: "human brain",
		icon: "\u{1F9E0}",
		description: "powering a human brain",
		whPerMinute: 0.333,
	},
	led: {
		label: "10 W LED bulb",
		icon: "\u{1F4A1}",
		description: "running a 10 W LED bulb",
		whPerMinute: 1 / 6,
	},
} as const;

export function isEquivalentId(value: unknown): value is EquivalentId {
	return typeof value === "string" && value in EQUIVALENTS;
}

/*
 * Duration split into primary and secondary units. A zero secondary unit is
 * dropped so 2h00 renders as 2h. Compact joins with no separator (2h10);
 * spaced joins with a space and repeats the secondary unit (2h 10m).
 */
function splitDuration(minutes: number): {
	value: number;
	unit: "h" | "m" | "s";
	remainder?: { value: number; unit: "m" | "s" };
} {
	if (!Number.isFinite(minutes) || minutes <= 0) return { value: 0, unit: "s" };
	const totalSeconds = Math.round(minutes * 60);
	if (totalSeconds < 60) return { value: totalSeconds, unit: "s" };
	const totalMinutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (totalMinutes < 60) {
		return seconds === 0
			? { value: totalMinutes, unit: "m" }
			: {
					value: totalMinutes,
					unit: "m",
					remainder: { value: seconds, unit: "s" },
				};
	}
	const hours = Math.floor(totalMinutes / 60);
	const mins = totalMinutes % 60;
	return mins === 0
		? { value: hours, unit: "h" }
		: { value: hours, unit: "h", remainder: { value: mins, unit: "m" } };
}

export function formatCompactDuration(minutes: number): string {
	const { value, unit, remainder } = splitDuration(minutes);
	return remainder
		? `${value}${unit}${String(remainder.value).padStart(2, "0")}`
		: `${value}${unit}`;
}

export function formatSpacedDuration(minutes: number): string {
	const { value, unit, remainder } = splitDuration(minutes);
	return remainder
		? `${value}${unit} ${String(remainder.value).padStart(2, "0")}${remainder.unit}`
		: `${value}${unit}`;
}

export function formatEquivalent(
	kwh: number,
	id: EquivalentId,
): string | undefined {
	const rate = EQUIVALENTS[id]?.whPerMinute;
	if (!isFinitePositiveNumber(rate) || !isFiniteNonNegativeNumber(kwh)) {
		return undefined;
	}
	const minutes = (kwh * 1000) / rate;
	return `${EQUIVALENTS[id].icon} ${formatCompactDuration(minutes)}`;
}

/* Verbose form for /neuralwatt:cost, where the activity is spelled out. */
export function formatEquivalentDetail(
	kwh: number,
	id: EquivalentId,
): string | undefined {
	const rate = EQUIVALENTS[id]?.whPerMinute;
	if (!isFinitePositiveNumber(rate) || !isFiniteNonNegativeNumber(kwh)) {
		return undefined;
	}
	const minutes = (kwh * 1000) / rate;
	const { icon, description } = EQUIVALENTS[id];
	return `${icon} ${formatSpacedDuration(minutes)} ${description}`;
}

export type EnergyStatusMode = "session" | "last" | "both" | "off";

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
	energyStatus: EnergyStatusMode;
	energyColor: ThemeColorName;
	equivalents: EquivalentId[];
	patchPiCost: boolean;
	perResponseLine: boolean;
	fallbackRateUsdPerKwh: number;
}

export const DEFAULT_SETTINGS: NeuralwattSettings = {
	energyStatus: "session",
	energyColor: "dim",
	equivalents: [],
	patchPiCost: true,
	perResponseLine: false,
	fallbackRateUsdPerKwh: DEFAULT_RATE_USD_PER_KWH,
};

function isEnergyStatusMode(value: unknown): value is EnergyStatusMode {
	return (
		value === "session" ||
		value === "last" ||
		value === "both" ||
		value === "off"
	);
}

export function isThemeColorName(value: unknown): value is ThemeColorName {
	return (
		typeof value === "string" &&
		(THEME_COLORS as readonly string[]).includes(value)
	);
}

export function parseSettings(raw: unknown): NeuralwattSettings {
	const settings: NeuralwattSettings = {
		...DEFAULT_SETTINGS,
		equivalents: [...DEFAULT_SETTINGS.equivalents],
	};
	if (!raw || typeof raw !== "object") return settings;
	const value = raw as Record<string, unknown>;
	if (isEnergyStatusMode(value.energyStatus)) {
		settings.energyStatus = value.energyStatus;
	}
	if (isThemeColorName(value.energyColor)) {
		settings.energyColor = value.energyColor;
	}
	if (Array.isArray(value.equivalents)) {
		settings.equivalents = value.equivalents.filter(isEquivalentId);
	}
	if (typeof value.patchPiCost === "boolean") {
		settings.patchPiCost = value.patchPiCost;
	}
	if (typeof value.perResponseLine === "boolean") {
		settings.perResponseLine = value.perResponseLine;
	}
	if (isFinitePositiveNumber(value.fallbackRateUsdPerKwh)) {
		settings.fallbackRateUsdPerKwh = value.fallbackRateUsdPerKwh;
	}
	return settings;
}

export function formatStatusText(
	totals: Totals,
	last: EnergyCostEntry | undefined,
	settings: NeuralwattSettings,
	mark = "\u26A1\uFE0F",
): string | undefined {
	if (settings.energyStatus === "off") return undefined;
	const energyKwh =
		settings.energyStatus === "last" ? (last?.energyKwh ?? 0) : totals.energyKwh;
	const parts = [`${mark} ${formatWh(energyKwh)}`];
	if (settings.energyStatus === "both" && last) {
		parts.push(`(+${formatWh(last.energyKwh)})`);
	}
	if (settings.energyStatus !== "last") {
		for (const id of settings.equivalents) {
			const equivalent = formatEquivalent(totals.energyKwh, id);
			if (equivalent) parts.push(`\u00B7 ${equivalent}`);
		}
	}
	return parts.join(" ");
}
