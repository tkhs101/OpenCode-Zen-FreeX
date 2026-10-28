// The scheduled survey's decisions, checked without a route and without a file.
//
// `limits-watch.mjs` exists to answer one question on a timer: which offered ids
// have never been measured, and which have stopped being offered. Both answers
// come from comparing two lists, so the route and the snapshot are handed in here
// rather than reached for — a case that had to ask Zen to find out whether it had
// found the right ids would be testing Zen.
import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const subject = import("./limits-watch.mjs").catch((error) => {
  assert.fail(`limits-watch.mjs failed to load: ${error?.message ?? error}`);
});

// A route that offers what a case names, and a catalogue that calls them free.
const route = (ids) => async (url) =>
  url.endsWith("/models")
    ? { data: ids.map((id) => ({ id })) }
    : { opencode: { models: Object.fromEntries(ids.map((id) => [id, { name: id }])) } };

const measured = (ids) => ({ models: Object.fromEntries(ids.map((id) => [id, { wall: "openEnded" }])) });

test("an id offered and never measured is the one a run measures", async () => {
  const { watch } = await subject;
  const swept = [];
  const state = await watch({
    sweep: true,
    fetchJSON: route(["known-free", "fresh-free"]),
    read: async () => measured(["known-free"]),
    sweepModels: async (ids) => {
      swept.push(...ids);
      return ids.map((id) => ({ model: id, servedTokens: 1, servedChars: 1000, refusedChars: null, refusedSizes: [], wall: "openEnded" }));
    },
  });
  assert.deepEqual(state.added, ["fresh-free"]);
  assert.deepEqual(state.measured, ["known-free"]);
  assert.deepEqual(swept, ["fresh-free"], "the id with a measurement behind it is not asked again");
  assert.equal(state.snapshot.models["fresh-free"].wall, "openEnded", "and the result is kept");
  assert.equal(state.snapshot.models["known-free"].wall, "openEnded", "beside what was already there");
});

test("without --sweep a run plans and asks nothing", async () => {
  const { watch } = await subject;
  let swept = false;
  const state = await watch({
    fetchJSON: route(["fresh-free"]),
    read: async () => measured([]),
    sweepModels: async () => {
      swept = true;
      return [];
    },
  });
  assert.deepEqual(state.added, ["fresh-free"]);
  assert.equal(swept, false, "a report is not a measurement");
  assert.deepEqual(Object.keys(state.snapshot.models), [], "and it moves nothing");
});

test("--all re-measures what is already measured", async () => {
  const { watch } = await subject;
  const swept = [];
  await watch({
    sweep: true,
    all: true,
    fetchJSON: route(["a-free", "b-free"]),
    read: async () => measured(["a-free"]),
    sweepModels: async (ids) => {
      swept.push(...ids);
      return [];
    },
  });
  assert.deepEqual(swept, ["a-free", "b-free"], "every offered id, measured or not");
});

test("an id that is no longer offered is said, and kept out of the way", async () => {
  const { watch } = await subject;
  const state = await watch({ fetchJSON: route(["a-free"]), read: async () => measured(["a-free", "gone-free"]) });
  assert.deepEqual(state.gone, ["gone-free"]);
  assert.deepEqual(state.offered, ["a-free"]);
  // The snapshot keeps it: an id the route stops offering today can be offered
  // again, and forgetting the measurement would make that cost a second sweep.
  assert.ok(Object.hasOwn(state.snapshot.models, "gone-free"));
});

test("a snapshot is written sorted, and read back whole", async () => {
  const { readSnapshot, writeSnapshot } = await subject;
  const file = join(tmpdir(), `zen-observed-${process.pid}-${Date.now()}.json`);
  try {
    const body = await writeSnapshot({ models: { "z-free": { wall: "openEnded" }, "a-free": { wall: "openEnded" } } }, file);
    assert.ok(existsSync(file));
    assert.ok(body.indexOf("a-free") < body.indexOf("z-free"), "sorted, so a diff is the ids that changed");
    const read = await readSnapshot(file);
    assert.deepEqual(Object.keys(read.models), ["a-free", "z-free"]);
  } finally {
    rmSync(file, { force: true });
  }
});

test("a snapshot that is missing, or is not one, is no snapshot", async () => {
  const { readSnapshot } = await subject;
  const missing = join(tmpdir(), `zen-observed-${process.pid}-missing-${Date.now()}.json`);
  assert.deepEqual(await readSnapshot(missing), { models: {} }, "a first run has nothing to compare against");
  // A file somebody edited into a list, or into a shape with no models in it, is
  // read as no measurement rather than as a measurement of nothing — the
  // difference decides whether every offered id gets swept or none does.
  const file = join(tmpdir(), `zen-observed-${process.pid}-junk-${Date.now()}.json`);
  try {
    for (const body of ["[]", '{"models":[]}', '{"models":null}', "not json at all"]) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(file, body, "utf8");
      assert.deepEqual(await readSnapshot(file), { models: {} }, body);
    }
  } finally {
    rmSync(file, { force: true });
  }
});

// The second thing a timer has to notice, and the one it used to miss for ever:
// an id whose wall was never found. `openEnded` means the top rung was SERVED, so
// the run has no bracket — and for a 1,048,576-token id under a ladder that
// stopped at 4,200,000 characters, that was true while the snapshot said 898,459
// against a wall of 1,048,092. Such a model is measured again on the timer, but
// only while the catalogue still declares more than the snapshot ever served.
const catalogued = (ids, declared) => async (url) =>
  url.endsWith("/models")
    ? { data: ids.map((id) => ({ id })) }
    : {
        opencode: {
          models: Object.fromEntries(ids.map((id) => [id, { name: id, limit: { context: declared[id] } }])),
        },
      };

const measuredWith = (entries) => async () => ({
  models: Object.fromEntries(
    Object.entries(entries).map(([id, v]) => [id, { wall: "openEnded", ...v }]),
  ),
});

test("an open-ended id the catalogue declares more for is measured again", async () => {
  const { watch } = await subject;
  const swept = [];
  const state = await watch({
    sweep: true,
    fetchJSON: catalogued(["small-free"], { "small-free": 262_144 }),
    read: measuredWith({ "small-free": { servedTokens: 100_000 } }),
    sweepModels: async (ids) => {
      swept.push(...ids);
      return [];
    },
  });
  assert.deepEqual(state.suspicion, ["small-free"]);
  assert.deepEqual(swept, ["small-free"], "100,000 against a declared 262,144 is a wall never found");
});

test("an id already served to its declaration is not asked again", async () => {
  const { watch } = await subject;
  const swept = [];
  const state = await watch({
    sweep: true,
    fetchJSON: catalogued(["served-free"], { "served-free": 262_144 }),
    read: measuredWith({ "served-free": { servedTokens: 250_000 } }),
    sweepModels: async (ids) => {
      swept.push(...ids);
      return [];
    },
  });
  assert.deepEqual(state.suspicion, []);
  assert.deepEqual(swept, [], "within a tenth of the declaration is a host counting differently");
});

test("a bracketed wall is already known, so it is not suspected", async () => {
  const { watch } = await subject;
  const swept = [];
  await watch({
    sweep: true,
    fetchJSON: catalogued(["walled-free"], { "walled-free": 262_144 }),
    read: measuredWith({ "walled-free": { servedTokens: 100_000, wall: "bracketed" } }),
    sweepModels: async (ids) => {
      swept.push(...ids);
      return [];
    },
  });
  assert.deepEqual(swept, [], "a wall this run already has is not a wall to look for again");
});

// The rule that decides what is measured at all: an id the catalogue declares
// at a million or more is answered from models.dev — the largest entry any
// provider declares for the same canonical model — and is not measured. Only an
// id the catalogue declares BELOW a million is measured, because only there can
// a measurement change the answer.
//
// The run of 2026-10-20 asked `minimax-m3.1-flash-free` and `beam-free` and
// `nemotron-3.5-super-vl-free` — ids whose value models.dev already answers —
// and spent eleven megabytes of prompts and half an hour of runner time to
// learn the 1,048,576 the catalogue already said.
test("an id the catalogue declares at a million is not measured", async () => {
  const { watch } = await subject;
  const swept = [];
  const state = await watch({
    sweep: true,
    all: true,
    fetchJSON: catalogued(["big-free", "small-free"], { "big-free": 1_000_000, "small-free": 262_144 }),
    read: measuredWith({ "big-free": { servedTokens: 898_459 } }),
    sweepModels: async (ids) => {
      swept.push(...ids);
      return [];
    },
  });
  assert.deepEqual(state.answeredElsewhere, ["big-free"], "the catalogue declares it at a million");
  assert.deepEqual(swept, ["small-free"], "so only the one below the line is measured");
});

test("the open-ended state does not bring a million-token id back into measurement", async () => {
  const { watch } = await subject;
  const swept = [];
  const state = await watch({
    sweep: true,
    fetchJSON: catalogued(["big-free"], { "big-free": 1_048_576 }),
    read: measuredWith({ "big-free": { servedTokens: 898_459 } }),
    sweepModels: async (ids) => {
      swept.push(...ids);
      return [];
    },
  });
  assert.deepEqual(state.suspicion, [], "an open-ended id is not a candidate while models.dev answers it");
  assert.deepEqual(swept, [], "and it is not asked about");
});

