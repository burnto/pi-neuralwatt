import { describe, expect, it } from "vitest";
import {
	type NeuralwattApiModel,
	asPrice,
	buildThinkingLevelMap,
	mapApiModel,
} from "../lib.ts";

describe("asPrice", () => {
	it("returns positive finite numbers", () => {
		expect(asPrice(1.5)).toBe(1.5);
		expect(asPrice(0.001)).toBe(0.001);
	});
	it("coerces non-positive / non-finite / non-number to 0", () => {
		expect(asPrice(0)).toBe(0);
		expect(asPrice(-1)).toBe(0);
		expect(asPrice(NaN)).toBe(0);
		expect(asPrice(Infinity)).toBe(0);
		expect(asPrice(null)).toBe(0);
		expect(asPrice(undefined)).toBe(0);
		expect(asPrice("3")).toBe(0);
		expect(asPrice(null as unknown as number)).toBe(0);
	});
});

describe("mapApiModel", () => {
	it("returns null for deprecated models", () => {
		const model: NeuralwattApiModel = {
			id: "old",
			metadata: { deprecated: true },
		};
		expect(mapApiModel(model)).toBeNull();
	});

	it("returns null when pricing is TBD", () => {
		const model: NeuralwattApiModel = {
			id: "tbd",
			metadata: { pricing: { pricing_tbd: true } },
		};
		expect(mapApiModel(model)).toBeNull();
	});

	it("maps a basic text-only model with metadata defaults", () => {
		const model: NeuralwattApiModel = {
			id: "nw-text",
			metadata: { display_name: "Text Model" },
		};
		const out = mapApiModel(model);
		expect(out).not.toBeNull();
		expect(out?.id).toBe("nw-text");
		expect(out?.name).toBe("Text Model");
		expect(out?.reasoning).toBe(false);
		expect(out?.thinkingLevelMap).toBeUndefined();
		expect(out?.input).toEqual(["text"]);
		expect(out?.contextWindow).toBe(131_072);
		expect(out?.maxTokens).toBe(65_536);
		expect(out?.compat?.maxTokensField).toBe("max_tokens");
		expect(out?.compat?.supportsDeveloperRole).toBe(false);
		expect(out?.compat?.requiresReasoningContentOnAssistantMessages).toBeUndefined();
	});

	it("falls back to id when display_name missing", () => {
		const out = mapApiModel({ id: "nw-id" });
		expect(out?.name).toBe("nw-id");
	});

	it("maps vision capability to text+image input", () => {
		const out = mapApiModel({
			id: "nw-vision",
			metadata: { capabilities: { vision: true } },
		});
		expect(out?.input).toEqual(["text", "image"]);
	});

	it("enables developerRole when capability is true", () => {
		const out = mapApiModel({
			id: "nw-dev",
			metadata: { capabilities: { developer_role: true } },
		});
		expect(out?.compat?.supportsDeveloperRole).toBeUndefined();
	});

	it("sets reasoning compat flags and maps thinking levels for reasoning models", () => {
		const out = mapApiModel({
			id: "nw-reason",
			metadata: { capabilities: { reasoning: true } },
		});
		expect(out?.reasoning).toBe(true);
		expect(out?.compat?.requiresReasoningContentOnAssistantMessages).toBe(true);
		expect(out?.thinkingLevelMap).toEqual({
			minimal: null,
			low: null,
			medium: "medium",
			high: null,
			xhigh: null,
		});
	});

	it("maps effort-based thinking levels when reasoning_effort is true", () => {
		const out = mapApiModel({
			id: "nw-effort",
			metadata: { capabilities: { reasoning: true, reasoning_effort: true } },
		});
		expect(out?.thinkingLevelMap).toEqual({
			off: "none",
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			xhigh: "max",
		});
	});

	it("reads context window and max tokens from limits when top-level absent", () => {
		const out = mapApiModel({
			id: "nw-limits",
			max_model_len: 4096,
			metadata: {
				limits: { max_context_length: 200_000, max_output_tokens: 8192 },
				pricing: {
					input_per_million: 2,
					output_per_million: 6,
					cached_input_per_million: 0.5,
					cached_output_per_million: -3,
				},
			},
		});
		expect(out?.contextWindow).toBe(4096); // top-level max_model_len wins
		expect(out?.maxTokens).toBe(8192);
		expect(out?.cost).toEqual({
			input: 2,
			output: 6,
			cacheRead: 0.5,
			cacheWrite: 0, // negative coerced
		});
	});

	it("falls back to limits.max_context_length when max_model_len absent", () => {
		const out = mapApiModel({
			id: "nw-ctx",
			metadata: { limits: { max_context_length: 500_000 } },
		});
		expect(out?.contextWindow).toBe(500_000);
	});

	it("respects max_model_len: undefined -> limits -> default", () => {
		const out = mapApiModel({ id: "x" });
		expect(out?.contextWindow).toBe(131_072);
	});
});

describe("buildThinkingLevelMap", () => {
	it("returns undefined when reasoning not enabled", () => {
		expect(buildThinkingLevelMap({ id: "x" })).toBeUndefined();
		expect(buildThinkingLevelMap({ id: "x", metadata: { capabilities: { reasoning: false } } })).toBeUndefined();
	});
});
