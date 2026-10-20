import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import { configurationFromEnv, indexZip, IndexerClient, processIndexJob, runIndexer, safeError } from "./lib/custom-game-indexer.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
function fixtureZip(entries, { zip64 = false } = {}) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const bytes = Buffer.from(entry.data || "");
    const method = entry.method ?? 0;
    const compressed = method === 8 ? deflateRawSync(bytes) : bytes;
    const checksum = crc32(bytes);
    const size = entry.declaredSize ?? bytes.length;
    const localExtra = zip64 ? Buffer.alloc(20) : Buffer.alloc(0);
    const centralExtra = zip64 ? Buffer.alloc(28) : Buffer.alloc(0);
    if (zip64) {
      localExtra.writeUInt16LE(1, 0); localExtra.writeUInt16LE(16, 2);
      localExtra.writeBigUInt64LE(BigInt(size), 4); localExtra.writeBigUInt64LE(BigInt(compressed.length), 12);
      centralExtra.writeUInt16LE(1, 0); centralExtra.writeUInt16LE(24, 2);
      centralExtra.writeBigUInt64LE(BigInt(size), 4); centralExtra.writeBigUInt64LE(BigInt(compressed.length), 12);
      centralExtra.writeBigUInt64LE(BigInt(offset), 20);
    }
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(zip64 ? 45 : 20, 4);
    head.writeUInt16LE(entry.flags ?? 0x800, 6); head.writeUInt16LE(method, 8);
    head.writeUInt32LE(checksum, 14); head.writeUInt32LE(zip64 ? 0xffffffff : compressed.length, 18);
    head.writeUInt32LE(zip64 ? 0xffffffff : size, 22); head.writeUInt16LE(name.length, 26); head.writeUInt16LE(localExtra.length, 28);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE((3 << 8) | 45, 4); dir.writeUInt16LE(zip64 ? 45 : 20, 6);
    dir.writeUInt16LE(entry.flags ?? 0x800, 8); dir.writeUInt16LE(method, 10);
    dir.writeUInt32LE(checksum, 16); dir.writeUInt32LE(zip64 ? 0xffffffff : compressed.length, 20);
    dir.writeUInt32LE(zip64 ? 0xffffffff : size, 24); dir.writeUInt16LE(name.length, 28); dir.writeUInt16LE(centralExtra.length, 30);
    const attributes = entry.attributes ?? (((entry.name.endsWith("/") ? 0x41ed : 0x81a4) << 16) >>> 0);
    dir.writeUInt32LE(attributes, 38); dir.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
    local.push(head, name, localExtra, compressed); central.push(dir, name, centralExtra);
    offset += head.length + name.length + localExtra.length + compressed.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(zip64 ? 0xffff : entries.length, 8);
  end.writeUInt16LE(zip64 ? 0xffff : entries.length, 10); end.writeUInt32LE(zip64 ? 0xffffffff : centralBytes.length, 12);
  end.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  const tail = [];
  if (zip64) {
    const end64 = Buffer.alloc(56);
    end64.writeUInt32LE(0x06064b50, 0); end64.writeBigUInt64LE(44n, 4); end64.writeUInt16LE(45, 12); end64.writeUInt16LE(45, 14);
    end64.writeBigUInt64LE(BigInt(entries.length), 24); end64.writeBigUInt64LE(BigInt(entries.length), 32);
    end64.writeBigUInt64LE(BigInt(centralBytes.length), 40); end64.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0); locator.writeBigUInt64LE(BigInt(offset + centralBytes.length), 8); locator.writeUInt32LE(1, 16);
    tail.push(end64, locator);
  }
  return Buffer.concat([...local, centralBytes, ...tail, end]);
}

