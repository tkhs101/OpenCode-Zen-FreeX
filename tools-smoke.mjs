// Asks Zen which of the client generations this package still speaks.
//
// The gate moved more than once in a day, and nothing short of asking it says
// so: a stale fingerprint does not look different from a working one until a
// user is refused. This is the check to run before a release, and whenever a
// report comes in that the free tier answers 403.
//
//   bun run check:gate
//
// Each profile is asked twice, because the plugin sends two shapes and Zen
// does not answer them alike:
//
//   floor  the names in `required`, which is what the plugin stands in for a
//          host that is not OpenCode and has none of these tools by name. This
//          is the shape the plugin exists to send, so it is the one that
//          decides the answer.
//   full   every tool the profile carries, which is what a host that is
//          OpenCode itself sends. It is reported for what it says about a
//          wording that has gone stale, and does not decide the exit code.
//
// Asking only the full shape hid a real gap: `read` alone is served and
// everything but `read` is refused, so a Zen that started insisting on another
// name would leave the full shape passing while the shape the plugin actually
// sends was refused.
//
// Every request here is built by the plugin itself: the header names come from
// provider.mjs's outboundHeaders and the tools from the same `required` the
// plugin stands in, so this cannot report on a shape the plugin does not send.
// A copy of the headers is what it used to ask with, and that copy had drifted -
// it was missing `accept` - with nothing failing on it.
//
// Each request is reported as:
//
//   answered   Zen served the request; this shape is current
//   refused    Zen did not recognise this generation (403)
//   superseded Zen wants a newer OpenCode than the one this profile claims (426)
//   failed     Zen answered something other than 403: the request was made, and
//              what came back is not a verdict on the fingerprint
//   malformed  the request could not be built, because a name in `required` has
//              no entry in that profile's `tools`: nothing was asked about the
//              fingerprint, and fingerprint.json is what has to change
//   unreachable the free tier could not be asked at all
//   timed-out  the request was still in flight when the deadline passed: the
//              route did not say no, it did not say anything at all, and that
//              is neither a refusal nor an outage
//
// Exit code is 0 when at least one generation's floor is answered. A generation
// being refused is not a failure while another still works, and `malformed` is
// not an answer either: it is a defect in fingerprint.json, and the gate names
// that instead of sending the reader to the network.

import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { baseFrom } from "./base-url.mjs";
import { PROFILES, agentFor } from "./core-tools.mjs";
import { officialSystemPrompt } from "./official-prompt.mjs";
import { readBoundedText } from "./limits.mjs";
import { opencodeID, outboundHeaders, randomProjectID } from "./provider.mjs";

// How many characters of an error body are read. A refusal is short, and the
// one thing this gate quotes is the sentence inside it, so the budget is the
// same one limits-audit.mjs reads a refusal with. The reader is limits.mjs's
// `readBoundedText`: the deadline, the budget and the release of the rest of
// the body are all its, and limits.mjs imports only node builtins, so nothing
// here closes a cycle.
const READ_BUDGET = 4096;