// A row for an id that is answered from models.dev is a row about a window
// nobody asked about, and it is the row that makes the next run think the
// model is still a candidate — `openEnded` is what the suspicion rule reads.
test("a row for an id models.dev answers is dropped from the snapshot", async () => {
  const { watch } = await subject;
  const state = await watch({
    sweep: false,
    fetchJSON: catalogued(["big-free", "small-free"], { "big-free": 1_000_000, "small-free": 262_144 }),
    read: measuredWith({ "big-free": { servedTokens: 898_459 }, "small-free": { servedTokens: 215_041 } }),
    sweepModels: async () => [],
  });
  assert.deepEqual(Object.keys(state.snapshot.models), ["small-free"], "only what the sweep measured is kept");
});

// The rule holds for an id the catalogue does not declare a window for: there is
// no declaration to be large, so there is nothing for models.dev to correct,
// and it is measured.
test("an id the catalogue does not declare a window for is measured", async () => {
  const { watch } = await subject;
  const swept = [];
  const state = await watch({
    sweep: true,
    fetchJSON: catalogued(["undeclared-free"], { "undeclared-free": undefined }),
    read: measuredWith({}),
    sweepModels: async (ids) => {
      swept.push(...ids);
      return [];
    },
  });
  assert.deepEqual(state.answeredElsewhere, []);
  assert.deepEqual(swept, ["undeclared-free"]);
});

// The report is what a pull request body is built from, and it used to claim
// work that could never happen. The snapshot never holds a row for an id
// models.dev answers — the run below drops those rows on every run — so such an
// id was never measured and yet was named as "new" on every single run:
// `minimax-m3.1-flash-free`, `beam-free` and `nemotron-3.5-super-vl-free` were
// in that list an hour after an hour, for ever.
test("an id models.dev answers is not new, because it is never measured", async () => {
  const { watch } = await subject;
  const state = await watch({
    fetchJSON: catalogued(["big-free", "small-free"], { "big-free": 1_048_576, "small-free": 262_144 }),
    read: measuredWith({}),
    sweepModels: async () => [],
  });
  assert.deepEqual(state.added, ["small-free"], "the id that will be measured is the one that is new");
  assert.deepEqual(state.answeredElsewhere, ["big-free"], "and the other is said under its own heading");
});

test("the report does not call an id models.dev answers new", async () => {
  const { watch } = await subject;
  const lines = [];
  await watch({
    log: (line) => lines.push(line),
    fetchJSON: catalogued(["big-free", "small-free"], { "big-free": 1_048_576, "small-free": 262_144 }),
    read: measuredWith({}),
    sweepModels: async () => [],
  });
  const said = lines.join("\n");
  assert.ok(said.includes("new: small-free"), "the id that is going to be measured is named");
  assert.ok(!/new:.*big-free/.test(said), "and the id that is never measured is not named as new");
  assert.ok(
    said.includes("answered from models.dev, so not measured: big-free"),
    "it is said under its own heading, so the report is not silent about it",
  );
});

// A row that disappears from the snapshot used to leave no trace: not in the
// log, not in what the run returned, and not in anything a pull request body
// could explain. The diff simply lost a measurement.
test("a row that is dropped from the snapshot is named", async () => {
  const { watch } = await subject;
  const lines = [];
  const state = await watch({
    log: (line) => lines.push(line),
    fetchJSON: catalogued(["big-free", "small-free"], { "big-free": 1_048_576, "small-free": 262_144 }),
    read: measuredWith({ "big-free": { servedTokens: 898_459 }, "small-free": { servedTokens: 215_041 } }),
    sweepModels: async () => [],
  });
  assert.deepEqual(state.dropped, ["big-free"], "the id whose row is gone is named");
  assert.deepEqual(Object.keys(state.snapshot.models), ["small-free"], "and the row really is gone");
  assert.ok(
    lines.some((line) => line.includes("dropped") && line.includes("big-free")),
    "the report says so, so a pull request body can explain the diff",
  );
});

// A row that carries a window the route stated in its own words is the one
// row the plugin reads most eagerly: `limits.mjs` settles an axis outright on a
// `named` number, where a bracketed one may only raise a declaration. A vendor
// raising a declaration over a million does not un-state what the route said
// about itself, so the row stays.
test("a row that carries a window the route named survives the drop", async () => {
  const { watch } = await subject;
  const state = await watch({
    fetchJSON: catalogued(["big-free"], { "big-free": 1_048_576 }),
    read: measuredWith({ "big-free": { servedTokens: 898_459, wall: "named", named: 1_000_000 } }),
    sweepModels: async () => [],
  });
  assert.deepEqual(state.dropped, [], "a window the route stated is not dropped");
  assert.equal(state.snapshot.models["big-free"].named, 1_000_000, "and it is still in the snapshot");
});

// The suspicion rule is the one rule here with no bound of its own: a row that
// says `openEnded` while the catalogue declares more than the row ever served
// is an id whose wall may be one rung up, and the ladder is the same on every
// run. Without the date on the row, the same question was paid for every hour
// — up to fourteen requests and several megabytes of prompt each.
test("an open-ended row measured yesterday is not asked about again", async () => {
  const { watch } = await subject;
  const swept = [];
  const state = await watch({
    at: "2026-10-20",
    sweep: true,
    fetchJSON: catalogued(["small-free"], { "small-free": 262_144 }),
    read: measuredWith({ "small-free": { servedTokens: 100_000, at: "2026-10-19" } }),
    sweepModels: async (ids) => {
      swept.push(...ids);
      return [];
    },
  });
  assert.deepEqual(state.suspicion, [], "the row was measured a day ago");
  assert.deepEqual(swept, [], "so the same question is not paid for again");
});

test("an open-ended row is asked about again once it is old enough", async () => {
  const { watch, SUSPECT_AFTER_DAYS } = await subject;
  const swept = [];
  const state = await watch({
    at: "2026-10-20",
    sweep: true,
    fetchJSON: catalogued(["small-free"], { "small-free": 262_144 }),
    read: measuredWith({ "small-free": { servedTokens: 100_000, at: "2026-10-13" } }),
    sweepModels: async (ids) => {
      swept.push(...ids);
      return [];
    },
  });
  assert.equal(SUSPECT_AFTER_DAYS, 7, "a week is the bound, and it is the row's age that is counted");
  assert.deepEqual(state.suspicion, ["small-free"], "a row a week old is asked about again");
  assert.deepEqual(swept, ["small-free"], "and the question is paid for once, not every hour");
});

test("an open-ended row a day short of the bound is not asked about again", async () => {
  const { watch } = await subject;
  const swept = [];
  const state = await watch({
    at: "2026-10-20",
    sweep: true,
    fetchJSON: catalogued(["small-free"], { "small-free": 262_144 }),
    read: measuredWith({ "small-free": { servedTokens: 100_000, at: "2026-10-14" } }),
    sweepModels: async (ids) => {
      swept.push(...ids);
      return [];
    },
  });
  assert.deepEqual(state.suspicion, [], "six days is not yet a week");
  assert.deepEqual(swept, [], "so nothing is asked");
});

// A row that is not a measurement is not a measurement. It used to count as one
// anyway, because `added` is decided by the id being in the table: the id was
// then never swept again, and the bad row was written straight back out, so
// the corruption was permanent.
test("a row that is not a measurement is dropped when the snapshot is read", async () => {
  const { readSnapshot } = await subject;
  const file = join(tmpdir(), `zen-observed-${process.pid}-rows-${Date.now()}.json`);
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        models: {
          "good-free": { wall: "openEnded", servedTokens: 10 },
          "text-free": "openEnded",
          "number-free": 12,
          "empty-free": {},
          "list-free": [],
        },
      }),
      "utf8",
    );
    const read = await readSnapshot(file);
    assert.deepEqual(Object.keys(read.models), ["good-free"], "only a row that names a wall is a measurement");
  } finally {
    rmSync(file, { force: true });
  }
});

test("an id whose row is not a measurement is measured again", async () => {
  const { watch, readSnapshot } = await subject;
  const file = join(tmpdir(), `zen-observed-${process.pid}-bad-row-${Date.now()}.json`);
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, JSON.stringify({ version: 1, models: { "text-free": "openEnded" } }), "utf8");
    const swept = [];
    await watch({
      sweep: true,
      fetchJSON: route(["text-free"]),
      read: () => readSnapshot(file),
      sweepModels: async (ids) => {
        swept.push(...ids);
        return [];
      },
    });
    assert.deepEqual(swept, ["text-free"], "the id was never measured, so it is measured now");
  } finally {
    rmSync(file, { force: true });
  }
});

