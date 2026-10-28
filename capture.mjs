// Recaptures fingerprint.json from a real OpenCode.
//
// The free tier reads the wording of the tools it knows by name out of the
// request body and refuses the request when it differs from its own copy. That
// copy moves with OpenCode, so the one held here goes stale — and a stale copy
// looks exactly like a working one until somebody is refused. This is how a new
// one is taken, so that refreshing it is a command and not an archaeology
// exercise.
//
//   bun run capture            # writes fingerprint.json
//   bun run capture -- --dry   # reports what changed, writes nothing
//
// A capture that is missing, or that is there and cannot be read as one, is
// written afresh rather than refused: this is the tool that writes the file,
// and the command every failure in `core-tools.mjs` names is this one, so a
// refusal here would leave the reader with a remedy that refuses in turn.
//
// Needs opencode on PATH (https://opencode.ai) and bun. Nothing goes to Zen: the
// OpenCode under test is pointed at a server running here, and the request it
// makes is the thing being read.
//
// CAPTURE_PORT moves the loopback port, and CAPTURE_TIMEOUT_MS how long the
// child is given before it is ended.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This module does not import `core-tools.mjs`, and that is the whole of why
// the remedy in that module's messages can be run: `core-tools` reads the
// capture at import and throws when it is missing or invalid, so a capture that
// imported it died before its own body ran — on the very file it is here to
// repair. It used to import it, for the profile the comparison was made
// against, and the import was the whole of the failure: `bun run capture` was
// the answer every message in that module gave, and it could not run.
//
// So the capture is read here, from the file that is written, and from nowhere
// else. One source of truth, and it is the file this script owns.

const PORT = numberFromEnv("CAPTURE_PORT", 8791, process.env, 65535);
// Where the capture is written, which is this directory unless something else
// says so: `--fingerprint <path>`, `--fingerprint=<path>` and
// `CAPTURE_FINGERPRINT` exist so a test can point the write at a scratch file,
// since the alternative — importing this module and letting it write the real
// one — is what made it untestable. The flag wins over the environment, and both
// are resolved against the working directory the way a path on a command line
// usually is. Exported, with the argv and environment it reads as parameters, so
// the one decision that can send a write somewhere unexpected is a test's to pin
// rather than a reader's to trust.
//
// The directory comes from the module's own URL and not from `import.meta.dir`,
// which is Bun's own: under Node it is `undefined`, and `join(undefined, ...)`
// throws while this module is still being evaluated — so a Node could not
// import it at all, and the `import.meta.main` fallback below (the one that
// exists for the Node older than 22.18) could never be reached.
const HERE = fileURLToPath(new URL(".", import.meta.url));
const FINGERPRINT = resolve(fingerprintTarget());
export function fingerprintTarget(argv = process.argv, env = process.env) {
  // Both spellings a command line accepts for an option with a value. Reading
  // only the space-separated one was worse than a missing feature: `=` matched
  // no element, so the flag was ignored and the write landed on the shipped
  // fingerprint.json — the exact outcome the flag exists to prevent, arrived at
  // silently.
  const flag = argv.indexOf("--fingerprint");
  const inline = argv.find((arg) => arg.startsWith("--fingerprint="));
  // A value that is another flag is not a value: `--fingerprint --dry` would
  // otherwise resolve to a file named `--dry`, which reads as a missing path
  // rather than as the typo it is. It is also what an empty `--fingerprint=`
  // names. The default is the safe answer either way, since a mistake must not
  // be the thing that decides where a write goes.
  //
  // The `=` form wins when both are on the command line: it carries its value in
  // the same argument, so it is the one that cannot be confused with the next
  // one, and the precedence is stated here rather than read off a nested
  // conditional.
  let value;
  if (inline !== undefined) value = inline.slice("--fingerprint=".length);
  else if (flag !== -1) value = argv[flag + 1];
  if (value && !value.startsWith("-")) return value;
  // `||` rather than `??` for the environment: an exported-but-empty variable
  // is not a path, and `resolve("")` is the working directory — a write aimed
  // at a directory fails, but a knob that reads as set while naming nothing is
  // worse than one that reads as unset.
  return env.CAPTURE_FINGERPRINT || join(HERE, "fingerprint.json");
}

