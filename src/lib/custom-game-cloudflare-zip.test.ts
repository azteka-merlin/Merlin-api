import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { crc32, deflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { hashCloudflareZipEntry, planCloudflareZip } from "./custom-game-cloudflare-zip";
import { DEFLATE64_BASE64, DEFLATE64_BYTES } from "./test-support/deflate64-fixture";

type EntryInput = { name: string | Uint8Array; data?: string | Uint8Array; method?: number; flags?: number; attrs?: number;
  extra?: Uint8Array; crc?: number; declaredSize?: number; compressed?: Uint8Array };
function field(id: number, bytes: Uint8Array) {
  const result = Buffer.alloc(4 + bytes.length); result.writeUInt16LE(id); result.writeUInt16LE(bytes.length, 2); result.set(bytes, 4); return result;
}
function zip(entries: EntryInput[], zip64 = false) {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; const locations: { local: number; central: number; payload: number }[] = [];
  let localOffset = 0; let centralOffset = 0;
  for (const input of entries) {
    const name = typeof input.name === "string" ? Buffer.from(input.name) : Buffer.from(input.name);
    const data = typeof input.data === "string" ? Buffer.from(input.data) : Buffer.from(input.data || []);
    const method = input.method ?? 0; const flags = input.flags ?? 0x800; const checksum = input.crc ?? crc32(data);
    const size = input.declaredSize ?? data.length;
    const compressed = Buffer.from(input.compressed || (method === 8 ? deflateRawSync(data) : data));
    const zip64Local = Buffer.alloc(16); zip64Local.writeBigUInt64LE(BigInt(size)); zip64Local.writeBigUInt64LE(BigInt(compressed.length), 8);
    const extraLocal = zip64 ? field(1, zip64Local) : Buffer.alloc(0);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(zip64 ? 45 : 20, 4);
    local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(flags & 8 ? 0 : checksum, 14);
    local.writeUInt32LE(zip64 ? 0xffffffff : flags & 8 ? 0 : compressed.length, 18);
    local.writeUInt32LE(zip64 ? 0xffffffff : flags & 8 ? 0 : size, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(extraLocal.length, 28);
    let descriptor = Buffer.alloc(0);
    if (flags & 8) {
      descriptor = Buffer.alloc(zip64 ? 24 : 16); descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(checksum, 4);
      if (zip64) { descriptor.writeBigUInt64LE(BigInt(compressed.length), 8); descriptor.writeBigUInt64LE(BigInt(size), 16); }
      else { descriptor.writeUInt32LE(compressed.length, 8); descriptor.writeUInt32LE(size, 12); }
    }
    const record = Buffer.concat([local, name, extraLocal, compressed, descriptor]);
    const zip64Central = Buffer.alloc(24); zip64Central.writeBigUInt64LE(BigInt(size));
    zip64Central.writeBigUInt64LE(BigInt(compressed.length), 8); zip64Central.writeBigUInt64LE(BigInt(localOffset), 16);
    const extraCentral = Buffer.concat([zip64 ? field(1, zip64Central) : Buffer.alloc(0), Buffer.from(input.extra || [])]);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(zip64 ? 45 : 20, 6); central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16); central.writeUInt32LE(zip64 ? 0xffffffff : compressed.length, 20);
    central.writeUInt32LE(zip64 ? 0xffffffff : size, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extraCentral.length, 30); central.writeUInt32LE(input.attrs ?? 0, 38);
    central.writeUInt32LE(zip64 ? 0xffffffff : localOffset, 42);
    const centralRecord = Buffer.concat([central, name, extraCentral]);
    locations.push({ local: localOffset, central: centralOffset, payload: localOffset + 30 + name.length + extraLocal.length });
    locals.push(record); centrals.push(centralRecord); localOffset += record.length; centralOffset += centralRecord.length;
  }
  for (const location of locations) location.central += localOffset;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(zip64 ? 0xffff : entries.length, 8); end.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
  end.writeUInt32LE(zip64 ? 0xffffffff : centralOffset, 12); end.writeUInt32LE(zip64 ? 0xffffffff : localOffset, 16);
  const trailer: Buffer[] = [];
  if (zip64) {
    const end64 = Buffer.alloc(56); end64.writeUInt32LE(0x06064b50); end64.writeBigUInt64LE(44n, 4);
    end64.writeUInt16LE(45, 12); end64.writeUInt16LE(45, 14); end64.writeBigUInt64LE(BigInt(entries.length), 24);
    end64.writeBigUInt64LE(BigInt(entries.length), 32); end64.writeBigUInt64LE(BigInt(centralOffset), 40); end64.writeBigUInt64LE(BigInt(localOffset), 48);
    const locator = Buffer.alloc(20); locator.writeUInt32LE(0x07064b50);
    locator.writeBigUInt64LE(BigInt(localOffset + centralOffset), 8); locator.writeUInt32LE(1, 16); trailer.push(end64, locator);
  }
  return { bytes: Buffer.concat([...locals, ...centrals, ...trailer, end]), locations, centralOffset: localOffset };
}

class Bucket {
  etag = "source-snapshot";
  reads: { offset: number; length: number; ifMatch: unknown }[] = [];
  cancellations = 0;
  maximumChunk = 0;
  constructor(public bytes: Uint8Array) {}
  async get(_key: string, options: R2GetOptions) {
    const range = options.range as { offset: number; length: number };
    const ifMatch = (options.onlyIf as R2Conditional).etagMatches;
    this.reads.push({ ...range, ifMatch });
    if (ifMatch !== this.etag) return { etag: this.etag, size: this.bytes.length };
    const bucket = this; let position = range.offset;
    return { etag: this.etag, size: this.bytes.length, body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (position >= range.offset + range.length) { controller.close(); return; }
        const chunk = bucket.bytes.subarray(position, Math.min(position + 65_536, range.offset + range.length));
        bucket.maximumChunk = Math.max(bucket.maximumChunk, chunk.length); position += chunk.length; controller.enqueue(chunk);
      }, cancel() { bucket.cancellations++; },
    }), arrayBuffer() { throw new Error("Full object buffering is forbidden"); } };
  }
  binding() { return this as unknown as R2Bucket; }
}

