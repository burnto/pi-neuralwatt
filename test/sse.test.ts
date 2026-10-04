import { describe, expect, it } from "vitest";
import {
	isNeuralwattChatCompletionsUrl,
	parseCommentPayload,
	readSseMetadata,
} from "../lib.ts";

describe("parseCommentPayload", () => {
	it("parses energy and cost comments", () => {
		expect(parseCommentPayload('energy {"energy_kwh": 0.1}')).toEqual({
			kind: "energy",
			value: { energy_kwh: 0.1 },
		});
		expect(parseCommentPayload('cost {"request_cost_usd": 0}')).toEqual({
			kind: "cost",
			value: { request_cost_usd: 0 },
		});
	});

	it("handles multi-line JSON and trims whitespace", () => {
		expect(
			parseCommentPayload('  energy {\n  "energy_kwh": 0.2\n}  '),
		).toEqual({ kind: "energy", value: { energy_kwh: 0.2 } });
	});

	it("returns undefined for unrelated or malformed lines", () => {
		expect(parseCommentPayload("fuel {\"a\":1}")).toBeUndefined();
		expect(parseCommentPayload("energy not-json")).toBeUndefined();
		expect(parseCommentPayload("energy [1,2]")).toBeUndefined();
		expect(parseCommentPayload("data: hello")).toBeUndefined();
	});
});

describe("isNeuralwattChatCompletionsUrl", () => {
	const origin = "https://api.neuralwatt.com";
	it("matches the provider origin and chat path", () => {
		expect(
			isNeuralwattChatCompletionsUrl(`${origin}/v1/chat/completions`, origin),
		).toBe(true);
		expect(isNeuralwattChatCompletionsUrl(`${origin}/v1/models`, origin)).toBe(false);
		expect(
			isNeuralwattChatCompletionsUrl("https://other/v1/chat/completions", origin),
		).toBe(false);
		expect(isNeuralwattChatCompletionsUrl("not-a-url", origin)).toBe(false);
	});
});

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let index = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (index >= chunks.length) {
				controller.close();
				return;
			}
			controller.enqueue(encoder.encode(chunks[index++]));
		},
	});
}

describe("readSseMetadata", () => {
	it("collects the response id from data lines and comments from chunked SSE", async () => {
		const comments: string[] = [];
		const id = await readSseMetadata(
			streamFromChunks([
				'data: {"id":"resp-1","choices":[]}\n',
				": energy {\"energy_kwh\": 0.1}\n",
				"data: {\"choices\":[{\"delta\":{}}]}\n",
				": cost {\"request_cost_usd\": 0.02}\n",
				"data: [DONE]\n",
			]),
			(line) => comments.push(line),
		);
		expect(id).toBe("resp-1");
		expect(comments).toEqual([
			'energy {"energy_kwh": 0.1}',
			'cost {"request_cost_usd": 0.02}',
		]);
	});

	it("handles a metadata comment split across chunk boundaries", async () => {
		const comments: string[] = [];
		await readSseMetadata(
			streamFromChunks([": ener", 'gy {"energy_kwh": 0.5}\ndata: [DONE]\n']),
			(line) => comments.push(line),
		);
		expect(comments).toEqual(['energy {"energy_kwh": 0.5}']);
	});

	it("returns the id even when the stream ends without [DONE]", async () => {
		const id = await readSseMetadata(
			streamFromChunks(['data: {"id":"late-1"}\n']),
			() => {},
		);
		expect(id).toBe("late-1");
	});

	it("stops cleanly when aborted mid-stream", async () => {
		const controller = new AbortController();
		let pullCount = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(streamController) {
				pullCount += 1;
				if (pullCount > 50) {
					streamController.close();
					return;
				}
				streamController.enqueue(
					new TextEncoder().encode('data: {"id":"x"}\n: energy {"energy_kwh": 1}\n'),
				);
			},
		});
		const comments: string[] = [];
		const promise = readSseMetadata(stream, (line) => comments.push(line), controller.signal);
		controller.abort();
		await expect(promise).resolves.toBeUndefined();
	});

	it("resolves without an id when the stream is empty", async () => {
		await expect(readSseMetadata(streamFromChunks([]), () => {})).resolves.toBeUndefined();
	});

	it("does not reject when the underlying stream errors", async () => {
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.error(new Error("boom"));
			},
		});
		await expect(readSseMetadata(stream, () => {})).resolves.toBeUndefined();
	});
});