// The endpoint, from the one place that owns it: a copy here was a second answer
// that drifted the moment the endpoint moved — this gate would probe the old host
// and report `unreachable` while the plugin asked the new one. The trailing
// slashes are stripped because the plugin puts the value through `httpURL`, which
// does the same: `ZEN_BASE_URL=https://…/v1/` must not become `//chat/completions`.
//
// The rule that does that — and that refuses a base which is not an HTTP(S) URL,
// or carries credentials, a query or a fragment — lives in `base-url.mjs`, shared
// with `limits-audit.mjs`. The copy that used to be here trimmed only, so a
// `ftp://…` or `https://user:pass@…` value passed the gate's validation and went
// out as a request; the audit's rule rejected it, and the two tools disagreed
// about the same variable. The rule cannot live in `limits-audit.mjs` any more:
// that file imports `chatRequest` from here, so importing it back would close a
// cycle. `base-url.mjs` is a maintenance module like this one and is not shipped.
//
// Resolved when it is needed rather than at module evaluation. Importing this
// module must not throw on a malformed variable it does not own: `limits-audit`
// and `limits-sweep` import it for `chatRequest`, and one bad environment line
// used to be their failure too. A run still validates it first (see the entry
// block below), so the gate reports the variable instead of a stack trace.
//
// An empty value names no base. `??` reads it as set, so `ZEN_BASE_URL=` — a
// line a profile export leaves behind — made the base the empty string and the
// request the relative URL `/chat/completions`, which `fetch` refuses to parse:
// the catch-all reported `unreachable` and the summary said the free tier could
// not be reached, a fault in the reader's own variable reported as an outage of
// the service. `baseFrom` answers it the same way.
//
// Exported so a test can ask the shared rule through this module and see that
// the gate really reads it, rather than a copy that could drift again.
export function baseURL(value = process.env.ZEN_BASE_URL) {
  return baseFrom(value);
}
// The model the gate probes with. It has to be a model the route still serves,
// and it stopped being one: `space-bunny-free` was retired by the route on
// 2026-10-19 and every request with it is answered 410, so every run of this
// gate said "this says nothing about it" and every CI job that ran it learned
// nothing — a green report that is not a report. The probe model is a piece of
// equipment like any other and it expires; what changed here is that the
// failure is now NAMED rather than being one more line of a run that says
// nothing, so the next expiry is a sentence about the probe and not a silence.
// It expired again: `minimax-m3.1-flash-free` was deprecated on 2026-10-25
// (410 `ModelDeprecated`, the answer itself naming `deepseek-v4.1-flash-free`
// as what to use), so the default is that one now.
//
// An empty value names no model either: `ZEN_CHECK_MODEL=` sent `model: ""`,
// and the route answered that with a 404 the gate reports as `probe-gone` —
// the probe model is gone — when the truth is that the reader's own variable
// was empty. The default is what an unset variable means.
const MODEL =
  process.env.ZEN_CHECK_MODEL === undefined || process.env.ZEN_CHECK_MODEL.trim() === ""
    ? "deepseek-v4.1-flash-free"
    : process.env.ZEN_CHECK_MODEL.trim();

// A session id of the shape OpenCode makes, since that is part of what is asked.
// It is provider.mjs's own `opencodeID` rather than a copy of it: the id is one
// of the things Zen judges, and a second implementation of it is a second thing
// to keep right.
function sessionID() {
  return opencodeID("ses", true);
}

// Zen gives the same sentence whichever part of a request failed to look like
// OpenCode, so it is worth printing: a refusal that arrives with no message at
// all reads as something other than a stale fingerprint.
function says(text) {
  // The first 120 characters of what Zen said, cut when the message runs
  // longer. The original bound required the whole message to fit before it
  // would quote anything, and that yielded to exactly the wrong body: the
  // free tier's `FreeUsageLimitError` (2026-10-28, the day the measuring
  // machine's own quota ran out) says `Free usage limit reached … subscribe
  // to OpenCode Go` in ~140 characters, the regex matched nothing, and the
  // one sentence that named the failure was the one sentence the summary
  // did not show — a bare `HTTP 429` that read as a question about the
  // fingerprint. The closing quote is now optional, and a cut message says
  // so with an ellipsis; a body with no message at all is still the same
  // answer as one with an empty message.
  const match = text.match(/"message"\s*:\s*"([^"]{1,120})([^"]*)"/);
  return match ? `: ${match[1]}${match[2] ? "…" : ""}` : "";
}

// The request a shape is asked with. It is its own function so index.test.mjs
// can hold it against the request the plugin was observed to send, offline, and
// so limits-audit.mjs asks with the same shape this gate does instead of a copy
// of it — a copy is what drifted before (it was missing `accept`).
export function requestFor(generation, profile, names) {
  return chatRequest({ model: MODEL, generation, profile, names, maxTokens: 40 });
}