// A number from the environment that is not a number is a mistake, and a
// mistake must not decide how long the child is given: `NaN` as a timeout
// fires at once, the child is killed before it has made a request, and the run
// then reports "no request was captured" — a mistyped knob reported as an
// OpenCode problem. A port outside the range a port can be in fails the same
// way, inside `Bun.serve`, as an error that says nothing about the variable
// that was wrong.
//
// A fraction is not one of these numbers either: `CAPTURE_PORT=8791.5` passed the
// range check and then failed inside `Bun.serve` as a socket error, and a
// fraction of a millisecond is not a timeout. `Number.isInteger` is the check for
// that, and it also refuses `NaN` and both infinities, so the finite test is not
// repeated beside it.
//
// So the default stands for a value that is not a number, and the variable that
// was refused is named: a knob that reads as set while it was not is worse than
// one that is unset, because the run would answer for the default and the
// reader would be looking at the wrong number.
//
// The environment is a parameter and the maximum a second one, so the rule is
// a test's to pin rather than a reader's to trust — the same reason
// `fingerprintTarget` takes its argv and its environment.
export function numberFromEnv(name, fallback, env = process.env, max = Number.POSITIVE_INFINITY) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    console.error(`${name} is not a number this run can use (${JSON.stringify(raw)}); using ${fallback}`);
    return fallback;
  }
  return value;
}

// The names Zen reads, by generation: 2.x sends `shell` where 1.x sends `bash`
// and carries none of the others. Everything else a host declares is ignored.
const READ = {
  "1.x": ["bash", "glob", "grep", "read", "write", "edit"],
  "2.x": ["shell", "read"],
};

// The ones a request of that generation has to carry, which is a subset of the
// names worth reading: `write` and `edit` are read when they are there and do
// not have to be, so a client that stopped sending them is not a capture to
// refuse. The two lists are literals and cannot check each other, so the loop
// below refuses to run when they disagree about a name.
const REQUIRED = {
  "1.x": ["bash", "glob", "grep", "read"],
  "2.x": ["shell", "read"],
};

// A name that has to be there but is not in READ is a required tool this script
// would never read: the request carries it, `missing` never sees it, and the
// profile written below is short one name Zen reads. The two lists are separate
// literals — one says what is worth reading, the other what has to be — so they
// are held together here rather than by the comment above claiming they agree.
for (const [generation, names] of Object.entries(REQUIRED)) {
  const unread = names.filter((name) => !(READ[generation] ?? []).includes(name));
  if (unread.length)
    throw new Error(
      `capture: REQUIRED["${generation}"] names ${unread.join(", ")}, which READ["${generation}"] does not read`,
    );
}

// The capture host's own shell, scratch directory and OS banner belong to the
// machine the capture ran on, not to the tool. These are put back to something
// neutral so the capture is not tied to one machine.
//
// The shell is the one these can get wrong, and it is worse than untidy: these
// bytes are the description the model reads, so a tool named `bash` described as
// executing PowerShell is a tool the model calls `PowerShell`. Measured
// 2026-10-20 through a local magpie pointed at this tree, `bash` declared with
// this profile's wording: the model answered `PowerShell` and the host answered
// `unknown tool "PowerShell"` — the whole turn lost, and again on the retry,
// because the wording never changes between them. Nine such calls in one
// session (`session-94316913`), each one a turn.
//
// opencode 1.19.0 words that tool after the host it runs on — "Executes a given
// Windows PowerShell (5.1) command…" on one machine, "PowerShell (7+)…" on
// another. The previous rule dropped only the version, on the assumption that a
// Linux capture carries no such clause at all; it does, which is how the
// PowerShell wording came to be shipped as the neutral one. A shell is a
// property of the tool, not of the machine that captured it, so the name is put
// back to the shell this tool actually runs — and the cmdlet advice with it,
// since `Get-ChildItem` is not a command that runs here.
//
// This is the neutral wording, so it is what any host converges to; what it is
// worth is settled by `bun run check:gate`, which answered both shapes of 1.x on
// 2026-10-20 with this wording in place.
const NEUTRALISE = [
  [/Be aware: OS: [^\n]*/g, "Be aware: OS: linux, Shell: bash"],
  [/Use `[^`]*` for temporary work outside the workspace\./g, "Use `/tmp` for temporary work outside the workspace."],
  [/Use `[A-Za-z]:\\[^`]*`/g, "Use `/tmp`"],
  // The sentence that names the shell, with or without a version and with or
  // without the Windows qualifier, in the `bash` and `shell` wordings alike.
  [/\b(?:Windows )?PowerShell(?: \(\d[^)]*\))? command\b/g, "bash command"],
  // The section heading over the shell's own notes.
  [/# (?:Windows )?PowerShell(?: \(\d[^)]*\))? shell notes/g, "# bash shell notes"],
  // The shell notes themselves: the two that only make sense in PowerShell are
  // dropped, and the cmdlet advice becomes the POSIX advice that is true here.
  // Written as whole lines so nothing is left half-rewritten.
  [/^- Prefer full cmdlet names like `Get-ChildItem`, `Set-Content`, `Remove-Item`, and `New-Item` over aliases\.$/gm,
   "- Prefer standard utilities over shell builtins where one exists."],
  [/^- Use `cmd1; if \(\$\?\) \{ cmd2 \}` to chain dependent commands\.\n/gm, ""],
  // "Commands run on Windows using PowerShell" is the 2.x `shell` wording's way
  // of saying the same thing, and the one `Windows` word the old rules missed.
  [/Commands run on Windows using PowerShell(?: \(\d[^)]*\))?\./g, "Commands run in the current shell."],
];
// The rules above, applied. Exported so the one thing they exist to prevent — a
// tool named `bash` whose description says PowerShell, which the model then calls
// as `PowerShell` — is pinned by a test rather than by a live session.
export function neutralise(description) {
  return NEUTRALISE.reduce((text, [find, to]) => text.replace(find, to), description);
}

