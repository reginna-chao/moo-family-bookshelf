/**
 * The Docker dev environment, read straight off `docker-compose.yml` and
 * `.dockerignore` as TEXT (tripwire).
 *
 * WHY A TEST READS THESE FILES. Since #355 the Docker dev environment is a
 * maintained artefact, and both properties pinned here fail SILENTLY:
 *
 *   1. SHARED MOUNTS. `extension/`, `worker/` and `pwa/` all import
 *      `shared/src` directly (no build step), so each compose service needs
 *      `./shared/src:/app/shared/src` next to its own `./<pkg>/src` mount.
 *      Without it the container keeps the copy baked in at build time: hot
 *      reload picks up a package edit but runs it against a stale `shared/`,
 *      and `docker compose build` / CI's `docker` job stay green because the
 *      image itself still builds. The `worker` service shipped without it.
 *
 *   2. NO PERSONAL DATA IN THE IMAGE. `.dockerignore` decides what enters the
 *      build context, and a bare pattern only matches at the context ROOT. The
 *      paths `.gitignore` keeps out of git because they hold personal data or
 *      local credentials — real Readmoo page dumps (`docs/resource/`), a Chrome
 *      profile with a Readmoo login (`.verify-selectors-profile/`), `.dev.vars`,
 *      local KV state (`.wrangler/`), wrangler configs naming the Cloudflare
 *      account (`wrangler*.local.toml`), untracked env files, `.claude/` — are
 *      otherwise copied into an image layer, where `docker history` / a pushed
 *      image exposes them. Nothing in a green build says so.
 *
 * HOW IT AVOIDS PASSING VACUOUSLY. Same device as `ciSuccessGate.test.ts`: the
 * paths are resolved from THIS file and their existence asserted, every helper
 * throws when its anchor (`services:`, a service key, a `volumes:` block) is
 * missing instead of returning an empty result, and positive companions pin
 * what the scan must find — exactly the three services with their
 * `moo-family-bookshelf-<svc>-dev` images, and an ignore line
 * (`**\/node_modules/`) that was always there. The volume reader is STRICT: a
 * list entry it cannot read throws rather than being skipped.
 *
 * No YAML library is used: neither `yaml` nor `js-yaml` is resolvable in this
 * workspace, and a new dependency is a non-goal (`.claude/rules/change-triage.md`).
 *
 * CI REACHABILITY (`.claude/rules/test.md` → "Cross-package parity tests must
 * be CI-reachable"). This file runs in `worker-check`, whose job-level `if:`
 * accepts `needs.changes.outputs.docker`; the `docker` path filter in
 * `.github/workflows/cicd.yml` lists `docker-compose.yml` and `.dockerignore`,
 * so a PR touching only either file still runs these assertions.
 *
 * MUTATION-CHECK SEAM. `COMPOSE_PATH` / `DOCKERIGNORE_PATH` are overridable
 * through `MOO_COMPOSE_PATH` / `MOO_DOCKERIGNORE_PATH` purely so the guards can
 * be driven RED against throwaway COPIES at authoring time, without editing the
 * live files. CI sets neither. A seam pointing at nothing throws loudly; one
 * pointing at a valid copy is the intended use, and the guards then read the
 * copy. Mutation-checked at authoring time: the pre-fix compose file fails only
 * the worker's shared mount, the pre-fix `.dockerignore` fails only
 * `docs/resource/` and the two `wrangler*.local.toml` lines, and a compose copy
 * without the `pwa` service fails the service-set companion.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

// Mutation-check seams (CI sets neither), resolved from THIS file, not the cwd.
// See the header → "MUTATION-CHECK SEAM".
const COMPOSE_PATH =
  process.env.MOO_COMPOSE_PATH ?? resolve(HERE, "../../../docker-compose.yml");
const DOCKERIGNORE_PATH =
  process.env.MOO_DOCKERIGNORE_PATH ?? resolve(HERE, "../../../.dockerignore");

/** Every compose service; each imports `shared/src` and mounts its own package. */
const EXPECTED_SERVICES = ["extension", "worker", "pwa"] as const;

const SHARED_MOUNT = "./shared/src:/app/shared/src";

// Lines `.gitignore` keeps out of git as personal or local-credential data.
// See the header → "NO PERSONAL DATA IN THE IMAGE".
const REQUIRED_IGNORE_LINES = [
  "docs/resource/",
  "**/.verify-selectors-profile/",
  "**/.dev.vars",
  "**/.wrangler/",
  "**/wrangler.local.toml",
  "**/wrangler.backup.local.toml",
  ".claude/",
  "**/.env",
  "**/.env.local",
];

/** Reads a file as UTF-8, CRLF-normalised; throws loudly when absent. */
function readText(path: string, label: string): string {
  if (!existsSync(path)) {
    throw new Error(
      `${label} not found at ${path}. This guard is only meaningful while it ` +
        `reads the real file — update the path instead of letting the ` +
        `assertions pass over an empty scan.`,
    );
  }
  return readFileSync(path, "utf8").split("\r\n").join("\n");
}

// --- docker-compose.yml ---

