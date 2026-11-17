import { vi } from "vitest";

/** Node's test runtime does not provide the Workers FixedLengthStream global. */
export function installFixedLengthStreamMock() {
  vi.stubGlobal("FixedLengthStream", class extends TransformStream<Uint8Array, Uint8Array> {
    constructor(expectedBytes: number) {
      let written = 0;
      super({
        transform(chunk, controller) {
          written += chunk.byteLength;
          if (written > expectedBytes) throw new RangeError("FixedLengthStream received too many bytes");
          controller.enqueue(chunk);
        },
        flush() {
          if (written !== expectedBytes) throw new RangeError("FixedLengthStream received an unexpected byte count");
        },
      });
    }
  });
}
