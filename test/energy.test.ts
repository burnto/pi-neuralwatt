import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	DEFAULT_RATE_USD_PER_KWH,
	ENERGY_COST_ENTRY_TYPE,
	type LegacyEnergyCostEntry,
	type ResponseTelemetry,
	type StreamEnergyRecord,
	addTelemetryToTotals,
	buildTelemetry,
	emptyTotals,
	isEnergyCostData,
	isLegacyEnergyEntry,
	isResponseTelemetry,
	lastTelemetryFromEntries,
	toResponseTelemetry,
	totalsFromEntries,
	withChargedCost,
} from "../lib.ts";

const RATE = 10;
const NOW = "2026-01-01T00:00:00.000Z";

const telemetry = (
	overrides: Partial<ResponseTelemetry> = {},
): ResponseTelemetry => ({
	schemaVersion: 2,
	provider: "neuralwatt",
	kind: "response-telemetry",
	modelId: "deepseek-v4-flash",
	recordedAt: NOW,
	energy: { status: "reported", kwh: 0.001 },
	cost: { status: "reported", usd: 0.01 },
	...overrides,
});

const legacy = (
	overrides: Partial<LegacyEnergyCostEntry> = {},
): LegacyEnergyCostEntry => ({
	provider: "neuralwatt",
	kind: "response-energy",
	energyKwh: 0.001,
	costUsd: 0.01,
	costSource: "reported",
	accountingMethod: "energy",
	measuredAt: NOW,
	...overrides,
});

const customEntry = (data: unknown) => ({
	type: "custom",
	customType: ENERGY_COST_ENTRY_TYPE,
	data,
});

describe("buildTelemetry", () => {
	it("records reported energy and cost with provenance", () => {
		const record: StreamEnergyRecord = {
			energy: {
				energy_kwh: 0.1,
				attribution_method: "measured",
				measurement_available: true,
			},
			cost: { request_cost_usd: 0.42 },
		};
		const out = buildTelemetry(record, {
			modelId: "m",
			responseId: "resp-1",
			accountingMethod: "energy",
			rateUsdPerKwh: RATE,
			recordedAt: NOW,
		});
		expect(out.energy).toEqual({
			status: "reported",
			kwh: 0.1,
			attributionMethod: "measured",
			measurementAvailable: true,
		});
		// Reported energy and cost are independent: no local estimate is invented.
		expect(out.cost).toEqual({ status: "reported", usd: 0.42 });
		expect(out.responseId).toBe("resp-1");
		expect(out.schemaVersion).toBe(2);
	});

	it("accepts a reported zero cost as meaningful", () => {
		const out = buildTelemetry(
			{ energy: { energy_kwh: 0.1 }, cost: { request_cost_usd: 0 } },
			{ modelId: "m", accountingMethod: "energy", rateUsdPerKwh: RATE, recordedAt: NOW },
		);
		expect(out.cost).toEqual({ status: "reported", usd: 0 });
	});

	it("marks unavailable energy without treating it as a verified measurement", () => {
		const out = buildTelemetry(
			{ energy: { measurement_available: false, energy_kwh: 0.5 } },
			{ modelId: "m", accountingMethod: "energy", rateUsdPerKwh: RATE, recordedAt: NOW },
		);
		expect(out.energy.status).toBe("unavailable");
		// A contradictory payload is not converted into an energy-rate estimate.
		expect(out.cost.status).toBe("missing");
	});

	it("records missing, invalid, and absent metadata distinctly", () => {
		expect(
			buildTelemetry({}, { modelId: "m", rateUsdPerKwh: RATE, recordedAt: NOW }).energy,
		).toEqual({ status: "missing" });
		expect(
			buildTelemetry(
				{ energy: { energy_kwh: -1 } },
				{ modelId: "m", rateUsdPerKwh: RATE, recordedAt: NOW },
			).energy,
		).toEqual({ status: "invalid" });
		expect(
			buildTelemetry(
				{ energy: { energy_kwh: Number.NaN } },
				{ modelId: "m", rateUsdPerKwh: RATE, recordedAt: NOW },
			).energy,
		).toEqual({ status: "invalid" });
	});

	it("estimates cost from energy only for a confirmed energy account", () => {
		const record: StreamEnergyRecord = { energy: { energy_kwh: 0.2 } };
		expect(
			buildTelemetry(record, {
				modelId: "m",
				accountingMethod: "energy",
				rateUsdPerKwh: RATE,
				recordedAt: NOW,
			}).cost,
		).toEqual({ status: "estimated", usd: 2, rateUsdPerKwh: RATE });
		expect(
			buildTelemetry(record, {
				modelId: "m",
				accountingMethod: "token",
				rateUsdPerKwh: RATE,
				recordedAt: NOW,
			}).cost.status,
		).toBe("missing");
		expect(
			buildTelemetry(record, {
				modelId: "m",
				accountingMethod: undefined,
				rateUsdPerKwh: RATE,
				recordedAt: NOW,
			}).cost.status,
		).toBe("missing");
	});

	it("keeps token-account reported energy but no energy-rate cost", () => {
		const out = buildTelemetry(
			{ energy: { energy_kwh: 0.3 } },
			{ modelId: "m", accountingMethod: "token", rateUsdPerKwh: RATE, recordedAt: NOW },
		);
		expect(out.energy).toEqual({ status: "reported", kwh: 0.3 });
		expect(out.cost.status).toBe("missing");
	});

	it("carries account context, preserving an explicit null subscription", () => {
		const account = {
			observedAt: NOW,
			accountingMethod: "token" as const,
			subscription: null,
		};
		const out = buildTelemetry(
			{},
			{ modelId: "m", account, rateUsdPerKwh: RATE, recordedAt: NOW },
		);
		expect(out.account).toEqual(account);
	});
});