function installDigestStream() {
  class NodeDigestStream extends WritableStream<ArrayBuffer | ArrayBufferView> {
    readonly digest: Promise<ArrayBuffer>;
    constructor() {
      const hash = createHash("sha256"); let resolve!: (value: ArrayBuffer) => void; let reject!: (error: unknown) => void;
      const promise = new Promise<ArrayBuffer>((ok, fail) => { resolve = ok; reject = fail; });
      super({ write(chunk) {
        hash.update(chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      }, close() { const bytes = hash.digest(); resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)); }, abort(error) { reject(error); } });
      this.digest = promise;
    }
  }
  vi.stubGlobal("crypto", { subtle: crypto.subtle, DigestStream: NodeDigestStream });
}

describe("Cloudflare ZIP planning and streaming", () => {
  beforeEach(installDigestStream);
  afterEach(() => vi.unstubAllGlobals());

  it.each([false, true])("hashes stored, deflate and empty members, ZIP64=%s", async zip64 => {
    const fixture = zip([{ name: "game/main.exe", data: "stored" }, { name: "port.dll", data: "deflate data ".repeat(100), method: 8 },
      { name: "empty.cfg", data: "" }, { name: "empty-deflate", method: 8 }, { name: "empty-dir/", method: 8 }], zip64);
    const bucket = new Bucket(fixture.bytes);
    const plan = await planCloudflareZip(bucket.binding(), "zip", bucket.etag, fixture.bytes.length);
    expect(plan.files.map(file => file.path)).toEqual(["game/main.exe", "port.dll", "empty.cfg", "empty-deflate"]);
    const files = [];
    for (const entry of plan.files) files.push(await hashCloudflareZipEntry(bucket.binding(), "zip", bucket.etag, fixture.bytes.length, entry));
    expect(files[0]?.sha256).toBe(createHash("sha256").update("stored").digest("hex"));
    expect(files[1]?.sha256).toBe(createHash("sha256").update("deflate data ".repeat(100)).digest("hex"));
    expect(files[2]?.sha256).toBe(createHash("sha256").digest("hex"));
    expect(files[3]?.sha256).toBe(files[2]?.sha256);
    expect(files[0]?.zip?.offset).toBe(fixture.locations[0]?.payload);
    expect(bucket.reads.every(read => read.ifMatch === bucket.etag)).toBe(true);
  });

  it.each([false, true])("validates signed data descriptors, ZIP64=%s", async zip64 => {
    const fixture = zip([{ name: "game.exe", data: "descriptor ".repeat(30), method: 8, flags: 0x808 }], zip64);
    const bucket = new Bucket(fixture.bytes);
    const plan = await planCloudflareZip(bucket.binding(), "zip", bucket.etag, fixture.bytes.length);
    expect((await hashCloudflareZipEntry(bucket.binding(), "zip", bucket.etag, fixture.bytes.length, plan.files[0]!)).sha256)
      .toBe(createHash("sha256").update("descriptor ".repeat(30)).digest("hex"));
  });

  it("accepts a single-volume ZIP64 locator whose disk count is zero", async () => {
    const fixture = zip([{ name: "game.exe", data: "single volume", method: 8 }], true);
    fixture.bytes.writeUInt32LE(0, fixture.bytes.length - 26);
    const bucket = new Bucket(fixture.bytes);
    const plan = await planCloudflareZip(bucket.binding(), "zip", bucket.etag, fixture.bytes.length);
    expect(plan.files).toHaveLength(1);
    expect((await hashCloudflareZipEntry(bucket.binding(), "zip", bucket.etag, fixture.bytes.length, plan.files[0]!)).sha256)
      .toBe(createHash("sha256").update("single volume").digest("hex"));
  });

  it.each(["locator-disk", "locator-two-volumes", "record-disk", "record-central-disk", "record-count", "entry-disk"])
    ("still rejects a split or inconsistent ZIP64 with %s", async mutation => {
      const fixture = zip([{ name: "game.exe", data: "single volume", method: 8 }], true);
      const locator = fixture.bytes.length - 42; const record = locator - 56;
      fixture.bytes.writeUInt32LE(0, locator + 16);
      if (mutation === "locator-disk") fixture.bytes.writeUInt32LE(1, locator + 4);
      if (mutation === "locator-two-volumes") fixture.bytes.writeUInt32LE(2, locator + 16);
      if (mutation === "record-disk") fixture.bytes.writeUInt32LE(1, record + 16);
      if (mutation === "record-central-disk") fixture.bytes.writeUInt32LE(1, record + 20);
      if (mutation === "record-count") fixture.bytes.writeBigUInt64LE(2n, record + 24);
      if (mutation === "entry-disk") fixture.bytes.writeUInt16LE(1, fixture.locations[0]!.central + 34);
      const bucket = new Bucket(fixture.bytes);
      await expect(planCloudflareZip(bucket.binding(), "zip", bucket.etag, fixture.bytes.length)).rejects.toThrow();
    });

  it("decodes CP437 and validated Unicode path extras", async () => {
    const raw = Uint8Array.of(0x82, 0x2e, 0x65, 0x78, 0x65);
    const unicode = Buffer.concat([Buffer.from([1]), Buffer.alloc(4), Buffer.from("ação.exe")]); unicode.writeUInt32LE(crc32(raw), 1);
    const fixture = zip([{ name: raw, data: "cp437", flags: 0 }, { name: "second.bin", data: "unicode", flags: 0,
      extra: field(0x7075, Buffer.concat([Buffer.from([1]), Buffer.from([0, 0, 0, 0]), Buffer.from("ignored-invalid-crc")])) },
    { name: raw.map((value, index) => index ? value : 0x90), data: "unicode", flags: 0,
      extra: field(0x7075, (() => { const copy = Buffer.from(unicode); copy.writeUInt32LE(crc32(raw.map((value, index) => index ? value : 0x90)), 1); return copy; })()) }]);
    const bucket = new Bucket(fixture.bytes); const plan = await planCloudflareZip(bucket.binding(), "zip", bucket.etag, fixture.bytes.length);
    expect(plan.files.map(file => file.path)).toEqual(["é.exe", "second.bin", "ação.exe"]);
    expect((await hashCloudflareZipEntry(bucket.binding(), "zip", bucket.etag, fixture.bytes.length, plan.files[2]!)).path).toBe("ação.exe");
  });

  it.each([
    ["traversal", [{ name: "../game.exe", data: "x" }]],
    ["absolute", [{ name: "/game.exe", data: "x" }]],
    ["Windows reserved name", [{ name: "aux.exe", data: "x" }]],
    ["install metadata", [{ name: "foo/.merlin-install.json", data: "x" }]],
    ["case ambiguity", [{ name: "Game/main.exe", data: "x" }, { name: "game/other.exe", data: "x" }]],
    ["Unicode ambiguity", [{ name: "é/a", data: "x" }, { name: "e\u0301/b", data: "x" }]],
    ["duplicate", [{ name: "main.exe", data: "x" }, { name: "main.exe", data: "x" }]],
    ["file directory conflict", [{ name: "main", data: "x" }, { name: "main/file", data: "x" }]],
    ["reversed file directory conflict", [{ name: "main/file", data: "x" }, { name: "main", data: "x" }]],
    ["symlink", [{ name: "main.exe", data: "x", attrs: 0xa000 << 16 >>> 0 }]],
    ["reparse point", [{ name: "main.exe", data: "x", attrs: 0x400 }]],
    ["encryption", [{ name: "main.exe", data: "x", flags: 1 }]],
    ["unsupported method", [{ name: "main.exe", data: "x", method: 99 }]],
    ["nonempty directory", [{ name: "directory/", data: "x" }]],
    ["invalid UTF8", [{ name: Uint8Array.of(0xff, 0x2e, 0x65, 0x78, 0x65), data: "x" }]],
    ["empty invalid deflate stream", [{ name: "empty", data: "", method: 8, compressed: new Uint8Array(0) }]],
    ["oversized file", [{ name: "main.exe", method: 8, data: "x", declaredSize: 31 * 1024 ** 3 }]],
  ] as [string, EntryInput[]][]) ("rejects %s in the plan", async (_label, entries) => {
    const fixture = zip(entries, entries.some(entry => (entry.declaredSize || 0) > 0xffffffff)); const bucket = new Bucket(fixture.bytes);
    await expect(planCloudflareZip(bucket.binding(), "zip", bucket.etag, fixture.bytes.length)).rejects.toThrow();
  });

  it("coalesces thousands of directory entries and bounds buffered range reads", async () => {
    const fixture = zip(Array.from({ length: 8000 }, (_, index) => ({ name: `data/file-${index}.bin`, data: "x" })));
    const bucket = new Bucket(fixture.bytes);
    const plan = await planCloudflareZip(bucket.binding(), "zip", bucket.etag, fixture.bytes.length);
    expect(plan.files).toHaveLength(8000); expect(bucket.reads.length).toBeLessThan(6);
    expect(Math.max(...bucket.reads.map(read => read.length))).toBeLessThanOrEqual(1024 ** 2);
    expect(bucket.maximumChunk).toBeLessThanOrEqual(65_536);
  });

  it("rejects overlapping local records and central directory truncation", async () => {
    const fixture = zip([{ name: "a.exe", data: "x" }, { name: "b.exe", data: "x" }]);
    fixture.bytes.writeUInt32LE(0, fixture.locations[1]!.central + 42);
    const bucket = new Bucket(fixture.bytes);
    await expect(planCloudflareZip(bucket.binding(), "zip", bucket.etag, fixture.bytes.length)).rejects.toThrow(/sobrepost/);
    const broken = zip([{ name: "a.exe", data: "x" }]); broken.bytes.writeUInt16LE(60_000, broken.locations[0]!.central + 28);
    const brokenBucket = new Bucket(broken.bytes);
    await expect(planCloudflareZip(brokenBucket.binding(), "zip", brokenBucket.etag, broken.bytes.length)).rejects.toThrow();
  });

  it("pins every read and rejects a source replaced between planning and hashing", async () => {
    const fixture = zip([{ name: "main.exe", data: "x" }]); const bucket = new Bucket(fixture.bytes);
    const plan = await planCloudflareZip(bucket.binding(), "zip", bucket.etag, fixture.bytes.length); bucket.etag = "replaced";
    await expect(hashCloudflareZipEntry(bucket.binding(), "zip", "source-snapshot", fixture.bytes.length, plan.files[0]!)).rejects.toThrow(/mudou/);
    expect(bucket.reads.every(read => read.ifMatch === "source-snapshot")).toBe(true);
  });

  it.each(["name", "method", "size", "crc", "extra-overlap"])("rejects a divergent local %s", async mutation => {
    const fixture = zip([{ name: "main.exe", data: "content" }]); const bucket = new Bucket(fixture.bytes);
    const plan = await planCloudflareZip(bucket.binding(), "zip", bucket.etag, fixture.bytes.length);
    if (mutation === "name") fixture.bytes[30] = "X".charCodeAt(0);
    if (mutation === "method") fixture.bytes.writeUInt16LE(8, 8);
    if (mutation === "size") fixture.bytes.writeUInt32LE(3, 22);
    if (mutation === "crc") fixture.bytes.writeUInt32LE(0, 14);
    if (mutation === "extra-overlap") fixture.bytes.writeUInt16LE(30, 28);
    await expect(hashCloudflareZipEntry(bucket.binding(), "zip", bucket.etag, fixture.bytes.length, plan.files[0]!)).rejects.toThrow();
  });

  it("rejects CRC corruption and deflate expansion beyond the declared size", async () => {
    const fixture = zip([{ name: "main.exe", data: "correct" }]); const bucket = new Bucket(fixture.bytes);
    const plan = await planCloudflareZip(bucket.binding(), "zip", bucket.etag, fixture.bytes.length);
    const payload = fixture.locations[0]!.payload; fixture.bytes[payload] = fixture.bytes[payload]! ^ 1;
    await expect(hashCloudflareZipEntry(bucket.binding(), "zip", bucket.etag, fixture.bytes.length, plan.files[0]!)).rejects.toThrow(/CRC32/);
    const expanded = zip([{ name: "main.exe", data: "expanded payload", method: 8, declaredSize: 1 }]); const expansionBucket = new Bucket(expanded.bytes);
    const expansionPlan = await planCloudflareZip(expansionBucket.binding(), "zip", expansionBucket.etag, expanded.bytes.length);
    await expect(hashCloudflareZipEntry(expansionBucket.binding(), "zip", expansionBucket.etag, expanded.bytes.length, expansionPlan.files[0]!)).rejects.toThrow(/excede/);
  });

  it("streams a large member with awaited progress and cancels on heartbeat failure", async () => {
    const data = Buffer.alloc(20 * 1024 ** 2, 0x61); const fixture = zip([{ name: "large.pak", data }]);
    const bucket = new Bucket(fixture.bytes); const plan = await planCloudflareZip(bucket.binding(), "zip", bucket.etag, fixture.bytes.length);
    const progress: number[] = [];
    const result = await hashCloudflareZipEntry(bucket.binding(), "zip", bucket.etag, fixture.bytes.length, plan.files[0]!, { onProgress: async bytes => { progress.push(bytes); } });
    expect(result.sha256).toBe(createHash("sha256").update(data).digest("hex"));
    expect(progress).toEqual([8 * 1024 ** 2, 16 * 1024 ** 2, 20 * 1024 ** 2]);
    expect(bucket.maximumChunk).toBeLessThanOrEqual(65_536);
    await expect(hashCloudflareZipEntry(bucket.binding(), "zip", bucket.etag, fixture.bytes.length, plan.files[0]!, { onProgress: async () => { throw new Error("lease lost"); } })).rejects.toThrow("lease lost");
    expect(bucket.cancellations).toBeGreaterThan(0);
  });
});

