import { describe, expect, it } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
	buildThinkingLevelMap,
	isOfflineValue,
	parseCachedModels,
	mapModelsResponse,
} from "../lib.ts";

const qwen = {
	id: "qwen-3.8-27b",
	object: "model",
	created: 0,
	owned_by: "neuralwatt",
	max_model_len: 262128,
	metadata: {
		display_name: "Qwen 3.8 27B",
		pricing: {
			input_per_million: 0.45,
			output_per_million: 3.2,
			cached_input_per_million: 0.25,
			cached_output_per_million: null,
		},
		capabilities: { vision: true, reasoning: true, reasoning_effort: true },
		reasoning: {
			mandatory: false,
			supported_efforts: ["xhigh", "medium", "low", "none"],
			accepted_efforts: ["max", "xhigh", "high", "medium", "low", "minimal", "none"],
			effort_aliases: { max: "xhigh", high: "xhigh", minimal: "low" },
		},
		limits: { max_context_length: 262128, max_output_tokens: 131072 },
	},
};

describe("buildThinkingLevelMap", () => {
	const levels = (model: Parameters<typeof buildThinkingLevelMap>[0]) =>
		getSupportedThinkingLevels({
			reasoning: true,
			thinkingLevelMap: buildThinkingLevelMap(model),
		} as Model<"openai-completions">);

	it("exposes only the claimed endpoints in the pre-metadata fallback", () => {
		// No metadata.reasoning: Pi treats undefined entries as supported, so the
		// fallback must null every level it cannot confirm.
		const fallback = {
			id: "legacy",
			metadata: {
				capabilities: { reasoning: true, reasoning_effort: true },
			},
		};
		expect(levels(fallback)).toEqual(["off", "high", "max"]);
	});

	it("disables reasoning levels entirely when effort control is absent", () => {
		const noEffort = {
			id: "mandatory",
			metadata: { capabilities: { reasoning: true } },
		};
		expect(levels(noEffort)).toEqual([]);
	});

	it("maps the reasoning contract's supported efforts and aliases", () => {
		expect(levels(qwen as never)).toEqual([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		expect(buildThinkingLevelMap(qwen as never)?.minimal).toBe("low");
		expect(buildThinkingLevelMap(qwen as never)?.max).toBe("xhigh");
	});
});

describe("isOfflineValue", () => {
	it("matches pi's offline semantics", () => {
		for (const value of ["1", "true", "TRUE", "yes", "Yes"]) {
			expect(isOfflineValue(value)).toBe(true);
		}
		for (const value of ["0", "false", "no", "", undefined, null, 1]) {
			expect(isOfflineValue(value)).toBe(false);
		}
	});
});

describe("mapModelsResponse", () => {
	it("maps the customer catalog and keeps enrolled preview models", () => {
		const out = mapModelsResponse({
			scope: "customer",
			data: [qwen, { id: "private-preview" }],
		});
		expect(out.authenticated).toBe(true);
		expect(out.models.map((m) => m.id).sort()).toEqual([
			"private-preview",
			"qwen-3.8-27b",
		]);
	});

	it("reports an unauthenticated public catalog", () => {
		const out = mapModelsResponse({ scope: "public", data: [qwen] });
		expect(out.authenticated).toBe(false);
		expect(out.models.map((m) => m.id)).toEqual(["qwen-3.8-27b"]);
	});

	it("treats a missing scope as unauthenticated and tolerates missing data", () => {
		expect(mapModelsResponse({ data: [qwen] }).authenticated).toBe(false);
		expect(mapModelsResponse({})).toEqual({ models: [], authenticated: false });
	});

	it("drops unusable models", () => {
		const out = mapModelsResponse({
			scope: "customer",
			data: [{ id: "tbd", metadata: { pricing: { pricing_tbd: true } } }, { id: "ok" }],
		});
		expect(out.models.map((m) => m.id)).toEqual(["ok"]);
	});

	it("keeps the reasoning map on mapped models", () => {
		const out = mapModelsResponse({ scope: "public", data: [qwen] });
		expect(out.models[0].thinkingLevelMap).toEqual(
			buildThinkingLevelMap(qwen as never),
		);
	});
});

describe("parseCachedModels", () => {
	const valid = {
		id: "qwen-3.8-27b",
		name: "Qwen",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.45, output: 3.2, cacheRead: 0.25, cacheWrite: 0 },
		contextWindow: 262128,
		maxTokens: 131072,
		compat: { maxTokensField: "max_tokens" },
	};

	it("keeps valid model configs", () => {
		expect(parseCachedModels({ models: [valid] })).toEqual([valid]);
	});

	it("degrades safely on corrupt cache data rather than casting it", () => {
		expect(parseCachedModels(null)).toEqual([]);
		expect(parseCachedModels({ models: "nope" })).toEqual([]);
		expect(
			parseCachedModels({
				models: [
					{ ...valid, cost: { input: "free" } },
					{ ...valid, contextWindow: -1 },
					{ ...valid, id: "" },
					{ ...valid, input: ["audio"] },
					{ nonsense: true },
					valid,
				],
			}),
		).toEqual([valid]);
	});
});