// A file this file did not write is no snapshot, and that is the same answer as
// a missing one: there is nothing to compare against, and every offered id is
// new.
test("a snapshot written by another version of this file is no snapshot", async () => {
  const { readSnapshot } = await subject;
  const file = join(tmpdir(), `zen-observed-${process.pid}-version-${Date.now()}.json`);
  try {
    const { writeFile } = await import("node:fs/promises");
    for (const body of [
      '{"version":2,"models":{"a-free":{"wall":"openEnded"}}}',
      '{"models":{"a-free":{"wall":"openEnded"}}}',
    ]) {
      await writeFile(file, body, "utf8");
      assert.deepEqual(await readSnapshot(file), { models: {} }, `${body} is not a snapshot this file understands`);
    }
  } finally {
    rmSync(file, { force: true });
  }
});

// The snapshot is written beside the file and renamed over it. `writeFile`
// truncates the target first, so a crash between the truncate and the write
// left `limits-observed.json` empty — and `limits.mjs` answers with an empty
// map when the JSON does not parse, so a half-written snapshot silently
// stripped every measured wall from the running plugin.
test("the snapshot is replaced whole, and never emptied on the way", async () => {
  const { writeSnapshot } = await subject;
  const file = join(tmpdir(), `zen-observed-${process.pid}-atomic-${Date.now()}.json`);
  try {
    await writeSnapshot({ models: { "a-free": { wall: "openEnded" } } }, file);
    const before = statSync(file).ino;
    await writeSnapshot({ models: { "a-free": { wall: "openEnded" }, "b-free": { wall: "bracketed" } } }, file);
    const after = statSync(file).ino;
    assert.notEqual(after, before, "the file is replaced, so a reader that had it open keeps the old one");
    assert.equal(existsSync(`${file}.${process.pid}.tmp`), false, "and the temporary it was written through is gone");
    const written = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(Object.keys(written.models), ["a-free", "b-free"], "the new file holds the new rows");
  } finally {
    rmSync(file, { force: true });
  }
});

// A row counts the same window twice, in two units: `named` is tokens, the
// rest are characters. The names cannot change — three files read this one —
// so the units are stated beside the rows instead.
test("the snapshot says what unit each of its numbers is in", async () => {
  const { writeSnapshot, readSnapshot } = await subject;
  const file = join(tmpdir(), `zen-observed-${process.pid}-units-${Date.now()}.json`);
  try {
    const body = await writeSnapshot(
      {
        models: {
          "a-free": { wall: "named", named: 1_000_000, servedChars: 4_000_000, servedTokens: 1_000_000 },
        },
      },
      file,
    );
    const written = JSON.parse(body);
    assert.equal(written._units.named, "tokens", "the window the route named is a number of tokens");
    assert.equal(written._units.servedChars, "characters", "and what was served is a number of characters");
    assert.equal(written._units.refusedSizes, "characters", "and so is every size that was refused");
    assert.equal(written._units.unavailable, "date, YYYY-MM-DD", "and the liveness day is a date");
    assert.equal(written.version, 1, "the version is still the one the readers know");
    assert.deepEqual(Object.keys(written.models), ["a-free"], "the rows are where they were");
    const read = await readSnapshot(file);
    assert.deepEqual(Object.keys(read.models), ["a-free"], "and a reader that ignores the key still reads the rows");
  } finally {
    rmSync(file, { force: true });
  }
});

test("a snapshot written before the units were stated is read as it was", async () => {
  const { readSnapshot } = await subject;
  const file = join(tmpdir(), `zen-observed-${process.pid}-no-units-${Date.now()}.json`);
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, JSON.stringify({ version: 1, models: { "a-free": { wall: "openEnded" } } }), "utf8");
    const read = await readSnapshot(file);
    assert.deepEqual(Object.keys(read.models), ["a-free"], "the key is only ever written, never required");
  } finally {
    rmSync(file, { force: true });
  }
});

// The catalogue the run reads decides what is measured at all, so a deployment
// that names one has to be read. `limits-audit.mjs` and `limits-sweep.mjs`
// both honour the variable; this file read provider.mjs's own constant, which
// no deployment can name.
test("the catalogue comes from the environment when one is named", async () => {
  const { catalogUrl, watch } = await subject;
  const { CATALOG } = await import("./provider.mjs");
  const named = "https://mirror.invalid/api.json";
  assert.equal(catalogUrl({ ZEN_CATALOG_URL: named }), named, "the named catalogue is the one that is read");
  assert.equal(catalogUrl({}), CATALOG, "and without one the production catalogue is");
  const urls = [];
  await watch({
    fetchJSON: async (url) => {
      urls.push(url);
      return url.endsWith("/models") ? { data: [] } : { opencode: { models: {} } };
    },
    read: async () => ({ models: {} }),
    sweepModels: async () => [],
  });
  assert.ok(urls.includes(catalogUrl()), "and the run fetches the catalogue from that URL");
});

// A route that answers 500, a name that does not resolve, a catalogue that
// cannot be read and a snapshot that cannot be written all have to be heard
// about: the exit code is how the workflow tells "reached the route" from
// "could not reach it", and a stack trace is not an answer.
//
// Run as a program, because that is the only way the entry point exists. The
// entry point is not Bun-only any more — it asks `import.meta.main` and falls
// back to process.argv[1] — but these subprocess cases stay with the Bun suite
// the repository pins; the case below runs the same file on whatever runtime the
// suite itself is on.
const needsBun = process.versions.bun
  ? undefined
  : "these subprocess cases are kept to the Bun suite";
test(
  "a run that could not reach the route says so, and exits with the code the workflow reads",
  { skip: needsBun },
  async () => {
    const script = fileURLToPath(new URL("./limits-watch.mjs", import.meta.url));
    const run = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      timeout: 60000,
      env: {
        ...process.env,
        // A closed port on the loopback: the connection is refused at once, so
        // the run fails for the reason under test rather than by waiting.
        ZEN_BASE_URL: "http://127.0.0.1:1/v1",
        ZEN_CATALOG_URL: "http://127.0.0.1:1/api.json",
      },
    });
    const said = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    assert.equal(run.status, 1, "a run that reached nothing is not a run that answered");
    assert.ok(
      said.includes("unable to read the route or the catalogue"),
      `the failure is named in a sentence, not in a stack trace: ${said}`,
    );
    assert.ok(said.includes("Check the network and ZEN_BASE_URL"), "and the remedy is said with it");
    assert.ok(!said.includes("limits-watch.mjs:"), "and no stack frame of this file is printed");
  },
);

// The snapshot is what the plugin reads at run time: `limits.mjs` answers with
// what the file holds, so a file that is not what the plugin can read is a
// window every host gets wrong. The workflow publishes that file without a
// person reading it, so the file has to be able to say that it is right — and
// the check has to be able to say that it is not.
const goodRow = {
  servedTokens: 375142,
  servedChars: 1750000,
  refusedChars: 1787500,
  refusedSizes: [1787500, 1825000],
  wall: "bracketed",
  at: "2026-10-20",
};

test("a snapshot this file wrote is one the plugin can read", async () => {
  const { writeSnapshot, checkSnapshot, checkSnapshotFile } = await subject;
  const file = join(tmpdir(), `zen-observed-${process.pid}-good-${Date.now()}.json`);
  try {
    await writeSnapshot({ models: { "a-free": goodRow } }, file);
    assert.deepEqual(checkSnapshot(JSON.parse(readFileSync(file, "utf8"))), [], "the file it writes passes its own check");
    const report = await checkSnapshotFile(file);
    assert.equal(report.ok, true, "and the check says so");
    assert.deepEqual(report.problems, [], "with nothing to say about it");
  } finally {
    rmSync(file, { force: true });
  }
});

test("a row with a wall nobody knows is refused, and the row is named", async () => {
  const { checkSnapshot } = await subject;
  const problems = checkSnapshot({
    version: 1,
    _units: { servedTokens: "tokens", servedChars: "characters", refusedChars: "characters", refusedSizes: "characters", named: "tokens", at: "date, YYYY-MM-DD", unavailable: "date, YYYY-MM-DD" },
    models: { "a-free": { ...goodRow, wall: "bracketedt" } },
  });
  assert.equal(problems.length, 1, "the row is the only thing wrong");
  assert.ok(problems[0].startsWith("a-free:"), "the row is named: " + problems[0]);
  assert.ok(problems[0].includes("bracketedt"), "and the wall it says is quoted: " + problems[0]);
});

test("a row that names two different refused sizes is refused", async () => {
  const { checkSnapshot } = await subject;
  const problems = checkSnapshot({
    version: 1,
    _units: { servedTokens: "tokens", servedChars: "characters", refusedChars: "characters", refusedSizes: "characters", named: "tokens", at: "date, YYYY-MM-DD", unavailable: "date, YYYY-MM-DD" },
    models: { "a-free": { ...goodRow, refusedChars: 1787501 } },
  });
  assert.equal(problems.length, 1, "the row is the only thing wrong");
  assert.ok(problems[0].includes("1787501") && problems[0].includes("1787500"), "and both sizes are said: " + problems[0]);
});

