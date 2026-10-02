import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	type EnergyCostEntry,
	ENERGY_COST_ENTRY_TYPE,
	type StreamEnergyRecord,
	addEntryToTotals,
	emptyTotals,
	isEnergyCostEntry,
	lastEntryFromEntries,
	makeEntry,
	resolveChargedCost,
	totalsFromEntries,
	withChargedCost,
} from "../lib.ts";

const RATE = 10;

const entry = (overrides: Partial<EnergyCostEntry> = {}): EnergyCostEntry => ({
	provider: "neuralwatt",
	kind: "response-energy",
	energyKwh: 0.001,
	costUsd: 0.01,
	costSource: "reported",
	accountingMethod: "energy",
	measuredAt: "2026-01-01T00:00:00.000Z",
	...overrides,
});

const customEntry = (data: unknown) => ({
	type: "custom",
	customType: ENERGY_COST_ENTRY_TYPE,
	data,
});

describe("resolveChargedCost", () => {
	it("prefers the charged cost reported by the API", () => {
		const record: StreamEnergyRecord = {
			energy: { energy_kwh: 0.1 },
			cost: { request_cost_usd: 0.42 },
		};
		expect(resolveChargedCost(record, "energy", RATE)).toEqual({
			costUsd: 0.42,
			source: "reported",
		});
	});

	it("accepts a reported cost of zero", () => {
		const record: StreamEnergyRecord = {
			energy: { energy_kwh: 0.1 },
			cost: { request_cost_usd: 0 },
		};
		expect(resolveChargedCost(record, "energy", RATE)).toEqual({
			costUsd: 0,
			source: "reported",
		});
	});

	it("falls back to energy times rate only for energy accounts", () => {
		const record: StreamEnergyRecord = { energy: { energy_kwh: 0.2 } };
		expect(resolveChargedCost(record, "energy", RATE)).toEqual({
			costUsd: 2,
			source: "energy-rate",
		});
		expect(resolveChargedCost(record, "token", RATE)).toBeUndefined();
		expect(resolveChargedCost(record, undefined, RATE)).toBeUndefined();
	});

	it("returns undefined when there is nothing usable", () => {
		expect(resolveChargedCost({}, "energy", RATE)).toBeUndefined();
		expect(
			resolveChargedCost({ energy: { energy_kwh: 0 } }, "energy", RATE),
		).toBeUndefined();
		expect(
			resolveChargedCost({ cost: { request_cost_usd: -1 } }, "energy", RATE),
		).toBeUndefined();
	});
});

describe("makeEntry", () => {
	it("returns undefined unless accountingMethod is 'energy'", () => {
		const record: StreamEnergyRecord = { energy: { energy_kwh: 0.1 } };
		expect(makeEntry(record, undefined, RATE)).toBeUndefined();
		expect(makeEntry(record, "token", RATE)).toBeUndefined();
	});

	it("returns undefined when energy_kwh is missing or non-positive", () => {
		expect(makeEntry({ energy: { energy_kwh: 0 } }, "energy", RATE)).toBeUndefined();
		expect(makeEntry({ energy: { energy_kwh: -1 } }, "energy", RATE)).toBeUndefined();
		expect(makeEntry({ energy: { energy_kwh: NaN } }, "energy", RATE)).toBeUndefined();
		expect(makeEntry({ energy: {} }, "energy", RATE)).toBeUndefined();
		expect(makeEntry({}, "energy", RATE)).toBeUndefined();
	});

	it("records the reported charged cost and source", () => {
		const out = makeEntry(
			{ energy: { energy_kwh: 0.2 }, cost: { request_cost_usd: 0.05 } },
			"energy",
			RATE,
		);
		expect(out?.costUsd).toBe(0.05);
		expect(out?.costSource).toBe("reported");
		expect(out?.rateUsdPerKwh).toBeUndefined();
		expect(out?.energyKwh).toBe(0.2);
		expect(out?.accountingMethod).toBe("energy");
		expect(typeof out?.measuredAt).toBe("string");
	});

	it("falls back to energy × rate and records the rate used", () => {
		const out = makeEntry({ energy: { energy_kwh: 0.2 } }, "energy", RATE);
		expect(out?.costUsd).toBe(2);
		expect(out?.costSource).toBe("energy-rate");
		expect(out?.rateUsdPerKwh).toBe(RATE);
	});

	it("passes through energy_joules when valid", () => {
		const out = makeEntry(
			{ energy: { energy_kwh: 0.1, energy_joules: 360_000 } },
			"energy",
			RATE,
		);
		expect(out?.energyJoules).toBe(360_000);
	});

	it("omits energyJoules when invalid", () => {
		const out = makeEntry(
			{ energy: { energy_kwh: 0.1, energy_joules: -5 } },
			"energy",
			RATE,
		);
		expect(out?.energyJoules).toBeUndefined();
	});

	it("carries the model id when provided", () => {
		const out = makeEntry({ energy: { energy_kwh: 0.1 } }, "energy", RATE, "glm-5.3");
		expect(out?.modelId).toBe("glm-5.3");
	});
});