// Zen compares roughly the first 700 characters and ignores the rest; 1200
// leaves margin, and the tail is where a note to the model goes.
const KEEP = 1200;

// How long the child is given to make its request. `opencode run` can sit on a
// prompt or a stalled connection, and this script would then hold the mock
// server and the temporary config open until somebody noticed: an instrument
// that waits for ever reads as one that is working.
//
// Read through the rule `numberFromEnv` states, so a mistyped value cannot
// decide it: `NaN` as a timeout fires the watchdog at once, which kills the
// child before it has made a request and leaves the run to report "no request
// was captured" — the mistyped knob reported as an OpenCode problem.
const CHILD_TIMEOUT_MS = numberFromEnv("CAPTURE_TIMEOUT_MS", 120_000);

// Whether this module is the file that was run rather than one the tests
// import. `import.meta.main` is the direct answer and the one Bun gives, but it
// arrived in Node 22.18 and nothing before that has it — and a script that
// cannot tell whether it was run is one a test cannot import: this file's
// evaluation path starts a server and rewrites fingerprint.json, so the helpers
// below are only testable behind this guard, and the guard is what keeps an
// import from taking that path. Exported so the guard itself is pinned by a test
// rather than trusted.
//
// What that test can pin is the half below, and it is the half worth pinning:
// this process reports `import.meta.main`, so a case here can only ever watch the
// guard answer `false` for an import — the `true` a run gets is not something an
// importing process can produce, and producing it would start a server. The
// decision itself is therefore a function of the three facts rather than of the
// process, and the facts a real run supplies are the only part left to the
// runtime: the flag where there is one, this module's URL, and argv.
export function invokedDirectly() {
  // `typeof` rather than `??`: a runtime without the property throws on the
  // member access itself, where there is nothing to fall back from.
  const main = typeof import.meta.main === "boolean" ? import.meta.main : undefined;
  return entryDecision({ main, url: import.meta.url, url1: process.argv[1] });
}

/**
 * Whether `url` is the file `url1` named, from the facts alone: `main` is the
 * runtime's own answer when it has one (`import.meta.main`), `url` where the
 * module was loaded from, and `url1` the script path the runtime was handed.
 *
 * The three are parameters for the same reason `tools-smoke.mjs`'s
 * `isEntryPoint` and `limits-audit.mjs`'s `entryVerdict` take theirs: the answer
 * that matters most here — `true`, this module is the file that was run — is the
 * one an importing process cannot produce without running the entry point, and
 * the branch that produces it is the one every Node older than 22.18 takes,
 * where there is no flag to read. Passed in, both halves are pinned by a test
 * that is merely importing; read off the process, one of them never runs here.
 *
 * `false` rather than `undefined` for a question that cannot be answered is what
 * this guard has always done, and it is the right way round for this file: the
 * entry block below reads the answer as a boolean, so `undefined` would fall
 * through it and a run would quietly do nothing. Where the fallback cannot
 * compare — nothing named as a script, a module URL that is not a file — the
 * file was still not shown to be the one that was run.
 */
export function entryDecision({ main, url, url1 }) {
  // A runtime that offers the flag has answered the question, and its answer is
  // the one to use: nothing else is consulted, so a path comparison cannot
  // override a `false` that means this module really was imported.
  if (typeof main === "boolean") return main;
  // Nothing was named as a script — `node -e`, a REPL, a worker — so there is no
  // run for this module to be part of. The empty string is the same nothing.
  if (!url1) return false;
  let here;
  try {
    here = resolve(fileURLToPath(url));
  } catch {
    // Not a `file:` URL — a `data:`, an eval, a loader's virtual module — so
    // there is no path for `url1` to be equal to, and throwing here would take
    // the import of this module down with it.
    return false;
  }
  // Both sides are resolved, because one file answers to several spellings: the
  // loader resolves what it reports while `argv[1]` is whatever was typed, so a
  // relative path or a trailing separator is the same file and a raw string
  // comparison would call it a different one.
  return here === resolve(url1);
}

// The signal handlers are stored so the exit path can take them off again: a
// `process.once` that has already fired is gone, but one that has not would
// swallow a Ctrl-C pressed while the capture is being compared and written
// (settling an already settled promise is a no-op). The kill is the part that
// has to happen while the child is alive; after that the default handler is the
// one that should end the script.

