import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const subject = import("./catalog.mjs").catch((error) => {
  assert.fail(`catalog.mjs failed to load: ${error?.message ?? error}`);
});

const VERSION = 1;
process.env.OPENCODE_ZEN_FREE_MODELS_SNAPSHOT = "";

// A snapshot document of the shape the survey writes. Every case that is not
// about a malformed document builds its answer with this.
function modelsDocument(protocols, { listedAt = "2026-10-27T00:00:00.000Z" } = {}) {
  return `{"version":${VERSION},"listedAt":"${listedAt}","protocols":${JSON.stringify(protocols)}}`;
}

const FLOOR = { "glm-5.3-flash-free": "chat", "big-pickle": "chat", "muse-spark-1.3-contributor-free": "responses" };

test("a document reads whole, and every rule the caller relies on is the reader's own", async () => {
  const { parseModelsSnapshotDocument } = await subject;
  const reads = parseModelsSnapshotDocument(modelsDocument(FLOOR));
  assert.ok(reads, "a whole document is an answer");
  assert.deepEqual(reads, FLOOR);
  // A suite that loads this module once cannot re-run a document the parser
  // rejected at load: the malformed shapes below are read one per case.
  assert.equal(parseModelsSnapshotDocument(""), undefined, "an empty answer is no answer");
  assert.equal(parseModelsSnapshotDocument("not json"), undefined);
  assert.equal(
    parseModelsSnapshotDocument(`{"version":2,"protocols":{"a-free":"chat"}}`),
    undefined,
    "a document of another version is one this build does not read",
  );
  assert.equal(
    parseModelsSnapshotDocument(`{"version":${VERSION},"protocols":[]}`),
    undefined,
    "a list is not a protocol map",
  );
  assert.equal(
    parseModelsSnapshotDocument(`{"version":${VERSION},"protocols":{}}`),
    undefined,
    "an empty map is no answer, not an empty one: installing it would wipe the floor",
  );
  assert.equal(
    parseModelsSnapshotDocument(`{"version":${VERSION}}`),
    undefined,
    "a document without a map is not one this build reads",
  );
});

test("a row that is not what it claims is skipped, and the rows about what it claims survive it", async () => {
  const { parseModelsSnapshotDocument } = await subject;
  const reads = parseModelsSnapshotDocument(
    modelsDocument({
      "big-pickle": "chat",
      "": "chat",
      "__proto__": "chat",
      "wrong-free": "gemini",
      "numbered-free": 7,
    }),
  );
  assert.deepEqual(
    reads,
    { "big-pickle": "chat" },
    "an unusable id and an unusable protocol are each no row; nothing else is dropped",
  );
  // An id that Object.prototype has is still stored, and that is correct: the
  // map keyed by ids is read by own properties everywhere its callers read it
  // (the same rule the catalogue map is read by), so a name a prototype invented
  // is a name the document really wrote — what would be a prototype read is the
  // own-property write the parser makes for every id its input named.
  const prototypeNamed = parseModelsSnapshotDocument(modelsDocument({ toString: "chat" }));
  assert.deepEqual(prototypeNamed, { toString: "chat" });
  assert.equal(Object.hasOwn(prototypeNamed, "toString"), true);
});

test("a document over the read ceiling is not read, and the same holds for a remote answer", async () => {
  const { parseModelsSnapshotDocument } = await subject;
  const big = `{"version":${VERSION},"protocols":{"a-free":"chat"},"pad":"${"x".repeat(256 * 1024)}"}`;
  assert.equal(parseModelsSnapshotDocument(big), undefined, "a body over the ceiling is refused before it can be parsed");
});

test("an installed answer replaces the bundled one as a whole, and the state says where it came from", async () => {
  const { installModelsSnapshot, installedProtocols, clearInstalledModelsSnapshot, modelsSnapshotState } = await subject;
  clearInstalledModelsSnapshot();
  try {
    assert.deepEqual(installedProtocols(), {}, "nothing installed and no bundled copy: no floor beyond the bootstrap table");
    assert.equal(installModelsSnapshot({} , { source: "remote" }), false, "an empty answer is no answer");
    assert.equal(
      installModelsSnapshot(FLOOR, { source: "remote", fetchedAt: 1234, url: "https://example.test/x" }),
      true,
    );
    assert.deepEqual(installedProtocols(), FLOOR);
    const state = modelsSnapshotState();
    assert.equal(state.source, "remote");
    assert.equal(state.fetchedAt, 1234);
    assert.equal(state.url, "https://example.test/x");
    assert.ok(state.ageMs >= 0);
    // A replacement is whole or it does not happen: the second install replaces
    // every row, so a caller that kept building on the old answer cannot leave
    // a row behind that the new answer withdrew.
    assert.equal(installModelsSnapshot({ "anew-free": "responses" }), true);
    assert.deepEqual(installedProtocols(), { "anew-free": "responses" });
    installModelsSnapshot(FLOOR, { source: "cache", fetchedAt: 1234 });
    assert.equal(modelsSnapshotState().source, "cache");
  } finally {
    clearInstalledModelsSnapshot();
  }
});