describe("isResponseTelemetry / isLegacyEnergyEntry / isEnergyCostData", () => {
	it("accepts well-formed v2 telemetry", () => {
		expect(isResponseTelemetry(telemetry())).toBe(true);
	});

	it("rejects malformed v2 telemetry", () => {
		expect(isResponseTelemetry(null)).toBe(false);
		expect(isResponseTelemetry({ ...telemetry(), schemaVersion: 1 })).toBe(false);
		expect(isResponseTelemetry({ ...telemetry(), provider: "x" })).toBe(false);
		expect(isResponseTelemetry({ ...telemetry(), energy: { status: "reported" } })).toBe(false);
		expect(
			isResponseTelemetry({ ...telemetry(), energy: { status: "reported", kwh: -1 } }),
		).toBe(false);
		expect(isResponseTelemetry({ ...telemetry(), cost: { status: "reported", usd: NaN } })).toBe(
			false,
		);
		expect(
			isResponseTelemetry({
				...telemetry(),
				cost: { status: "estimated", usd: 1 },
			}),
		).toBe(false);
	});

	it("accepts legacy entries and rejects malformed ones", () => {
		expect(isLegacyEnergyEntry(legacy())).toBe(true);
		expect(
			isLegacyEnergyEntry(legacy({ costSource: "energy-rate", rateUsdPerKwh: RATE })),
		).toBe(true);
		expect(isLegacyEnergyEntry(legacy({ costSource: "energy-rate" }))).toBe(false);
		expect(isLegacyEnergyEntry(legacy({ energyKwh: 0 }))).toBe(false);
		expect(isLegacyEnergyEntry(legacy({ costUsd: -1 }))).toBe(false);
		expect(isLegacyEnergyEntry({ ...legacy(), accountingMethod: "token" })).toBe(false);
	});

	it("treats both generations as energy-cost data", () => {
		expect(isEnergyCostData(telemetry())).toBe(true);
		expect(isEnergyCostData(legacy())).toBe(true);
		expect(isEnergyCostData({ nonsense: true })).toBe(false);
	});
});

describe("toResponseTelemetry (legacy migration)", () => {
	it("maps a legacy reported entry without rewriting provenance", () => {
		const out = toResponseTelemetry(legacy());
		expect(out.schemaVersion).toBe(2);
		expect(out.energy).toEqual({ status: "reported", kwh: 0.001 });
		expect(out.cost).toEqual({ status: "reported", usd: 0.01 });
		expect(out.account?.accountingMethod).toBe("energy");
		expect(out.responseId).toBeUndefined();
	});

	it("preserves the original fallback rate on a legacy estimate", () => {
		const out = toResponseTelemetry(
			legacy({ costSource: "energy-rate", rateUsdPerKwh: 5, costUsd: 0.005 }),
		);
		expect(out.cost).toEqual({
			status: "estimated",
			usd: 0.005,
			rateUsdPerKwh: 5,
		});
	});

	it("passes v2 telemetry through unchanged", () => {
		const value = telemetry();
		expect(toResponseTelemetry(value)).toBe(value);
	});
});