async function withZip(t, bytes, run) {
  const directory = await mkdtemp(path.join(tmpdir(), "merlin-index-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "fixture.zip");
  await writeFile(filename, bytes);
  return run(filename, directory);
}

for (const zip64 of [false, true]) test(`streaming ZIP${zip64 ? "64" : ""} hashes stored, deflate and empty members with correct byte locators`, async t => {
  const entries = [{ name: "game/" }, { name: "game/main.exe", data: "game binary" },
    { name: "game/data.pak", data: "packed content".repeat(500), method: 8 }, { name: "empty.cfg", data: "" }];
  const bytes = fixtureZip(entries, { zip64 });
  await withZip(t, bytes, async filename => {
    const events = [];
    const manifest = await indexZip(filename, { onProgress: event => events.push(event) });
    assert.equal(manifest.files.length, 3);
    for (const [index, member] of manifest.files.entries()) {
      const source = entries[index + 1];
      assert.equal(member.sha256, sha(source.data));
      const payload = bytes.subarray(member.zip.offset, member.zip.offset + member.zip.compressedSize);
      assert.equal(member.zip.method === 8 ? inflateRawSync(payload).toString() : payload.toString(), source.data);
      assert.equal(member.zip.crc32, crc32(Buffer.from(source.data)));
    }
    assert.equal(events.at(-1).processedBytes, manifest.totalSizeBytes);
    assert.equal(events.at(-1).processedFiles, 3);
    assert.ok(events.every((event, index) => !index || event.processedBytes >= events[index - 1].processedBytes));
  });
});

test("CRC mismatch is rejected even when decompressed length is correct", async t => {
  const bytes = fixtureZip([{ name: "main.exe", data: "original" }]);
  bytes[30 + Buffer.byteLength("main.exe")] ^= 1;
  await withZip(t, bytes, filename => assert.rejects(indexZip(filename), /CRC32/));
});

for (const [label, entries, expected] of [
  ["zip slip", [{ name: "../outside.exe", data: "x" }], /invalid|caminho/i],
  ["Windows reserved name", [{ name: "game/CON.exe", data: "x" }], /caminho/i],
  ["case collision", [{ name: "Main.exe", data: "x" }, { name: "main.exe", data: "x" }], /caixa|duplicados/i],
  ["file-directory conflict", [{ name: "game", data: "x" }, { name: "game/main.exe", data: "x" }], /conflito/i],
  ["duplicate member", [{ name: "main.exe", data: "x" }, { name: "main.exe", data: "x" }], /duplicados/i],
  ["symlink", [{ name: "main.exe", data: "elsewhere", attributes: (0xa1ff << 16) >>> 0 }], /simbólicos/i],
  ["encrypted", [{ name: "main.exe", data: "x", method: 8, flags: 0x801 }], /criptografado/i],
  ["unsupported compression", [{ name: "main.exe", data: "x", method: 12 }], /stored ou deflate/i],
  ["deflate expansion beyond declared length", [{ name: "main.exe", data: "content".repeat(1000), method: 8, declaredSize: 5 }], /size|tamanho|bytes/i],
]) test(`rejects ${label}`, async t => {
  await withZip(t, fixtureZip(entries), filename => assert.rejects(indexZip(filename), expected));
});

test("limits reject an oversized archive and expanded payload before hashing", async t => {
  await withZip(t, fixtureZip([{ name: "data.pak", data: "1234567890", method: 8 }]), async filename => {
    await assert.rejects(indexZip(filename, { limits: { maxArchiveBytes: 8 } }), /limite/);
    await assert.rejects(indexZip(filename, { limits: { maxGameBytes: 8 } }), /limite/);
  });
});

test("rejects local headers that disagree with the central directory", async t => {
  const bytes = fixtureZip([{ name: "main.exe", data: "123" }]);
  bytes[30] = "x".charCodeAt(0);
  await withZip(t, bytes, filename => assert.rejects(indexZip(filename), /Nome local/));
});

const job = { id: "job1", gameId: "game1", archiveKey: "archives/game.zip", packageType: "zip", leaseToken: "lease-secret", sourceEtag: "source-v1", sourceSize: 0 };
function sourceResponse(bytes, start, end, extra = {}) {
  return new Response(bytes.subarray(start, end + 1), { status: 206, headers: {
    "content-range": `bytes ${start}-${end}/${bytes.length}`, "content-length": String(end - start + 1), etag: '"source-v1"', ...extra } });
}

test("HTTP range resumes after a partially read body without double-hashing", async () => {
  const bytes = Buffer.from("0123456789");
  const ranges = [];
  let interrupted = false;
  const client = new IndexerClient({ apiUrl: "http://localhost:8787", secret: "api-secret", retryDelayMs: 1,
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers.authorization, "Bearer api-secret");
      if (options.method === "HEAD") return new Response(null, { headers: { "content-length": String(bytes.length), etag: "source-v1" } });
      const range = /^bytes=(\d+)-(\d+)$/.exec(options.headers.range);
      const [start, end] = range.slice(1).map(Number); ranges.push([start, end]);
      if (!interrupted) {
        interrupted = true;
        let count = 0;
        return new Response(new ReadableStream({ pull(controller) {
          if (!count++) controller.enqueue(bytes.subarray(0, 3));
          else controller.error(new Error("connection reset"));
        } }), { status: 206, headers: { "content-range": `bytes ${start}-${end}/${bytes.length}`, etag: "source-v1" } });
      }
      return sourceResponse(bytes, start, end);
    } });
  const received = [];
  await client.readSource({ ...job, sourceSize: bytes.length }, { sizeBytes: bytes.length, rangeBytes: 6, consume: async chunk => received.push(chunk) });
  assert.deepEqual(ranges, [[0, 5], [3, 8], [9, 9]]);
  assert.equal(sha(Buffer.concat(received)), sha(bytes));
});

