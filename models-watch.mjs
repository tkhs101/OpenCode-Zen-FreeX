#!/usr/bin/env bun
// The protocol table's own survey, beside limits-watch.mjs for the walls it keeps.
//
// The runtime layer of the snapshot lives in catalog.mjs: what a request asks at
// when the docs cannot be reached is what this file recorded last. What it
// records is derived data, not a measurement — the docs table is published
// upstream and already reviewed there, and the pipeline that turns it into
// models-observed.json is the same parse models.mjs runs against the same page
// on every discovery. That is why this survey costs nothing the walls sweep
// pays: it reads one markdown page, and no Zen credential is spent on it.
//
// Modes:
//   models-watch.mjs                 — what the snapshot says now (status)
//   models-watch.mjs --check         — validate the snapshot file only (no network)
//   models-watch.mjs --sweep         — read the live docs, print what moved
//   models-watch.mjs --sweep --write — and write the snapshot when it moved
//
// Exit codes, the convention the walls survey uses:
//   0 — asked (or no ask needed) and the answer is something this build reads
//   1 — could not ask (a fetch that failed, an unreadable file)
//   2 — asked and the answer is unusable (the parser's own note is printed)
//
// Nothing here ships in the package: like limits-watch.mjs this is a checkout
// tool, and `package.json` gates its npm script on the file's presence.

import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseModelsSnapshotDocument } from "./catalog.mjs";
import { DOCS } from "./provider.mjs";
import { parseProtocolDocsReport } from "./models.mjs";

const SNAPSHOT_VERSION = 1;
const DEFAULT_DOCS = DOCS;

// The name of the file under this repository, from where this tool runs: the
// snapshot is a checked-in artifact, and a path that moved with the working
// directory would commit it somewhere else.
const snapshotPath = (explicit) => resolve(explicit ?? "models-observed.json");

async function readSnapshotFile(path) {
  try {
    const file = await open(path, "r");
    const text = await file.readFile("utf8");
    await file.close();
    const document = JSON.parse(text);
    if (document?.version !== SNAPSHOT_VERSION)
      return { text, document, note: `the file names version ${JSON.stringify(document?.version)}, and this tool writes ${SNAPSHOT_VERSION}` };
    return { text, document, note: undefined };
  } catch (error) {
    return { text: undefined, document: undefined, note: error.message };
  }
}

function describe(protocols) {
  const ids = Object.keys(protocols ?? {});
  const byProtocol = {};
  for (const id of ids) byProtocol[protocols[id]] = (byProtocol[protocols[id]] ?? 0) + 1;
  const summary = Object.entries(byProtocol)
    .map(([protocol, count]) => `${count} ${protocol}`)
    .join(", ");
  return ids.length ? `${ids.length} rows (${summary})` : "no rows";
}

function diff(current, next) {
  const before = current?.protocols ?? {};
  const after = next.protocols ?? {};
  const added = [];
  const removed = [];
  const changed = [];
  for (const [id, protocol] of Object.entries(after)) {
    if (!(id in before)) added.push(id);
    else if (before[id] !== protocol) changed.push(`${id}: ${before[id]} → ${protocol}`);
  }
  for (const id of Object.keys(before)) if (!(id in after)) removed.push(id);
  return { added, removed, changed };
}

// One write: a temporary file beside the target, then a rename over it. The
// same shape the runtime's own cache writes use, so a reader that starts while
// this runs never sees half a document.
async function writeSnapshot(path, document) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    const file = await open(temporary, "w", 0o600);
    await file.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
    await file.close();
    await rename(temporary, path);
  } catch (error) {
    try {
      await rm(temporary, { force: true });
    } catch {
      // The write already failed; the temp is best effort.
    }
    throw error;
  }
}

async function fetchDocs(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    headers: { accept: "text/plain" },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.text();
}

function usage() {
  console.log(`usage: bun models-watch.mjs [--check | --sweep [--write] [--docs=<url>] [--out=<path>]]

  (no flags)            what models-observed.json says now
  --check               validate the file against the parser the runtime reads it with
  --sweep               read the live docs table and report what moved
  --write               with --sweep: write the file when it changed
  --docs=<url>          with --sweep: override the docs page (default: OpenCode's models.mdx)
  --out=<path>          the snapshot's path (default: ./models-observed.json)`);
}