export function chatRequest({ model, generation, profile, names, maxTokens = 40, messages }) {
  return {
    headers: outboundHeaders({
      session: sessionID(),
      agent: agentFor(generation),
      // A fresh project id per ask: the tier ledgers its free quota per project
      // id and egress together (measured 2026-10-26), and the shared `global`
      // bucket is burned by every freeriding plugin user on popular exits —
      // a gate probing with it reports a wording refusal where the truth is a
      // spent bucket.
      project: randomProjectID(),
      protocol: "chat",
    }),
    body: {
      model,
      messages: messages ?? [
        // The official prompt is part of the shape the tier serves. Measured
        // 2026-10-28: a promptless request — whatever its tools, its ids, its
        // model or its egress (two IPs agreed) — is refused with the same
        // `FreeUsageLimitError` 429 a spent quota earns, while the verbatim
        // replay of a genuine request answers 200 and the same tiny probe
        // carrying only the system message answers 200 too. A probe without
        // the prompt therefore reads as a spent bucket, which is the one
        // wrong thing this gate could tell its reader. The check is new:
        // promptless probes earned verdicts until at least 2026-10-26.
        { role: "system", content: officialSystemPrompt(generation, model) },
        { role: "user", content: "hi" },
      ],
      // A name in `required` that the profile does not carry is a broken
      // fingerprint, not a request to ask Zen with: without this it is sent as
      // `{"type":"function"}`, Zen refuses it as malformed, and the gate blames
      // the wording instead of the file it came from.
      tools: names.map((name) => {
        const tool = profile.tools[name];
        if (!tool) throw new Error(`${generation} has no tool named "${name}" in fingerprint.json`);
        return { type: "function", function: tool };
      }),
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: maxTokens,
    },
  };
}

// A request that could not be built at all: a name in `required` with no entry
// in that profile's `tools`, or a profile that cannot even name its shapes. It
// is reported as a verdict rather than thrown, because one broken profile must
// not silence the report — the other generations still have to be asked, and
// what is wrong with this one is a file rather than a service.
function malformed(generation, shape, error) {
  return { generation, shape, verdict: "malformed", detail: `${shape}: ${error.message}` };
}

