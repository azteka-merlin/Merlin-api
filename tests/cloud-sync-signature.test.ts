import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { objectKey, parseSignature, verifySignature } from "../src/lib/cloud-sync";

const master = "test-only-master-secret";
const keyId = `MCL${"a".repeat(40)}`;

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function signedRequest(method: string, urlString: string, timestamp = new Date()): Request {
  const url = new URL(urlString);
  const date = timestamp.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const dateStamp = date.slice(0, 8);
  const headers = new Headers({
    "x-amz-date": date,
    "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
  });
  const secret = hmac(master, `merlin-cloud-s3:v1:${keyId}`).toString("hex");
  const canonicalHeaders = `host:${url.host}\nx-amz-content-sha256:UNSIGNED-PAYLOAD\nx-amz-date:${date}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonical = [method, url.pathname, url.search.slice(1), canonicalHeaders, signedHeaders, "UNSIGNED-PAYLOAD"].join("\n");
  const scope = `${dateStamp}/us-east-1/s3/aws4_request`;
  const toSign = `AWS4-HMAC-SHA256\n${date}\n${scope}\n${createHash("sha256").update(canonical).digest("hex")}`;
  const dateKey = hmac(`AWS4${secret}`, dateStamp);
  const regionKey = hmac(dateKey, "us-east-1");
  const serviceKey = hmac(regionKey, "s3");
  const signature = hmac(hmac(serviceKey, "aws4_request"), toSign).toString("hex");
  headers.set("authorization", `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`);
  return new Request(url, { method, headers });
}

describe("Merlin stage cloud S3 facade", () => {
  it("accepts a CloudRedirect-style SigV4 request", async () => {
    const request = signedRequest("GET", "https://staging.api-merlin.com/merlin-cloud?list-type=2&prefix=steam%2F");
    const parsed = parseSignature(request);
    expect(parsed).not.toBeNull();
    expect(await verifySignature(request, master, parsed!)).toBe(true);
  });

  it("rejects a changed target, a changed header and an old signature", async () => {
    const request = signedRequest("GET", "https://staging.api-merlin.com/merlin-cloud/steam/123/730/save");
    const changedTarget = new Request("https://staging.api-merlin.com/merlin-cloud/steam/456/730/save", request);
    expect(await verifySignature(changedTarget, master, parseSignature(changedTarget)!)).toBe(false);
    const changedHeader = new Request(request);
    changedHeader.headers.set("x-amz-content-sha256", "incorrect");
    expect(await verifySignature(changedHeader, master, parseSignature(changedHeader)!)).toBe(false);
    const old = signedRequest("GET", request.url, new Date(Date.now() - 600_000));
    expect(await verifySignature(old, master, parseSignature(old)!)).toBe(false);
  });

  it("keeps R2 object keys within the Steam namespace", () => {
    expect(objectKey("/merlin-cloud/steam/123/730/save.dat")).toBe("steam/123/730/save.dat");
    expect(objectKey("/merlin-cloud/steam/123/0/account-metadata")).toBe("steam/123/0/account-metadata");
    expect(objectKey("/merlin-cloud/steam/123/730/../save.dat")).toBeNull();
    expect(objectKey("/merlin-cloud/assets/private.txt")).toBeNull();
    expect(objectKey("/merlin-cloud/steam/123/730/%2e%2e/private.txt")).toBeNull();
  });
});
