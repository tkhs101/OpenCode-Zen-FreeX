import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";
import { SNAPSHOT_LIMIT, refreshSnapshot } from "./limits.mjs";

// The protocol table, as a snapshot beside the module.
//
// The catalogue and the docs are where a model's protocol is read from live:
// models.mjs holds the parsers, and the `-free` rule covers an id the catalogue
// cannot speak for. This file is for the third fact about the same gap — a
// release cut before the docs table grew a model Zen made free since, or a
// mirror that cannot reach the docs at all. For those, discovery falls back to
// the snapshot: an id the docs no longer name, or whose live read failed, still
// gets the protocol the table recorded, until the docs name it again.
//
// The snapshot's write side is the survey in models-watch.mjs (and the scheduled
// workflow that runs it), which reads the live docs page and commits what the
// parser made of it. The rules both sides obey are the same one suite's: version
// shape, a bounded number of rows, ids and protocols that are what they claim.
// A file a host downloads is even less trusted than one it reads beside itself,
// because no one reviewing a diff has seen it, so the parser here restates the
// write-side rules rather than trusting them.
//
// Nothing here may fail a request. Every entry in this file is bounded and
// fallible: a bad document is no answer rather than a throw, and an installed
// answer is replaced as a whole or not at all.

// Where the snapshot lives, as the bundled copy beside this module. The path is
// env and explicit-argument adjustable the same way the limits snapshot's is.
const DEFAULT_MODELS_SNAPSHOT_FILE = new URL("./models-observed.json", import.meta.url);
export const DEFAULT_MODELS_SNAPSHOT_URL =
  "https://raw.githubusercontent.com/tkhs101/OpenCode-Zen-FreeX/main/models-observed.json";

// The shape of the snapshot this build reads. A file that names another version
// is a file written by a build that means something else by these rows.
const MODELS_SNAPSHOT_VERSION = 1;

// The remote document's bounds. They mirror the writer's rules and models-watch's
// check: the widest census of the docs table this route has needed is two
// hundred rows, the tenfold bound is one no real table reaches, and at this
// document ceiling (the same 256 KiB the walls snapshot is read under) the row
// bound stays the effective one.
const MODELS_SNAPSHOT_ROWS_LIMIT = 2_000;

// A whole-number setting with a floor, a ceiling and a default. The same rule
// limits.mjs applies to its own settings, restated here per this file's own
// style: provider.mjs restates retrySetting for the same reason, and a second
// reading of "a number" is not worth tightening two modules together over.
function numberSetting(explicit, env, name, { min, max, fallback }) {
  const usableNumber = (value) => Number.isSafeInteger(value) && value >= min && value <= max;
  if (explicit !== undefined) {
    const value = typeof explicit === "string" && explicit !== "" ? Number(explicit) : explicit;
    return usableNumber(value) ? value : fallback;
  }
  const named = env?.[name];
  if (typeof named === "string" && named !== "") {
    const value = Number(named);
    return usableNumber(value) ? value : fallback;
  }
  return fallback;
}

// An id is a name, not any string. The docs parser (models.mjs) only writes ids
// that matched its own shape rule, so the restatement here is the reader's half
// of the same contract: a row from anywhere else does not enter.
const isUsableId = (id) => typeof id === "string" && id !== "" && id !== "__proto__";

// The four endpoints this file names, as models.mjs names them. A row whose
// value is anything else describes a protocol this build does not ask, and one
// it must not adopt — a "systemone" or "gemini" row would put a model on an
// endpoint no SDK here speaks. `Object.hasOwn` on a plain object keyed by these
// names reads nothing a prototype invented.
const PROTOCOLS = new Set(["chat", "responses", "anthropic", "systemone"]);

// The snapshot members scale with the bounds above:
const SNAPSHOT_REFRESH_DEFAULT = 3_600_000;
const SNAPSHOT_TIMEOUT_DEFAULT = 5_000;
const SNAPSHOT_TIMEOUT_MIN = 100;
const SNAPSHOT_TIMEOUT_MAX = 60_000;

export const MODELS_SNAPSHOT_ENV = "OPENCODE_ZEN_FREE_MODELS_SNAPSHOT";
export const MODELS_SNAPSHOT_URL_ENV = "OPENCODE_ZEN_FREE_MODELS_SNAPSHOT_URL";
export const MODELS_SNAPSHOT_CACHE_ENV = "OPENCODE_ZEN_FREE_MODELS_SNAPSHOT_CACHE";
export const MODELS_SNAPSHOT_REFRESH_ENV = "OPENCODE_ZEN_FREE_MODELS_SNAPSHOT_REFRESH_MS";
export const MODELS_SNAPSHOT_TIMEOUT_ENV = "OPENCODE_ZEN_FREE_MODELS_SNAPSHOT_TIMEOUT_MS";

