/** Every binding a production deploy carries, for prod-mode requests that reach the verification
 *  gate's hourly budget — when to use it is in `createProductionBindings`'s JSDoc. */

import type { RateLimitBindingName } from "../../src/utils/env";
import {
  createAttemptBudgetNamespace,
  type AttemptBudgetCall,
  type AttemptBudgetNamespace,
  type AttemptBudgetNamespaceFake,
  type AttemptBudgetNamespaceOptions,
} from "./attemptBudgetNamespace";
import { rateLimitBindings } from "./rateLimitBindings";

/** Spread into a request's env: `{ KV: kv, ...bindings }`. */
export type ProductionBindings = Record<RateLimitBindingName, RateLimit> & {
  ATTEMPT_BUDGET: AttemptBudgetNamespace;
};

/**
 * The four Rate Limiting stubs (`rateLimitBindings()`, admitting everything)
 * plus a fresh in-memory `ATTEMPT_BUDGET` namespace, and that namespace's
 * handles for inspecting RPCs (`calls`, `record`) or injecting failures
 * (`opts.fail`, or `namespace.fail` mid-test).
 *
 * Use it for any request sent WITHOUT `DEV_MODE` that carries a secret and
 * reaches the gate's hourly budget: production carries the Durable Object
 * binding too, and without it the request takes the KV fallback, which writes
 * `ratelimit:user:verify*` counters and logs `ATTEMPT_BUDGET_BINDING_MISSING`.
 * Leave `ATTEMPT_BUDGET` out (plain `rateLimitBindings()`) only where that
 * fallback is the subject.
 *
 * Unlike the stateless Rate Limiting stubs, the namespace COUNTS: build one set
 * per test (in `beforeEach`) and send every request of that test with it. A set
 * built per request gives each request an empty budget, which no deployment
 * ever does.
 */
export function createProductionBindings(
  opts?: AttemptBudgetNamespaceOptions,
): {
  bindings: ProductionBindings;
  namespace: AttemptBudgetNamespaceFake;
  calls: AttemptBudgetCall[];
} {
  const namespace = createAttemptBudgetNamespace(opts);
  return {
    bindings: { ...rateLimitBindings(), ATTEMPT_BUDGET: namespace.namespace },
    namespace,
    calls: namespace.calls,
  };
}

/** The bindings alone, for suites that never inspect the Durable Object; one set per test,
 *  reused by its requests ({@link createProductionBindings}). */
export function productionBindings(): ProductionBindings {
  return createProductionBindings().bindings;
}