// `namesOf` is a function because naming the tools is part of building the
// request, and building it is what the guarded region is for: a profile that
// names a tool it does not carry is this generation+shape's verdict rather than
// a rejection into the fan-out that would leave every other generation unasked.
//
// Exported so tools-smoke.test.mjs can hand it a stubbed `fetch` and pin what it
// does with each answer — in particular that every response body is released —
// without asking Zen. It takes no arguments the caller does not already have, and
// a test that called it would otherwise have to reach the network to see it run.
export async function check(generation, profile, shape, namesOf) {
  let request;
  try {
    request = requestFor(generation, profile, namesOf());
  } catch (error) {
    return malformed(generation, shape, error);
  }
  const { headers, body } = request;
  // Both are built before the transport `try`: a base that will not parse is
  // this file's input being wrong, and a body that will not serialize is a
  // defect in the request. Left inside the `try`, either was caught by the
  // transport's handler and reported as `unreachable` — the one verdict that
  // says the free tier could not be reached at all, about a request that was
  // never sent. From here down, only the transport is caught.
  const endpoint = `${baseURL()}/chat/completions`;
  const payload = JSON.stringify(body);
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: payload,
      signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    // Only the transport is caught here. A timeout, a refused connection and a
    // fault in this file are three different things, and the summary reads
    // `unreachable` as "the free tier could not be reached at all" — so a
    // request that was still in flight when the deadline passed was reported
    // as an outage of the service. The two are told apart here, and the
    // summary knows the difference.
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    return {
      generation,
      shape,
      verdict: timedOut ? "timed-out" : "unreachable",
      detail: error.message,
    };
  }
  // The status is the verdict; the body only ever explains one. Reading it
  // first made a 200 whose body was cut — a reset mid-stream, or the 30s
  // timeout firing while it was still arriving — look like `unreachable`,
  // "the free tier could not be reached at all", for a request Zen had
  // answered. Nothing more is read on the success path either: a body nobody
  // reads is a body nobody has to receive. It is let go of rather than left
  // dangling, the way provider.mjs's readRemote releases the body of a
  // response it does not read: an unread body holds its connection open until
  // the GC gets to it, and a gate that probes one host twice does not need two
  // sockets held for a verdict it already has. A cancel that fails is not a
  // verdict either, so it is swallowed here — and the status is still the
  // answer whatever the release did.
  if (response.ok) {
    await response.body?.cancel().catch(() => {});
    return { generation, shape, verdict: "answered", detail: `as ${headers.get("user-agent")}` };
  }
  // The 426 body is released for the same reason as the answered one, and
  // released here rather than above the `ok` check because the two branches
  // below are the opposite case: they *do* read the body, to quote what Zen
  // said about the fingerprint, and a release hoisted above them would take
  // that away. This branch reads nothing — its detail is the fixed sentence
  // below, since a 426 means Zen wants a newer OpenCode and there is nothing in
  // the body this gate could add — so the body is let go of rather than left
  // for the GC to close.
  if (response.status === 426) {
    await response.body?.cancel().catch(() => {});
    return {
      generation,
      shape,
      verdict: "superseded",
      detail: "Zen wants a newer OpenCode than this profile claims",
    };
  }
  // A body that cannot be read leaves the status standing: a 403 whose body
  // was lost is still a 403, and `says` has nothing to add to it.
  //
  // The read gets its own short deadline. The 30 s above is the request's,
  // and a signal governs the body as well as the request, so a body that
  // arrived after it was aborted: the text fell back to "", and Zen's sentence
  // — the one thing this gate quotes — was lost, leaving a bare `HTTP 403`
  // that reads as a refusal Zen had nothing to say about. limits.mjs's
  // `readBoundedText` carries that deadline, bounds the body and releases the
  // rest of it, and it imports only node builtins, so there is no cycle to
  // close.
  const { text } = await readBoundedText(response, READ_BUDGET).catch(() => ({ text: "" }));
  // Only a 403 is the answer this gate reads: Zen quoting the fingerprint
  // back. A 5xx, a 429 or a 401 says something about the service or the way
  // it was asked, and reading any of them as "the fingerprint is stale" sends
  // the reader to `capture` over a problem capturing cannot fix.
  if (response.status === 403)
    return { generation, shape, verdict: "refused", detail: `HTTP 403${says(text)}` };
  // A probe model the route no longer serves is a fact about the PROBE, and
  // this gate is about the fingerprint. 410 is the route retiring an id, and
  // it names the one thing that changed: the model. 404 is the route not
  // knowing the id it was asked for — or not knowing the path, since a
  // ZEN_BASE_URL that points somewhere the route does not serve answers the
  // same way — so both variables are named there. They are not the fingerprint
  // being stale, and reporting them as "failed" put them in the same column as
  // an outage, which is where a reader stops looking.
  if (response.status === 410)
    return {
      generation,
      shape,
      verdict: "probe-gone",
      detail: `HTTP 410${says(text)} — the probe model is gone; set ZEN_CHECK_MODEL to one the route serves`,
    };
  if (response.status === 404)
    return {
      generation,
      shape,
      verdict: "probe-gone",
      detail: `HTTP 404${says(text)} — no such probe model or path; set ZEN_CHECK_MODEL to one the route serves and check ZEN_BASE_URL`,
    };
  return { generation, shape, verdict: "failed", detail: `HTTP ${response.status}${says(text)}` };
}

// Whether this module is the file that was run rather than one the tests
// import. `import.meta.main` is the direct answer and the one Bun gives, but it
// arrived in Node 22.18 and nothing before that has it — and a gate that cannot
// tell whether it was run is a gate that reports success without asking.
function invokedDirectly() {
  // `typeof` rather than `??`: a runtime without the property throws on the
  // member access itself, where there is nothing to fall back from.
  if (typeof import.meta.main === "boolean") return import.meta.main;
  // The runtime gave no answer, so the paths have to. Both sides are arguments
  // to `isEntryPoint` below, which is where the question is actually decided.
  return isEntryPoint({ argv1: process.argv[1], moduleUrl: import.meta.url });
}

