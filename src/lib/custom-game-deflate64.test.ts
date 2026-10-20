import { describe, expect, it, vi } from "vitest";
import { inflateDeflate64 } from "./custom-game-deflate64";
import { DEFLATE64_BASE64, DEFLATE64_BYTES } from "./test-support/deflate64-fixture";

const fixture = () => new Uint8Array(Buffer.from(DEFLATE64_BASE64, "base64"));
function source(bytes = fixture(), chunkSize = bytes.length, cancel = vi.fn()) {
  let offset = 0;
  return new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset === bytes.length) { controller.close(); return; }
    const next = Math.min(offset + chunkSize, bytes.length);
    controller.enqueue(bytes.subarray(offset, next)); offset = next;
  }, cancel }, { highWaterMark: 0 });
}
async function decode(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader(); const chunks: Uint8Array[] = [];
  while (true) { const next = await reader.read(); if (next.done) break; chunks.push(next.value); }
  return { bytes: Buffer.concat(chunks), chunks };
}

describe("bounded Deflate64 decoder", () => {
  it("decodes a real 7-Zip method-9 payload in output chunks of at most 64 KiB", async () => {
    const result = await decode(inflateDeflate64(source()));
    expect(result.bytes).toEqual(Buffer.alloc(DEFLATE64_BYTES));
    expect(result.chunks.length).toBeGreaterThanOrEqual(4);
    expect(Math.max(...result.chunks.map(chunk => chunk.byteLength))).toBeLessThanOrEqual(65536);
  });
  it("handles compressed input fragmented down to single bytes", async () => {
    expect((await decode(inflateDeflate64(source(fixture(), 1)))).bytes).toEqual(Buffer.alloc(DEFLATE64_BYTES));
  });
  it("rejects truncation and malformed compressed data", async () => {
    await expect(decode(inflateDeflate64(source(fixture().subarray(0, -1))))).rejects.toThrow(/truncado|inválido/);
    await expect(decode(inflateDeflate64(source(new Uint8Array([0xff]))))).rejects.toThrow(/inválido/);
  });
  it("rejects trailing data both within a chunk and in the following input chunk", async () => {
    const bytes = new Uint8Array([...fixture(), 1]);
    await expect(decode(inflateDeflate64(source(bytes)))).rejects.toThrow(/extras/);
    await expect(decode(inflateDeflate64(source(bytes, fixture().length)))).rejects.toThrow(/extras/);
  });
  it("does not prefetch before downstream demand and propagates cancellation", async () => {
    const pull = vi.fn(); const cancel = vi.fn();
    const input = new ReadableStream<Uint8Array>({ pull(controller) { pull(); controller.enqueue(fixture()); }, cancel }, { highWaterMark: 0 });
    const output = inflateDeflate64(input);
    await Promise.resolve(); expect(pull).not.toHaveBeenCalled();
    const reader = output.getReader();
    expect((await reader.read()).value?.byteLength).toBeLessThanOrEqual(65536);
    expect(pull).toHaveBeenCalledTimes(1);
    await reader.cancel("stop"); expect(cancel).toHaveBeenCalledWith("stop");
    expect((await decode(inflateDeflate64(source()))).bytes).toHaveLength(DEFLATE64_BYTES);
  });
  it("propagates source errors and releases codec memory for the next stream", async () => {
    const input = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error("source lost")); } });
    await expect(decode(inflateDeflate64(input))).rejects.toThrow("source lost");
    for (let index = 0; index < 20; index++) expect((await decode(inflateDeflate64(source()))).bytes).toHaveLength(DEFLATE64_BYTES);
  });
  it("keeps concurrent streams independent while sharing the bounded WASM heap", async () => {
    const streams = await Promise.all(Array.from({ length: 8 }, () => decode(inflateDeflate64(source(fixture(), 13)))));
    expect(streams.every(result => result.bytes.equals(Buffer.alloc(DEFLATE64_BYTES)))).toBe(true);
  });
});