// Where the bundled snapshot is read from, with the same three-way answer the
// limits snapshot's path takes: an explicit string is the caller's own answer
// (and an empty one is the caller saying "no bundled copy"), an env value is the
// operator's, and the module's own directory is the default.
export function modelsSnapshotPath(explicit, env = globalThis.process?.env) {
  if (explicit !== undefined) return explicit;
  const named = env?.[MODELS_SNAPSHOT_ENV];
  if (typeof named === "string") return named;
  return fileURLToPath(DEFAULT_MODELS_SNAPSHOT_FILE);
}

// Where the remote snapshot is read from. The precedence is the limits
// snapshot's: an operator who pinned a local path — the env present at all,
// including empty — has chosen the source, and the remote is off rather than
// fighting that choice. `""` then means what it means in every layer of this
// file: no answer, silently.
export function modelsSnapshotURL(explicit, env = globalThis.process?.env) {
  if (explicit !== undefined) {
    if (typeof explicit !== "string") return undefined;
    return explicit === "" ? undefined : explicit;
  }
  if (env && Object.hasOwn(env, MODELS_SNAPSHOT_ENV)) return undefined;
  const named = env?.[MODELS_SNAPSHOT_URL_ENV];
  if (typeof named === "string") return named === "" ? undefined : named;
  return DEFAULT_MODELS_SNAPSHOT_URL;
}

// Where the remote answer is cached between runs. The same platform cache
// directory the limits cache uses, with a file name of its own so a remote
// answer is never mistaken for a file the limits snapshot wrote.
export function modelsSnapshotCachePath(explicit, env = globalThis.process?.env) {
  if (explicit !== undefined) {
    if (typeof explicit !== "string") return undefined;
    return explicit === "" ? undefined : explicit;
  }
  const named = env?.[MODELS_SNAPSHOT_CACHE_ENV];
  if (typeof named === "string") return named === "" ? undefined : named;
  const home = homedir();
  const base = env?.LOCALAPPDATA || env?.XDG_CACHE_HOME || (home ? join(home, ".cache") : "");
  return base ? join(base, "opencode-zen-freex", "models-observed.remote.json") : undefined;
}

// How long a successful answer is trusted before the provider asks again. An
// hour, like the limits snapshot's interval, for the same pair of reasons: the
// scheduled survey is hourly, and a host that restarts more often than that
// should read its cache rather than spend a request per start.
export function modelsSnapshotRefreshMs(explicit, env = globalThis.process?.env) {
  return numberSetting(explicit, env, MODELS_SNAPSHOT_REFRESH_ENV, {
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
    fallback: SNAPSHOT_REFRESH_DEFAULT,
  });
}

// How long one fetch may take. The same five seconds, bounded the same way.
export function modelsSnapshotTimeoutMs(explicit, env = globalThis.process?.env) {
  return numberSetting(explicit, env, MODELS_SNAPSHOT_TIMEOUT_ENV, {
    min: SNAPSHOT_TIMEOUT_MIN,
    max: SNAPSHOT_TIMEOUT_MAX,
    fallback: SNAPSHOT_TIMEOUT_DEFAULT,
  });
}

// A document, as the protocol map this build offers. The whole document is
// rejected when it names another version, too many rows, or no valid row at
// all — an empty or wholly invalid document is not an empty answer; installing
// it would wipe the bundled floor for every id the docs no longer name.
// Individual bad rows are skipped, and the document survives as long as one
// row does. The return is a plain object, because the snapshot's job is to be
// spread into a protocols map, and a Map would ask every spread site to have
// read this file first.
export function parseModelsSnapshotDocument(text) {
  try {
    if (typeof text !== "string" || text.length > SNAPSHOT_LIMIT) return undefined;
    const document = JSON.parse(text);
    if (document?.version !== MODELS_SNAPSHOT_VERSION) return undefined;
    const protocols = document?.protocols;
    if (!protocols || typeof protocols !== "object" || Array.isArray(protocols)) return undefined;
    const entries = Object.entries(protocols);
    if (entries.length === 0 || entries.length > MODELS_SNAPSHOT_ROWS_LIMIT) return undefined;
    const result = {};
    for (const [id, protocol] of entries) {
      if (!isUsableId(id)) continue;
      if (typeof protocol !== "string" || !PROTOCOLS.has(protocol)) continue;
      result[id] = protocol;
    }
    return Object.keys(result).length > 0 ? result : undefined;
  } catch {
    // A document that is not JSON, not text or not shaped like a snapshot is no
    // answer. Nothing on a request path may throw because an input was bad.
    return undefined;
  }
}

// The bundled snapshot, one read per file and never a second one: it is read at
// startup and not while a process serves requests. The memo exists for the same
// reason the walls snapshot keeps one (`wallReads` in limits.mjs), and for the
// same one, "a bundled file is an input that changes when somebody commits".
const bundledReads = new Map();