test("full ZIP job heartbeats during a slow download and removes its temporary ZIP", async t => {
  const bytes = fixtureZip([{ name: "main.exe", data: "my game" }]);
  await withZip(t, bytes, async (_filename, directory) => {
    const reports = [];
    let completed;
    const client = new IndexerClient({ apiUrl: "http://localhost", secret: "api-secret", retryDelayMs: 1,
      fetchImpl: async (url, options) => {
        if (url.endsWith("/progress")) { reports.push(JSON.parse(options.body)); return Response.json({ success: true }); }
        if (url.endsWith("/complete")) { completed = JSON.parse(options.body); return Response.json({ success: true }); }
        if (options.method === "HEAD") return new Response(null, { headers: { "content-length": String(bytes.length), etag: "source-v1" } });
        const [start, end] = /^bytes=(\d+)-(\d+)$/.exec(options.headers.range).slice(1).map(Number);
        await delay(55);
        return sourceResponse(bytes, start, end);
      } });
    const manifest = await processIndexJob(client, { ...job, sourceSize: bytes.length },
      { tempRoot: directory, limits: { reserveDiskBytes: 0 }, heartbeatMs: 15 });
    assert.equal(manifest.archiveSha256, sha(bytes));
    assert.equal(completed.manifest.files[0].sha256, sha("my game"));
    assert.ok(reports.filter(item => item.phase === "downloading" && item.processedBytes === 0).length >= 2);
    assert.equal(reports.at(-1).processedFiles, 1);
    assert.deepEqual(await readdir(directory), ["fixture.zip"]);
  });
});

test("legacy folder job streams each object and verifies existing hashes", async () => {
  const bytes = Buffer.from("folder binary");
  let completed;
  const client = new IndexerClient({ apiUrl: "http://localhost", secret: "api-secret", fetchImpl: async (url, options) => {
    if (url.endsWith("/progress")) return Response.json({ success: true });
    if (url.endsWith("/complete")) { completed = JSON.parse(options.body); return Response.json({ success: true }); }
    assert.ok(url.endsWith("?file=0"));
    if (options.method === "HEAD") return new Response(null, { headers: { "content-length": String(bytes.length), etag: "source-v1" } });
    return sourceResponse(bytes, 0, bytes.length - 1);
  } });
  await processIndexJob(client, { ...job, packageType: "folder", files: [{ key: "files/1", path: "main.exe", sizeBytes: bytes.length, sha256: sha(bytes) }] });
  assert.equal(completed.manifest.files[0].sha256, sha(bytes));
  assert.equal(completed.manifest.totalSizeBytes, bytes.length);
});

