import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AppContext } from "../src/types";
import { handleCloudGateway } from "../src/lib/cloud-sync";

const master = "test-only-master-secret";
const accessKeyId = `MCL${"a".repeat(40)}`;
const secret = createHmac("sha256", master).update(`merlin-cloud-s3:v1:${accessKeyId}`).digest("hex");

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function signed(method: string, path: string, body?: string): Request {
  const url = new URL(`https://staging.api-merlin.com${path}`);
  const date = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const scope = `${date.slice(0, 8)}/us-east-1/s3/aws4_request`;
  const headers = new Headers({
    "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
    "x-amz-date": date,
  });
  const checksum = body === undefined ? "" : createHash("sha256").update(body).digest("base64");
  if (checksum) headers.set("x-amz-checksum-sha256", checksum);
  const signedNames = [...headers.keys(), "host"].sort();
  const canonicalHeaders = signedNames.map((name) => `${name}:${name === "host" ? url.host : headers.get(name)}\n`).join("");
  const canonical = [method, url.pathname, url.search.slice(1), canonicalHeaders, signedNames.join(";"), "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = `AWS4-HMAC-SHA256\n${date}\n${scope}\n${createHash("sha256").update(canonical).digest("hex")}`;
  const dateKey = hmac(`AWS4${secret}`, date.slice(0, 8));
  const regionKey = hmac(dateKey, "us-east-1");
  const serviceKey = hmac(regionKey, "s3");
  const signature = hmac(hmac(serviceKey, "aws4_request"), toSign).toString("hex");
  headers.set("authorization", `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedNames.join(";")}, Signature=${signature}`);
  return new Request(url, { method, headers, body });
}

function fakeContext(request: Request) {
  const objects = new Map<string, Uint8Array>();
  const multipart = new Map<string, Map<number, Uint8Array>>();
  const daily = new Map<string, number>();
  const bucket = {
    async get(key: string) {
      const bytes = objects.get(key);
      return bytes ? { body: new Blob([bytes]).stream(), etag: "etag", httpEtag: '"etag"', size: bytes.length } : null;
    },
    async head(key: string) {
      const bytes = objects.get(key);
      return bytes ? { httpEtag: '"etag"', size: bytes.length } : null;
    },
    async put(key: string, body: Uint8Array | ReadableStream) {
      const bytes = body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());
      objects.set(key, bytes);
      return { httpEtag: '"etag"' };
    },
    async delete(key: string) { objects.delete(key); },
    async list({ prefix }: { prefix: string }) {
      return { objects: [...objects.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, bytes]) => ({
        key, size: bytes.length, uploaded: new Date(), httpEtag: '"etag"',
      })), truncated: false };
    },
    async createMultipartUpload(key: string) {
      multipart.set(key, new Map());
      return { uploadId: "test-upload-id-123" };
    },
    resumeMultipartUpload(key: string, uploadId: string) {
      if (uploadId !== "test-upload-id-123" || !multipart.has(key)) throw new Error("invalid upload");
      return {
        async uploadPart(partNumber: number, bytes: Uint8Array) {
          multipart.get(key)!.set(partNumber, bytes);
          return { etag: createHash("md5").update(bytes).digest("hex") };
        },
        async complete(parts: { partNumber: number; etag: string }[]) {
          const chunks = parts.map((part) => multipart.get(key)!.get(part.partNumber)!);
          objects.set(key, new Uint8Array(Buffer.concat(chunks.map((item) => Buffer.from(item)))));
          multipart.delete(key);
          return { httpEtag: '"completed"' };
        },
        async abort() { multipart.delete(key); },
      };
    },
  };
  const database = {
    prepare(sql: string) {
      let params: unknown[] = [];
      return {
        bind(...values: unknown[]) { params = values; return this; },
        async first() {
          if (sql.includes("FROM cloud_sync_clients")) return {
            access_key_id: accessKeyId, hwid_digest: createHash("sha256").update("test-hwid").digest("hex"),
            lease_expires_at: new Date(Date.now() + 60_000).toISOString(), revoked_at: null,
            status: "active", license_expires_at: new Date(Date.now() + 60_000).toISOString(), license_hwid: "test-hwid",
          };
          if (sql.includes("FROM cloud_sync_daily_uploads")) return { bytes_uploaded: daily.get(String(params[0])) || 0 };
          return null;
        },
        async run() { daily.set(String(params[0]), (daily.get(String(params[0])) || 0) + Number(params[2])); },
      };
    },
  };
  return {
    context: { req: { raw: request }, env: { ENVIRONMENT: "staging", JWT_SECRET: master, merlin_db: database, MERLIN_FILES: bucket } } as unknown as AppContext,
    objects,
  };
}

