// Stand-in for the `cloudflare:workers` runtime module under Vitest (Node has no such module);
// aliased in worker/vitest.config.ts. Only what src/ imports: the DurableObject base class.

/** Minimal `DurableObject` base: keeps `ctx` and `env` for the subclass, like the runtime's. */
export class DurableObject<Env = unknown> {
  protected ctx: DurableObjectState;
  protected env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