test("worker stops after an empty --once claim and redacts credentials", async () => {
  let requests = 0;
  const client = new IndexerClient({ apiUrl: "http://localhost", secret: "api-secret", fetchImpl: async () => { requests++; return Response.json({ job: null }); } });
  await runIndexer({ client, once: true, log: () => {} });
  assert.equal(requests, 1);
  assert.equal(safeError(new Error("api-secret lease-secret"), ["api-secret", "lease-secret"]), "[redacted] [redacted]");
  assert.throws(() => configurationFromEnv({}), /CUSTOM_GAME_INDEXER_API_URL/);
  assert.throws(() => new IndexerClient({ apiUrl: "http://untrusted.example", secret: "x" }), /HTTPS/);
});

test("idempotent POST retries when the completion acknowledgement body is lost", async () => {
  let attempts = 0;
  const client = new IndexerClient({ apiUrl: "http://localhost", secret: "api-secret", retryDelayMs: 1,
    fetchImpl: async () => {
      if (!attempts++) return new Response(new ReadableStream({ start(controller) { controller.error(new Error("lost acknowledgement")); } }));
      return Response.json({ success: true, alreadyCompleted: true });
    } });
  const result = await client.post("/job/complete", { leaseToken: "lease", manifest: {} });
  assert.equal(attempts, 2);
  assert.equal(result.alreadyCompleted, true);
});

test("loss of heartbeat aborts network work and cleans the temporary directory", async t => {
  const bytes = fixtureZip([{ name: "main.exe", data: "my game" }]);
  await withZip(t, bytes, async (_filename, directory) => {
    let heartbeat = 0;
    const client = new IndexerClient({ apiUrl: "http://localhost", secret: "api-secret", retryDelayMs: 1,
      fetchImpl: async (url, options) => {
        if (url.endsWith("/progress")) {
          return ++heartbeat > 1 ? new Response(null, { status: 409 }) : Response.json({ success: true });
        }
        if (options.method === "HEAD") return new Response(null, { headers: { "content-length": String(bytes.length), etag: "source-v1" } });
        await delay(1000, undefined, { signal: options.signal });
        throw new Error("unexpected completion");
      } });
    await assert.rejects(processIndexJob(client, { ...job, sourceSize: bytes.length },
      { tempRoot: directory, limits: { reserveDiskBytes: 0 }, heartbeatMs: 15 }), /409/);
    assert.deepEqual(await readdir(directory), ["fixture.zip"]);
  });
});

test("accepts a correctly deflated empty directory without adding it to the file manifest", async t => {
  const bytes = fixtureZip([{ name: "game/", method: 8 }, { name: "game/main.exe", data: "x" }]);
  await withZip(t, bytes, async filename => {
    const manifest = await indexZip(filename);
    assert.equal(manifest.files.length, 1);
    assert.equal(manifest.files[0].sha256, sha("x"));
  });
});

test("pins HEAD ETag for a legacy folder and refuses ranges from another version", async () => {
  const oldBytes = Buffer.from([1, 2, 3]); const newBytes = Buffer.from([4, 5, 6]);
  let completed; let range = 0;
  const legacyJob = { ...job, archiveKey: "folder/manifest", packageType: "folder", sourceEtag: "manifest-v1", sourceSize: 3,
    files: [{ key: "files/1", path: "main.exe", sizeBytes: 3 }] };
  const client = new IndexerClient({ apiUrl: "http://localhost", secret: "api-secret", fetchImpl: async (url, options) => {
    if (url.endsWith("/progress")) return Response.json({ success: true });
    if (url.endsWith("/complete")) { completed = JSON.parse(options.body); return Response.json({ success: true }); }
    if (options.method === "HEAD") return new Response(null, { headers: { "content-length": "3", etag: "version1" } });
    assert.equal(options.headers["if-match"], '"version1"');
    const [start, end] = /^bytes=(\d+)-(\d+)$/.exec(options.headers.range).slice(1).map(Number);
    const current = range++ === 0 ? oldBytes : newBytes;
    return new Response(current.subarray(start, end + 1), { status: 206, headers: {
      "content-range": `bytes ${start}-${end}/3`, etag: range === 1 ? "version1" : "version2" } });
  } });
  await assert.rejects(processIndexJob(client, legacyJob, { rangeBytes: 1 }), /409/);
  assert.equal(completed, undefined);
});