test("the cache is read only when it holds a whole valid snapshot", async () => {
  const { readModelsSnapshotCache } = await subject;
  const dir = mkdtempSync(join(tmpdir(), "zen-models-cache-"));
  const file = join(dir, "models.remote.json");
  try {
    writeFileSync(file, "not json");
    assert.equal(readModelsSnapshotCache(file), undefined, "a cache that is not JSON is no cache");
    writeFileSync(file, `{"version":${VERSION},"protocols":{}}`);
    assert.equal(readModelsSnapshotCache(file), undefined, "a cache with no valid row is no answer, not an empty one");
    writeFileSync(file, modelsDocument(FLOOR));
    const cached = readModelsSnapshotCache(file);
    assert.ok(cached, "a whole document is a cache");
    assert.deepEqual(cached.protocols, FLOOR);
    assert.equal(cached.fetchedAt, statSync(file).mtimeMs, "the cache's own write time is its fetchedAt");
    assert.equal(readModelsSnapshotCache(join(dir, "missing.json")), undefined);
    // Startup reads the cache synchronously, so its size and kind are checked
    // before the read: a corrupt large file or a non-file cannot stall a start.
    writeFileSync(file, "x".repeat(256 * 1024 + 1));
    assert.equal(readModelsSnapshotCache(file), undefined, "a cache over the read ceiling is not read");
    assert.equal(readModelsSnapshotCache(dir), undefined, "a directory is not a cache file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a successful refresh installs the answer and caches the validated bytes", async () => {
  const { refreshModelsSnapshot, installedProtocols, readModelsSnapshotCache, modelsSnapshotState, clearInstalledModelsSnapshot } = await subject;
  const dir = mkdtempSync(join(tmpdir(), "zen-models-refresh-"));
  const cache = join(dir, "nested", "models.remote.json");
  const text = modelsDocument({ "remote-free": "responses" });
  clearInstalledModelsSnapshot();
  try {
    const result = await refreshModelsSnapshot({
      url: "https://example.test/models-observed.json",
      cachePath: cache,
      fetchImpl: async () => ({
        ok: true,
        headers: { get: () => String(text.length) },
        text: async () => text,
      }),
    });
    assert.equal(result.ok, true, "the server's answer is read whole");
    assert.deepEqual(result.protocols, { "remote-free": "responses" });
    assert.deepEqual(installedProtocols(), { "remote-free": "responses" });
    assert.equal(modelsSnapshotState().source, "remote");
    const cached = readModelsSnapshotCache(cache);
    assert.ok(cached, "the validated bytes are cached");
    assert.deepEqual(cached.protocols, { "remote-free": "responses" });
  } finally {
    clearInstalledModelsSnapshot();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every failure of a refresh is a reason, and none is a throw", async () => {
  const { refreshModelsSnapshot, installModelsSnapshot, clearInstalledModelsSnapshot, installedProtocols } = await subject;
  clearInstalledModelsSnapshot();
  installModelsSnapshot(FLOOR, { source: "cache", fetchedAt: 1234 });
  const cases = [
    ["url", { url: "not-a-url" }],
    ["url", { url: "ftp://example.test/x" }],
    ["fetch", { url: "https://example.test/x", fetchImpl: "not a function" }],
    ["http", { url: "https://example.test/x", fetchImpl: async () => ({ ok: false, headers: { get: () => null }, body: null }) }],
    ["invalid", { url: "https://example.test/x", fetchImpl: async () => ({ ok: true, headers: { get: () => null }, text: async () => '{"version":9,"protocols":{}}' }) }],
  ];
  try {
    for (const [reason, args] of cases) {
      const result = await refreshModelsSnapshot(args);
      assert.equal(result.ok, false, `${reason} is not a success but the answer this route offered`);
      assert.equal(result.reason, reason);
    }
    assert.deepEqual(installedProtocols(), FLOOR, "a failed refresh leaves the installed answer in place");
  } finally {
    clearInstalledModelsSnapshot();
  }
});

test("the settings take the caller's answer, the operator's, or the default", async () => {
  const {
    modelsSnapshotURL,
    modelsSnapshotCachePath,
    modelsSnapshotRefreshMs,
    modelsSnapshotTimeoutMs,
    DEFAULT_MODELS_SNAPSHOT_URL,
  } = await subject;
  assert.equal(modelsSnapshotURL(undefined, {}), DEFAULT_MODELS_SNAPSHOT_URL);
  assert.equal(modelsSnapshotURL("", {}), undefined, 'an empty URL is the operator saying "no"');
  assert.equal(modelsSnapshotURL("", {}), undefined);
  assert.equal(modelsSnapshotURL(undefined, { OPENCODE_ZEN_FREE_MODELS_SNAPSHOT: "./x.json" }), undefined, "a pinned local source settles the question, whether it is empty or not");
  assert.equal(modelsSnapshotURL(undefined, { OPENCODE_ZEN_FREE_MODELS_SNAPSHOT_URL: "" }), undefined);
  assert.equal(modelsSnapshotURL(undefined, { OPENCODE_ZEN_FREE_MODELS_SNAPSHOT_URL: "https://mirror.test/m.json" }), "https://mirror.test/m.json");
  assert.equal(modelsSnapshotURL("https://explicit.test/m.json", { OPENCODE_ZEN_FREE_MODELS_SNAPSHOT_URL: "https://ignored.test/m.json" }), "https://explicit.test/m.json");
  // An explicit non-string is the caller saying nothing sensible, and the
  // answer for that is "no remote" rather than a throw on the way to one.
  assert.equal(modelsSnapshotURL(7), undefined);
  // The platform cache directory: LOCALAPPDATA on Windows, XDG_CACHE_HOME
  // under it, the user's own home under that — read in the order the limits
  // cache reads them, and the home is homedir()'s, not env.HOME's.
  assert.equal(
    modelsSnapshotCachePath(undefined, { LOCALAPPDATA: "/locals" }),
    "/locals/opencode-zen-freex/models-observed.remote.json",
  );
  assert.equal(
    modelsSnapshotCachePath(undefined, { XDG_CACHE_HOME: "/xdg" }),
    "/xdg/opencode-zen-freex/models-observed.remote.json",
  );
  assert.equal(
    modelsSnapshotCachePath(undefined, {}),
    join(homedir(), ".cache", "opencode-zen-freex", "models-observed.remote.json"),
  );
  assert.equal(modelsSnapshotCachePath("", {}), undefined);
  // The interval and the deadline: a value in range is taken, one that is not
  // is the fallback, and the same rule answers both.
  assert.equal(modelsSnapshotRefreshMs("123"), 123);
  assert.equal(modelsSnapshotRefreshMs("0"), 3_600_000, "a refresh of zero is not a decision, it is a typo");
  assert.equal(modelsSnapshotTimeoutMs("30000"), 30_000);
  assert.equal(modelsSnapshotTimeoutMs("5"), 5_000, "below the floor is the default");
  assert.equal(modelsSnapshotTimeoutMs("60001"), 5_000, "above the ceiling is the default");
});

test("the bundled copy is the floor under the bootstrap table", async () => {
  const { bundledModelsSnapshot, clearBundledModelsSnapshot } = await subject;
  clearBundledModelsSnapshot();
  // A real read of the file beside this module, whatever the survey last wrote:
  // what the case asserts is that the file IS read, not what it says.
  const beside = join(dirname(fileURLToPath(import.meta.url)), "models-observed.json");
  const bundled = bundledModelsSnapshot(beside);
  assert.ok(bundled && Object.keys(bundled).length > 0, "the file beside this module is read, not guessed at");
  for (const [id, protocol] of Object.entries(bundled)) {
    assert.ok(id && id !== "__proto__", "every bundled id is a name");
    assert.ok(["chat", "responses", "anthropic", "systemone"].includes(protocol), `every bundled protocol is one this build asks (${id}: ${protocol})`);
  }
  // An explicit "" says "no bundled copy", and the answer is the same empty
  // floor the absence of a file gives — including on a second read.
  assert.deepEqual(bundledModelsSnapshot(""), {});
  assert.deepEqual(bundledModelsSnapshot(""), {});
  clearBundledModelsSnapshot();
  assert.deepEqual(bundledModelsSnapshot("./definitely-missing.json"), {}, "a missing file is no answer, not a failure");
  clearBundledModelsSnapshot();
});