// Run `opencode` against the local server and bring back what it sent, plus
// whether the run itself was a clean exit. `start` is a parameter so the tests
// can hand this a child they drive by hand and pin the one property that makes
// the exit code trustworthy: a child a signal killed exits with a null code,
// and that is a failure of the run rather than the 0 `value ?? 0` used to
// report — a killed run then went on to compare and rewrite fingerprint.json.
export async function capture(intro, start) {
  console.log(intro);
  // A signal is not an exit code: a child killed by the watchdog (SIGKILL) or
  // by a Ctrl-C leaves `value` null, and reading that as 0 is what let an
  // interrupted run reach the write below. One answer for the signals and the
  // error path both.
  return await new Promise((done) => {
    let ran = true;
    const child = start();
    const timer = setTimeout(() => {
      console.error(`opencode did not finish within ${CHILD_TIMEOUT_MS} ms; ending it`);
      child.kill("SIGKILL");
    }, CHILD_TIMEOUT_MS);
    // What both endings have to do before they settle the promise: nothing else
    // is going to fire for this child, so the watchdog would later log an ending
    // for a run that already ended, and a `process.once` left armed swallows one
    // Ctrl-C. A spawn failure (`error`, ENOENT) ends here too — the path the
    // shipped script only survived because it happens to exit soon after.
    const settle = (code) => {
      clearTimeout(timer);
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
      done({ code, ran });
    };
    // Ctrl-C has to take the child with it: nothing else would end it, and the
    // next run would find the port still held. It is also a failed run — the
    // request may never have been made — so it must not walk into the compare
    // and write path the way an exit-0 does.
    const interrupted = (signal) => () => {
      ran = false;
      child.kill(signal);
      settle(1);
    };
    const onInterrupt = interrupted("SIGINT");
    const onTerminate = interrupted("SIGTERM");
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
    child.on("error", () => {
      console.error("could not run opencode; install it from https://opencode.ai and put it on PATH");
      ran = false;
      settle(1);
    });
    child.on("exit", (value, signal) => {
      if (signal) ran = false;
      settle(signal ? 1 : (value ?? 0));
    });
  });
}