describe("stage cloud gateway roundtrip", () => {
  it("stores, lists and retrieves a signed save; keeps only the latest recovery copies", async () => {
    const key = "/merlin-cloud/steam/123456/730/blobs/save.dat";
    const first = signed("PUT", key, "save-v1");
    const fixture = fakeContext(first);
    expect((await handleCloudGateway(fixture.context)).status).toBe(200);
    for (const version of ["save-v2", "save-v3", "save-v4", "save-v5"]) {
      fixture.context.req.raw = signed("PUT", key, version);
      expect((await handleCloudGateway(fixture.context)).status).toBe(200);
    }
    const recovery = [...fixture.objects.keys()].filter((item) => item.startsWith("cloud-sync/stage/recovery/"));
    expect(recovery).toHaveLength(2);
    fixture.context.req.raw = signed("GET", "/merlin-cloud?list-type=2&prefix=steam%2F123456%2F730%2F");
    const listing = await handleCloudGateway(fixture.context);
    expect(listing.status).toBe(200);
    expect(await listing.text()).toContain("steam/123456/730/blobs/save.dat");
    fixture.context.req.raw = signed("GET", key);
    expect(await (await handleCloudGateway(fixture.context)).text()).toBe("save-v5");
  });

  it("denies requests outside the stage environment", async () => {
    const fixture = fakeContext(signed("GET", "/merlin-cloud?list-type=2&prefix=steam%2F"));
    (fixture.context.env as unknown as { ENVIRONMENT: string }).ENVIRONMENT = "production";
    expect((await handleCloudGateway(fixture.context)).status).toBe(404);
  });

  it("accepts account-scoped metadata but refuses bucket-wide listing", async () => {
    const key = "/merlin-cloud/steam/123456/0/account.dat";
    const fixture = fakeContext(signed("PUT", key, "metadata"));
    expect((await handleCloudGateway(fixture.context)).status).toBe(200);
    fixture.context.req.raw = signed("GET", "/merlin-cloud?list-type=2&prefix=steam%2F");
    expect((await handleCloudGateway(fixture.context)).status).toBe(400);
  });

  it("preserves percent-encoded save names in the signed URL and R2 key", async () => {
    const key = "/merlin-cloud/steam/123456/730/blobs/My%20Saves/caf%C3%A9.dat";
    const fixture = fakeContext(signed("PUT", key, "accented-name"));
    expect((await handleCloudGateway(fixture.context)).status).toBe(200);
    expect(fixture.objects.has("cloud-sync/stage/steam/123456/730/blobs/My Saves/café.dat")).toBe(true);
    fixture.context.req.raw = signed("GET", key);
    expect(await (await handleCloudGateway(fixture.context)).text()).toBe("accented-name");
  });

  it("completes a CloudRedirect-style multipart upload", async () => {
    const key = "/merlin-cloud/steam/123456/730/blobs/large.dat";
    const fixture = fakeContext(signed("POST", `${key}?uploads=`));
    const created = await handleCloudGateway(fixture.context);
    expect(created.status).toBe(200);
    expect(await created.text()).toContain("test-upload-id-123");
    const etags: string[] = [];
    for (const [index, data] of ["first", "second"].entries()) {
      fixture.context.req.raw = signed("PUT", `${key}?partNumber=${index + 1}&uploadId=test-upload-id-123`, data);
      const part = await handleCloudGateway(fixture.context);
      expect(part.status).toBe(200);
      etags.push(part.headers.get("etag")!);
    }
    const completion = `<CompleteMultipartUpload>${etags.map((etag, index) => `<Part><PartNumber>${index + 1}</PartNumber><ETag>${etag}</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
    fixture.context.req.raw = signed("POST", `${key}?uploadId=test-upload-id-123`, completion);
    expect((await handleCloudGateway(fixture.context)).status).toBe(200);
    fixture.context.req.raw = signed("GET", key);
    expect(await (await handleCloudGateway(fixture.context)).text()).toBe("firstsecond");
  });
});