// The codes a host answers with when it cannot make a link at all — no
// privilege for a symlink, a file system without hard links, a Windows that has
// neither — as opposed to an error a fixture made by mistake. Only these may
// become a skip; anything else has to fail, because a case that silently does
// nothing is a case that reports success without checking.
//
// `EINVAL` is not on this list, and it is the one code here that a mistake in
// the fixture can produce. Neither `link` nor `symlink` lists EINVAL among
// its errors — a file system that cannot make links answers ENOSYS, ENOTSUP
// or EPERM — while an invalid argument is exactly what EINVAL means, so the
// code that says "this host cannot do it" is also the code that says "these
// arguments are wrong". Read as unsupported, a fixture that passed the wrong
// arguments would skip instead of failing, and a skipped case is one that
// reports success without checking anything.
//
// `EXDEV` is not on this list either, and it is the more dangerous of the two
// to leave in, because it is the code most likely to arrive from a genuinely
// broken fixture. It means the two paths are on different mounts or volumes —
// a statement about where the fixture put its files, not about what the host
// can do. No host can hard-link across a volume, so a fixture whose two halves
// landed on different drives would be skipped as "this host cannot make links"
// on a host that makes them perfectly well: a broken fixture reporting success
// having checked nothing.
//
// The policy is here, in the module that ships, rather than in a test file
// that checked a copy of itself: the rule used to exist only as a copy inside
// tools-smoke.test.mjs, and the one implementation of the decision in the
// repository — `linked()` in limits-audit.test.mjs — turned EVERY error into a
// skip, the two codes above included. A rule that is asserted against a copy
// proves only that the copy agrees with itself.
//
// Exported so both test files assert the same decision.
export const UNSUPPORTED_LINK_CODES = ["EPERM", "EACCES", "ENOSYS", "ENOTSUP"];

// The error as one of this host's refusals to make a link, or undefined when it
// is anything else — and anything else has to fail the case that hit it.
export function unsupportedError(error) {
  return UNSUPPORTED_LINK_CODES.includes(error?.code) ? error : undefined;
}

/**
 * Whether `moduleUrl` is the file `argv1` named: `true` it was run, `false` it
 * was not, `undefined` that could not be told. Both sides are arguments so
 * tools-smoke.test.mjs can pin the shapes that would otherwise need a second
 * process — a junction, a hard link, an entry that is gone — against the same
 * code a real run takes rather than a copy of it.
 *
 * The invariant this file exists to protect is that no path through it asks
 * nothing and exits 0, which is a gate reporting success without asking. So
 * `false` is only for a *proven* different file, and everything this cannot
 * settle is `undefined`, which prints the message and exits non-zero: an
 * uncertain answer must never be read as "this file was not run".
 */
export function isEntryPoint({ argv1, moduleUrl }) {
  // Nothing was named as a script, so there is no run for this module to be
  // part of: this is `node -e` or a REPL importing it, which is the one case
  // where asking nothing is the right answer.
  if (argv1 === undefined) return false;

  let self;
  let run;
  try {
    self = resolve(fileURLToPath(moduleUrl));
    run = resolve(argv1);
  } catch {
    // A module URL that names nothing on disk (`data:`, an eval), or an entry
    // that is not a path at all: there is nothing to compare.
    return undefined;
  }
  if (self === run) return true;

  // A path is a spelling, and one file has several. `import.meta.url` is already
  // resolved by the loader while `argv[1]` is whatever was typed, so a symlink
  // or a Windows directory junction arrives here as two different strings while
  // this is still the file that was run. Comparing what both point at is what
  // tells a junction from a test import.
  let resolved;
  try {
    resolved = [realpathSync(self), realpathSync(run)];
  } catch {
    // Either path could not be resolved — an entry that is gone, a URL that is
    // not a file — so which file was run is not a question this can answer.
    return undefined;
  }
  if (resolved[0] === resolved[1]) return true;

  // Two names for one file that realpath cannot join: a hard link has no target
  // to resolve, so it stays two paths on disk. File identity is what is left to
  // tell it from a different file, and it is only read when both sides report
  // one: an `ino` of 0 is a filesystem saying it has no identity to give (some
  // FUSE and network mounts), and comparing those would call two different files
  // one file — a `true` that makes an import ask Zen. Where the identity cannot
  // be read at all, the question stays open rather than answered "different
  // file", because after this branch a differing realpath is not proof either.
  const identity = (at) => fileIdentity(statSync(at, { bigint: true }));
  let ids;
  try {
    ids = [identity(self), identity(run)];
  } catch {
    return undefined;
  }
  if (ids[0] === undefined || ids[1] === undefined) return undefined;
  return ids[0] === ids[1];
}