// The comparison and the write, after a run worth reading. Split out so a test
// can drive it with a captured request instead of a real `opencode` — and with a
// scratch `fingerprint` rather than the shipped one, so pinning the write path
// cannot rewrite the file this repository keeps. `dry` is read here rather than
// at module load for the same reason: a test has to be able to ask for the dry
// report without a second process.
export function report({ request, code, fingerprint = FINGERPRINT, dry = process.argv.includes("--dry") }) {
  let body;
  try {
    body = JSON.parse(request.body);
  } catch {
    console.error("the captured request body is not JSON; nothing to read");
    process.exit(1);
  }

  // The shape is unpacked once, before anything asks a question of it: a tool
  // arrives either as `{ type, function: { … } }` or as the function object
  // itself, and `raw.function ?? raw` written out at each reading is one place
  // per reading that has to agree about which of the two arrived.
  const offered = (body.tools ?? []).map((raw) => raw?.function ?? raw);

  // Which generation this client is: the names it sends say so. It is read
  // before the tools are, since the two generations do not send the same names
  // and 2.x has to be recognised by `shell` rather than judged against 1.x's.
  const sent = new Set(offered.map((tool) => tool?.name));
  const generation = sent.has("shell") ? "2.x" : "1.x";
  const read = READ[generation];

  // Which protocol was captured, since each of 1.x's protocols bundles its own
  // provider-utils and a capture must not overwrite the ones it did not observe.
  // Anthropic is not one this can read: its tools carry `input_schema` where the
  // other two carry `parameters`, so read as the chat one it would write every
  // tool without its parameters and take the chat slot's provider-utils from an
  // anthropic client. Refused rather than written — and asked before the
  // per-tool loop below, which would otherwise refuse the same capture first
  // with "carries no parameter schema", a diagnosis about a schema that is there.
  if (offered.some((tool) => tool?.input_schema !== undefined)) {
    console.error("the captured request is in the anthropic shape, which this script cannot read; nothing written");
    process.exit(1);
  }
  const protocol = body.input !== undefined && body.messages === undefined ? "responses" : "chat";

  const tools = {};
  for (const tool of offered) {
    if (!tool?.name || !read.includes(tool.name) || !tool.description) continue;
    tools[tool.name] = {
      name: tool.name,
      description: neutralise(tool.description).slice(0, KEEP),
      parameters: tool.parameters,
    };
  }

  // A name this generation has to carry that the request does not carry at all:
  // this OpenCode no longer sends it, so the capture cannot be taken this way.
  // `sent` rather than `tools`, because `tools` only holds names that
  // arrived with a non-empty description — a required tool that is there and
  // carries no description would otherwise be reported as one this OpenCode
  // stopped sending.
  const required = REQUIRED[generation];
  const missing = required.filter((name) => !sent.has(name));
  if (missing.length) {
    console.error(
      `the captured request has no ${missing.join(", ")}; this OpenCode no longer sends them, so it cannot be captured this way`,
    );
    process.exit(1);
  }
  // The other half of the same question, and the one reading `sent` alone left
  // open: a required name that was sent but has no description to capture is in
  // `sent` and not in `tools`. Writing it into `required` would name a tool
  // the profile does not carry, which is the shape `bun run check:gate` refuses —
  // and the wording that would have said so is reported as GONE below, about a
  // tool that was sent. The two lists are held together here instead.
  const uncaptured = required.filter((name) => !tools[name]);
  if (uncaptured.length) {
    console.error(
      `the captured request carries ${uncaptured.join(", ")} without a description to capture; not writing`,
    );
    process.exit(1);
  }
  for (const [name, tool] of Object.entries(tools)) {
    if (tool.description.length < 100) {
      console.error(`${name}'s description looks truncated (${tool.description.length} chars); not writing`);
      process.exit(1);
    }
    // Every tool a request carries has a schema, and a capture that keeps the
    // wording without it writes a tool that Zen then compares against a request
    // which has one. Only the anthropic shape is refused above, so a third shape
    // would otherwise reach here as a tool with no parameters at all — which
    // JSON.stringify drops from the written file in silence.
    if (!tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) {
      console.error(`${name} carries no parameter schema this script can read; not writing`);
      process.exit(1);
    }
  }

  console.log(`\nagent:  ${request.agent}`);
  console.log(`tools:  ${Object.keys(tools).join(", ")}  (${generation}, ${protocol})`);
  if (code !== 0) console.log(`(opencode exited ${code}; its request was still captured)`);

  const agent = parseAgent(request.agent, generation, fingerprint);
  // The generation comes from the tool names and the agent's shape from the
  // User-Agent, and nothing said that the two belong together. They come from
  // the same OpenCode, so they do — unless what was captured is a host that
  // says one thing and sends another, which is the disagreement Zen refuses
  // (a 403 FreeTierError) and which is then reported as a wording problem.
  // Refused here rather than written: a capture that pairs them is a file
  // every consumer of would carry the disagreement, and the capture is the
  // one place it can still be seen.
  const release = !("providerUtils" in agent);
  if (release !== (generation === "2.x")) {
    console.error(
      `the captured User-Agent is a ${release ? "2.x" : "1.x"} one but the tools are ${generation}; not writing`,
    );
    process.exit(1);
  }

  // The baseline is the file that is written, not the copy this process
  // imported: `--fingerprint` exists so a run can write another file, and a
  // comparison against the repository's copy describes a file nobody is
  // writing — a target that holds no such profile was reported as "nothing
  // changed" and nothing was written, and a target that does differ could be
  // reported as unchanged. It is also the only place the provider-utils this
  // capture did not observe can come from: they belong to the target, and the
  // write replaces the whole profile, so they have to be carried over from
  // there rather than from anywhere else.
  //
  // And the target is read now, at the comparison, rather than when the process
  // started: a capture takes minutes, and a file edited while it ran is
  // compared as it is now rather than as it was.
  const target = readTarget(fingerprint);
  const before = target.profiles[generation];
  if (agent.providerUtils) {
    // Only the protocol this run observed is this capture's answer. The other
    // two are values no capture can take — the one User-Agent describes the
    // protocol OpenCode used, not the versions of the other clients — so they
    // are carried over from the file being written, and from nowhere else.
    // `parseAgent` fills all three keys from that one version for its callers;
    // copying those into a target that has no profile yet would invent two
    // versions nobody observed, and a target that has a profile would lose its
    // own. A target with no profile therefore gets the observed protocol and
    // the anthropic note below says the remaining entry has to be written by
    // hand; that is a smaller lie than a fabricated User-Agent.
    agent.providerUtils = {
      ...before?.agent?.providerUtils,
      [protocol]: agent.providerUtils[protocol],
    };
  }
  // The whole profile is compared, not only the tools the new capture happens to
  // carry: the write below replaces `{ agent, required, tools }` entire, so a tool
  // that is no longer captured — or a `required` list that moved — is a change,
  // and reading it as "nothing changed" would leave the file describing a request
  // this OpenCode no longer makes.
  const nextProfile = { agent, required, tools };
  const same = (left, right) => JSON.stringify(order(left)) === JSON.stringify(order(right));
  const agentChanged = !same(before?.agent, agent);
  const requiredChanged = !same(before?.required, required);
  const removed = Object.keys(before?.tools ?? {}).filter((name) => !tools[name]);
  let changed = removed.length + (requiredChanged ? 1 : 0);
  for (const [name, tool] of Object.entries(tools)) {
    const moved = !same(before?.tools?.[name], tool);
    if (moved) changed++;
    console.log(`  ${name.padEnd(6)} ${moved ? "CHANGED" : "unchanged"}  ${tool.description.length} chars`);
  }
  for (const name of removed) console.log(`  ${name.padEnd(6)} GONE     (was in the stored profile, not in this capture)`);
  if (requiredChanged)
    console.log(`  required  CHANGED  ${(before?.required ?? []).join(", ")} -> ${required.join(", ")}`);
  if (agent.providerUtils)
    console.log(`  agent  ${agentChanged ? "CHANGED" : "unchanged"}  ${protocol} provider-utils kept separate from the others`);
  // The anthropic entry is the one a capture cannot take: the anthropic request
  // shape is refused above, and no free model speaks that protocol, so the
  // value in the file is one a human has to check when @ai-sdk/anthropic is
  // bumped. It is said here, after the comparison, because it is about the file
  // rather than about this run: a capture that cannot check it must not let
  // the file look as current as the rest of it.
  if (agent.providerUtils) {
    const anthropic = agent.providerUtils.anthropic;
    console.error(
      `the anthropic provider-utils is the one entry a capture cannot take; no free model speaks that protocol, so ${fingerprint} ${anthropic ? `carries "${anthropic}" as it was` : "carries none, and the value has to be written by hand"} and nothing here can tell whether it is current. It is maintained by hand, and has to be checked when @ai-sdk/anthropic is bumped.`,
    );
  }

  if (dry) {
    // The agent is named whenever it moved, not only when it is the whole of
    // what moved: `changed` counts tools and the required list and never the
    // agent, so a run where the required list *and* the agent both changed used
    // to print the change count alone and leave the agent out of the report.
    const summary = drySummary({ changed, agentChanged });
    console.log(
      `\n${summary.length ? `${summary.join(" and ")} would change.` : "Nothing would change."} Nothing written (--dry).`,
    );
    process.exit(summary.length ? 1 : 0);
  }

  if (!changed && !agentChanged) {
    console.log("\nnothing changed.");
    process.exit(0);
  }

  // The file that is written: the target's own content, with this generation's
  // profile replaced. The target was read above — it is the baseline — so what
  // is written is what the target held, with one profile in it replaced.
  //
  // What the target held and could not be used — a file that is not JSON, one
  // with no profiles object — was said out loud when it was read, and the file
  // is written from scratch in that case. Refusing to write it would leave the
  // reader with the advice every failure in this repository gives — run `bun
  // run capture` to write a new one — and that command would refuse in turn,
  // which is how a broken capture came to be unfixable: the remedy died of the
  // disease it was the cure for.
  const next = target.file;
  next.profiles[generation] = nextProfile;
  // Written beside the target and renamed over it: a rename within one directory
  // is atomic, so the window in which an interruption can leave a half-written
  // file is the temp file's, not the shipped capture's. Writing in place left a
  // truncated fingerprint.json behind when the Ctrl-C these handlers exist for
  // arrived mid-write — and the remedy every consumer names is `bun run capture`,
  // the command that had just failed. The temp name is fixed and sits next to its
  // target, so it is on the same filesystem (a rename across devices is not
  // atomic, and here is not even allowed).
  const scratch = `${fingerprint}.tmp`;
  return Bun.write(scratch, JSON.stringify(next, null, 2) + "\n").then(
    () => {
      renameSync(scratch, fingerprint);
      console.log(
        `\nwrote ${fingerprint} for ${generation}. Now run \`bun run check:gate\` and commit if it passes.`,
      );
    },
    (cause) => {
      // A write that failed leaves its temp file where nothing reads it, and the
      // next run would find it stale: the capture that could not be written is
      // not one to be picked up later. The cleanup is therefore best-effort and
      // reports its own failure rather than raising it: `rmSync` throws for
      // anything but ENOENT, and what sits at the temp path when the write failed
      // is exactly what the write failed on — a directory raises ERR_FS_EISDIR,
      // which would replace the write error with a cleanup error and send the
      // reader after the wrong one. The error that says why the capture was not
      // written is the one that has to arrive.
      try {
        rmSync(scratch, { force: true });
      } catch (cleanup) {
        console.error(
          `could not remove ${scratch} (${cleanup?.code ?? cleanup?.message ?? cleanup}); it is left behind`,
        );
      }
      throw cause;
    },
  );
}