describe("Cloudflare ZIP in workerd", () => {
  it("runs ZIP64 and multichunk deflate through native R2, DigestStream and zlib", async () => {
    const bundled = await build({ bundle: true, write: false, format: "esm", platform: "browser", external: ["node:zlib"],
      plugins: [{ name: "worker-wasm-module", setup(builder) {
        builder.onResolve({ filter: /zlib-streams\.wasm$/ }, () => ({ path: "./deflate64.wasm", external: true }));
      } }],
      stdin: { resolveDir: fileURLToPath(new URL("../../", import.meta.url).href), contents: `import { planCloudflareZip, hashCloudflareZipEntry } from "./src/lib/custom-game-cloudflare-zip.ts";
        export default { async fetch(request, env) { try {
          if(request.method === 'PUT') { await env.BUCKET.put('zip', await request.arrayBuffer()); return new Response('ok'); }
          const object = await env.BUCKET.head('zip');
          const plan = await planCloudflareZip(env.BUCKET, 'zip', object.etag, object.size);
          const files = []; for(const entry of plan.files) files.push(await hashCloudflareZipEntry(env.BUCKET, 'zip', object.etag, object.size, entry));
          return Response.json({files, totalSizeBytes: plan.totalSizeBytes});
        } catch(error) { return new Response(error.stack, {status: 500}); } } };`, loader: "ts" } });
    const runtime = new Miniflare({ modules: [
      { type: "ESModule", path: "worker.mjs", contents: bundled.outputFiles[0]!.text },
      { type: "CompiledWasm", path: "deflate64.wasm", contents: readFileSync(createRequire(import.meta.url).resolve("zlib-streams/zlib-streams.wasm")) },
    ],
      compatibilityDate: "2026-06-20", compatibilityFlags: ["nodejs_compat"], r2Buckets: ["BUCKET"] });
    try {
      const data = Buffer.alloc(2 * 1024 ** 2); for (let index = 0; index < data.length; index++) data[index] = index * 31 % 251;
      for (const diskCount of [undefined, 0, 1]) {
        const zip64 = diskCount !== undefined;
        const fixture = zip([{ name: "large.pak", data, method: 8, flags: 0x808 }, { name: "empty.cfg", data: "" }], zip64);
        if (zip64) fixture.bytes.writeUInt32LE(diskCount, fixture.bytes.length - 26);
        const uploaded = await runtime.dispatchFetch("https://worker/", { method: "PUT", body: fixture.bytes });
        expect(uploaded.status, await uploaded.text()).toBe(200);
        const response = await runtime.dispatchFetch("https://worker/");
        const content = await response.text(); expect(response.status, content).toBe(200);
        const result = JSON.parse(content); expect(result.files[0].sha256).toBe(createHash("sha256").update(data).digest("hex"));
        expect(result.files[1].sha256).toBe(createHash("sha256").digest("hex")); expect(result.totalSizeBytes).toBe(data.length);
      }
      const deflate64 = zip([{ name: "game/iso.bin", data: Buffer.alloc(DEFLATE64_BYTES), method: 9,
        compressed: Buffer.from(DEFLATE64_BASE64, "base64") }]);
      await runtime.dispatchFetch("https://worker/", { method: "PUT", body: deflate64.bytes });
      const method9 = await runtime.dispatchFetch("https://worker/");
      const method9Content = await method9.text(); expect(method9.status, method9Content).toBe(200);
      const method9Result = JSON.parse(method9Content);
      expect(method9Result.files[0].zip.method).toBe(9);
      expect(method9Result.files[0].sizeBytes).toBe(DEFLATE64_BYTES);
      expect(method9Result.files[0].sha256).toBe(createHash("sha256").update(Buffer.alloc(DEFLATE64_BYTES)).digest("hex"));
      const corrupted = zip([{ name: "main.exe", data: "native CRC validation" }]);
      const payload = corrupted.locations[0]!.payload; corrupted.bytes[payload] = corrupted.bytes[payload]! ^ 1;
      await runtime.dispatchFetch("https://worker/", { method: "PUT", body: corrupted.bytes });
      const failed = await runtime.dispatchFetch("https://worker/");
      expect(failed.status).toBe(500); expect(await failed.text()).toContain("CRC32");
    } finally { await runtime.dispose(); }
  }, 60_000);
});
