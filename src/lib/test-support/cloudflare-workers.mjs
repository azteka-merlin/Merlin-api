// Only used by Node-based Vitest suites that import the Worker entry point.
// Durable Object behavior is exercised separately in the real Miniflare runtime.
export class DurableObject {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
}