const args = process.argv.slice(2);
const flags = args.filter((arg) => arg.startsWith("--"));
const positional = args.filter((arg) => !arg.startsWith("--"));
if (positional.length || flags.some((flag) => flag === "--help" || flag === "-h")) {
  usage();
  process.exit(positional.length ? 1 : 0);
}
const path = snapshotPath(flags.find((flag) => flag.startsWith("--out="))?.slice(6) ?? undefined);
const docsURL = flags.find((flag) => flag.startsWith("--docs="))?.slice(7) ?? DEFAULT_DOCS;
const wantsCheck = flags.includes("--check");
const wantsSweep = flags.includes("--sweep");
const wantsWrite = flags.includes("--write");

// ---- --check ----------------------------------------------------------------
// The preflight the scheduled workflow runs before it reaches the network: a
// snapshot this build cannot parse is a repository fault, and it must fail here
// rather than disappear into a survey's "the docs could not be asked".
if (wantsCheck) {
  const { document, note } = await readSnapshotFile(path);
  if (note !== undefined) {
    console.error(`models-observed.json is unreadable: ${note} (path: ${path})`);
    process.exit(1);
  }
  const reparse = parseModelsSnapshotDocument(JSON.stringify(document));
  if (!reparse) {
    console.error(
      "models-observed.json is not a document this build reads (version, shape, or no whole row); the rules are the ones catalog.mjs parses by",
    );
    process.exit(2);
  }
  console.log(`models-observed.json reads whole: ${describe(reparse)}`);
  process.exit(0);
}

// ---- status -----------------------------------------------------------------
if (!wantsSweep) {
  const { document, note } = await readSnapshotFile(path);
  if (note !== undefined) {
    console.log(`models-observed.json: unreadable (${note}); the runtime answers from its bundled table`);
    process.exit(1);
  }
  console.log(`models-observed.json: ${describe(document?.protocols)}`);
  console.log(`listed: ${document?.listedAt ?? "(no date in the file)"}`);
  process.exit(0);
}

// ---- --sweep ----------------------------------------------------------------
// The live read. Same parser, same rules: the survey writes what the runtime
// would have answered from had this page failed while it was being asked, so
// the two ends of the convention cannot drift apart on a parse.
let report;
try {
  report = parseProtocolDocsReport(await fetchDocs(docsURL));
} catch (error) {
  console.error(`the docs page could not be read: ${error.message}`);
  process.exit(1);
}
if (report.note) console.error(`note: ${report.note}`);
if (Object.keys(report.protocols).length === 0) {
  console.error(`the docs page named nothing this plugin asks (rows: ${report.rows}, matched: ${report.matched}); nothing written. Read the note above.`);
  process.exit(2);
}

const next = {
  version: SNAPSHOT_VERSION,
  listedAt: new Date().toISOString(),
  protocols: report.protocols,
};
const { document: current, note: currentNote } = await readSnapshotFile(path);
if (currentNote !== undefined) {
  console.log(`the snapshot on disk is not a readable one (${currentNote}); the sweep's answer replaces it.`);
}
const moved = diff(current, next);
const quiet =
  moved.added.length === 0 && moved.removed.length === 0 && moved.changed.length === 0;

console.log(`the live docs say: ${describe(next.protocols)}`);
if (quiet && currentNote === undefined) {
  console.log("nothing has moved; the snapshot on disk already says this.");
  if (!wantsWrite) process.exit(0);
  // The bytes can still be wanted: a hand edit that lost a row is repaired by
  // re-writing the full document, and --write is the request to do it.
  await writeSnapshot(path, next);
  console.log(`rewritten: ${path}`);
  process.exit(0);
}
if (moved.added.length) console.log(`  + ${moved.added.join(", ")}`);
if (moved.removed.length) console.log(`  - ${moved.removed.join(", ")}`);
for (const line of moved.changed) console.log(`  ~ ${line}`);
if (!wantsWrite) {
  console.log("no --write: the file is left as it is.");
  process.exit(quiet ? 0 : 3);
}
await writeSnapshot(path, next);
console.log(`written: ${path}`);
const recheck = parseModelsSnapshotDocument(JSON.stringify(next));
if (!recheck) {
  // Unreachable given the parse above, and guarded anyway: a survey that wrote
  // a document its own runtime refuses must say so rather than exit green.
  console.error("the written snapshot does not re-read whole — this is a bug in this tool, not in the docs");
  process.exit(2);
}
process.exit(0);
