import { crc32 } from "node:zlib";
import type { IntegrityFile } from "./custom-game-integrity";

const GiB = 1024 ** 3;
const MAX_ARCHIVE = 100 * GiB;
const MAX_GAME = 200 * GiB;
const MAX_FILE = 30 * GiB;
const MAX_FILES = 100_000;
const MAX_ENTRIES = 200_000;
const MAX_CENTRAL_BYTES = 64 * 1024 ** 2;
const MAX_PLAN_BYTES = 16 * 1024 ** 2;
const MAX_PATH_INDEX_BYTES = 16 * 1024 ** 2;
const WINDOW_BYTES = 1024 ** 2;
const encoder = new TextEncoder();
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
// The first 128 CP437 characters agree with ASCII. Keep the upper half explicit;
// TextDecoder does not offer CP437 in the Workers runtime.
const CP437 = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";

export type CloudflareZipEntry = {
  path: string;
  sizeBytes: number;
  compressedSize: number;
  method: 0 | 8 | 9;
  crc32: number;
  flags: number;
  localHeaderOffset: number;
  /** First following local header, or the start of the central directory. */
  dataBoundary: number;
  /** Base64 preserves byte-for-byte local/central name equality across JSON. */
  rawName: string;
};

function invalid(message: string): never { throw new Error(message); }
function integer(value: number, maximum: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) invalid(`${label} inválido ou acima do limite.`);
  return value;
}
function view(bytes: Uint8Array) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
function u16(bytes: Uint8Array, offset: number) { return view(bytes).getUint16(offset, true); }
function u32(bytes: Uint8Array, offset: number) { return view(bytes).getUint32(offset, true); }
function u64(bytes: Uint8Array, offset: number) {
  if (offset + 8 > bytes.byteLength) invalid("Campo ZIP64 truncado.");
  const number = Number(view(bytes).getBigUint64(offset, true));
  return integer(number, Number.MAX_SAFE_INTEGER, "Valor ZIP64");
}
function sameBytes(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
function toBase64(bytes: Uint8Array) {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}
function fromBase64(value: string) {
  if (typeof value !== "string" || value.length > 88_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) invalid("Nome ZIP armazenado inválido.");
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}
function safePath(value: string, directory = false) {
  const name = value.replace(/\\/g, "/").replace(directory ? /\/$/ : /$^/, "");
  const parts = name.split("/");
  if (!name || name.length > 500 || parts.length > 32 || parts.some(part => !part || part === "." || part === ".." ||
    /[<>:"|?*\x00-\x1f\x7f]/.test(part) || /[. ]$/.test(part) ||
    /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part) ||
    part.toLowerCase() === ".merlin-install.json" || part.includes("\ufffd"))) invalid("O ZIP contém um caminho de arquivo inválido.");
  return name;
}

async function pinnedRange(bucket: R2Bucket, key: string, etag: string, archiveSize: number, offset: number, length: number) {
  integer(offset, archiveSize, "Posição ZIP");
  integer(length, archiveSize, "Tamanho da leitura ZIP");
  if (!length || offset + length > archiveSize) invalid("Leitura ultrapassa os limites do ZIP.");
  const object = await bucket.get(key, { onlyIf: { etagMatches: etag }, range: { offset, length } });
  if (!object || !("body" in object) || !object.body || object.etag !== etag || object.size !== archiveSize) {
    if (object && "body" in object && object.body) await object.body.cancel().catch(() => {});
    invalid("O ZIP mudou durante a indexação.");
  }
  return object.body;
}

/** Only small metadata reads are materialized, never a member's contents. */
async function readRange(bucket: R2Bucket, key: string, etag: string, archiveSize: number, offset: number, length: number) {
  if (!length || length > WINDOW_BYTES) invalid("Leitura de metadados ZIP acima do limite.");
  const reader = (await pinnedRange(bucket, key, etag, archiveSize, offset, length)).getReader();
  const result = new Uint8Array(length);
  let consumed = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (consumed + value.byteLength > length) invalid("Resposta de leitura ZIP acima do intervalo solicitado.");
      result.set(value, consumed); consumed += value.byteLength;
    }
    if (consumed !== length) invalid("Leitura de metadados ZIP truncada.");
    return result;
  } catch (error) { await reader.cancel(error).catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}

function extraFields(bytes: Uint8Array) {
  const fields = new Map<number, Uint8Array>();
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) invalid("Campo extra ZIP truncado.");
    const id = u16(bytes, offset); const length = u16(bytes, offset + 2);
    offset += 4;
    if (offset + length > bytes.length || fields.has(id)) invalid("Campo extra ZIP inválido ou duplicado.");
    fields.set(id, bytes.subarray(offset, offset + length)); offset += length;
  }
  return fields;
}

