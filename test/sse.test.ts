import { describe, expect, it } from "vitest";
import { isNeuralwattChatCompletionsUrl, parseCommentPayload } from "../lib.ts";

describe("parseCommentPayload", () => {
	it("parses an energy comment with object value", () => {
		const out = parseCommentPayload('energy {"energy_kwh": 0.1, "energy_joules": 360}');
		expect(out).toEqual({ kind: "energy", value: { energy_kwh: 0.1, energy_joules: 360 } });
	});

	it("parses a cost comment", () => {
		const out = parseCommentPayload('cost {"request_cost_usd": 0.01}');
		expect(out).toEqual({ kind: "cost", value: { request_cost_usd: 0.01 } });
	});

	it("trims leading/trailing whitespace", () => {
		const out = parseCommentPayload('  energy {"a":1}  ');
		expect(out).toEqual({ kind: "energy", value: { a: 1 } });
	});

	it("handles multi-line JSON value via /s flag", () => {
		const payload = `energy {
  "energy_kwh": 0.2,
  "nested": {"x": [1, 2]}
}`;
		const out = parseCommentPayload(payload);
		expect(out?.kind).toBe("energy");
		expect(out?.value).toEqual({ energy_kwh: 0.2, nested: { x: [1, 2] } });
	});

	it("returns undefined for unknown kinds", () => {
		expect(parseCommentPayload('fuel {"a":1}')).toBeUndefined();
		expect(parseCommentPayload('energyy {"a":1}')).toBeUndefined();
	});

	it("returns undefined when no JSON object follows the kind", () => {
		expect(parseCommentPayload("energy")).toBeUndefined();
		expect(parseCommentPayload("energy not-json")).toBeUndefined();
		expect(parseCommentPayload("cost plain")).toBeUndefined();
	});

	it("returns undefined for malformed JSON", () => {
		expect(parseCommentPayload("energy {not json}")).toBeUndefined();
		expect(parseCommentPayload("energy {")).toBeUndefined();
	});

	it("returns undefined for empty / unrelated lines", () => {
		expect(parseCommentPayload("")).toBeUndefined();
		expect(parseCommentPayload("data: hello")).toBeUndefined();
		expect(parseCommentPayload("event: message")).toBeUndefined();
	});

	it("returns undefined for JSON-shaped values that are not braced objects", () => {
		// The regex requires `{...}` braces, so array / scalar payloads don't match.
		expect(parseCommentPayload("energy [1,2]")).toBeUndefined();
		expect(parseCommentPayload('energy "x"')).toBeUndefined();
		expect(parseCommentPayload("energy 123")).toBeUndefined();
	});
});

describe("isNeuralwattChatCompletionsUrl", () => {
	const origin = "https://api.neuralwatt.com";

	it("matches a string url on the provider origin ending in /chat/completions", () => {
		expect(isNeuralwattChatCompletionsUrl(`${origin}/v1/chat/completions`, origin)).toBe(true);
	});

	it("matches when pathname is exactly /chat/completions", () => {
		expect(isNeuralwattChatCompletionsUrl(`${origin}/chat/completions`, origin)).toBe(true);
	});

	it("returns false for a different origin", () => {
		expect(isNeuralwattChatCompletionsUrl("https://other.example/v1/chat/completions", origin)).toBe(false);
	});

	it("returns false when path does not end in /chat/completions", () => {
		expect(isNeuralwattChatCompletionsUrl(`${origin}/v1/models`, origin)).toBe(false);
		expect(isNeuralwattChatCompletionsUrl(`${origin}/v1/chat/completions/extra`, origin)).toBe(false);
		expect(isNeuralwattChatCompletionsUrl(`${origin}/chat/completionsX`, origin)).toBe(false);
	});

	it("handles URL objects", () => {
		expect(isNeuralwattChatCompletionsUrl(new URL(`${origin}/v1/chat/completions`), origin)).toBe(true);
		expect(isNeuralwattChatCompletionsUrl(new URL(`${origin}/v1/models`), origin)).toBe(false);
	});

	it("handles Request objects (uses input.url)", () => {
		const req = new Request(`${origin}/v1/chat/completions`, { method: "POST" });
		expect(isNeuralwattChatCompletionsUrl(req, origin)).toBe(true);
	});

	it("returns false for invalid URL strings", () => {
		expect(isNeuralwattChatCompletionsUrl("not-a-url", origin)).toBe(false);
		expect(isNeuralwattChatCompletionsUrl("://broken", origin)).toBe(false);
	});

	it("respects subdomain mismatch (origin is exact)", () => {
		expect(
			isNeuralwattChatCompletionsUrl("https://eu.api.neuralwatt.com/v1/chat/completions", origin),
		).toBe(false);
	});
});