/**
 * The identity of one file from the `stat` that was just read of it: `dev` and
 * `ino` joined, or `undefined` where the file system reports no inode to compare
 * (`ino` of 0 is how FUSE and some network mounts answer). Exported so
 * tools-smoke.test.mjs can pin both readings by calling it with the numbers —
 * `isEntryPoint` takes paths, and a host that reports an inode of 0 for a real
 * file is one this suite cannot conjure on demand, so the rule that decides the
 * hard-link question would otherwise be pinned only where inodes are reported
 * and unchecked everywhere else. That is the wrong way round: `undefined` is the
 * answer that must not be read as "a different file", since reading it that way
 * is a gate that asks nothing and exits 0.
 */
export function fileIdentity(stats) {
  return stats.ino === 0n ? undefined : `${stats.dev}:${stats.ino}`;
}

// What is said when the run/import question has no answer. Exported so a test
// can pin the sentence an importer or a run sees.
export const UNDETERMINED_ENTRY =
  "Could not tell whether this file was run or imported, so nothing was asked: neither import.meta.main nor process.argv[1] named an entry point. Run it with `bun run check:gate`.";

// Only a run asks Zen. index.test.mjs imports this module to hold its request
// against the plugin's, and an import must not reach the network.
//
// An answer this could not settle (`undefined`) is printed and recorded as a
// non-zero exit rather than thrown: this is module evaluation, so a throw here
// kills the importer — `limits-audit.mjs` and `limits-sweep.mjs` both import
// `chatRequest` — before its own code can run. A run that reaches this branch
// still exits non-zero, because `process.exitCode` is the process's answer and
// nothing was asked, so the gate cannot report success. An importer keeps its
// exports; under a runtime that can answer (Bun, Node ≥ 22.18) this branch is
// not reached by an import at all, where `import.meta.main` is `false`.
//
// The one undeterminable case that is not even an import question is a process
// that named no script at all — `node -e`, a REPL. Nothing can be run from here
// then, and the sentence and the exit code would be about a gate the importer
// never asked for.
const entry = invokedDirectly();
const noScriptNamed = process.argv?.[1] === undefined || process.argv?.[1] === "";
if (entry === undefined && !noScriptNamed) {
  console.error(UNDETERMINED_ENTRY);
  process.exitCode = 1;
}