// The file that is written, read as the baseline it is: the profile this
// generation had in it, and the file itself, to be written back with that
// profile replaced.
//
// Three shapes come out of a target, and all three have to be usable, because
// writing a capture is what this script is for and the file it repairs may be
// the very one every other tool here reads:
//
//   a file that holds a capture   - extended; the other profiles are kept
//   a file that holds no profiles - the profiles written afresh; the rest kept
//   a file that cannot be read     - written from scratch, and said out loud
//
// The last two are not refusals. A refusal would leave the reader with the
// advice every failure in this repository gives — "run `bun run capture` to
// write a new one" — and that command would refuse in turn, so a capture that
// was broken could not be repaired by the tool whose job is to repair it. The
// file is written either way, and what it held is said out loud, because a
// file that is replaced without a word is a file nobody knows was there.
//
// The predicate is the one `core-tools.mjs` reads a table with, written out
// again rather than imported: importing that module would take this script
// down with the very capture it is here to repair, which is the whole of what
// the missing import above is about. The rule is the same one, so the two
// files cannot end up disagreeing about what a table is.
const isTable = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

// The two views a target is returned as describe one file: `report` writes
// through `file` and compares against `profiles`, so they have to be the same
// objects. The early returns used to hand back a separately allocated
// `{ profiles: {} }` for each, which is a `profiles` view of a file nobody wrote.
// Exported so the shape is pinned by a test rather than trusted, the same reason
// `numberFromEnv` takes its environment as a parameter.
//
// Every return below is built here, so the invariant is stated once: a caller
// cannot get the two views from different objects, and a new early return cannot
// reintroduce the pair that is not one target.
function targetOf(file) {
  return { file, profiles: file.profiles };
}