function decodedName(raw: Uint8Array, flags: number, fields: Map<number, Uint8Array>) {
  const unicode = fields.get(0x7075);
  if (unicode && unicode.length >= 5 && unicode[0] === 1 && u32(unicode, 1) === crc32(raw)) return utf8.decode(unicode.subarray(5));
  if (flags & 0x800) return utf8.decode(raw);
  let result = "";
  for (const byte of raw) result += byte < 128 ? String.fromCharCode(byte) : CP437[byte - 128];
  return result;
}

function validateMethod(flags: number, method: number) {
  if (flags & (1 | 64 | 8192)) invalid("ZIP criptografado não é suportado.");
  if (flags & ~0x080e) invalid("O ZIP usa opções de formato não suportadas.");
  if (method !== 0 && method !== 8 && method !== 9) invalid(`O ZIP deve usar compressão stored, deflate ou deflate64 (método encontrado: ${method}).`);
}

/**
 * Reads the central directory in cached 1 MiB windows. A 100k-entry archive
 * therefore makes tens of metadata requests rather than 100k R2 requests.
 * Local headers are checked lazily by hashCloudflareZipEntry.
 */
export async function planCloudflareZip(bucket: R2Bucket, key: string, etag: string, archiveSize: number): Promise<{ files: CloudflareZipEntry[]; totalSizeBytes: number }> {
  integer(archiveSize, MAX_ARCHIVE, "Tamanho do ZIP");
  if (archiveSize < 22) invalid("ZIP truncado.");
  const tailOffset = Math.max(0, archiveSize - 65_557);
  const tail = await readRange(bucket, key, etag, archiveSize, tailOffset, archiveSize - tailOffset);
  let end = -1;
  for (let offset = tail.length - 22; offset >= 0; offset--) {
    if (u32(tail, offset) === 0x06054b50 && offset + 22 + u16(tail, offset + 20) === tail.length) { end = offset; break; }
  }
  if (end < 0) invalid("Diretório final do ZIP não encontrado.");
  if (u16(tail, end + 4) || u16(tail, end + 6)) invalid("ZIP dividido em múltiplos volumes não é suportado.");
  let count = u16(tail, end + 10);
  if (u16(tail, end + 8) !== count) invalid("Contagem de entradas ZIP inconsistente.");
  let centralSize = u32(tail, end + 12); let centralOffset = u32(tail, end + 16);
  let metadataBoundary = tailOffset + end;
  const locatorOffset = metadataBoundary - 20;
  let locator: Uint8Array | undefined;
  if (locatorOffset >= 0) locator = locatorOffset >= tailOffset ? tail.subarray(locatorOffset - tailOffset, locatorOffset - tailOffset + 20) :
    await readRange(bucket, key, etag, archiveSize, locatorOffset, 20);
  const hasZip64 = locator?.length === 20 && u32(locator, 0) === 0x07064b50;
  if (hasZip64 || count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    if (!hasZip64 || !locator) invalid("Localizador ZIP64 ausente.");
    // Some single-volume writers emit zero for this count (also accepted by
    // CPython's ZIP64 reader). Disk indexes and entry counts below still prove
    // that every record belongs to the same volume; counts above one are split.
    if (u32(locator, 4) || u32(locator, 16) > 1) invalid("ZIP64 dividido em múltiplos volumes não é suportado.");
    const zip64Offset = u64(locator, 8);
    const zip64 = await readRange(bucket, key, etag, archiveSize, zip64Offset, 56);
    const recordLength = u64(zip64, 4);
    if (u32(zip64, 0) !== 0x06064b50 || recordLength < 44 || zip64Offset + 12 + recordLength !== locatorOffset ||
      u32(zip64, 16) || u32(zip64, 20) || u64(zip64, 24) !== u64(zip64, 32)) invalid("Diretório ZIP64 inválido.");
    const zip64Count = u64(zip64, 32); const zip64Size = u64(zip64, 40); const zip64Central = u64(zip64, 48);
    if ((count !== 0xffff && count !== zip64Count) || (centralSize !== 0xffffffff && centralSize !== zip64Size) ||
      (centralOffset !== 0xffffffff && centralOffset !== zip64Central)) invalid("Diretórios ZIP e ZIP64 divergentes.");
    count = zip64Count; centralSize = zip64Size; centralOffset = zip64Central; metadataBoundary = zip64Offset;
  }
  integer(count, MAX_ENTRIES, "Quantidade de entradas ZIP");
  integer(centralSize, MAX_CENTRAL_BYTES, "Tamanho do diretório central ZIP");
  integer(centralOffset, archiveSize, "Posição do diretório central ZIP");
  if (!count || centralOffset + centralSize > metadataBoundary || centralSize < count * 46) invalid("Diretório central ZIP inválido.");
  const centralEnd = centralOffset + centralSize;
  let windowOffset = -1; let window = new Uint8Array(0);
  async function centralRead(offset: number, length: number) {
    if (offset < centralOffset || offset + length > centralEnd || length > WINDOW_BYTES) invalid("Entrada ultrapassa o diretório central ZIP.");
    if (offset < windowOffset || offset + length > windowOffset + window.length) {
      windowOffset = offset;
      window = await readRange(bucket, key, etag, archiveSize, offset, Math.min(WINDOW_BYTES, centralEnd - offset));
    }
    return window.subarray(offset - windowOffset, offset - windowOffset + length);
  }
  const files: CloudflareZipEntry[] = [];
  const localRecords: { offset: number; minimumEnd: number; entry?: CloudflareZipEntry }[] = [];
  const declared = new Set<string>(); const regular = new Set<string>(); const canonical = new Map<string, string>();
  let totalSizeBytes = 0; let planBytes = 64; let pathIndexBytes = 0; let offset = centralOffset;
  for (let index = 0; index < count; index++) {
    const header = await centralRead(offset, 46);
    if (u32(header, 0) !== 0x02014b50) invalid("Entrada do diretório central ZIP inválida.");
    const flags = u16(header, 8); const method = u16(header, 10); validateMethod(flags, method);
    const checksum = u32(header, 16); let compressedSize = u32(header, 20); let sizeBytes = u32(header, 24);
    const nameLength = u16(header, 28); const extraLength = u16(header, 30); const commentLength = u16(header, 32);
    let disk = u16(header, 34); const attrs = u32(header, 38); let localOffset = u32(header, 42);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    if (offset + recordLength > centralEnd) invalid("Entrada ZIP truncada.");
    const contents = await centralRead(offset + 46, nameLength + extraLength);
    const rawName = contents.subarray(0, nameLength); const fields = extraFields(contents.subarray(nameLength));
    const zip64 = fields.get(1); let zip64Position = 0;
    function next64() { if (!zip64) invalid("Campo ZIP64 obrigatório ausente."); const value = u64(zip64, zip64Position); zip64Position += 8; return value; }
    if (sizeBytes === 0xffffffff) sizeBytes = next64();
    if (compressedSize === 0xffffffff) compressedSize = next64();
    if (localOffset === 0xffffffff) localOffset = next64();
    if (disk === 0xffff) { if (!zip64 || zip64Position + 4 > zip64.length) invalid("Disco ZIP64 ausente."); disk = u32(zip64, zip64Position); }
    if (disk) invalid("ZIP dividido em múltiplos volumes não é suportado.");
    const decoded = decodedName(rawName, flags, fields);
    const directory = /[\\/]$/.test(decoded); const name = safePath(decoded, directory);
    const mode = (attrs >>> 16) & 0xf000;
    if ((mode && mode !== (directory ? 0x4000 : 0x8000)) || (attrs & 0x400)) invalid("Links simbólicos e arquivos especiais não são permitidos no ZIP.");
    if ((attrs & 0x10) && !directory) invalid("Diretório ZIP com nome inválido.");
    integer(sizeBytes, MAX_FILE, "Tamanho do arquivo ZIP"); integer(compressedSize, MAX_ARCHIVE, "Tamanho comprimido ZIP");
    integer(localOffset, centralOffset, "Posição do cabeçalho local ZIP");
    if (method === 0 && sizeBytes !== compressedSize) invalid("Tamanhos de arquivo stored divergentes.");
    if ((method === 8 || method === 9) && compressedSize < 2) invalid("Conteúdo deflate ZIP truncado.");
    if (sizeBytes > Math.max(1, compressedSize) * 10_000) invalid("A taxa de compressão do ZIP ultrapassa o limite.");
    if (directory && (sizeBytes || checksum || compressedSize > 65_536)) invalid("Diretório ZIP contém dados.");
    if (localOffset + 30 + nameLength + compressedSize > centralOffset) invalid("Dados do ZIP ultrapassam o diretório central.");
    const parts = name.split("/"); let prefix = "";
    for (let part = 0; part < parts.length; part++) {
      prefix += `${part ? "/" : ""}${parts[part]}`;
      const normalized = prefix.normalize("NFC").toLocaleLowerCase("en-US");
      const prior = canonical.get(normalized);
      if (prior && prior !== prefix) invalid("O ZIP contém caminhos ambíguos por caixa ou Unicode.");
      if (!prior) {
        // Deep, disjoint directory trees can otherwise consume much more RAM
        // than the serialized plan. Bound their expanded path registry too.
        pathIndexBytes += normalized.length * 2 + prefix.length * 2 + 192;
        if (pathIndexBytes > MAX_PATH_INDEX_BYTES) invalid("O índice de caminhos ZIP ultrapassa o limite de memória.");
      }
      if (part < parts.length - 1 && regular.has(normalized)) invalid("O ZIP contém conflito entre arquivo e pasta.");
      if (part === parts.length - 1) {
        if (declared.has(normalized)) invalid("O ZIP contém caminhos duplicados.");
        if (!directory && canonical.has(normalized)) invalid("O ZIP contém conflito entre arquivo e pasta.");
        declared.add(normalized); if (!directory) regular.add(normalized);
      }
      if (!prior) canonical.set(normalized, prefix);
    }
    let entry: CloudflareZipEntry | undefined;
    if (!directory) {
      if (files.length >= MAX_FILES) invalid("O ZIP excede o limite de arquivos.");
      totalSizeBytes = integer(totalSizeBytes + sizeBytes, MAX_GAME, "Tamanho descompactado ZIP");
      entry = { path: name, sizeBytes, compressedSize, method: method as 0 | 8 | 9, crc32: checksum,
        flags, localHeaderOffset: localOffset, dataBoundary: centralOffset, rawName: toBase64(rawName) };
      planBytes += encoder.encode(JSON.stringify(entry)).length + 1;
      if (planBytes > MAX_PLAN_BYTES) invalid("O plano de indexação ZIP ultrapassa 16 MiB.");
      files.push(entry);
    }
    localRecords.push({ offset: localOffset, minimumEnd: localOffset + 30 + nameLength + compressedSize, ...(entry ? { entry } : {}) });
    offset += recordLength;
  }
  if (offset < centralEnd) {
    const signature = await centralRead(offset, 6);
    if (u32(signature, 0) !== 0x05054b50 || offset + 6 + u16(signature, 4) !== centralEnd) invalid("Dados inesperados após o diretório central ZIP.");
  }
  if (!files.length || !totalSizeBytes) invalid("O ZIP não contém arquivos de jogo.");
  localRecords.sort((left, right) => left.offset - right.offset);
  for (let index = 0; index < localRecords.length; index++) {
    const record = localRecords[index]!;
    const boundary = localRecords[index + 1]?.offset ?? centralOffset;
    if (record.offset === boundary || record.minimumEnd > boundary) invalid("O ZIP contém cabeçalhos ou conteúdos sobrepostos.");
    if (record.entry) record.entry.dataBoundary = boundary;
  }
  return { files, totalSizeBytes };
}