// The one-line summary of a run in which the floor was not served everywhere it
// was asked. `served` is how many floors were answered, `unbuilt` how many could
// not be built, and `unserved` the verdicts of the rest — which are *not* all
// refusals: a floor can come back `unreachable` or `failed`, and calling those
// refused is what pointed the reader at the wording, and at `capture`, over an
// outage. Exported so a test can pin the wording without asking Zen.
//
// A `malformed` verdict belongs to `unbuilt` and nowhere else. A floor whose
// request could not be built was never asked, so it is not one of the verdicts
// to count, and `total` here is the number of floors something was actually
// asked of: a `total` that counted the unasked ones made the one-line summary
// name a single floor twice — `1 not served, 1 never asked of 2` for a run with
// one malformed floor and one answered one — which is two names for one row and
// a denominator that does not add up. The rows still print every floor and say
// which is which; this is the sentence that counts them.
export function refusedSummary({ served, unbuilt = [], unserved = [] }) {
  // The two call sites below used to disagree about which verdicts `unserved`
  // held — one left `malformed` out, the other passed it straight through — so
  // the split is made here, from the rows the caller has, rather than trusted to
  // two places that can drift apart. A caller cannot mis-count a malformed floor
  // into the refusals if the only list that carries verdicts has none in it.
  const verdicts = unserved.filter((verdict) => verdict !== "malformed");
  // Asked floors are the denominator: the ones that came back with a verdict and
  // the ones that could not be built. Anything else was never asked, and asking
  // nothing is not a way to be not served.
  const total = served + verdicts.length + unbuilt.length;
  if (!served) {
    // Being unable to ask is not an answer. Saying the fingerprint has gone stale
    // when nothing was reached sends the reader to `capture` over a dead network.
    // Only 403 and 426 are Zen answering about the fingerprint at all: a 5xx or a
    // 429 was answered by something that never judged it, and counting those as a
    // verdict would blame the wording for an outage.
    //
    // Only the floor decides the exit code, so only the floor is read here: the
    // `full` shape is reported, not asked on behalf of the plugin, and letting a
    // stray 5xx on one turn a clean all-refused run into "check the network"
    // points the reader at an outage the deciding shape never reported.
    const fingerprint = (verdict) => verdict === "refused" || verdict === "superseded";
    if (unbuilt.length) {
      // A request that could not be built was never asked, so nothing about the
      // network applies to it: the name in `required` with no tool behind it is
      // in fingerprint.json, and so is the fix.
      return `${unbuilt.length}/${total} floor requests were never asked: a name in \`required\` has no entry in that profile's \`tools\`, and the malformed lines above name them. Fix fingerprint.json before reading anything else here — a request that could not be built is not a network problem.`;
    }
    // A probe model the route no longer serves is said so FIRST, because it is
    // the one verdict that makes every other verdict in this run meaningless:
    // the run asked a model that is gone, so nothing it learned was about the
    // fingerprint. `space-bunny-free` was retired on 2026-10-19 and every run
    // since then ended here — with a green CI job and a report that said the
    // service should be checked, when what needed changing was one line of
    // configuration.
    if (verdicts.includes("probe-gone")) {
      return "None of them, and not about the fingerprint: the model this gate probes with is no longer served, so nothing in this run was an answer about the wording. Set ZEN_CHECK_MODEL to a model the route serves and ask again.";
    }
    if (verdicts.every(fingerprint)) {
      return "None of them. Zen has moved past every generation this plugin knows; the tool wording in fingerprint.json needs capturing again from a current OpenCode.";
    }
    if (verdicts.some(fingerprint)) {
      return "Some of the floor requests were answered about the fingerprint and some were not, which is not a fact about the fingerprint either way. Check the network or ZEN_BASE_URL and ask again.";
    }
    // A timeout is neither an answer nor an outage. The request was still in
    // flight when the deadline passed, so the route did not say no about the
    // wording and it did not say nothing because it could not be reached — it
    // did not answer at all. Saying the free tier "could not be reached at
    // all" about that sends the reader to the network for a request that was
    // still in flight, and saying Zen answered every floor request says
    // something the run does not know.
    if (verdicts.includes("timed-out")) {
      return "The free tier did not answer before this gate's deadline, so this says nothing about the fingerprint. Ask again, or check the route's load — a request that is still in flight is not a refusal.";
    }
    if (!verdicts.some((verdict) => verdict === "unreachable")) {
      return "Zen answered every floor request, but none of them with a verdict on the fingerprint, so this says nothing about it. Check the service or ZEN_BASE_URL and ask again.";
    }
    return "The free tier could not be reached at all, so this says nothing about the fingerprint. Check the network or ZEN_BASE_URL and ask again.";
  }
  // At least one generation works, so the rest are reported by what they
  // actually were: only the ones Zen refused are called refused. `served` is
  // named so the parts add up to the denominator on the page, and the unasked
  // floors are kept outside it: "of N" is the floors something was asked of, and
  // a request that could not be built is not one of them. Counting it in made a
  // single floor appear on both sides of the sentence.
  //
  // `unbuilt` holds the `malformed` rows, which is how the gate's fan-out builds
  // it: rows off the same `check` that produced every other verdict, so the
  // suite's raw-word rows and the gate's rows are one shape rather than one shape
  // plus an abbreviation only this summary accepts.
  const refused = verdicts.filter((verdict) => verdict === "refused" || verdict === "superseded").length;
  const other = verdicts.length - refused;
  const what = [
    served ? `${served} served` : null,
    refused ? `${refused} refused` : null,
    other ? `${other} not served` : null,
  ]
    .filter(Boolean)
    .join(", ");
  const asked = unbuilt.length ? `${what} of ${total} asked, ` : `${what} of ${total}.`;
  const malformed = unbuilt.length
    ? `${unbuilt.length} never asked: the malformed lines above name what fingerprint.json has to gain before those can be asked.`
    : "";
  // The opening sentence claims every generation this plugin knows is served —
  // "so the plugin still has a generation Zen will serve" — and that is only what
  // the rows said when every floor was asked. A floor that was never asked
  // (`malformed`) or never answered (`unreachable`, `failed`) is a generation
  // nothing is known about: the run still proves the plugin works, because one
  // floor was answered, but it does not prove this plugin will be served in
  // general, and the sentence said it did.
  const proven = served === total;
  return `${
    proven
      ? "At least one generation works, so the plugin still has a generation Zen will serve."
      : "At least one generation was served, so the plugin works for the floor that was answered."
  } ${asked}${malformed}`;
}

