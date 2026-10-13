// One-time production migration. Copy and verify first; never delete source keys here.
// Run from Merlin-api: node scripts/migrate-custom-games-prefix.mjs --apply
import { spawn, spawnSync } from "node:child_process";

const apply = process.argv.includes("--apply");
const cleanup = process.argv.includes("--cleanup");
const endpoint = "https://7ad4971c1414af1203494d55ab660307.r2.cloudflarestorage.com";
const bucket = "custom-games";
const profile = "merlin-r2";
const uuid = /^[0-9a-f-]{36}$/;
const awsBase = ["--endpoint-url", endpoint, "--profile", profile, "--cli-read-timeout", "300", "--cli-connect-timeout", "30"];
const knownObjects = new Map();
const knownPrefixes = new Set();

function run(command, args, input) {
  const result = spawnSync(command, args, { cwd: process.cwd(), input, encoding: "utf8", maxBuffer: 24 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${String(result.stderr || result.stdout).slice(0, 1000)}`);
  return result.stdout;
}

function aws(args, input) { return run("aws", [...args, ...awsBase], input); }
function awsAsync(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("aws", [...args, ...awsBase], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(stdout) : reject(new Error(`aws failed (${code}): ${stderr.slice(0, 1000)}`)));
  });
}
function objectUrl(key) { return `s3://${bucket}/${key}`; }
function listPrefix(prefix) {
  const listing = JSON.parse(aws(["s3api", "list-objects-v2", "--bucket", bucket, "--prefix", prefix]));
  for (const object of listing.Contents || []) knownObjects.set(object.Key, { ContentLength: object.Size, ETag: object.ETag });
  knownPrefixes.add(prefix);
}
function head(key, optional = false) {
  if (knownObjects.has(key)) return knownObjects.get(key);
  if (knownPrefixes.size && [...knownPrefixes].some(prefix => key.startsWith(prefix))) {
    if (optional) return null;
    throw new Error(`Missing source object: ${key}`);
  }
  const result = spawnSync("aws", ["s3api", "head-object", "--bucket", bucket, "--key", key, ...awsBase],
    { encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (optional && result.status !== 0 && /\b(404|Not Found|NoSuchKey)\b/.test(result.stderr)) return null;
  if (result.status !== 0) throw new Error(`HEAD ${key}: ${result.stderr.slice(0, 1000)}`);
  const object = JSON.parse(result.stdout);
  knownObjects.set(key, object);
  return object;
}

function copyVerified(oldKey, newKey, expectedSize) {
  const source = head(oldKey);
  if (source.ContentLength !== expectedSize) throw new Error(`Source size mismatch: ${oldKey}`);
  let target = head(newKey, true);
  if (target && target.ContentLength !== expectedSize) throw new Error(`Existing target size mismatch: ${newKey}`);
  if (!target && apply) {
    if (expectedSize < 8 * 1024 ** 2) {
      aws(["s3api", "copy-object", "--bucket", bucket, "--key", newKey, "--copy-source", `${bucket}/${oldKey}`]);
    } else {
      aws(["s3", "cp", objectUrl(oldKey), objectUrl(newKey), "--no-progress", "--copy-props", "none"]);
    }
    target = JSON.parse(aws(["s3api", "head-object", "--bucket", bucket, "--key", newKey]));
    knownObjects.set(newKey, target);
  }
  if (apply && target?.ContentLength !== expectedSize) throw new Error(`Target copy incomplete: ${newKey}`);
  console.log(`${target ? "verified" : "would copy"} ${oldKey} -> ${newKey} (${expectedSize})`);
  return target;
}

async function copyVerifiedAsync(oldKey, newKey, expectedSize) {
  const source = head(oldKey);
  if (source.ContentLength !== expectedSize) throw new Error(`Source size mismatch: ${oldKey}`);
  let target = head(newKey, true);
  if (target && target.ContentLength !== expectedSize) throw new Error(`Existing target size mismatch: ${newKey}`);
  if (!target && apply) {
    if (expectedSize < 8 * 1024 ** 2) {
      await awsAsync(["s3api", "copy-object", "--bucket", bucket, "--key", newKey, "--copy-source", `${bucket}/${oldKey}`]);
    } else {
      await awsAsync(["s3", "cp", objectUrl(oldKey), objectUrl(newKey), "--no-progress", "--copy-props", "none"]);
    }
    target = JSON.parse(await awsAsync(["s3api", "head-object", "--bucket", bucket, "--key", newKey]));
    knownObjects.set(newKey, target);
  }
  if (apply && target?.ContentLength !== expectedSize) throw new Error(`Target copy incomplete: ${newKey}`);
  console.log(`${target ? "verified" : "would copy"} ${oldKey} -> ${newKey} (${expectedSize})`);
  return target;
}

function wrangler(sql) {
  const result = JSON.parse(run(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "d1", "execute", "merlin-db", "--remote", "--json", "--command", sql]));
  if (!result?.[0]?.success) throw new Error("D1 operation failed");
  return result[0];
}

const games = wrangler("SELECT id,name,image_key,archive_key,archive_size,package_type,published FROM custom_games ORDER BY created_at DESC;").results;
if (cleanup) {
  const oldKeys = [];
  listPrefix("game-files/");
  listPrefix("images/");
  listPrefix("archives/");
  listPrefix("manifests/");
  for (const game of games) {
    if (!uuid.test(game.id) || !game.image_key.startsWith(`${game.id}/images/`)) throw new Error(`Game image not migrated: ${game.id}`);
    const oldImage = `images/${game.image_key.split("/").at(-1)}`;
    if (head(oldImage, true)?.ContentLength !== head(game.image_key).ContentLength) throw new Error(`Image differs: ${game.id}`);
    oldKeys.push(oldImage);
    if (game.archive_key === `draft/${game.id}`) continue;
    if (!game.archive_key.startsWith(`${game.id}/`)) throw new Error(`Game package not migrated: ${game.id}`);
    if (game.package_type === "zip") {
      const oldArchive = `archives/${game.archive_key.split("/").at(-1)}`;
      if (head(oldArchive, true)?.ContentLength !== game.archive_size || head(game.archive_key).ContentLength !== game.archive_size) {
        throw new Error(`Archive differs: ${game.id}`);
      }
      oldKeys.push(oldArchive);
    } else if (game.package_type === "folder") {
      const oldManifest = `manifests/${game.archive_key.split("/").at(-1)}`;
      const manifest = JSON.parse(aws(["s3", "cp", objectUrl(game.archive_key), "-", "--no-progress"]));
      if (!Array.isArray(manifest.files) || manifest.totalSizeBytes !== game.archive_size || !head(oldManifest, true)) {
        throw new Error(`Manifest differs: ${game.id}`);
      }
      listPrefix(`${game.id}/files/`);
      for (const file of manifest.files) {
        if (!file.key.startsWith(`${game.id}/files/`)) throw new Error(`File outside game: ${file.key}`);
        if (file.sizeBytes === 0) continue;
        const oldFile = `game-files/${file.key.split("/").at(-1)}`;
        if (head(oldFile, true)?.ContentLength !== file.sizeBytes || head(file.key).ContentLength !== file.sizeBytes ||
            head(file.key).ETag.replace(/^"|"$/g, "") !== file.etag) throw new Error(`File differs: ${file.key}`);
        oldKeys.push(oldFile);
      }
      oldKeys.push(oldManifest);
    } else throw new Error(`Unexpected package type: ${game.package_type}`);
  }
  console.log(`${apply ? "Removing" : "Would remove"} ${oldKeys.length} verified legacy objects; unmatched objects are untouched.`);
  if (apply) {
    for (let index = 0; index < oldKeys.length; index += 100) {
      const keys = oldKeys.slice(index, index + 100);
      const result = JSON.parse(aws(["s3api", "delete-objects", "--bucket", bucket,
        "--delete", JSON.stringify({ Objects: keys.map(Key => ({ Key })), Quiet: false })]));
      if (result.Errors?.length) throw new Error(`Legacy deletion failed at batch ${index / 100 + 1}`);
    }
    const remaining = new Set(["game-files/", "images/", "archives/", "manifests/"].flatMap(prefix =>
      (JSON.parse(aws(["s3api", "list-objects-v2", "--bucket", bucket, "--prefix", prefix])).Contents || []).map(object => object.Key)));
    if (oldKeys.some(key => remaining.has(key))) throw new Error("Some legacy objects remain after deletion");
  }
  process.exit(0);
}
for (const game of games) {
  if (!uuid.test(game.id)) throw new Error(`Invalid game ID: ${game.id}`);
  if ((game.archive_key.startsWith(`${game.id}/`) || game.archive_key === `draft/${game.id}`) &&
      game.image_key.startsWith(`${game.id}/`)) continue;
  if (!/^images\/[0-9a-f-]{36}\.(jpg|png|webp)$/.test(game.image_key)) throw new Error(`Unexpected image key: ${game.image_key}`);
  const newImage = `${game.id}/${game.image_key}`;
  copyVerified(game.image_key, newImage, head(game.image_key).ContentLength);
  let newPackage = game.archive_key;
  if (game.archive_key === `draft/${game.id}`) {
    // Draft has no package object.
  } else if (game.package_type === "zip") {
    if (!/^archives\/[0-9a-f-]{36}\.zip$/.test(game.archive_key)) throw new Error(`Unexpected archive: ${game.archive_key}`);
    newPackage = `${game.id}/${game.archive_key}`;
    copyVerified(game.archive_key, newPackage, game.archive_size);
  } else if (game.package_type === "folder") {
    if (!/^manifests\/[0-9a-f-]{36}\.json$/.test(game.archive_key)) throw new Error(`Unexpected manifest: ${game.archive_key}`);
    const manifest = JSON.parse(aws(["s3", "cp", objectUrl(game.archive_key), "-", "--no-progress"]));
    if (!Array.isArray(manifest.files) || manifest.totalSizeBytes !== game.archive_size) throw new Error(`Invalid manifest: ${game.archive_key}`);
    listPrefix("game-files/");
    listPrefix(`${game.id}/files/`);
    const updated = structuredClone(manifest);
    let next = 0;
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (next < manifest.files.length) {
        const i = next++;
        const file = manifest.files[i];
        if (!/^game-files\/[0-9a-f-]{36}$/.test(file.key)) throw new Error(`Unexpected file key: ${file.key}`);
        const newKey = `${game.id}/files/${file.key.slice("game-files/".length)}`;
        updated.files[i].key = newKey;
        if (file.sizeBytes > 0) {
          const copied = await copyVerifiedAsync(file.key, newKey, file.sizeBytes);
          if (copied) updated.files[i].etag = copied.ETag.replace(/^"|"$/g, "");
        }
      }
    }));
    newPackage = `${game.id}/${game.archive_key}`;
    if (apply) {
      const payload = JSON.stringify(updated);
      aws(["s3", "cp", "-", objectUrl(newPackage), "--content-type", "application/json", "--no-progress"], payload);
      const copiedManifest = JSON.parse(aws(["s3", "cp", objectUrl(newPackage), "-", "--no-progress"]));
      if (copiedManifest.files.length !== updated.files.length || copiedManifest.totalSizeBytes !== updated.totalSizeBytes ||
          copiedManifest.files.some((file, index) => file.key !== updated.files[index].key || file.etag !== updated.files[index].etag)) {
        throw new Error(`Manifest verification failed: ${newPackage}`);
      }
    }
    console.log(`${apply ? "verified" : "would write"} ${newPackage} (${manifest.files.length} files)`);
  } else throw new Error(`Unexpected package type: ${game.package_type}`);

  if (apply) {
    const sql = `UPDATE custom_games SET image_key='${newImage}',archive_key='${newPackage}',updated_at=CURRENT_TIMESTAMP WHERE id='${game.id}' AND image_key='${game.image_key}' AND archive_key='${game.archive_key}';`;
    const updated = wrangler(sql);
    if (updated.meta.changes !== 1) throw new Error(`D1 compare-and-swap failed: ${game.id}`);
  }
  console.log(`${apply ? "migrated" : "would migrate"} ${game.name} (${game.id})`);
}