async function payloadOffset(bucket: R2Bucket, key: string, etag: string, archiveSize: number, entry: CloudflareZipEntry) {
  safePath(entry.path); validateMethod(entry.flags, entry.method);
  integer(entry.sizeBytes, MAX_FILE, "Tamanho do arquivo ZIP"); integer(entry.compressedSize, MAX_ARCHIVE, "Tamanho comprimido ZIP");
  integer(entry.localHeaderOffset, archiveSize, "Posição local ZIP"); integer(entry.dataBoundary, archiveSize, "Limite local ZIP");
  integer(entry.crc32, 0xffffffff, "CRC32 ZIP");
  if ((entry.method === 0 && entry.sizeBytes !== entry.compressedSize) || ((entry.method === 8 || entry.method === 9) && entry.compressedSize < 2)) invalid("Tamanhos do conteúdo ZIP inválidos.");
  const expectedName = fromBase64(entry.rawName);
  const header = await readRange(bucket, key, etag, archiveSize, entry.localHeaderOffset, 30);
  if (u32(header, 0) !== 0x04034b50 || u16(header, 6) !== entry.flags || u16(header, 8) !== entry.method) invalid("Cabeçalho local do ZIP diverge do diretório central.");
  const nameLength = u16(header, 26); const extraLength = u16(header, 28);
  const offset = entry.localHeaderOffset + 30 + nameLength + extraLength;
  if (nameLength !== expectedName.length || offset + entry.compressedSize > entry.dataBoundary) invalid("Conteúdo ZIP sobreposto ou fora dos limites.");
  const contents = await readRange(bucket, key, etag, archiveSize, entry.localHeaderOffset + 30, nameLength + extraLength);
  if (!sameBytes(contents.subarray(0, nameLength), expectedName)) invalid("Nome local do ZIP diverge do diretório central.");
  const fields = extraFields(contents.subarray(nameLength));
  let localSize = u32(header, 22); let localCompressed = u32(header, 18);
  const zip64 = fields.get(1); let zip64Position = 0;
  function next64() { if (!zip64) invalid("Campo ZIP64 local ausente."); const value = u64(zip64, zip64Position); zip64Position += 8; return value; }
  if (localSize === 0xffffffff) localSize = next64();
  if (localCompressed === 0xffffffff) localCompressed = next64();
  if (entry.flags & 8) {
    if ((u32(header, 14) && u32(header, 14) !== entry.crc32) || (localSize && localSize !== entry.sizeBytes) ||
      (localCompressed && localCompressed !== entry.compressedSize)) invalid("Tamanhos ou CRC do cabeçalho local ZIP divergentes.");
    const descriptorOffset = offset + entry.compressedSize;
    const length = Math.min(24, entry.dataBoundary - descriptorOffset);
    if (length < 12) invalid("Descritor de dados ZIP ausente.");
    const descriptor = await readRange(bucket, key, etag, archiveSize, descriptorOffset, length);
    let matches = false;
    for (const start of u32(descriptor, 0) === 0x08074b50 ? [4, 0] : [0]) {
      if (start + 12 > descriptor.length || u32(descriptor, start) !== entry.crc32) continue;
      if (u32(descriptor, start + 4) === entry.compressedSize && u32(descriptor, start + 8) === entry.sizeBytes) matches = true;
      if (start + 20 <= descriptor.length && u32(descriptor, start + 4) === entry.compressedSize % 0x100000000 &&
        u32(descriptor, start + 8) === Math.floor(entry.compressedSize / 0x100000000) &&
        u32(descriptor, start + 12) === entry.sizeBytes % 0x100000000 &&
        u32(descriptor, start + 16) === Math.floor(entry.sizeBytes / 0x100000000)) matches = true;
    }
    if (!matches) invalid("Descritor de dados ZIP diverge do diretório central.");
  } else if (u32(header, 14) !== entry.crc32 || localSize !== entry.sizeBytes || localCompressed !== entry.compressedSize) {
    invalid("Tamanhos ou CRC do cabeçalho local ZIP divergentes.");
  }
  return offset;
}