export function readTarget(fingerprint) {
  let text;
  try {
    text = readFileSync(fingerprint, "utf8");
  } catch {
    // Not there is the ordinary first run; unreadable is a permission problem
    // or a directory standing where the file belongs, and the write below has
    // its own say about that.
    console.log(`no capture at ${fingerprint} to compare against; one will be written from scratch`);
    return targetOf({ profiles: {} });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    console.error(
      `the capture at ${fingerprint} is not JSON (${cause?.message ?? cause}); it will be replaced by this capture`,
    );
    return targetOf({ profiles: {} });
  }
  if (!isTable(parsed)) {
    console.error(`the capture at ${fingerprint} is not a table of profiles; it will be replaced by this capture`);
    return targetOf({ profiles: {} });
  }
  if (!isTable(parsed.profiles)) {
    // The file is kept — the note in it, and whatever else it holds — and only
    // the profiles are written afresh. The old shape of `profiles` is lost: it
    // was not a table of profiles, so there was nothing in it to keep. A list
    // is the shape that used to get through: `JSON.stringify` drops a named
    // property set on an array, so the profile was written and then dropped
    // again, and the run said it had written a capture.
    console.error(
      `the capture at ${fingerprint} holds no profiles object; its profiles will be written afresh and the rest of the file kept`,
    );
    const file = { ...parsed, profiles: {} };
    return targetOf(file);
  }
  return targetOf({ ...parsed, profiles: { ...parsed.profiles } });
}

// The parts of the --dry sentence, in the order they are said: the change count
// when there is one, and "the agent" whenever the agent moved. The two are
// independent because `changed` never counts the agent — it is the tools and the
// required list — so a run where both moved has to say both, and a run where
// only the agent moved has a count of zero to say nothing about.
//
// `requiredChanged` is deliberately not a parameter, and the reason is worth
// stating because it looks like an omission: the required list is already in
// the count. `changed` is the tools that moved, the tools that are gone, and
// the required list that moved, so a run where the list moved on its own says
// "1 change(s) would change" and the summary has nothing else to add about it.
// The guard the summary used to be built under (`agentChanged &&
// !requiredChanged`) is not re-injected, because what it decided is decided
// here instead: the summary is built from the two booleans that vary, and the
// pair that matters — a count *and* a moved agent — is pinned directly in
// capture.test.mjs rather than argued about through a run.
export function drySummary({ changed, agentChanged }) {
  return [changed ? `${changed} change(s)` : null, agentChanged ? "the agent" : null].filter(Boolean);
}

// Key order is not what is being captured: these objects come out of a parsed
// request body and out of a JSON file, and JSON.stringify is sensitive to the
// order they arrived in.
function order(value) {
  if (Array.isArray(value)) return value.map(order);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, order(value[key])]));
}