test("a row whose date is not a date is refused", async () => {
  const { checkSnapshot } = await subject;
  const problems = checkSnapshot({
    version: 1,
    _units: { servedTokens: "tokens", servedChars: "characters", refusedChars: "characters", refusedSizes: "characters", named: "tokens", at: "date, YYYY-MM-DD", unavailable: "date, YYYY-MM-DD" },
    models: { "a-free": { ...goodRow, at: "2026-13-40" } },
  });
  assert.equal(problems.length, 1, "the row is the only thing wrong");
  assert.ok(problems[0].includes("2026-13-40"), "and the date it says is quoted: " + problems[0]);
});

test("a row whose number is not a whole number is refused", async () => {
  const { checkSnapshot } = await subject;
  const problems = checkSnapshot({
    version: 1,
    _units: { servedTokens: "tokens", servedChars: "characters", refusedChars: "characters", refusedSizes: "characters", named: "tokens", at: "date, YYYY-MM-DD", unavailable: "date, YYYY-MM-DD" },
    models: { "a-free": { ...goodRow, servedTokens: 375142.5 } },
  });
  assert.equal(problems.length, 1, "the row is the only thing wrong");
  assert.ok(problems[0].includes("servedTokens"), "and the number it says is named: " + problems[0]);
});

test("a file that does not say what unit its numbers are in is refused", async () => {
  const { checkSnapshot } = await subject;
  const problems = checkSnapshot({ version: 1, models: { "a-free": goodRow } });
  assert.equal(problems.length, 1, "the file is the only thing wrong");
  assert.ok(problems[0].includes("unit"), "and what is missing is said: " + problems[0]);
});

test("a file that says the wrong unit for a number is refused", async () => {
  const { checkSnapshot } = await subject;
  const problems = checkSnapshot({
    version: 1,
    _units: { servedTokens: "characters", servedChars: "characters", refusedChars: "characters", refusedSizes: "characters", named: "tokens", at: "date, YYYY-MM-DD", unavailable: "date, YYYY-MM-DD" },
    models: { "a-free": goodRow },
  });
  assert.equal(problems.length, 1, "the file is the only thing wrong");
  assert.ok(problems[0].includes("servedTokens") && problems[0].includes("tokens"), "and the unit it says is named: " + problems[0]);
});

test("a snapshot that cannot be read and one that is not JSON are told apart", async () => {
  const { checkSnapshotFile } = await subject;
  const missing = join(tmpdir(), `zen-observed-${process.pid}-gone-${Date.now()}.json`);
  const unreadable = await checkSnapshotFile(missing);
  assert.equal(unreadable.ok, false, "a file that is not there is not a snapshot");
  assert.equal(unreadable.why, "unreadable", "and it is said as a file that could not be read");
  assert.ok(unreadable.problems[0].includes("could not be read"), "in so many words: " + unreadable.problems[0]);
  const file = join(tmpdir(), `zen-observed-${process.pid}-junk-${Date.now()}.json`);
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, "not json at all", "utf8");
    const notJson = await checkSnapshotFile(file);
    assert.equal(notJson.ok, false, "a file that is not JSON is not a snapshot");
    assert.equal(notJson.why, "not-json", "and it is said as a file that is not JSON");
    assert.ok(notJson.problems[0].includes("not JSON"), "in so many words: " + notJson.problems[0]);
  } finally {
    rmSync(file, { force: true });
  }
});

test("--check reads the file, writes nothing, and asks nothing", { skip: needsBun }, async () => {
  const { writeSnapshot } = await subject;
  const file = join(tmpdir(), `zen-observed-${process.pid}-check-${Date.now()}.json`);
  try {
    await writeSnapshot({ models: { "a-free": goodRow } }, file);
    const before = readFileSync(file, "utf8");
    const script = fileURLToPath(new URL("./limits-watch.mjs", import.meta.url));
    const run = spawnSync(process.execPath, [script, "--check", file], {
      encoding: "utf8",
      timeout: 60000,
      env: {
        ...process.env,
        // A closed port on the loopback: the check asks nothing, so a run that
        // reached for the route would fail here rather than pass quietly.
        ZEN_BASE_URL: "http://127.0.0.1:1/v1",
        ZEN_CATALOG_URL: "http://127.0.0.1:1/api.json",
      },
    });
    const said = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    assert.equal(run.status, 0, `a snapshot the plugin can read passes: ${said}`);
    assert.ok(
      said.includes("is a snapshot the plugin can read"),
      `the child says the file passed, rather than saying nothing and happening to exit 0: ${said}`,
    );
    assert.equal(readFileSync(file, "utf8"), before, "and the file it read is the file it left");
  } finally {
    rmSync(file, { force: true });
  }
});

test("--check says which row is wrong, and exits with the code the workflow reads", { skip: needsBun }, async () => {
  const { writeSnapshot } = await subject;
  const file = join(tmpdir(), `zen-observed-${process.pid}-bad-${Date.now()}.json`);
  try {
    await writeSnapshot({ models: { "a-free": { ...goodRow, wall: "nonsense" } } }, file);
    const script = fileURLToPath(new URL("./limits-watch.mjs", import.meta.url));
    const run = spawnSync(process.execPath, [script, "--check", file], {
      encoding: "utf8",
      timeout: 60000,
      env: {
        ...process.env,
        // The same closed port as the passing case: `--check` asks nothing, and a
        // run that did reach for the route fails at once here instead of talking
        // to the live route and answering a question this case is not asking.
        ZEN_BASE_URL: "http://127.0.0.1:1/v1",
        ZEN_CATALOG_URL: "http://127.0.0.1:1/api.json",
      },
    });
    const said = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    assert.equal(run.status, 1, "a snapshot the plugin cannot read does not pass");
    assert.ok(said.includes("is not what the plugin will read"), `the child's own sentence is said: ${said}`);
    assert.ok(said.includes("a-free:"), "the row is named: " + said);
    assert.ok(said.includes("nonsense"), "and what is wrong with it is said: " + said);
  } finally {
    rmSync(file, { force: true });
  }
});

// The entry point used to be `import.meta.main`, which is Bun's: on a Node
// before 22.18 the file evaluated nothing and exited 0, so a check that read no
// snapshot looked exactly like a pass. `entryVerdict` settles the question from
// process.argv[1], and this case runs the file with this process's own runtime.
// It used to accept a visible failure naming the undetermined entry as one of
// two answers, which is the regression it exists for: the file is spawned by
// path, so argv[1] names it and the entry point has to resolve.
test("the entry point resolves on whatever runtime ran it", async () => {
  const { writeSnapshot } = await subject;
  const file = join(tmpdir(), `zen-observed-${process.pid}-node-entry-${Date.now()}.json`);
  try {
    await writeSnapshot({ models: { "a-free": goodRow } }, file);
    const script = fileURLToPath(new URL("./limits-watch.mjs", import.meta.url));
    const run = spawnSync(process.execPath, [script, "--check", file], {
      encoding: "utf8",
      timeout: 60000,
    });
    const said = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    assert.notEqual(said.trim(), "", "a process that says nothing has not answered");
    assert.equal(run.status, 0, `running the file by path has to resolve the entry point: ${said}`);
    assert.ok(
      said.includes("is a snapshot the plugin can read"),
      `a zero exit has to be the check's own pass sentence: ${said}`,
    );
  } finally {
    rmSync(file, { force: true });
  }
});

// The suite runs under Bun, where `import.meta.main` answers the entry question
// and the `process.argv[1]` fallback is never consulted. Bun is not the only
// runtime these files run on, so the same file is asked by Node when one is on
// PATH. A host without one is skipped rather than failed: there is no second
// runtime to ask. The fallback itself is unit-tested in limits-audit.test.mjs,
// where `entryVerdict({ main: undefined, ... })` can be called directly — this
// case is what says the file still loads and answers on Node.
const nodeBinary = (() => {
  const probe = spawnSync("node", ["--version"], { encoding: "utf8" });
  return probe.status === 0 ? "node" : undefined;
})();
test(
  "the entry point resolves on Node too, where Bun's flag is not the answer",
  { skip: nodeBinary === undefined ? "no node on PATH to ask" : false },
  async () => {
    const { writeSnapshot } = await subject;
    const file = join(tmpdir(), `zen-observed-${process.pid}-node-runtime-${Date.now()}.json`);
    try {
      await writeSnapshot({ models: { "a-free": goodRow } }, file);
      const script = fileURLToPath(new URL("./limits-watch.mjs", import.meta.url));
      const run = spawnSync(nodeBinary, [script, "--check", file], {
        encoding: "utf8",
        timeout: 60000,
      });
      const said = `${run.stdout ?? ""}${run.stderr ?? ""}`;
      assert.equal(run.status, 0, `node has to load the file and resolve its entry: ${said}`);
      assert.ok(
        said.includes("is a snapshot the plugin can read"),
        `and the check's own pass sentence is what it says: ${said}`,
      );
    } finally {
      rmSync(file, { force: true });
    }
  },
);