/** Hashes one R2 member with native SHA/CRC and native raw-deflate streaming. */
export async function hashCloudflareZipEntry(bucket: R2Bucket, key: string, etag: string, archiveSize: number,
  entry: CloudflareZipEntry, options: { onProgress?: (bytes: number) => Promise<void> } = {}): Promise<IntegrityFile> {
  integer(archiveSize, MAX_ARCHIVE, "Tamanho do ZIP");
  const offset = await payloadOffset(bucket, key, etag, archiveSize, entry);
  const digest = new crypto.DigestStream("SHA-256");
  // Abort rejects digest too; attach the observer before opening the R2 stream.
  const digestResult = digest.digest;
  void digestResult.catch(() => {});
  const writer = digest.getWriter();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let processed = 0; let checksum = 0; let lastProgress = 0; let lastProgressAt = Date.now();
  try {
    if (entry.compressedSize) {
      const source = await pinnedRange(bucket, key, etag, archiveSize, offset, entry.compressedSize);
      const stream = entry.method === 9 ? (await import("./custom-game-deflate64")).inflateDeflate64(source)
        : entry.method === 8 ? source.pipeThrough(new DecompressionStream("deflate-raw")) : source;
      reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        processed += value.byteLength;
        if (processed > entry.sizeBytes) invalid("Conteúdo descompactado ZIP excede o tamanho declarado.");
        checksum = crc32(value, checksum);
        await writer.write(value);
        if (options.onProgress && (processed - lastProgress >= 8 * 1024 ** 2 || Date.now() - lastProgressAt >= 1000)) {
          await options.onProgress(processed); lastProgress = processed; lastProgressAt = Date.now();
        }
      }
    }
    if (processed !== entry.sizeBytes || checksum !== entry.crc32) invalid("Tamanho ou CRC32 do conteúdo ZIP inválido.");
    if (options.onProgress && processed !== lastProgress) await options.onProgress(processed);
    await writer.close();
    const sha256 = Array.from(new Uint8Array(await digestResult), byte => byte.toString(16).padStart(2, "0")).join("");
    return { path: entry.path, sizeBytes: entry.sizeBytes, sha256,
      zip: { offset, compressedSize: entry.compressedSize, method: entry.method, crc32: entry.crc32 } };
  } catch (error) {
    await Promise.allSettled([reader?.cancel(error), writer.abort(error)]); throw error;
  } finally { reader?.releaseLock(); writer.releaseLock(); }
}