// The protocol floor the bundled copy offers, or `{}` when there is none: a
// missing file, an unparsable one or one in another shape all say the same
// thing — this build declares exactly what its code does and nothing more.
// An explicit "" is the caller saying "no bundled copy", which is why the
// fallback above passes the argument through rather than reading the env again:
// undefined means "the operator's answer", and anything else — including ""
// — is an answer this file takes as given.
export function bundledModelsSnapshot(file = undefined) {
  const path = file === undefined ? modelsSnapshotPath() : file;
  if (typeof path !== "string" || path === "") return {};
  const held = bundledReads.get(path);
  if (held !== undefined) return held;
  const protocols = {};
  try {
    const info = statSync(path);
    if (info.isFile() && info.size <= SNAPSHOT_LIMIT) {
      const parsed = parseModelsSnapshotDocument(readFileSync(path, { encoding: "utf8" }));
      if (parsed) {
        for (const [id, protocol] of Object.entries(parsed)) protocols[id] = protocol;
      }
    }
  } catch {
    // No bundled answer, silently: the bootstrap table is standing in.
  }
  bundledReads.set(path, protocols);
  return protocols;
}

// Tests begin under no bundled answer.
export function clearBundledModelsSnapshot() {
  bundledReads.clear();
}

// ---- the remote answer and its cache ----------------------------------------

// The remote answer this process has installed, if any. Kept apart from the
// bundled memo, which a path keys; this has none, and only one can be installed
// at a time (install replaces the whole answer; it never merges).
let installed;

// Install a parsed remote answer. The input is a whole parsed document or
// nothing; a replacement is visible all at once (the assignment happens after
// the copy is built) so a half-read document can never be the state a request
// reads.
export function installModelsSnapshot(protocols, meta = {}) {
  if (!protocols || typeof protocols !== "object" || Array.isArray(protocols)) return false;
  const copy = {};
  for (const [id, protocol] of Object.entries(protocols)) {
    if (!isUsableId(id)) continue;
    if (typeof protocol !== "string" || !PROTOCOLS.has(protocol)) continue;
    copy[id] = protocol;
  }
  if (Object.keys(copy).length === 0) return false;
  installed = {
    protocols: copy,
    source: typeof meta?.source === "string" ? meta.source : "installed",
    fetchedAt: Number.isFinite(meta?.fetchedAt) ? meta.fetchedAt : Date.now(),
    url: typeof meta?.url === "string" ? meta.url : undefined,
  };
  return true;
}

// Drop the installed answer. Only for tests and for a provider that has been
// told to stop reading remotely: it is the one way back to the bundled file.
export function clearInstalledModelsSnapshot() {
  const had = installed !== undefined;
  installed = undefined;
  return had;
}

// What is installed, as a copy. `ageMs` is the answer's age, not the process's:
// a cache loaded at start-up is old from the moment it is read, which is what
// the provider decides from.
export function modelsSnapshotState() {
  if (!installed) return undefined;
  return {
    source: installed.source,
    fetchedAt: installed.fetchedAt,
    url: installed.url,
    ageMs: Math.max(0, Date.now() - installed.fetchedAt),
  };
}

// The snapshot this process answers from, as a plain object a caller can spread:
// the installed remote answer when there is one, otherwise the bundled copy the
// caller hands in. The parameter is the caller's own floor — the copy it read
// once at startup, honouring whatever "" it was given — rather than a second
// read of the bundled file from in here, which would answer a caller that
// disabled the bundled copy with the copy it disabled. Without the parameter
// the bundled file beside this module is the answer, which is what a caller
// that says nothing about it wants.
export function installedProtocols(bundled) {
  if (installed) return { ...installed.protocols };
  if (bundled !== undefined) return { ...bundled };
  return { ...bundledModelsSnapshot() };
}

// The last remote answer written to disk, with the time it was written (the
// file's mtime). A missing, unreadable, unparsable or empty cache is undefined
// and never a throw: the caller has a bundled file and a network for exactly
// this answer. Startup reads the file synchronously, so the same ceiling and
// kind checks the walls snapshot's reader makes are made before the read.
export function readModelsSnapshotCache(file) {
  try {
    if (typeof file !== "string" || file === "") return undefined;
    const info = statSync(file);
    if (!info.isFile() || info.size > SNAPSHOT_LIMIT) return undefined;
    const text = readFileSync(file, { encoding: "utf8" });
    const protocols = parseModelsSnapshotDocument(text);
    if (!protocols) return undefined;
    return { protocols, fetchedAt: info.mtimeMs };
  } catch {
    return undefined;
  }
}

// One remote refresh, never throwing. The bounds, the deadline, the byte-capped
// read and the atomic cache write are refreshSnapshot's; the two halves this
// caller owns are the parser and the installer, and the contract both sides
// share is stated on refreshSnapshot itself. The returned map is the same
// plain object that was installed (or undefined).
export async function refreshModelsSnapshot({
  url,
  cachePath,
  timeoutMs = SNAPSHOT_TIMEOUT_DEFAULT,
  fetchImpl = globalThis.fetch,
} = {}) {
  const result = await refreshSnapshot({
    url,
    cachePath,
    timeoutMs,
    fetchImpl,
    parse: parseModelsSnapshotDocument,
    install: installModelsSnapshot,
  });
  return result.ok
    ? { ok: true, fetchedAt: result.fetchedAt, protocols: result.walls }
    : { ok: false, reason: result.reason };
}
