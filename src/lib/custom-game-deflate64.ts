import module from "zlib-streams/zlib-streams.wasm";

// The codec is zlib-streams 1.4.0 (Gildas Lormeau, BSD-3-Clause; zlib and
// Chromium notices are included in that package's LICENSE). This adapter uses
// its documented C streaming exports and supplies pull-based backpressure;
// no upstream JavaScript driver or archive data is copied into this module.
type Inflater = {
  memory: WebAssembly.Memory;
  malloc(size: number): number;
  free(pointer: number): void;
  inflate9_new(): number;
  inflate9_init_raw(handle: number): number;
  inflate9_process(handle: number, input: number, length: number, output: number, outputSize: number, flush: number): number;
  inflate9_last_consumed(handle: number): number;
  inflate9_end(handle: number): number;
  _initialize?(): void;
};
const BUFFER_BYTES = 64 * 1024;
let instance: Inflater | undefined;
function codec() {
  if (!instance) {
    const api = new WebAssembly.Instance(module).exports as unknown as Inflater;
    api._initialize?.();
    instance = api;
  }
  return instance;
}

/** ZIP method 9; bounded buffers and one output chunk for each downstream pull. */
export function inflateDeflate64(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const api = codec();
  const reader = source.getReader();
  let handle = 0; let input = 0; let output = 0;
  let inputOffset = 0; let inputLength = 0;
  let pending: Uint8Array | undefined; let pendingOffset = 0;
  let sourceEnded = false; let finished = false; let disposed = false;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (handle) api.inflate9_end(handle);
    if (input) api.free(input);
    if (output) api.free(output);
    handle = input = output = 0;
    pending = undefined;
    try { reader.releaseLock(); } catch { /* A cancelled pending read settles before its pull finishes. */ }
  };
  try {
    handle = api.inflate9_new(); input = api.malloc(BUFFER_BYTES); output = api.malloc(BUFFER_BYTES);
    if (!handle || !input || !output || api.inflate9_init_raw(handle) !== 0) throw new Error("Não foi possível iniciar o decoder Deflate64.");
  } catch (error) {
    void reader.cancel(error).catch(() => {});
    dispose();
    throw error;
  }

  async function fillInput() {
    if (inputOffset < inputLength || sourceEnded || finished) return;
    inputOffset = inputLength = 0;
    while (!pending || pendingOffset === pending.byteLength) {
      pending = undefined; pendingOffset = 0;
      const next = await reader.read();
      if (finished) return;
      if (next.done) { sourceEnded = true; return; }
      pending = next.value;
      if (!(pending instanceof Uint8Array)) throw new Error("Dados Deflate64 inválidos.");
      if (pending.byteLength) break;
    }
    const length = Math.min(BUFFER_BYTES, pending.byteLength - pendingOffset);
    new Uint8Array(api.memory.buffer).set(pending.subarray(pendingOffset, pendingOffset + length), input);
    pendingOffset += length; inputLength = length;
  }

  async function requireEndOfSource() {
    if (inputOffset < inputLength || (pending && pendingOffset < pending.byteLength)) throw new Error("Dados extras após o stream Deflate64.");
    pending = undefined;
    while (!sourceEnded && !finished) {
      const next = await reader.read();
      if (next.done) sourceEnded = true;
      else if (next.value.byteLength) throw new Error("Dados extras após o stream Deflate64.");
    }
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (!finished) {
          await fillInput();
          if (finished) return;
          const remaining = inputLength - inputOffset;
          // NO_FLUSH also drains a final pending match. EOF is accepted only
          // when the codec explicitly reaches Z_STREAM_END, never on silence.
          const result = api.inflate9_process(handle, remaining ? input + inputOffset : 0, remaining, output, BUFFER_BYTES, 0);
          const status = result >> 24;
          const produced = result & 0x00ffffff;
          const consumed = api.inflate9_last_consumed(handle);
          if (produced > BUFFER_BYTES || consumed > remaining || consumed < 0) throw new Error("Estado do decoder Deflate64 inválido.");
          inputOffset += consumed;
          if (status < 0 && status !== -5) throw new Error(`Conteúdo Deflate64 inválido (${status}).`);
          if (status === 1) {
            await requireEndOfSource();
            if (finished) return;
            const chunk = produced ? new Uint8Array(api.memory.buffer).slice(output, output + produced) : undefined;
            finished = true; dispose();
            if (chunk) controller.enqueue(chunk);
            controller.close();
            return;
          }
          if (!produced && !consumed) throw new Error(sourceEnded ? "Stream Deflate64 truncado." : "Stream Deflate64 sem progresso.");
          if (produced) {
            controller.enqueue(new Uint8Array(api.memory.buffer).slice(output, output + produced));
            return;
          }
        }
      } catch (error) {
        finished = true;
        await reader.cancel(error).catch(() => {});
        dispose();
        controller.error(error);
      }
    },
    async cancel(reason) {
      finished = true;
      await reader.cancel(reason).catch(() => {});
      dispose();
    },
  }, { highWaterMark: 0 });
}