// `ZEN_BASE_URL` is not read by `--check`: it asks nothing. The base used to be
// parsed while the module was evaluated, so a malformed variable failed a check
// of a file that was perfectly readable. It is parsed when a run asks for it
// now, and this is the case that pins that.
test("--check does not fail on a ZEN_BASE_URL it never uses", async () => {
  const { writeSnapshot } = await subject;
  const file = join(tmpdir(), `zen-observed-${process.pid}-lazy-base-${Date.now()}.json`);
  try {
    await writeSnapshot({ models: { "a-free": goodRow } }, file);
    const script = fileURLToPath(new URL("./limits-watch.mjs", import.meta.url));
    const run = spawnSync(process.execPath, [script, "--check", file], {
      encoding: "utf8",
      timeout: 60000,
      env: {
        ...process.env,
        // The form `base-url.mjs` refuses: it would have thrown during module
        // evaluation, which `--check` never needs to reach.
        ZEN_BASE_URL: "ftp://opencode.ai/inference/v1",
      },
    });
    const said = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    assert.equal(run.status, 0, `--check asks nothing, so a base it never uses may not fail it: ${said}`);
    assert.ok(said.includes("is a snapshot the plugin can read"), `the check's own pass sentence is said: ${said}`);
  } finally {
    rmSync(file, { force: true });
  }
});

// A result the sweep learned nothing about is not a measurement. A run in which
// every request failed comes back as `openEnded` with nothing served and
// nothing refused — and written into the snapshot, that row says "no wall in
// reach" about a run that never got an answer, overwriting an earlier good
// measurement and marking the id as measured for ever.
test("a result the run learned nothing about gets no row, and is named", async () => {
  const { watch } = await subject;
  const lines = [];
  const state = await watch({
    sweep: true,
    log: (line) => lines.push(line),
    fetchJSON: catalogued(["small-free"], { "small-free": 262_144 }),
    read: measuredWith({}),
    sweepModels: async () => [
      {
        model: "small-free",
        servedTokens: null,
        servedChars: null,
        refusedChars: null,
        refusedSizes: [],
        wall: "openEnded",
        says: [],
      },
    ],
  });
  assert.deepEqual(state.unlearned, ["small-free"], "the id the run learned nothing about is named");
  assert.deepEqual(Object.keys(state.snapshot.models), [], "and no row was written for it");
  assert.ok(
    lines.some((line) => line.includes("learned nothing") && line.includes("small-free")),
    "the report says so, so a pull request body can explain it",
  );
});

test("an earlier good measurement is not overwritten by a run that learned nothing", async () => {
  const { watch } = await subject;
  const state = await watch({
    sweep: true,
    // `--all`, because an id that already has a row is not asked about again
    // by the timer — and the row has to be in the way for this to be about
    // overwriting it.
    all: true,
    fetchJSON: catalogued(["small-free"], { "small-free": 262_144 }),
    read: measuredWith({ "small-free": { servedTokens: 215_041, wall: "bracketed" } }),
    sweepModels: async () => [
      {
        model: "small-free",
        servedTokens: null,
        servedChars: null,
        refusedChars: null,
        refusedSizes: [],
        wall: "openEnded",
        says: [],
      },
    ],
  });
  assert.deepEqual(state.unlearned, ["small-free"], "the run learned nothing about the id");
  assert.equal(state.snapshot.models["small-free"].wall, "bracketed", "and the row it had stands");
  assert.equal(state.snapshot.models["small-free"].servedTokens, 215_041, "with the number it carried");
});

test("a result the route served without a count is a measurement, and is kept", async () => {
  const { watch } = await subject;
  const state = await watch({
    sweep: true,
    fetchJSON: catalogued(["small-free"], { "small-free": 262_144 }),
    read: measuredWith({}),
    sweepModels: async () => [
      {
        model: "small-free",
        servedTokens: null,
        servedChars: 200_000,
        refusedChars: null,
        refusedSizes: [],
        wall: "openEnded",
        says: [],
      },
    ],
  });
  assert.deepEqual(state.unlearned, [], "the route served a size, so the run learned something");
  assert.equal(state.snapshot.models["small-free"].servedChars, 200_000, "and the row is written");
});

// A wall label is what decides whether a row is a measurement, and the label
// used to be accepted as any string while `--check` enforced this file's own
// list. A row a person mistyped into `"bracketedt"` was then read as a
// measurement: `added` is decided by the id being in the table, so that id was
// never swept again and the bad row was written straight back out.
test("a row whose wall is not one this file knows is not a measurement", async () => {
  const { readSnapshot } = await subject;
  const file = join(tmpdir(), `zen-observed-${process.pid}-wall-${Date.now()}.json`);
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        models: {
          "good-free": { wall: "openEnded", servedTokens: 10 },
          "typo-free": { wall: "bracketedt" },
          "spaced-free": { wall: " bracketed" },
        },
      }),
      "utf8",
    );
    const read = await readSnapshot(file);
    assert.deepEqual(Object.keys(read.models), ["good-free"], "only a wall this file knows is a measurement");
  } finally {
    rmSync(file, { force: true });
  }
});

// An id is a key, and an id named `__proto__` is exactly the key a plain object
// cannot hold: assigning it walks the prototype setter. The row is lost, the id
// stays "new" and is swept on every run, and the map's prototype becomes a
// row-shaped object that later lookups read through.
test("an id named __proto__ is a row and never a prototype", async () => {
  const { readSnapshot, watch } = await subject;
  const file = join(tmpdir(), `zen-observed-${process.pid}-proto-${Date.now()}.json`);
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      file,
      '{"version":1,"models":{"__proto__":{"wall":"openEnded","servedTokens":100}}}',
      "utf8",
    );
    const read = await readSnapshot(file);
    assert.equal(Object.getPrototypeOf(read.models), null, "the snapshot map has no prototype to reach");
    assert.ok(Object.hasOwn(read.models, "__proto__"), "and the id is an own property, not the prototype");
    assert.equal(read.models.__proto__.servedTokens, 100, "the row is what it says it is");
    // ...and a measurement for that id is written as a row too.
    const state = await watch({
      sweep: true,
      fetchJSON: async (url) =>
        url.endsWith("/models")
          ? { data: [{ id: "__proto__" }] }
          : { opencode: { models: { ["__proto__"]: { name: "__proto__", cost: { input: 0, output: 0 } } } } },
      read: async () => ({ models: Object.create(null) }),
      sweepModels: async () => [
        {
          model: "__proto__",
          servedTokens: 100,
          servedChars: 400,
          refusedChars: null,
          refusedSizes: [],
          wall: "openEnded",
          says: [],
        },
      ],
    });
    assert.equal(Object.getPrototypeOf(state.snapshot.models), null, "the map it writes has no prototype either");
    assert.ok(Object.hasOwn(state.snapshot.models, "__proto__"), "the id is a row, not a prototype");
    assert.equal(state.snapshot.models.__proto__.servedTokens, 100);
  } finally {
    rmSync(file, { force: true });
  }
});

// A run that learned nothing still has to move the day it is asked about, or
// the seven-day bound reads the unchanged measurement day for ever: an
// `openEnded` row that fell past the week was re-swept every hour.
test("an attempt that learned nothing dates the row without rewriting the measurement", async () => {
  const { watch } = await subject;
  const state = await watch({
    at: "2026-10-20",
    sweep: true,
    fetchJSON: catalogued(["small-free"], { "small-free": 262_144 }),
    read: measuredWith({ "small-free": { servedTokens: 100_000, at: "2026-10-13" } }),
    sweepModels: async () => [
      {
        model: "small-free",
        servedTokens: null,
        servedChars: null,
        refusedChars: null,
        refusedSizes: [],
        wall: "openEnded",
        says: [],
      },
    ],
  });
  assert.deepEqual(state.unlearned, ["small-free"], "the run learned nothing about it");
  const row = state.snapshot.models["small-free"];
  assert.equal(row.at, "2026-10-13", "the measurement's own day is not rewritten");
  assert.equal(row.servedTokens, 100_000, "and the measurement stands");
  assert.equal(row.tried, "2026-10-20", "but the attempt is dated, so the week starts again");
  // The next tick reads the row this run wrote, and does not pay for the same
  // question again — which is the whole cost this field is for.
  const again = await watch({
    at: "2026-10-20",
    sweep: true,
    fetchJSON: catalogued(["small-free"], { "small-free": 262_144 }),
    read: async () => ({ models: state.snapshot.models }),
    sweepModels: async () => {
      throw new Error("a row asked about today must not be measured again");
    },
  });
  assert.deepEqual(again.suspicion, [], "the later of `at` and `tried` is the day the age is counted from");
});

test("a row asked about after it was measured is not suspected again", async () => {
  const { watch } = await subject;
  const swept = [];
  const state = await watch({
    at: "2026-10-20",
    sweep: true,
    fetchJSON: catalogued(["small-free"], { "small-free": 262_144 }),
    read: measuredWith({ "small-free": { servedTokens: 100_000, at: "2026-10-01", tried: "2026-10-19" } }),
    sweepModels: async (ids) => {
      swept.push(...ids);
      return [];
    },
  });
  assert.deepEqual(state.suspicion, [], "the attempt is a day later than the measurement");
  assert.deepEqual(swept, [], "so the same question is not paid for again");
});