describe("isEnergyCostEntry", () => {
	it("accepts reported and fallback entries", () => {
		expect(isEnergyCostEntry(entry())).toBe(true);
		expect(
			isEnergyCostEntry(entry({ costSource: "energy-rate", rateUsdPerKwh: RATE })),
		).toBe(true);
	});

	it("accepts a legacy v1 entry with a rate and a positive cost", () => {
		expect(
			isEnergyCostEntry({
				provider: "neuralwatt",
				kind: "response-energy",
				energyKwh: 0.001,
				rateUsdPerKwh: 5,
				costUsd: 0.005,
				accountingMethod: "energy",
				costSource: "energy-rate",
				reportedRequestCostUsd: 0.004,
				measuredAt: "2026-01-01T00:00:00.000Z",
			}),
		).toBe(true);
	});

	it("rejects non-objects", () => {
		expect(isEnergyCostEntry(null)).toBe(false);
		expect(isEnergyCostEntry(undefined)).toBe(false);
		expect(isEnergyCostEntry("x")).toBe(false);
		expect(isEnergyCostEntry(42)).toBe(false);
	});

	it("rejects wrong discriminators and malformed numbers", () => {
		expect(isEnergyCostEntry({ ...entry(), provider: "other" })).toBe(false);
		expect(isEnergyCostEntry({ ...entry(), kind: "x" })).toBe(false);
		expect(isEnergyCostEntry({ ...entry(), accountingMethod: "token" })).toBe(false);
		expect(isEnergyCostEntry({ ...entry(), costSource: "other" })).toBe(false);
		expect(isEnergyCostEntry({ ...entry(), energyKwh: 0 })).toBe(false);
		expect(isEnergyCostEntry({ ...entry(), costUsd: -1 })).toBe(false);
		expect(isEnergyCostEntry({ ...entry(), costUsd: NaN })).toBe(false);
	});

	it("requires a positive rate on fallback entries", () => {
		expect(isEnergyCostEntry(entry({ costSource: "energy-rate" }))).toBe(false);
		expect(
			isEnergyCostEntry(entry({ costSource: "energy-rate", rateUsdPerKwh: -1 })),
		).toBe(false);
	});
});

describe("addEntryToTotals / emptyTotals", () => {
	it("emptyTotals is all zeros", () => {
		expect(emptyTotals()).toEqual({
			requests: 0,
			energyKwh: 0,
			energyJoules: 0,
			costUsd: 0,
			reportedCostRequests: 0,
			estimatedCostRequests: 0,
		});
	});

	it("adds a single entry including request and source counts", () => {
		const totals = addEntryToTotals(
			emptyTotals(),
			entry({ energyKwh: 0.1, costUsd: 0.5, energyJoules: 100 }),
		);
		expect(totals).toEqual({
			requests: 1,
			energyKwh: 0.1,
			energyJoules: 100,
			costUsd: 0.5,
			reportedCostRequests: 1,
			estimatedCostRequests: 0,
		});
	});

	it("derives joules from kwh when entry has no energyJoules (1 kwh = 3,600,000 J)", () => {
		const totals = addEntryToTotals(emptyTotals(), entry({ energyKwh: 0.5 }));
		expect(totals.energyJoules).toBe(1_800_000);
	});

	it("accumulates across multiple entries and tracks estimated costs", () => {
		let totals = emptyTotals();
		totals = addEntryToTotals(totals, entry({ energyKwh: 0.1, costUsd: 0.5 }));
		totals = addEntryToTotals(
			totals,
			entry({ energyKwh: 0.2, costUsd: 1, costSource: "energy-rate", rateUsdPerKwh: RATE }),
		);
		expect(totals.requests).toBe(2);
		expect(totals.energyKwh).toBeCloseTo(0.3, 10);
		expect(totals.costUsd).toBeCloseTo(1.5, 10);
		expect(totals.reportedCostRequests).toBe(1);
		expect(totals.estimatedCostRequests).toBe(1);
	});

	it("does not mutate the input totals", () => {
		const base = emptyTotals();
		addEntryToTotals(base, entry());
		expect(base).toEqual(emptyTotals());
	});
});

describe("totalsFromEntries", () => {
	it("sums only well-formed energy entries", () => {
		const totals = totalsFromEntries([
			customEntry(entry({ energyKwh: 0.1, costUsd: 0.2 })),
			{ type: "message", customType: ENERGY_COST_ENTRY_TYPE, data: entry() },
			{ type: "custom", customType: "other", data: entry() },
			customEntry({ nonsense: true }),
			customEntry(entry({ energyKwh: 0.2, costUsd: 0.4 })),
		]);
		expect(totals.requests).toBe(2);
		expect(totals.energyKwh).toBeCloseTo(0.3, 10);
		expect(totals.costUsd).toBeCloseTo(0.6, 10);
	});

	it("returns zero totals for empty input", () => {
		expect(totalsFromEntries([])).toEqual(emptyTotals());
	});
});

describe("lastEntryFromEntries", () => {
	it("returns the last well-formed entry", () => {
		const first = entry({ energyKwh: 0.1 });
		const second = entry({ energyKwh: 0.2 });
		expect(
			lastEntryFromEntries([
				customEntry(first),
				{ type: "custom", customType: "other", data: entry() },
				customEntry({ bad: true }),
				customEntry(second),
			]),
		).toEqual(second);
	});

	it("returns undefined when there are no valid entries", () => {
		expect(lastEntryFromEntries([])).toBeUndefined();
		expect(lastEntryFromEntries([customEntry({ bad: true })])).toBeUndefined();
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
		expect(out.usage.cost.cacheRead).toBeCloseTo(0.05, 10);
		expect(out.usage.input).toBe(10);
		expect(out.stopReason).toBe("stop");
	});

	it("handles a message whose token cost is zero", () => {
		const out = withChargedCost(message(0), 0.03);
		expect(out.usage.cost).toEqual({
			input: 0.03,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0.03,
		});
	});

	it("does not mutate the original message", () => {
		const original = message(1);
		withChargedCost(original, 0.2);
		expect(original.usage.cost.total).toBe(1);
	});
});