describe("addTelemetryToTotals / emptyTotals", () => {
	it("starts at zero", () => {
		expect(emptyTotals()).toEqual({
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
		});
	});

	it("keeps energy and cost coverage independent", () => {
		let totals = emptyTotals();
		// energy only
		totals = addTelemetryToTotals(
			totals,
			telemetry({ cost: { status: "missing" } }),
		);
		// cost only (no energy)
		totals = addTelemetryToTotals(
			totals,
			telemetry({ energy: { status: "missing" } }),
		);
		// neither
		totals = addTelemetryToTotals(
			totals,
			telemetry({ energy: { status: "unavailable" }, cost: { status: "invalid" } }),
		);
		expect(totals.responses).toBe(3);
		expect(totals.energyReported).toBe(1);
		expect(totals.energyUnavailable).toBe(2);
		expect(totals.reportedCostResponses).toBe(1);
		expect(totals.costMissing).toBe(2);
		expect(totals.reportedCostUsd).toBeCloseTo(0.01, 10);
		expect(totals.costUsd).toBeCloseTo(0.01, 10);
	});

	it("separates reported from estimated cost and derives joules", () => {
		let totals = emptyTotals();
		totals = addTelemetryToTotals(
			totals,
			telemetry({ energy: { status: "reported", kwh: 0.5 }, cost: { status: "reported", usd: 1 } }),
		);
		totals = addTelemetryToTotals(
			totals,
			telemetry({
				energy: { status: "reported", kwh: 0.1 },
				cost: { status: "estimated", usd: 1, rateUsdPerKwh: RATE },
			}),
		);
		expect(totals.energyKwh).toBeCloseTo(0.6, 10);
		expect(totals.energyJoules).toBeCloseTo(2_160_000, 6);
		expect(totals.reportedCostUsd).toBe(1);
		expect(totals.estimatedCostUsd).toBe(1);
		expect(totals.costUsd).toBe(2);
	});

	it("does not mutate the input", () => {
		const base = emptyTotals();
		addTelemetryToTotals(base, telemetry());
		expect(base).toEqual(emptyTotals());
	});
});

describe("totalsFromEntries / lastTelemetryFromEntries", () => {
	it("sums new and legacy records together without double counting", () => {
		const totals = totalsFromEntries([
			customEntry(telemetry({ energy: { status: "reported", kwh: 0.1 }, cost: { status: "reported", usd: 0.2 } })),
			{ type: "message", customType: ENERGY_COST_ENTRY_TYPE, data: telemetry() },
			{ type: "custom", customType: "other", data: telemetry() },
			customEntry({ nonsense: true }),
			customEntry(legacy({ energyKwh: 0.2, costUsd: 0.4 })),
		]);
		expect(totals.responses).toBe(2);
		expect(totals.energyKwh).toBeCloseTo(0.3, 10);
		expect(totals.costUsd).toBeCloseTo(0.6, 10);
		expect(totals.reportedCostResponses).toBe(2);
	});

	it("returns zero totals for empty input", () => {
		expect(totalsFromEntries([])).toEqual(emptyTotals());
	});

	it("returns the last migrated record", () => {
		const first = telemetry({ energy: { status: "reported", kwh: 0.1 } });
		const last = telemetry({ energy: { status: "reported", kwh: 0.2 } });
		const out = lastTelemetryFromEntries([
			customEntry(first),
			customEntry({ bad: true }),
			customEntry(last),
		]);
		expect(out?.energy).toEqual({ status: "reported", kwh: 0.2 });
		expect(lastTelemetryFromEntries([])).toBeUndefined();
	});

	it("migrates a legacy record on read", () => {
		const out = lastTelemetryFromEntries([customEntry(legacy({ energyKwh: 0.3 }))]);
		expect(out?.energy).toEqual({ status: "reported", kwh: 0.3 });
		expect(out?.schemaVersion).toBe(2);
	});
});

describe("withChargedCost", () => {
	const message = (total: number): AssistantMessage =>
		({
			role: "assistant",
			content: [],
			api: "openai-completions",
			provider: "neuralwatt",
			model: "deepseek-v4-flash",
			timestamp: 0,
			usage: {
				input: 10,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 30,
				cost: {
					input: total * 0.25,
					output: total * 0.5,
					cacheRead: total * 0.25,
					cacheWrite: 0,
					total,
				},
			},
			stopReason: "stop",
		}) as unknown as AssistantMessage;

	it("replaces the total and scales sub-costs proportionally", () => {
		const out = withChargedCost(message(1), 0.2);
		expect(out.usage.cost.total).toBe(0.2);
		expect(out.usage.cost.input).toBeCloseTo(0.05, 10);
		expect(out.usage.cost.output).toBeCloseTo(0.1, 10);
	});

	it("patches a reported zero to zero", () => {
		const out = withChargedCost(message(1), 0);
		expect(out.usage.cost.total).toBe(0);
	});

	it("does not mutate the original message", () => {
		const original = message(1);
		withChargedCost(original, 0.2);
		expect(original.usage.cost.total).toBe(1);
	});
});

describe("default rate compatibility", () => {
	it("stays at 10 USD/kWh", () => {
		expect(DEFAULT_RATE_USD_PER_KWH).toBe(10);
	});
});
