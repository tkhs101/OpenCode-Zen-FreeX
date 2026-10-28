#!/usr/bin/env bun
// The release watcher, beside models-watch.mjs for the protocol table.
//
// The plugin presents itself as a captured OpenCode: fingerprint.json names the
// version each generation was taken from, and the Zen free tier wants a request
// that agrees with a whole generation — the prompt, the tools and the headers
// were all captured together and move together. When OpenCode ships a new
// release, the captured floor does not move until somebody notices it and runs
// the loop (`bun run check:gate`, then `bun run capture` if the floor answers
// nothing). What this watcher buys is the noticing.
//
// Unlike autoupdating the User-Agent — which zen-proxy does, and which this
// deliberately does not do — nothing here rewrites a fingerprint or a header by
// itself: a version string that moved without its prompt and its tools is the
// one request shape Zen reads as incoherent (see MAINTAINING.md's "The gate is
// a generation"). The watcher answers with a fact and lets the loop run.
//
// It asks the releases feeds for OpenCode's repo and compares them against the
// profiles. Nothing else is read, and nothing but the versions leaves this file.
//
// Exit codes:
//   0 — the newest release is not newer than what is captured
//   2 — the newest release IS newer than what is captured (asked; finding)
//   1 — could not ask (a fetch or a parse that failed, a repo that names none)

import { readFileSync } from "node:fs";

const REPO = "anomalyco/opencode";
const RELEASES = `https://api.github.com/repos/${REPO}/releases?per_page=10`;

const fingerprint = JSON.parse(readFileSync("fingerprint.json", "utf8"));

function versionOfTag(tag) {
  const match = /^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(String(tag ?? "").trim());
  return match?.[1];
}

// Versions are compared as release ordering, not semver semantics: what the
// answer is for is "is this one newer than the capture", and a full semver
// implementation would take a stance on things the fingerprint does not name.
// The first three numbers are the order; a prerelease suffix at an equal core
// is the OLDER one (semver agrees), and two suffixes at an equal core compare
// as strings, where being right matters less than being stable.
function versionKey(version) {
  const [core, rest = ""] = String(version).split(/[-+]/);
  const [major, minor, patch] = core.split(".").map((part) => Number(part) || 0);
  return [major, minor, patch, rest];
}

function isNewer(candidate, captured) {
  if (!candidate) return false;
  if (candidate === captured) return false;
  const a = versionKey(candidate);
  const b = versionKey(captured ?? "0.0.0");
  if (a[0] !== b[0]) return a[0] > b[0];
  if (a[1] !== b[1]) return a[1] > b[1];
  if (a[2] !== b[2]) return a[2] > b[2];
  if (a[3] && !b[3]) return false;
  if (!a[3] && b[3]) return true;
  return a[3] > b[3];
}

// The Repo's releases, fingerprint profiles compared below. The 1.x generation
// is not watched: the free tier retired that lane on 2026-10-25 and a retired
// lane cannot move again, so its captured version is history rather than a
// floor, and reporting it as one is noise forever.
const RETIRED_GENERATIONS = new Set(["1.x"]);

const releases = await fetch(RELEASES, {
  headers: { accept: "application/vnd.github+json" },
})
  .then((response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status} from the releases feed`);
    return response.json();
  })
  .catch((error) => {
    console.error(`could not read ${REPO}'s releases: ${error.message}`);
    process.exit(1);
  });

const shipped = Object.entries(fingerprint.profiles ?? {})
  .map(([generation, profile]) => ({
    generation,
    version: profile?.agent?.opencode ?? undefined,
  }))
  .filter(
    (entry) =>
      !RETIRED_GENERATIONS.has(entry.generation) && typeof entry.version === "string",
  );

const latest = releases.find((release) => versionOfTag(release.tag_name));
const latestVersion = versionOfTag(latest?.tag_name);
if (!latestVersion) {
  console.error(`${REPO} publishes no release whose tag is a version this file reads`);
  process.exit(1);
}
console.log(`newest release: ${latestVersion}`);
for (const entry of shipped) {
  console.log(`captured ${entry.generation}: ${entry.version}`);
}
const moved = shipped.filter((entry) => isNewer(latestVersion, entry.version));
if (moved.length === 0) {
  console.log("every captured generation is the newest release, or newer than it (a capture may run a dev copy); nothing to do.");
  process.exit(0);
}
for (const entry of moved) {
  console.log(
    `OpenCode ${latestVersion} is newer than the captured ${entry.generation} floor (${entry.version}); the floor may have moved under it.`,
  );
}
console.log(
  [
    "What to do, in the order the loop states it:",
    `  1. bun run check:gate   — does the tier still answer the captured floor?`,
    `  2. bun run capture -- --dry   — when it refuses: what a fresh capture would change (nothing written)`,
    `  3. bun run capture     — after the dry run's differences are read and agreed to`,
    `The prompt and the tools are not captured by these; they are refreshed from the same release (see MAINTAINING.md's "The loop").`,
  ].join("\n"),
);
process.exit(2);