/** Everything under the top-level `services:` key, up to the next top-level key. */
function servicesRegion(compose: string): string {
  const match = /^services:[ \t]*$/m.exec(compose);
  if (!match) {
    throw new Error(
      "No top-level `services:` key found in docker-compose.yml.",
    );
  }
  const rest = compose.slice(match.index + match[0].length);
  const next = /^[^\s#]/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/** Two-space-indented bare keys inside the services region, in file order. */
function serviceIds(compose: string): string[] {
  const matches = servicesRegion(compose).matchAll(
    /^ {2}([A-Za-z0-9_-]+):[ \t]*$/gm,
  );
  return [...matches].map((match) => match[1]);
}

/** The lines of one service, from its key up to the next service key (or EOF). */
function serviceBlock(compose: string, service: string): string {
  const region = servicesRegion(compose);
  const start = new RegExp(`^ {2}${service}:[ \\t]*$`, "m").exec(region);
  if (!start) {
    throw new Error(`Service \`${service}\` not found in docker-compose.yml.`);
  }
  const rest = region.slice(start.index + start[0].length);
  const next = /^ {2}[A-Za-z0-9_-]+:[ \t]*$/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/** The service's `image:` value, or `null` when it declares none. */
function serviceImage(block: string): string | null {
  const match = /^ {4}image:[ \t]*(\S+)[ \t]*$/m.exec(block);
  return match ? match[1] : null;
}

// The short-syntax entries of a service's `volumes:` list; STRICT (unreadable lines throw).
// See the header → "HOW IT AVOIDS PASSING VACUOUSLY".
function serviceVolumes(block: string, service: string): string[] {
  const start = /^ {4}volumes:[ \t]*$/m.exec(block);
  if (!start) {
    throw new Error(`Service \`${service}\` has no \`volumes:\` block.`);
  }
  const volumes: string[] = [];
  for (const line of block.slice(start.index + start[0].length).split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    if (!line.startsWith("     ")) {
      break;
    }
    const entry = /^ {6}- (?:"([^"]*)"|'([^']*)'|(\S+))[ \t]*$/.exec(line);
    if (!entry) {
      throw new Error(
        `Unparsable line in \`${service}\`'s volumes: ${JSON.stringify(line)}. ` +
          `Fix the parser rather than letting a mount go unchecked.`,
      );
    }
    volumes.push(entry[1] ?? entry[2] ?? entry[3]);
  }
  if (volumes.length === 0) {
    throw new Error(`\`${service}\`'s volumes parsed to zero entries.`);
  }
  return volumes;
}

// --- .dockerignore ---

/** Every pattern line, trimmed; blank lines and `#` comments dropped. */
function ignorePatterns(dockerignore: string): string[] {
  return dockerignore
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

const COMPOSE = readText(COMPOSE_PATH, "docker-compose.yml");
const DOCKERIGNORE = readText(DOCKERIGNORE_PATH, ".dockerignore");

describe("docker-compose.yml service mounts", () => {
  it("defines exactly the extension, worker and pwa services, each with its dev image", () => {
    // Positive companion: a drifted service scan would otherwise run the mount cases over nothing.
    expect(existsSync(COMPOSE_PATH)).toBe(true);
    expect([...serviceIds(COMPOSE)].sort()).toEqual(
      [...EXPECTED_SERVICES].sort(),
    );
    for (const service of EXPECTED_SERVICES) {
      expect(
        serviceImage(serviceBlock(COMPOSE, service)),
        `\`${service}\` must build the image moo-family-bookshelf-${service}-dev`,
      ).toBe(`moo-family-bookshelf-${service}-dev`);
    }
  });

  it.each(EXPECTED_SERVICES)(
    "bind-mounts shared/src and its own src into the %s service",
    (service) => {
      // Without the shared mount, hot reload runs against the shared/ baked into the image.
      // See the header → "SHARED MOUNTS".
      const volumes = serviceVolumes(serviceBlock(COMPOSE, service), service);
      expect(volumes, `\`${service}\` must mount ${SHARED_MOUNT}`).toContain(
        SHARED_MOUNT,
      );
      expect(volumes).toContain(`./${service}/src:/app/${service}/src`);
    },
  );
});

describe(".dockerignore keeps local secrets and personal data out of the image", () => {
  it("reads the ignore file and finds a pattern that was always there", () => {
    // Positive companion: a moved file or a broken line reader would make every case below vacuous.
    expect(existsSync(DOCKERIGNORE_PATH)).toBe(true);
    expect(ignorePatterns(DOCKERIGNORE)).toContain("**/node_modules/");
  });

  it.each(REQUIRED_IGNORE_LINES)(
    "excludes %s from the build context",
    (line) => {
      // Whole-line match: a commented-out or longer pattern does not count.
      expect(
        ignorePatterns(DOCKERIGNORE),
        `.dockerignore must contain the line \`${line}\``,
      ).toContain(line);
    },
  );

  it("re-includes nothing with a `!` exception", () => {
    // Docker applies the LAST matching line, so a later `!` line re-admits a pinned exclusion.
    expect(
      ignorePatterns(DOCKERIGNORE).filter((line) => line.startsWith("!")),
    ).toEqual([]);
  });
});