// Where the capture goes, and the loopback server that reads the request the
// OpenCode under test makes. Only a run gets this far: `entry` above is false
// for an import, and the helpers this file exports are what the tests drive
// instead of a real `opencode`.
const entry = invokedDirectly();
if (entry) {
  // OpenCode makes more than one request (a short one for the title, then the
  // real one). The one worth reading is the longest, since it is the one that
  // carries the full toolset. It is kept in memory and handed to `report` as it
  // is: the request is the only thing this state is for, and the file it used to
  // be written to and read back from was cleaned up only at the start of the
  // next run, so every successful run left one behind.
  let longest = { agent: null, body: "" };
  let server;
  try {
    server = Bun.serve({
      port: PORT,
      hostname: "127.0.0.1",
      async fetch(request) {
        try {
          const url = new URL(request.url);
          if (url.pathname.endsWith("/models"))
            return Response.json({ object: "list", data: [{ id: "big-pickle", object: "model", owned_by: "opencode" }] });
          const body = await request.text();
          if (body.length > longest.body.length) longest = { agent: request.headers.get("user-agent"), body };
          return new Response(
            [
              'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"big-pickle","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}',
              'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"big-pickle","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
              "data: [DONE]",
              "",
            ].join("\n\n"),
            { headers: { "content-type": "text/event-stream" } },
          );
        } catch (cause) {
          // A client that aborts mid-request rejects inside this handler, and an
          // unhandled rejection here would end the run with a stack trace instead
          // of the sentence below. The body is not this script's to keep.
          console.error(`the capture server could not read a request: ${cause?.message ?? cause}`);
          return new Response("", { status: 400 });
        }
      },
    });
  } catch (cause) {
    // A port that is already taken used to end the run inside `Bun.serve` with a
    // raw stack that named neither the port nor the variable that chose it —
    // and `.env.example` promises that a knob the run ignores is said out loud.
    // This is the one failure here the reader can fix in one line, so it is a
    // sentence about the knob and the port, not a stack about a socket.
    console.error(
      `the capture server could not listen on 127.0.0.1:${PORT}: ${cause?.message ?? cause}. ` +
        `Set CAPTURE_PORT to a port nothing else is using (${PORT} is taken), then run the capture again.`,
    );
    process.exit(1);
  }

  const home = mkdtempSync(join(tmpdir(), "zen-capture-home-"));
  // Where OpenCode looks for its config is XDG_CONFIG_HOME/opencode, and the
  // three XDG directories are pointed at `home` below.
  const config = join(home, "config", "opencode", "opencode.json");
  await Bun.write(
    config,
    JSON.stringify({ provider: { opencode: { options: { baseURL: `http://127.0.0.1:${PORT}/v1` } } } }),
  );

  const { code, ran } = await capture(
    `listening on 127.0.0.1:${PORT}, running opencode against it`,
    () =>
      // `--standalone` is what makes a desktop-built CLI run its own server
      // instead of looking for the desktop service to attach to. Measured
      // 2026-10-28 against 2.2.0: without it the run printed its banner and
      // exited without a request ever reaching this port; with it, the request
      // arrives. The stock CLI ignores the flag; `mini-capture.mjs`, the
      // desktop-driven capture this file predates, has always passed it.
      spawn("opencode", ["run", "--standalone", "-m", "opencode/big-pickle", "Say OK."], {
        env: {
          ...process.env,
          XDG_DATA_HOME: join(home, "data"),
          XDG_CONFIG_HOME: join(home, "config"),
          XDG_CACHE_HOME: join(home, "cache"),
        },
        stdio: ["ignore", "ignore", "inherit"],
      }),
  );
  // Stopping is awaited, and the snapshot is taken after it: the handler is
  // async, so a body still being read could otherwise replace `longest` after the
  // capture had already been read — which is exactly what the comment above that
  // state claims cannot happen.
  await server.stop(true);
  const captured = { ...longest };
  // Removed before the exit paths below, not after the capture: a run that could
  // not capture anything is exactly the one that used to leave its temporary home
  // behind, since the exits above this line are the ones a failure takes. The
  // synchronous form is deliberate: `rm` from `node:fs` is the callback one, so
  // awaiting it silently did nothing and left a directory behind every run.
  try {
    rmSync(home, { recursive: true, force: true });
  } catch (cause) {
    console.error(`could not remove ${home}: ${cause?.message ?? cause}`);
  }
  // A run that was killed — the watchdog's SIGKILL, a Ctrl-C — is a failure
  // whatever code came back, and it must not reach the compare and write below:
  // that is how an aborted run used to rewrite fingerprint.json.
  if (!ran) process.exit(1);
  // The empty body is the run that never reached this server, refused here
  // rather than left to `report`: `report` parses the body, and a failure to
  // parse would be reported as a bad capture rather than the missing one it is.
  if (!captured.body.length) {
    console.error("no request was captured; opencode did not reach the local server");
    process.exit(1);
  }

  await report({ request: captured, code });
}

// The User-Agent is stored the way agentFor() reads it back, which is not
// necessarily the same split the raw header used. The file is passed in so that
// the refusal below can name the file to fix: the agent is written by hand into
// the capture, and a message that named the generation alone would leave the
// reader to work out which file that was.
function parseAgent(agent, generation, fingerprint) {
  const twoPart = /^opencode\/(\d[^ ]*) ai-sdk\/provider-utils\/(\S+) (\S+)$/.exec(agent ?? "");
  if (twoPart) {
    const [, opencode, providerUtils, runtime] = twoPart;
    return {
      opencode,
      providerUtils: { chat: providerUtils, responses: providerUtils, anthropic: providerUtils },
      runtime,
    };
  }
  const threePart = /^opencode\/([a-z]+)\/(\d[^/]*)\/([a-z-]+)$/.exec(agent ?? "");
  if (threePart) {
    const [, channel, opencode, client] = threePart;
    return { channel, opencode, client };
  }
  console.error(
    `\ncould not read \`${agent}\` as an OpenCode User-Agent; write the ${generation} profile's agent in ${fingerprint} by hand`,
  );
  process.exit(1);
}