if (entry) {
  // Validated before anything is asked. `check` resolves the same base for each
  // request, but by then it is inside a fan-out; here a run can name the
  // variable that is wrong instead of leaving a rejected promise and a stack
  // trace, and no request is built on a base that is not an HTTP(S) URL.
  try {
    baseURL();
  } catch (error) {
    console.error(`\ncheck:gate — unable to ask: ${error?.message ?? error}`);
    console.error("Check ZEN_BASE_URL, then ask again.");
    process.exit(1);
  }
  // Each request is independent and every result is printed in order, so the
  // profiles are asked at once and, within each profile, so are its two shapes:
  // awaiting the floor before its own full pushed that full request back by
  // whatever the floor spent, up to its 30s timeout.
  const results = (
    await Promise.all(
      Object.entries(PROFILES).map(async ([generation, profile]) => {
        // Both are started before either is awaited, and the array keeps the
        // printed order floor then full. `check` reports its own failures, so
        // neither promise can reject out of this fan-out.
        return Promise.all([
          check(generation, profile, "floor", () => [...profile.required]),
          check(generation, profile, "full", () => Object.keys(profile.tools)),
        ]);
      }),
    )
  ).flat();

  const width = Math.max(...results.map((result) => result.generation.length));
  for (const result of results)
    console.log(
      `${result.shape.padEnd(6)}${result.verdict.padEnd(12)} ${result.generation.padEnd(width)}  ${result.detail}`,
    );

  const floor = results.filter((result) => result.shape === "floor");
  const served = floor.filter((result) => result.verdict === "answered");
  // A floor request that could not be built was never asked, so it is not one of
  // the refusals the summary talks about, and it is the one outcome whose fix is
  // in `fingerprint.json` rather than in the network or the wording.
  const unbuilt = floor.filter((result) => result.verdict === "malformed");
  console.log(`\n${served.length}/${floor.length} generations serve a host that is not OpenCode at ${baseURL()}`);

  // A generation whose full shape is served while its floor is not is the case
  // this gate was widened to see: the plugin would work for a host bringing its
  // own OpenCode tools and be refused for the host it was written for. A floor
  // that was never asked says nothing about that, and its own line says why.
  for (const result of floor) {
    if (result.verdict === "answered" || result.verdict === "malformed") continue;
    const full = results.find(
      (other) => other.generation === result.generation && other.shape === "full",
    );
    if (full?.verdict === "answered")
      console.log(
        `${result.generation} answers the full OpenCode shape but not the tools the plugin stands in: a host that has none of them by name will be refused.`,
      );
  }

  if (!served.length) {
    console.log(
      refusedSummary({
        served: 0,
        // No `total`: the summary counts the floors something was asked of from
        // the rows it is handed, so there is no second place for this run to work
        // out a denominator and get it different from the other call site's.
        unbuilt,
        unserved: floor.filter((result) => result.verdict !== "malformed").map((result) => result.verdict),
      }),
    );
    process.exitCode = 1;
  } else if (served.length < floor.length) {
    // Reached when a floor was not answered, which a malformed one is: the exit
    // code is still decided by the served floors alone, so a run whose one
    // working generation answered and whose other floor has a name missing from
    // its `tools` prints this line and no longer calls that floor refused.
    console.log(
      refusedSummary({
        served: served.length,
        unbuilt,
        unserved: floor.filter((result) => result.verdict !== "answered").map((result) => result.verdict),
      }),
    );
  }
}