test("a row that carries the day it was tried passes the check, and a bad one does not", async () => {
  const { checkSnapshot } = await subject;
  const units = {
    servedTokens: "tokens",
    servedChars: "characters",
    refusedChars: "characters",
    refusedSizes: "characters",
    named: "tokens",
    at: "date, YYYY-MM-DD",
    unavailable: "date, YYYY-MM-DD",
  };
  assert.deepEqual(
    checkSnapshot({ version: 1, _units: units, models: { "a-free": { ...goodRow, tried: "2026-10-20" } } }),
    [],
    "the optional attempt day is part of the shape rather than a problem",
  );
  const bad = checkSnapshot({
    version: 1,
    _units: units,
    models: { "a-free": { ...goodRow, tried: "2026-13-40" } },
  });
  assert.ok(bad.some((problem) => problem.includes("tried")), "a day that is not a day is refused: " + bad.join("\n"));
  // The liveness day is read by the same rule: optional, but a value has to be
  // a day, or a report would believe "no such day" is when the route said the
  // model was gone.
  assert.deepEqual(
    checkSnapshot({ version: 1, _units: units, models: { "a-free": { ...goodRow, unavailable: "2026-10-20" } } }),
    [],
    "the optional liveness day is part of the shape too",
  );
  const badUnavailable = checkSnapshot({
    version: 1,
    _units: units,
    models: { "a-free": { ...goodRow, unavailable: "2026-13-40" } },
  });
  assert.ok(
    badUnavailable.some((problem) => problem.includes("unavailable")),
    "a liveness day that is not a day is refused: " + badUnavailable.join("\n"),
  );
});

test("a snapshot written before the liveness unit existed is still readable", async () => {
  const { checkSnapshot } = await subject;
  // The previous version wrote no `_units.unavailable` because it had no such
  // row field. Requiring the unit would make every repository snapshot fail
  // --check until a sweep rewrote it, which is a schema gate on a file that is
  // otherwise exactly what this version reads. The unit is required only when
  // the file names it.
  const oldUnits = {
    servedTokens: "tokens",
    servedChars: "characters",
    refusedChars: "characters",
    refusedSizes: "characters",
    named: "tokens",
    at: "date, YYYY-MM-DD",
  };
  assert.deepEqual(
    checkSnapshot({ version: 1, _units: oldUnits, models: { "a-free": goodRow } }),
    [],
    "a file from before the field existed passes",
  );
  const wrong = checkSnapshot({
    version: 1,
    _units: { ...oldUnits, unavailable: "tokens" },
    models: { "a-free": goodRow },
  });
  assert.ok(
    wrong.some((problem) => problem.includes("unavailable") && problem.includes("date")),
    "but a file that names the field still has to name the right unit: " + wrong.join("\n"),
  );
});

// `--check` is the gate on the unattended merge, and a positive safe integer is
// not a plausible measurement: 9,000,000,000 tokens passed the shape check and
// was merged into main, where `limits.mjs` would read it as a window.
test("a measurement too large to be one is refused, and the units have to agree", async () => {
  const { checkSnapshot } = await subject;
  const units = {
    servedTokens: "tokens",
    servedChars: "characters",
    refusedChars: "characters",
    refusedSizes: "characters",
    named: "tokens",
    at: "date, YYYY-MM-DD",
    unavailable: "date, YYYY-MM-DD",
  };
  const over = (patch) =>
    checkSnapshot({ version: 1, _units: units, models: { "a-free": { ...goodRow, ...patch } } });
  const giant = over({ servedTokens: 9_000_000_000 });
  assert.ok(giant.some((problem) => problem.includes("servedTokens")), "the token count is named: " + giant.join("\n"));
  assert.ok(giant.some((problem) => problem.includes("4000000")), "and so is the bound it crossed");
  const wide = over({ servedChars: 33_000_000 });
  assert.ok(wide.some((problem) => problem.includes("servedChars")), "the character count is named: " + wide.join("\n"));
  const named = over({ wall: "named", named: 9_000_000_000 });
  assert.ok(named.some((problem) => problem.includes("named")), "and a named window is bounded: " + named.join("\n"));
  const crossed = over({ servedTokens: 4_000_000, servedChars: 400_000 });
  assert.ok(
    crossed.some((problem) => problem.includes("servedTokens") && problem.includes("servedChars")),
    "a token count that outruns the characters it was read from is two different runs: " + crossed.join("\n"),
  );
});

