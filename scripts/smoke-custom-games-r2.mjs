// Small, isolated transport smoke test. Credentials stay in memory and signed
// URLs are never printed. The temporary multipart/object is removed in finally.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { AwsClient } from "aws4fetch";

const profile = process.argv[2] || "merlin-r2";
const account = process.env.CUSTOM_GAMES_R2_ACCOUNT_ID || "7ad4971c1414af1203494d55ab660307";
if (!/^[a-f0-9]{32}$/.test(account)) throw new Error("Invalid R2 account");
const credentials = JSON.parse(execFileSync("aws", ["configure", "export-credentials", "--profile", profile, "--format", "process"], { encoding: "utf8" }));
const signer = new AwsClient({ accessKeyId: credentials.AccessKeyId, secretAccessKey: credentials.SecretAccessKey, service: "s3", region: "auto" });
const key = `_upload-smoke/${randomUUID()}`;
const target = `https://${account}.r2.cloudflarestorage.com/custom-games/${key}`;
let uploadId;
let complete = false;
async function check(response, operation) {
  if (!response.ok) throw new Error(`${operation} failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
  return response;
}
try {
  const checkpointTarget = `${target}-checkpoint`;
  try {
    let etag;
    for (let index = 0; index < 3; index++) {
      const response = await check(await signer.fetch(checkpointTarget, { method: "PUT", headers: etag ? { "If-Match": etag } : { "If-None-Match": "*" }, body: JSON.stringify({ index }) }), "conditional checkpoint update");
      etag = response.headers.get("etag");
      assert.ok(etag);
      await response.arrayBuffer();
    }
  } finally { await check(await signer.fetch(checkpointTarget, { method: "DELETE" }), "checkpoint cleanup"); }
  const created = await check(await signer.fetch(`${target}?uploads`, { method: "POST" }), "initiate");
  const xml = await created.text();
  uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(xml)?.[1];
  assert.ok(uploadId);
  const url = new URL(target);
  url.searchParams.set("uploadId", uploadId);
  url.searchParams.set("partNumber", "1");
  url.searchParams.set("X-Amz-Expires", "900");
  const signed = await signer.sign(url, { method: "PUT", aws: { signQuery: true } });
  const preflight = await check(await fetch(signed.url, { method: "OPTIONS", headers: {
    Origin: "https://api-merlin.com", "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "content-type",
  } }), "CORS preflight");
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://api-merlin.com");
  const bytes = Buffer.alloc(6 * 1024 ** 2, 0x5a);
  const uploaded = await check(await fetch(signed.url, { method: "PUT", headers: { "Content-Type": "application/octet-stream", Origin: "https://api-merlin.com" }, body: bytes }), "signed part");
  const etag = uploaded.headers.get("etag");
  assert.ok(etag);
  assert.match(uploaded.headers.get("access-control-expose-headers") || "", /etag/i);
  await uploaded.arrayBuffer();
  const finished = await check(await signer.fetch(`${target}?uploadId=${encodeURIComponent(uploadId)}`, { method: "POST", headers: { "Content-Type": "application/xml" },
    body: `<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>${etag.replace(/"/g, "&quot;")}</ETag></Part></CompleteMultipartUpload>` }), "complete");
  assert.ok(!(await finished.text()).includes("<Error>"));
  complete = true;
  const downloaded = await check(await signer.fetch(target), "integrity read");
  const received = Buffer.from(await downloaded.arrayBuffer());
  assert.equal(createHash("sha256").update(received).digest("hex"), createHash("sha256").update(bytes).digest("hex"));
  console.log("R2 smoke passed: CORS, presigned multipart PUT, ETag, complete and SHA-256 roundtrip (6 MiB).");
} finally {
  if (uploadId && !complete) await check(await signer.fetch(`${target}?uploadId=${encodeURIComponent(uploadId)}`, { method: "DELETE" }), "abort cleanup");
  if (complete) await check(await signer.fetch(target, { method: "DELETE" }), "object cleanup");
  console.log("Temporary R2 smoke data removed.");
}