// The exit codes are the workflow's only way to tell "could not ask" from
// "asked, and there was nothing": 1 was both, so an empty listing looked like
// an outage. Run as a program, because the entry point is Bun's.
function runWatchInChild(script, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function watchServer({ listing, catalog }) {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url, "http://127.0.0.1");
      const body = url.pathname.endsWith("/models") ? { data: listing.map((id) => ({ id })) } : catalog;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

test(
  "a route that answered with ids exits 0, and one that answered with none exits 2",
  { skip: needsBun },
  async () => {
    const script = fileURLToPath(new URL("./limits-watch.mjs", import.meta.url));
    const offered = await watchServer({
      listing: ["a-free"],
      catalog: { opencode: { models: { "a-free": { name: "a-free" } } } },
    });
    try {
      const { port } = offered.address();
      const run = await runWatchInChild(script, {
        ZEN_BASE_URL: `http://127.0.0.1:${port}/v1`,
        ZEN_CATALOG_URL: `http://127.0.0.1:${port}/api.json`,
      });
      assert.equal(run.status, 0, `a route that offered an id was reached: ${run.stdout}${run.stderr}`);
      assert.ok(run.stdout.includes("1 free ids offered"), "and the report says what it saw");
    } finally {
      await closeServer(offered);
    }
    // The route answers, and the answer is an empty listing: reached, and
    // nothing to publish. That is exit 2, not the exit 1 of a dead route.
    const empty = await watchServer({ listing: [], catalog: { opencode: { models: {} } } });
    try {
      const { port } = empty.address();
      const run = await runWatchInChild(script, {
        ZEN_BASE_URL: `http://127.0.0.1:${port}/v1`,
        ZEN_CATALOG_URL: `http://127.0.0.1:${port}/api.json`,
      });
      assert.equal(run.status, 2, `a route that offered nothing was still reached: ${run.stdout}${run.stderr}`);
      assert.ok(run.stdout.includes("0 free ids offered"), "and the report says so, rather than reporting an outage");
    } finally {
      await closeServer(empty);
    }
  },
);

// `--status` is the read-only freshness view: it stats the snapshot, validates
// it with `--check`'s rules, and reports what a scheduler would see. Its own
// exits are 0 healthy / 1 unreadable / 2 readable-but-degraded, so the cases
// below pin both the report and the code.
const STATUS_NOW = Date.parse("2026-10-20T12:00:00Z");

test("--status reports a fresh snapshot as healthy, and reads without writing", async () => {
  const { writeSnapshot, statusSnapshot } = await subject;
  const file = join(tmpdir(), `zen-status-${process.pid}-healthy-${Date.now()}.json`);
  try {
    await writeSnapshot({ models: { "a-free": { ...goodRow, tried: "2026-10-20" } } }, file);
    utimesSync(file, new Date(STATUS_NOW), new Date(STATUS_NOW));
    const before = readFileSync(file, "utf8");
    const beforeMtime = statSync(file).mtimeMs;
    const { report, exitCode } = await statusSnapshot(file, { now: STATUS_NOW });
    assert.equal(exitCode, 0, "a readable, valid, fresh snapshot is healthy");
    assert.deepEqual(report.issues, []);
    assert.equal(report.snapshotPath, file);
    assert.equal(report.generatedAt, new Date(STATUS_NOW).toISOString(), "the date is the file's own mtime");
    assert.equal(report.ageSeconds, 0);
    assert.equal(report.staleAfterSeconds, 7200, "the default bound is two hours");
    assert.equal(report.stale, false);
    assert.equal(report.models, 1);
    assert.deepEqual(report.rows, [
      {
        id: "a-free",
        wall: "bracketed",
        at: "2026-10-20",
        tried: "2026-10-20",
        ageDays: 0,
        stale: false,
      },
    ]);
    assert.equal(readFileSync(file, "utf8"), before, "the status run does not rewrite the snapshot");
    assert.equal(statSync(file).mtimeMs, beforeMtime, "and it does not touch the file's mtime");
  } finally {
    rmSync(file, { force: true });
  }
});

test(
  "--status prints one JSON line with --json, and a human summary without it",
  { skip: needsBun },
  async () => {
    const { writeSnapshot } = await subject;
    const file = join(tmpdir(), `zen-status-${process.pid}-cli-${Date.now()}.json`);
    const script = fileURLToPath(new URL("./limits-watch.mjs", import.meta.url));
    const today = new Date().toISOString().slice(0, 10);
    try {
      await writeSnapshot({ models: { "a-free": { ...goodRow, at: today } } }, file);
      utimesSync(file, new Date(), new Date());
      const json = spawnSync(process.execPath, [script, "--status", "--json", file], {
        encoding: "utf8",
        timeout: 60000,
      });
      assert.equal(json.status, 0, `a healthy snapshot exits 0: ${json.stdout}${json.stderr}`);
      const report = JSON.parse(json.stdout);
      assert.equal(report.snapshotPath, file);
      assert.equal(report.stale, false);
      assert.equal(report.models, 1);
      assert.equal(report.rows[0].id, "a-free");
      const human = spawnSync(process.execPath, [script, "--status", file], {
        encoding: "utf8",
        timeout: 60000,
      });
      assert.equal(human.status, 0, `the human mode exits 0 too: ${human.stdout}${human.stderr}`);
      assert.ok(human.stdout.includes("snapshot is healthy"), "the summary says what it found: " + human.stdout);
      assert.ok(human.stdout.includes("a-free"), "and it names the row");
    } finally {
      rmSync(file, { force: true });
    }
  },
);

test(
  "--status calls a snapshot older than the bound stale and exits 2, and honours --stale-after",
  { skip: needsBun },
  async () => {
    const { writeSnapshot } = await subject;
    const file = join(tmpdir(), `zen-status-${process.pid}-stale-${Date.now()}.json`);
    const script = fileURLToPath(new URL("./limits-watch.mjs", import.meta.url));
    // The row this case writes is measured today, computed rather than taken
    // from `goodRow`: the child below reads the real clock, and a date written
    // into the source went stale on 2026-10-28 — the day the 2026-10-20
    // `goodRow` carries crossed the week the row-freshness check allows, and a
    // run that was green the day before failed on a constant. The pinned-clock
    // cases above keep the shared row; this one cannot pin its child's clock,
    // so it names its own day.
    const today = new Date().toISOString().slice(0, 10);
    try {
      await writeSnapshot({ models: { "a-free": { ...goodRow, at: today } } }, file);
      const past = new Date(Date.now() - 180_000);
      utimesSync(file, past, past);
      const run = spawnSync(process.execPath, [script, "--status", "--json", "--stale-after", "60", file], {
        encoding: "utf8",
        timeout: 60000,
      });
      // A run that mistook the bound's value for the file would exit 1 with
      // `snapshot_missing`; 2 with a stale issue is the proof that it did not.
      assert.equal(run.status, 2, `a stale snapshot is readable but degraded: ${run.stdout}${run.stderr}`);
      const report = JSON.parse(run.stdout);
      assert.equal(report.staleAfterSeconds, 60, "the named bound is the one used");
      assert.equal(report.stale, true, "three minutes is older than one");
      assert.ok(report.ageSeconds >= 60, `the age is the file's: ${report.ageSeconds}`);
      assert.ok(
        report.issues.some((issue) => issue.code === "snapshot_stale"),
        "the issue names the staleness: " + JSON.stringify(report.issues),
      );
      // The default bound is two hours, so the same three-minute file is fresh
      // to a run that named nothing.
      const fresh = spawnSync(process.execPath, [script, "--status", "--json", file], {
        encoding: "utf8",
        timeout: 60000,
      });
      assert.equal(fresh.status, 0, `two hours is the default: ${fresh.stdout}${fresh.stderr}`);
      assert.equal(JSON.parse(fresh.stdout).stale, false);
    } finally {
      rmSync(file, { force: true });
    }
  },
);

// `--stale-after` takes a value, and the parser used to step over the token
// after it whether or not that token was a number. `--status --stale-after
// file.json` therefore read the default snapshot and silently reported on a file
// nobody named. A value that is not a whole number of seconds is now left in the
// argument list, where it is read as the positional snapshot: a path that is not
// one fails and says which file was asked for.
test("--status does not eat a snapshot path as an invalid --stale-after value", { skip: needsBun }, () => {
  const script = fileURLToPath(new URL("./limits-watch.mjs", import.meta.url));
  const missing = join(tmpdir(), `zen-status-${process.pid}-positional-${Date.now()}.json`);
  const run = spawnSync(process.execPath, [script, "--status", "--json", "--stale-after", missing], {
    encoding: "utf8",
    timeout: 60000,
  });
  const said = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  assert.equal(run.status, 1, `the file after the flag has to be the one reported on: ${said}`);
  assert.ok(said.includes(missing), `and the report names it: ${said}`);
});

// A path that begins with a number is the same failure the case above pins, and
// `parseInt` read the `2026` out of `2026-10-21.json` and took it as the window.
// The token has to be digits and nothing else. The name is relative because that
// is the shape that puts a number first: a path under a temporary directory
// begins with a `/`, and `parseInt` answers NaN for it — the case above already
// covers that one, and it cannot see this parser rule.
test("--stale-after does not read a number out of a path that begins with one", { skip: needsBun }, () => {
  const script = fileURLToPath(new URL("./limits-watch.mjs", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "zen-status-"));
  const name = "2026-10-21.json";
  try {
    const run = spawnSync(
      process.execPath,
      [script, "--status", "--json", "--stale-after", name],
      { encoding: "utf8", timeout: 60000, cwd: dir },
    );
    const said = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    assert.equal(run.status, 1, `a leading number is not a whole number: ${said}`);
    assert.ok(
      said.includes(name),
      `the run has to report on the file it was handed, not the default one: ${said}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--status exits 1 when the snapshot is missing, and says which file", async () => {
  const { statusSnapshot } = await subject;
  const missing = join(tmpdir(), `zen-status-${process.pid}-missing-${Date.now()}.json`);
  const { report, exitCode } = await statusSnapshot(missing);
  assert.equal(exitCode, 1, "a file that is not there is not a degraded snapshot");
  assert.equal(report.generatedAt, null);
  assert.equal(report.ageSeconds, null);
  assert.deepEqual(report.rows, []);
  assert.equal(report.models, 0);
  assert.deepEqual(
    report.issues.map((issue) => issue.code),
    ["snapshot_missing"],
    "and the report names what is missing",
  );
  assert.ok(report.issues[0].message.includes(missing), "with the path a reader needs: " + report.issues[0].message);
});

test("--status exits 1 when the file is not JSON", async () => {
  const { statusSnapshot } = await subject;
  const file = join(tmpdir(), `zen-status-${process.pid}-invalid-${Date.now()}.json`);
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, "not json at all", "utf8");
    utimesSync(file, new Date(STATUS_NOW), new Date(STATUS_NOW));
    const notJson = await statusSnapshot(file, { now: STATUS_NOW });
    assert.equal(notJson.exitCode, 1, "one unreadable answer and one malformed answer are both exit 1");
    assert.deepEqual(notJson.report.issues.map((issue) => issue.code), ["snapshot_not_json"]);
  } finally {
    rmSync(file, { force: true });
  }
});

test("--status reports an invalid snapshot with issues and exit 2", async () => {
  const { writeSnapshot, statusSnapshot } = await subject;
  const file = join(tmpdir(), `zen-status-${process.pid}-bad-${Date.now()}.json`);
  try {
    await writeSnapshot({ models: { "a-free": { ...goodRow, wall: "bracketedt" } } }, file);
    utimesSync(file, new Date(STATUS_NOW), new Date(STATUS_NOW));
    const { report, exitCode } = await statusSnapshot(file, { now: STATUS_NOW });
    assert.equal(exitCode, 2, "readable but wrong is degraded, not unreadable");
    assert.ok(
      report.issues.some((issue) => issue.code === "snapshot_invalid" && issue.message.includes("bracketedt")),
      "the row's wall is quoted: " + JSON.stringify(report.issues),
    );
    assert.equal(report.models, 1, "the report still says how many rows the file holds");
    assert.equal(report.rows[0].wall, "bracketedt", "and surfaces the label it found");
    // An empty snapshot is readable and valid, and still degraded: it measures
    // nothing, which is the one thing a snapshot exists to do.
    await writeSnapshot({ models: {} }, file);
    utimesSync(file, new Date(STATUS_NOW), new Date(STATUS_NOW));
    const empty = await statusSnapshot(file, { now: STATUS_NOW });
    assert.equal(empty.exitCode, 2);
    assert.equal(empty.report.models, 0);
    assert.deepEqual(empty.report.rows, []);
    assert.deepEqual(empty.report.issues.map((issue) => issue.code), ["no_measurements"]);
  } finally {
    rmSync(file, { force: true });
  }
});

test("--status surfaces an unavailable row, tolerates a malformed day, and only calls a recent one an outage", async () => {
  const { writeSnapshot, statusSnapshot } = await subject;
  const file = join(tmpdir(), `zen-status-${process.pid}-unavailable-${Date.now()}.json`);
  const write = async (row) => {
    await writeSnapshot({ models: { "a-free": row } }, file);
    utimesSync(file, new Date(STATUS_NOW), new Date(STATUS_NOW));
    return statusSnapshot(file, { now: STATUS_NOW });
  };
  try {
    const recent = await write({ ...goodRow, unavailable: "2026-10-19" });
    assert.equal(recent.exitCode, 2, "a recent unavailable day is degraded");
    assert.equal(recent.report.rows[0].unavailableAt, "2026-10-19", "the field is surfaced under its report name");
    assert.ok(
      recent.report.issues.some((issue) => issue.code === "model_unavailable" && issue.message.includes("2026-10-19")),
      "and the report says the route refused it as gone: " + JSON.stringify(recent.report.issues),
    );
    // A hand-edited row is not a reason to throw, but a value that is not a day
    // is now a validation problem: the row says it is unavailable on a day that
    // does not exist, so the snapshot is invalid even though the report still
    // runs and does not read the value as an outage.
    const malformed = await write({ ...goodRow, unavailable: "not-a-day" });
    assert.equal(malformed.exitCode, 2, "a liveness day that is not a day is refused by the check");
    assert.equal(malformed.report.rows[0].unavailableAt, undefined);
    assert.ok(
      malformed.report.issues.some(
        (issue) => issue.code === "snapshot_invalid" && issue.message.includes("unavailable"),
      ),
      "the problem names the field: " + JSON.stringify(malformed.report.issues),
    );
    assert.ok(
      !malformed.report.issues.some((issue) => issue.code === "model_unavailable"),
      "and a value nobody can read is not an outage",
    );
    // An old day is history: it is still surfaced, but it does not claim the
    // model is unavailable now.
    const old = await write({ ...goodRow, unavailable: "2026-01-01" });
    assert.equal(old.exitCode, 0, "an answer from last winter is not a current outage");
    assert.equal(old.report.rows[0].unavailableAt, "2026-01-01");
    assert.deepEqual(old.report.issues, []);
  } finally {
    rmSync(file, { force: true });
  }
});

test("--status marks a measurement older than the watcher's week, and a later attempt resets it", async () => {
  const { writeSnapshot, statusSnapshot } = await subject;
  const file = join(tmpdir(), `zen-status-${process.pid}-row-age-${Date.now()}.json`);
  const write = async (row) => {
    await writeSnapshot({ models: { "a-free": row } }, file);
    utimesSync(file, new Date(STATUS_NOW), new Date(STATUS_NOW));
    return statusSnapshot(file, { now: STATUS_NOW });
  };
  try {
    const old = await write({ ...goodRow, at: "2026-10-01" });
    assert.equal(old.exitCode, 2, "a measurement older than a week is degraded");
    assert.equal(old.report.rows[0].ageDays, 19);
    assert.equal(old.report.rows[0].stale, true);
    assert.ok(
      old.report.issues.some((issue) => issue.code === "row_stale"),
      "the issue names the row: " + JSON.stringify(old.report.issues),
    );
    // `tried` is when the id was last asked about and learned nothing, and it is
    // the later of the two days the age is counted from — the same rule the
    // suspicion bound uses.
    const retried = await write({ ...goodRow, at: "2026-10-01", tried: "2026-10-19" });
    assert.equal(retried.exitCode, 0, "an attempt a day ago is not a stale measurement");
    assert.equal(retried.report.rows[0].ageDays, 1);
    assert.equal(retried.report.rows[0].stale, false);
  } finally {
    rmSync(file, { force: true });
  }
});

// The snapshot's second half is liveness: when every answer of a run said the
// model itself is gone, the row keeps the day it was said, beside the day the
// id was last asked about. It is an observation and never a switch — the tests
// below assert the row and the report, and nothing here hides a model.
test("an unavailable result dates the existing row with tried and unavailable, and says why", async () => {
  const { watch } = await subject;
  const lines = [];
  const state = await watch({
    at: "2026-10-20",
    sweep: true,
    log: (line) => lines.push(line),
    fetchJSON: catalogued(["small-free"], { "small-free": 262_144 }),
    read: measuredWith({ "small-free": { servedTokens: 100_000, at: "2026-10-13" } }),
    sweepModels: async () => [
      {
        model: "small-free",
        servedTokens: null,
        servedChars: null,
        refusedChars: null,
        refusedSizes: [],
        wall: "openEnded",
        says: [],
        unavailable: true,
        unavailableSays: '{"error":{"message":"model small-free not found"}}',
      },
    ],
  });
  assert.deepEqual(state.unlearned, ["small-free"], "the run still learned no measurement");
  const row = state.snapshot.models["small-free"];
  assert.equal(row.at, "2026-10-13", "the measurement's own day is not rewritten");
  assert.equal(row.servedTokens, 100_000, "and the measurement stands");
  assert.equal(row.tried, "2026-10-20", "the attempt is dated, so the week starts again");
  assert.equal(row.unavailable, "2026-10-20", "and the route's own answer is dated beside it");
  const said = lines.join("\n");
  assert.ok(
    said.includes('unavailable: small-free — {"error":{"message":"model small-free not found"}}'),
    "the report repeats the sentence the route used: " + said,
  );
});

test("a transient unlearned attempt dates the row but does not call the model unavailable", async () => {
  const { watch } = await subject;
  const lines = [];
  const state = await watch({
    at: "2026-10-20",
    sweep: true,
    log: (line) => lines.push(line),
    fetchJSON: catalogued(["small-free"], { "small-free": 262_144 }),
    read: measuredWith({ "small-free": { servedTokens: 100_000, at: "2026-10-13" } }),
    sweepModels: async () => [
      {
        model: "small-free",
        servedTokens: null,
        servedChars: null,
        refusedChars: null,
        refusedSizes: [],
        wall: "openEnded",
        says: [],
        // A 429/timeout run has no `unavailable` key at all; the sweep only adds
        // it when every answer named the model as gone.
      },
    ],
  });
  const row = state.snapshot.models["small-free"];
  assert.equal(row.tried, "2026-10-20", "the attempt still moves the age bound");
  assert.ok(!Object.hasOwn(row, "unavailable"), "a bad hour does not mark a model unavailable");
  assert.ok(!lines.join("\n").includes("unavailable:"), "and the report does not claim it did");
});

test("an unavailable new id gets no measurement row, and is said", async () => {
  const { watch } = await subject;
  const lines = [];
  const state = await watch({
    sweep: true,
    log: (line) => lines.push(line),
    fetchJSON: route(["fresh-free"]),
    read: async () => ({ models: {} }),
    sweepModels: async () => [
      {
        model: "fresh-free",
        servedTokens: null,
        servedChars: null,
        refusedChars: null,
        refusedSizes: [],
        wall: "openEnded",
        says: [],
        unavailable: true,
        unavailableSays: "model has been retired",
      },
    ],
  });
  assert.deepEqual(state.added, ["fresh-free"], "the id was never measured");
  assert.ok(!Object.hasOwn(state.snapshot.models, "fresh-free"), "and no measurement is invented for it");
  assert.ok(
    lines.join("\n").includes("unavailable: fresh-free — model has been retired"),
    "but the report says the route called it gone: " + lines.join("\n"),
  );
});

test("a later measurement clears the unavailable day", async () => {
  const { watch } = await subject;
  const state = await watch({
    at: "2026-10-20",
    sweep: true,
    all: true,
    fetchJSON: catalogued(["small-free"], { "small-free": 262_144 }),
    read: measuredWith({
      "small-free": { servedTokens: 100_000, at: "2026-10-13", tried: "2026-10-18", unavailable: "2026-10-18" },
    }),
    sweepModels: async () => [
      {
        model: "small-free",
        servedTokens: 200_000,
        servedChars: 800_000,
        refusedChars: null,
        refusedSizes: [],
        wall: "openEnded",
        says: [],
      },
    ],
  });
  const row = state.snapshot.models["small-free"];
  assert.equal(row.at, "2026-10-20", "the row is the new measurement");
  assert.equal(row.servedTokens, 200_000);
  assert.ok(!Object.hasOwn(row, "unavailable"), "a model the route answered is not still marked gone");
  assert.ok(!Object.hasOwn(row, "tried"), "and the failed attempt's day goes with the old row");
});

test("--status surfaces the unavailable day the watch wrote", async () => {
  const { watch, writeSnapshot, readSnapshot, statusSnapshot } = await subject;
  const today = new Date().toISOString().slice(0, 10);
  const file = join(tmpdir(), `zen-status-${process.pid}-written-unavailable-${Date.now()}.json`);
  try {
    const state = await watch({
      at: today,
      sweep: true,
      all: true,
      fetchJSON: catalogued(["small-free"], { "small-free": 262_144 }),
      read: measuredWith({ "small-free": { servedTokens: 100_000, at: today } }),
      sweepModels: async () => [
        {
          model: "small-free",
          servedTokens: null,
          servedChars: null,
          refusedChars: null,
          refusedSizes: [],
          wall: "openEnded",
          says: [],
          unavailable: true,
          unavailableSays: "model not found",
        },
      ],
    });
    await writeSnapshot(state.snapshot, file);
    const read = await readSnapshot(file);
    assert.equal(read.models["small-free"].unavailable, today, "a reader passes the liveness day through");
    const { report, exitCode } = await statusSnapshot(file, { now: Date.now() });
    assert.equal(exitCode, 2, "the status view degrades on an unavailable model");
    assert.equal(report.rows[0].unavailableAt, today, "and surfaces the day under its report name");
    assert.ok(
      report.issues.some((issue) => issue.code === "model_unavailable"),
      "with the issue that says the route called it gone: " + JSON.stringify(report.issues),
    );
  } finally {
    rmSync(file, { force: true });
  }
});
