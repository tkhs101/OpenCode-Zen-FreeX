import { readFileSync, statSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Zen's catalogue is where a model's limits are declared from, and for some
// free ids it under-reports them. A free id and its paid twin are the same
// upstream model — x-opencode-upstream-model-id answers
// "deepseek/deepseek-v4.1-flash" whichever of the two is asked for — and only
// the paid one is declared at what that model can actually do.
//
// A limit the host believes is acted on. The window decides when a
// conversation is compacted and whether a request is worth sending at all; the
// output cap is sent as max_tokens on every request. So an under-reported limit
// is not the conservative choice, it is a wrong one nobody can see: a window
// that is too small is never refused, it is just quietly never used, and an
// output cap that is too small cuts replies off with a finish reason that looks
// like the model's own decision.
//
// The input axis is the third, and it fails the same way one layer out. A host
// that plans what to send reads it as the room a prompt has; a host that shows a
// model's window reads it as the window itself — measured 2026-10-16, magpie's
// `context_window` and `max_input_tokens` both follow `limit.input` when one is
// declared. So an input axis that under-reports is not only never used, it is
// what a user is shown as the model's size.
//
// Only evidence moves a value here, and evidence is sorted:
//   route       the route's own answer about its own limit: the words of a
//               refusal, or what its own service demonstrates
//   route-twin  what this route declares for the same upstream model
//   route-sweep what the scheduled sweep measured against this same route and
//               checked in beside this file as `limits-observed.json`: the same
//               bracket the route tier records, taken by machine rather than by
//               hand, and the tier that answers for a model this file has never
//               named — which is what a model Zen made free this morning is
//   vendor      the model vendor's published page
//   witnessed   a generation somebody watched finish
//
// The hand-kept table still has the first word for an id it names, because the
// samples and the reasoning are beside its number. The sweep has the last word
// for the ids and axes it does not: a window nobody measured is a window every
// host gets wrong, and waiting for somebody to write a table entry by hand is
// how a new model stays wrong for a week. The output axis is not measured at
// all: models.dev is read with the route id's `-free` suffix removed, its paid
// twin's `limit.output` is the declaration (canonical fallback when there is no
// paid twin), and the table's output entries are a historical fallback only for
// an id models.dev does not describe. A sweep asks no completion for anything;
// it brackets prompts.
//
// Being accepted is not evidence. Zen answers 200 to max_tokens 2000000 under a
// short prompt, so a value that is accepted says something about the request
// and nothing about what the model writes. A route, route-twin or route-sweep
// value may set any number; a vendor or witnessed one may only raise, because
// lowering a limit on weaker evidence invents a restriction nobody asked for.
// A sweep that found no wall is in the same position: making the largest
// prompt it served into a declaration would turn "nothing refused this" into
// "this is the ceiling", so a wall the sweep never hit may only raise too.
//
// Every axis carries the catalogue value it was measured against. A catalogue
// that moves voids that axis rather than leaving a stale number behind, and a
// refusal that names a different window while the plugin is running corrects it
// for the rest of the process (see observeRouteStatement).
export const LIMITS = {
  // The window that used to be here was 1048576, measured on 2026-10-15 from a
  // refusal that named it. On 2026-10-19 the route refused 1,050,000-token
  // prompts and stopped naming anything: past a wall of about 326,700 tokens the
  // answer is 400 `context_length_exceeded` — "Your request resulted in more
  // tokens than this model's maximum context length allows. Please reduce the
  // length of the messages or run compaction." — and there is no number in that
  // sentence to read. What replaced it is a bracket, measured in characters
  // because a refused request reports no `usage.prompt_tokens`: 1,522,400
  // characters of filler were served and counted 326,702 tokens, 1,522,600 was
  // refused three times out of three, and six sessions of 250,413-token prompts
  // were all served. 326000 is the last served point rounded down rather than a
  // figure the route stated — a host has to stop below a wall it can never quite
  // touch, and the wall itself was just demonstrated: 326,750 is refused, so
  // that number cannot be the budget. The margin is also about the endpoints:
  // the same day, 254,196- and 279,095-token requests from a host were refused
  // in the same words while a 331,989-token request was served, so an endpoint
  // that says no sooner can be reached at any size above the catalogue's 200000.
  // The catalogue remains the fallback if this entry is ever voided, and it is
  // the one window Zen itself states.
  //
  // The output axis is untouched, and the route is less forthcoming about it than
  // it was: over 393216 it answered "Invalid max_tokens value, the valid range of
  // max_tokens is [1, 393216]", which is the only sentence seen anywhere on this
  // route that states a completion ceiling as a range, and asking for 1000000
  // later the same day was answered 200 instead. 384000 stays what it was — a
  // figure from the paid twin, which that sentence did not contradict.
  "deepseek-v4.1-flash-free": {
    context: {
      value: 326000,
      source: "route",
      declaredAt: 200000,
      measured: "2026-10-19",
      samples: "326,702 tokens served (1,522,400 characters); 1,522,600 characters (about 326,745 tokens) refused 3/3 with context_length_exceeded, as was 1,522,800 and 1,050,000 tokens; 250,413 served from six different sessions. The same day, 254,196- and 279,095-token requests were refused while a 331,989-token one was served, so not every endpoint behind this id draws the wall in the same place. A second sweep the same day served 1,000,000 characters (215,178 tokens) and refused 1,600,000 and 2,800,000, which places the wall in the same region without narrowing it.",
      how: "the route's own enforcement, found by bracketing because its refusal names no number; 326000 is the largest served sample (326,702) rounded down, with room for a host's count to differ from the route's, and not a figure the route ever stated. 326,750 was asked three times and refused three times, so the wall itself cannot be the declared budget. The 1048576 measured on 2026-10-15 is withdrawn: the route that stated it now refuses prompts a third that size.",
    },
    output: {
      value: 384000,
      source: "route-twin",
      declaredAt: 32000,
      measured: "2026-10-15",
      samples: "one reply of 306,880 completion tokens, finish=stop; nothing above it observed. The `[1, 393216]` sentence below did not reproduce on a 2026-10-19 re-ask, which was answered 200, so nothing on this route confirms or contradicts 384000 today",
      how: "deepseek-v4.1-flash, the paid id serving the same upstream model, is declared 384000 in this same catalogue; DeepSeek's own page says 384K, which is 393216 read as binary K",
    },
  },
  "mimo-v2.6-flash-free": {
    context: {
      value: 375000,
      source: "route",
      declaredAt: 200000,
      measured: "2026-10-20",
      samples: "375,142 tokens served (1,750,000 characters, counted by the route) on 2026-10-20, where an earlier sweep had served 343,131 (1,600,000 characters) and refused 1,900,000, 2,200,000 and 2,800,000 characters. The 2026-10-20 run asked 200,000 (44,244 tokens), 1,000,000 (215,030) and 1,600,000 (343,121), was refused at 2,800,000, and narrowed through 2,200,000, 1,900,000, 1,825,000 and 1,787,500: 1,787,500 is the nearest refused size and the top of the bracket, while the earlier 2,800,000 probe is a higher refusal and not the bracket's edge.",
      how: "the route's own enforcement, found by bracketing, and 375,000 is the largest served sample rounded down so that a host's count may differ from the route's. The 1048576 this entry used to carry is withdrawn: what the route used to serve it refuses now, which is the same way deepseek-v4.1-flash-free's stated million went. The exact position of the wall between 1,750,000 characters (served, 375,142 tokens) and the 1,787,500 characters the route refused is not known - the sweep stopped at the first refusal it could reproduce, and the earlier 2,800,000 probe was refused too, so that number is an upper bound rather than the bracket's edge - and the figure declared sits under both.",
    },
    output: {
      value: 131072,
      source: "vendor",
      declaredAt: 32000,
      measured: "2026-10-15",
      samples: "nothing above 32000 watched on this route; that same refusal came back with the requested 200000 unclamped, and a 2026-10-19 ask for max_tokens 1000000 was answered rather than refused, so this route states no completion ceiling for this id at all",
      how: "Xiaomi's own entry for mimo-v2.6-flash, api.xiaomimimo.com and its China token plan, declares 1048576/131072, as do DeepInfra and nan; this route declares 32000 for the free id and states no completion ceiling of its own",
    },
  },
  "big-pickle": {
    context: {
      value: 375000,
      source: "route",
      declaredAt: 200000,
      measured: "2026-10-20",
      samples: "375,142 tokens served (1,750,000 characters, counted by the route) on 2026-10-20, where an earlier sweep had served 343,131 (1,600,000 characters) and refused 1,900,000, 2,200,000 and 2,800,000 characters. The 2026-10-20 run asked 200,000 (44,244 tokens), 1,000,000 (215,030) and 1,600,000 (343,121), was refused at 2,800,000, and narrowed through 2,200,000, 1,900,000, 1,825,000 and 1,787,500: 1,787,500 is the nearest refused size and the top of the bracket, while the earlier 2,800,000 probe is a higher refusal and not the bracket's edge.",
      how: "the route's own enforcement, found by bracketing; 375,000 is the largest served sample rounded down so that a host's count may differ from the route's. This entry used to say the axis was left to the catalogue because the one attempt to measure it answered 200 with an empty body, which is not an answer: a 2026-10-19 sweep did measure it, and the catalogue's 200000 is a third of what the route serves.",
    },
    output: {
      value: 131072,
      source: "route",
      declaredAt: 32000,
      measured: "2026-10-15",
      samples: "the endpoint refused the request asking for 200000 and named its own ceiling; nothing watched above 32000. Re-asked with max_tokens 1000000 on 2026-10-19 and named the same 131072, so the number holds",
      how: "\"max_tokens is too large: 200000. This model supports at most 131072 completion tokens, whereas you provided 200000.\" — an upstream that validates the requested ceiling and states its own. This id is the same upstream model as mimo-v2.6-flash-free (x-opencode-upstream-model-id answers mimo-v2.6-flash) on a different endpoint, which is why the two share their measurements above and are still measured apart.",
    },
    // The catalogue declares `input: 160000` for this id, and a prompt of
    // 343,131 tokens was served on 2026-10-19 — a prompt more than twice it, so
    // the declaration is falsified rather than merely small. It matters more than
    // a stale number usually does, because `input` is the axis a gateway reads as
    // the prompt budget: magpie answers `context_window` with the smaller of
    // `context` and `input`, so with 160000 left in place this model was offered
    // a 160000-token window to every host behind it no matter what `context`
    // said. Measured the same way as the window above and from the same sweep.
    input: {
      value: 375000,
      source: "route",
      declaredAt: 160000,
      measured: "2026-10-19",
      samples: "343,131 tokens served (1,600,000 characters), against a declared input of 160000 — more than twice the declaration, which no margin accounts for",
      how: "the prompt the route was measured to serve, which is the same bracket as the context entry above and is what an input axis can be: this route never names an input cap in a refusal, so nothing here is a figure it stated. Declared at the window rather than at the sample, so a host planning a prompt from it and a host planning from the context are told the same thing — the precedent space-bunny-free set when its own input was found to be half of what it serves.",
    },
  },
  "nemotron-3.5-lightning-free": {
    context: {
      value: 1000000,
      source: "route",
      declaredAt: 262144,
      measured: "2026-10-20",
      samples: "a refusal that named the window on 2026-10-15, which is what `bun run limits:audit` asks for; and on 2026-10-20 a prompt of 974,358 tokens was SERVED (`usage.prompt_tokens`), against a catalogue that declares 262144 — so the named million is not a ceiling the pasted round number merely claims, it is a scale the route demonstrably serves at nearly 3.7 times the declaration",
      how: "\"This endpoint's maximum context length is 1000000 tokens. However, you requested about …\" — read from the refusal the audit provoked by asking for more completion tokens than the window leaves, on the same upstream that words it as the mimo entry above. The catalogue declares 262144 for this id.",
    },
  },
  "longcat-2.5-preview-free": {
    output: {
      value: 262144,
      source: "route",
      declaredAt: 131072,
      measured: "2026-10-15",
      samples: "the ceiling named by a refusal, from the same audit run; nothing above 131072 watched on this route",
      how: "\"Upstream request failed: [invalid_parameter] 参数校验失败: /max_tokens: 1000000 is not less or equal to 262144\" — the second wording namedOutputCap reads, where the ceiling is the number max_tokens has to stay under. Its context needs nothing: the catalogue's 1000000 is what that same refusal calls the endpoint's window.",
    },
  },
  // The two the free tier added on 2026-10-16, each measured the day it was
  // noticed. Both under-report in the catalogue the same way the older entries
  // do, and both were checked on every axis: nothing below is what a refusal
  // happened to say, it is all that was asked.
  "ll-alpha-free": {
    output: {
      value: 262144,
      source: "route",
      declaredAt: 65536,
      measured: "2026-10-16",
      samples: "max_completion_tokens 1000000 and 300000 both refused, each naming 262144; nothing above 65536 watched — the ceiling is the route's own number, four times what the catalogue declares",
      how: "\"Upstream request failed: [400] max_completion_tokens is too large: 300000.This model supports at most 262144 completion tokens.\" — the ceiling is the number the sentence names. Its context needs nothing: the same day's refusal, \"The input (341480 tokens) is longer than the model's context length (262144 tokens).\", is the window the catalogue already declares.",
    },
  },
  "glm-5.3-flash-free": {
    context: {
      value: 323000,
      source: "route",
      declaredAt: 200000,
      measured: "2026-10-20",
      samples: "323,107 tokens served (1,506,250 characters, counted by the route) on 2026-10-20, where an earlier sweep the same day had served 311,109 (1,450,000 characters). The 2026-10-20 run refused 1,525,000 characters, and 1,600,000 before it: 1,525,000 is the nearest refusal and the top of the bracket this entry sits under. This id's upstream was failing intermittently earlier the same day - a request of 547,384 characters was answered and one of 540,983 was refused, which no wall does - and a failure that is not about a size is not counted as one.",
      how: "the route's own enforcement, found by bracketing, and 323,000 is the largest served sample rounded down so that a host's count may differ from the route's. The twin-derived 1000000 this entry used to carry is withdrawn: the paid id's window is not one this endpoint serves, and the refusal that withdrew it was answered by a serve of the same size the next day, which is this id's instability rather than a wall. The wall's exact position between 323,107 tokens (1,506,250 characters) and the 1,525,000 characters the route refused is not known - the sweep stopped at the first refusal it could reproduce. The 2026-10-20 instability is the reason the run's own bracket is not evidence: a refusal under a size the route served is the endpoint's opinion, not the wall's, and both the plugin and the sweep now refuse to read it as one. When this id's upstream is failing, a measurement of it says something about the upstream and not about the window.",
    },
    output: {
      value: 131072,
      source: "route-twin",
      declaredAt: 32000,
      measured: "2026-10-16",
      samples: "max_tokens 4000000 was accepted with no refusal at all, which is the DeepSeek upstream's shape: silence here is not evidence of a ceiling either way, and nothing above 32000 was watched",
      how: "the same paid twin declares 131072 on this axis",
    },
  },
  // The catalogue calls this model a 1M-context model and writes 1000000 — the
  // decimal million. The wall behind it is the binary one, and the gap between
  // them is 48,576 tokens a host would never be allowed to use: 1,048,092 was
  // served and counted by the route, which is 1,048,576 minus a few hundred
  // tokens of message overhead, while 1,082,359 was refused. So this is the same
  // wall `beam-free` and the other 1048576 ids sit behind, and the catalogue's
  // round number is the one value on this route measured to be under-reporting
  // by more than the route's own envelope costs.
  //
  // Nothing was declared over it: 1048092 is the largest size served, rounded
  // down, not the wall itself. The refusal names no number, so the wall is only
  // known to lie between that sample and the first refusal, and a host that
  // builds to the top of its window is refused at the same size as a host that
  // builds to nothing. 1040000 keeps the last thousand tokens — about the
  // overhead of a message envelope, measured at 484 tokens here — as room for a
  // host that counts differently from the route.
  "minimax-m3.1-flash-free": {
    context: {
      value: 1048576,
      source: "models.dev",
      declaredAt: 1000000,
      measured: "2026-10-20",
      samples: "1,048,092 tokens served (counted by `usage.prompt_tokens`, bisected from 274,375 words at 3.936 tokens/word); 1,082,359 tokens refused. Earlier the same day 1,046,141 was served and 1,046,764 refused, so the wall moves by a few hundred tokens with the envelope and sits just under 1048576 rather than at the 1000000 the catalogue writes.",
      how: "the catalogue writes 1000000, the decimal million, and the wall behind it is the binary 1048576. models.dev declares 1048576 for this canonical model — llmgateway/minimax-m3.1-flash and llmgateway-providers are the only two of nineteen entries that say so, against seventeen that repeat the catalogue's 1000000 — and the bisection above agrees with those two and with nothing else. Declared at the wall rather than under it: a host deducts its own envelope, and this route's is measured at about 484 tokens, which 1048576 covers.",
    },
    output: {
      value: 512000,
      source: "route-twin",
      declaredAt: 512000,
      measured: "2026-10-20",
      samples: "nothing watched above 32000 on this id; the catalogue declares 512000 and no refusal was asked for it",
      how: "the catalogue declares 512000 for this same free id, which is the one completion ceiling this route states for it. Left at the declaration rather than lowered: nothing here measured it, and lowering a ceiling on no evidence cuts replies off.",
    },
  },
  "beam-free": {
    context: {
      value: 1048576,
      source: "models.dev",
      declaredAt: 1048576,
      measured: "2026-10-20",
      samples: "1,048,361 tokens served (counted by `usage.prompt_tokens`, bisected from 255,000 words at 4.193 tokens/word); 1,071,887 tokens refused. The served sample lands within 215 tokens of the binary 1048576, so this is the binary wall and the catalogue's 1048576 is already the right scale here.",
      how: "the route's own enforcement, found by bisection because its refusal states no number. The catalogue declares 1048576 and the route serves 1,048,361 of it, so the declaration is correct in scale and is the binary wall itself rather than a rounded sample: the served sample lands within 215 tokens of it, and the figure declared is that wall. This entry exists so the sweep does not have to rediscover a wall that is the catalogue's own number.",
    },
    output: {
      value: 131072,
      source: "vendor",
      declaredAt: 131072,
      measured: "2026-10-20",
      samples: "nothing above 32000 watched on this route",
      how: "the catalogue declares 131072 for this id; nothing here measured it, and the axis is left as declared.",
    },
  },
  // Measured the day a host's window for this id was reported half its size.
  // Only the input axis moves: the window and the ceiling are what this route
  // declares, and what was served agrees with both.
  "space-bunny-free": {
    input: {
      value: 1048576,
      source: "route",
      declaredAt: 524288,
      measured: "2026-10-16",
      samples: "prompts of 535,110, 935,110 and 979,550 tokens served whole, each with the needle at the end of it echoed back and each counted by `usage.prompt_tokens`, so the declared 524288 is already known to be small; a prompt placed over the window was refused 400, in words that name nothing",
      how: "the catalogue's 524288 is its own `context − output` (1048576 − 524288) read as a cap, and this route does not enforce it: the samples above run from just past the declared cap to nearly twice it, served whole, and the wall is the 1048576-token window this same catalogue declares for this id. A host that shows the input axis shows the window — magpie's `context_window` and `max_input_tokens` are both this field when one is declared — so a derivation left here is a wrong window on screen.",
    },
  },
};

// "This model's maximum context length is 1048576 tokens. However, you
// requested 1422278 tokens (1038278 in the messages, 384000 in the
// completion)." — the route's own words, and the sentence seen most often on
// this route that states a window. A second upstream phrases the same fact as
// "This endpoint's maximum context length is ...", with the request broken into
// text input, tool input and output; both are the route naming its own window,
// and its "requested about" figure is a rough one (chars, not tokens) rather
// than the count a served request reports in `usage.prompt_tokens`. A generic
// 400 says nothing attributable and is left alone; §7 of the measured notes has
// a context overflow and an invalid parameter answering with byte-identical 400s
// on another Zen model.
//
// A third wording states the same fact as a parenthetical, and was missed until
// it was measured: "The input (341480 tokens) is longer than the model's context
// length (262144 tokens)." (`ll-alpha-free`, 2026-10-16). It names the same
// number in the same sentence, so it is read the same way — a window this file
// does not read is a window the plugin keeps under-declaring, which is the one
// failure it exists to remove.
const NAMED_CONTEXT = [
  /maximum context length is (\d+) tokens/id,
  /context length \((\d+) tokens?\)/id,
];

// "max_tokens is too large: 200000. This model supports at most 131072 completion
// tokens, whereas you provided 200000." — an upstream that validates the ceiling
// it was asked for and names its own, which is the only sentence seen on this
// route that states a completion ceiling at all. It is worth knowing that the
// DeepSeek upstream does not validate: `max_tokens: 2000000` under a short prompt
// answers 200 there, so silence from this one says nothing about a model, and a
// request that is served is not evidence of a ceiling either way.
const NAMED_OUTPUT = [
  /supports at most (\d+) completion tokens/id,
  // "/max_tokens: 1000000 is not less or equal to 262144" — LongCat's wording for
  // the same fact, where the ceiling is the number it has to stay under.
  /max_tokens:?\s*\d+\s+is not less or equal to\s+(\d+)/id,
  // "Invalid max_tokens value, the valid range of max_tokens is [1, 393216]" —
  // the DeepSeek upstream's wording, and the only sentence seen on this route
  // that states a completion ceiling as a range. The upper end is the ceiling:
  // the number the route says it accepts up to, which is what a declaration of
  // this axis has to stay inside. It is not a sentence to rely on: measured
  // 2026-10-19, and asking for 1000000 later the same day was answered 200 rather
  // than refused, so the route states this ceiling on some endpoints and not
  // others. The pattern stays because reading it costs nothing when it does not
  // appear, and a ceiling the route does state is the one number on this axis
  // that does not have to be guessed at.
  /valid range of max_tokens is \[\s*\d+\s*,\s*(\d+)\s*\]/id,
];

// Names a refusal made while this process is running, by model id. Not
// persisted: the same kind of fact as LIMITS, only newer, so a restart falls
// back to what was measured last.
const OBSERVED = new Map();
const OBSERVED_OUTPUT = new Map();

// The two maps above as a caller can hold them, and a way to put them back where
// they were found. They are module state on purpose — a refusal this process saw
// is the route speaking, and it outranks the shipped table for as long as the
// process runs — but one process is not always one conversation: a second reader
// of this module, a test run above all, has to be able to answer from the table
// it shipped with rather than from evidence the first reader happened to
// collect. Called with nothing it answers with the pair as they stand; called
// with a pair it makes that pair the state and answers with what it replaced, so
// the caller can put the first one back in a `finally`. The shape is
// `limitDiagnostics`'s, which returns the sink it replaced for the same reason.
export function limitObservations(restore) {
  const previous = { context: new Map(OBSERVED), output: new Map(OBSERVED_OUTPUT) };
  if (restore !== undefined) {
    for (const [map, entries] of [
      [OBSERVED, restore.context],
      [OBSERVED_OUTPUT, restore.output],
    ]) {
      map.clear();
      for (const [id, value] of entries ?? []) map.set(id, value);
    }
  }
  return previous;
}

// ---- the wall the route enforces, learned from the traffic it serves -------
//
// Everything above this line is a measurement somebody took by hand and wrote
// down. That does not scale: the wall this route enforces moved under one id on
// 2026-10-19, and the only reason it was noticed is that a conversation filled
// the window and every request after it was refused. The same wall sits in front
// of every offered model, it is not the number the catalogue publishes, and it
// moves without notice.
//
// So each model gets a bracket, kept while the plugin runs and carried across
// restarts in one small file, and the bracket is moved only by what the route
// itself answers:
//
//   floor   the largest request the route is known to have SERVED, read from the
//           characters of the request that was sent through one estimate, in the
//           same units as `ceil` below: a bracket whose ends were read through
//           different estimates would be two numbers about two scales.
//   ceil    the smallest request the route is known to have REFUSED, in those
//           same units. It is the bound the declaration may not cross, which is
//           what stops a search from asking for a size already turned down.
//   ceiling what this file declares to the host, and the one number a host acts
//           on: it compacts a conversation at it and decides what is worth
//           sending at all.
//   step    how far above the proven floor the declaration is willing to go. It
//           doubles every time the host is seen to have filled the declaration,
//           and halves on every refusal, which is the whole of the search: each
//           refusal narrows the bracket, and the overshoot that caused it is
//           half the size of the one before.
//
// Nothing here sends a request of its own. Every observation is a request the
// host was already making, which is why this can be on by default: the cost of a
// wrong guess is one refused turn, and the step halving is what makes those
// refusals both rarer and smaller. A model nothing is asked of is never probed
// at all, and its declaration is exactly what the table and the catalogue said.
//
// The host sees a learned ceiling at its next list rebuild — the start, an hour
// later, or a `refresh()` — which is also what keeps this from being a loop: the
// bracket moves on the traffic the host sends against the declaration it was
// given, not on the declaration it is being given now.
//
// One estimate, used at both ends of the bracket, because a floor and a ceiling
// read through different estimates are two numbers about different scales and
// the search between them would be searching a scale nobody declared in. What
// keeps this honest is the structure around it — the step halving on every
// refusal, the bound a refusal puts under the declaration, and the refusal
// budget that ends the search — and not the precision of a character count.
//
// It is deliberately script-aware: a window declared from a Latin ratio alone
// would come out at a third of the real one for a wall of Chinese text, which is
// the silent under-declaration this file exists to remove.
const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const SCAN_LIMIT = 32 * 1024 * 1024;
const CJK_TOKENS_PER_CHAR = 0.7;
// The characters one token covers, measured against the route's own
// `usage.prompt_tokens` on the bodies a host actually sends — 3.938, 4.015 and
// 4.034 on conversations of 12,546, 60,796 and 292,396 tokens, so 3.996.
//
// The 4.66 this replaces was not wrong, it was answering a different question.
// Measured against the sweep's repeated filler text it is exact: the nine models
// in `limits-observed.json` come back at 4.65 to 4.68 characters per token,
// averaging 4.666. That is the ratio for `The quick brown fox` repeated, which
// tokenises far better than a coding conversation — same words, no JSON, no
// tool-call ids, no punctuation between fragments. Applied to real traffic it read
// the prompt about 14% short: the three points above came back at 0.845, 0.862 and
// 0.866 of the route's count, and a floor read 14% short is a window declared 14%
// short, which is the one direction this file exists to stop.
//
// The sweep itself never calls `estimateTokens` — it asks the route and reads
// `prompt_tokens` — so the two ratios cannot be confused again: this one belongs to
// a bracket learned while a host is running, and the table's numbers are the
// route's own count.
const LATIN_CHARS_PER_TOKEN = 3.996;

// The tokens a request's own text holds. An estimate, and used as one: the route
// counts tokens with a tokenizer this plugin does not have, so every size below is
// read from characters through the ratios above. The sweep does not use this at
// all — it asks the route and reads `prompt_tokens` — so the table's numbers are
// the route's own count, while a bracket learned while a host is running is
// measured with this. Aligning the two is what this ratio is for.
export function estimateTokens(text) {
  const { cjk, other } = scriptCount(text);
  return Math.round(cjk * CJK_TOKENS_PER_CHAR + other / LATIN_CHARS_PER_TOKEN);
}

function scriptCount(text) {
  if (typeof text !== "string" || text === "") return { cjk: 0, other: 0 };
  const scan = text.length > SCAN_LIMIT ? text.slice(0, SCAN_LIMIT) : text;
  // A string with no CJK at all — nearly every request to this route — is
  // answered without walking it, which is what keeps this cheap on a prompt of
  // several megabytes. `test` bails at the first match, so the walk below only
  // happens for text that really holds one.
  if (!CJK.test(scan)) return { cjk: 0, other: scan.length };
  let cjk = 0;
  for (let at = 0; at < scan.length; at += 1) {
    const code = scan.charCodeAt(at);
    if (code >= 0x2e80 && code <= 0xd7ff) cjk += 1;
  }
  return { cjk, other: scan.length - cjk };
}

// Every character of a request body this file can see, as one string, so that a
// caller with a parsed body does not have to know which protocol wrote it. Only
// strings are counted; a number, a flag or a nested object contributes nothing,
// which makes this a floor on the request's real size — the one direction that
// cannot turn a small request into a large claim. Exported for the provider,
// which has the body in hand before it sends anything.
//
// The budget is counted in characters, and that is the whole of a repair: it
// used to count strings, at 4096 of them, and a chat body holds one string per
// role, per content, per tool-call id, per tool name and per tool arguments. A
// long conversation therefore stopped being read at a point that had nothing to
// do with its size, and what came back was a floor on a floor — a body of
// 1,012,508 characters was estimated at 44,181 tokens against a true 217,276,
// because the walk gave up after the four-thousandth string. The estimate is a
// bracket's unit, so an under-read there is not a rounding error: it is a wall
// learned at a fifth of the size the route actually saw, and the declaration
// built on it lands below a size the route has already served. Counting
// characters makes the cut a bound on the quantity being estimated, which is
// what `SCAN_LIMIT` already is for the CJK scan below.
//
// An encoded attachment is not prompt text either, and counting it was the one
// way this floor read as a ceiling. A screenshot posted to a chat body arrives
// as `data:image/png;base64,…` — about 1.37 million characters per megabyte of
// PNG — which at this file's 3.996 characters per token is 343,000 tokens for a
// picture the route bills in the low thousands. On the VPS a four-word prompt
// with a 10 MB screenshot read as 3,498,676 tokens, and that size became a
// model's floor: the declared window went to 3,491,182 for a route measured at
// 1,048,092, and a client planning a prompt from it would be refused by the wall
// the number was supposed to describe. The two shapes read here are the data URI
// (chat and responses) and a bare base64 field under a `type`, `mime_type` or
// `media_type` (the anthropic and gemini shapes), and both are skipped whole. A
// text document pasted as a data URI is skipped with them: that reads the body
// low, which is the direction a floor is allowed to fail in, and the direction
// the paragraph above already promises.
const ATTACHMENT_MIN = 4096;

const isAttachment = (text, key, parent) => {
  if (text.length >= ATTACHMENT_MIN && text.startsWith("data:") && text.slice(0, 256).includes(","))
    return true;
  // The bare-base64 shapes only under a field named `data`, and only when its
  // parent says what it is: `{type:"base64",data}` and `{mime_type,data}` are
  // attachments, while a `data` field elsewhere is a name this walk cannot read,
  // and skipping it would be skipping text nobody proved was not text.
  return (
    key === "data" &&
    parent !== null &&
    typeof parent === "object" &&
    (typeof parent.type === "string" ||
      typeof parent.mime_type === "string" ||
      typeof parent.media_type === "string")
  );
};

export function requestText(body, budget = SCAN_LIMIT) {
  const parts = [];
  let seen = 0;
  const walk = (value, depth, key, parent) => {
    if (seen >= budget || depth > 12) return;
    if (typeof value === "string") {
      // Skipped before the budget is charged: the budget bounds the text this
      // walk is about, and an attachment is not a long prompt that used it up.
      if (isAttachment(value, key, parent)) return;
      parts.push(value);
      seen += value.length;
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1, key, parent);
      return;
    }
    if (value && typeof value === "object")
      for (const [name, item] of Object.entries(value)) walk(item, depth + 1, name, value);
  };
  walk(body, 0, undefined, undefined);
  return parts.join("");
}

// The size of one request, as the observers below take it.
export function requestSize(body) {
  return { tokens: estimateTokens(requestText(body)) };
}

// Which scale `requestSize` measures in. A bracket is a pair of numbers this file
// took from that scale, so a record is only evidence while the scale that produced
// it is the scale still in use: the estimator once counted strings instead of
// characters and under-read a long conversation to a fifth of its size, which put
// a floor and a ceiling on a deflated scale and then bounded a window measured on
// the right one. A record carrying another number was measured by a different
// instrument and says nothing about this one.
//
// The number moves whenever the estimate changes meaning, and a record that
// disagrees is dropped rather than repaired: the floor is the largest size the
// route was seen to serve AS THIS FILE COUNTED IT, and there is nothing to salvage
// from a count whose unit was wrong.
//
// It moved to 3 when an attachment stopped being counted as text. A request
// carrying a 10 MB screenshot read as 3,498,676 tokens on scale 2 and reads as
// the four words it held on this one, and every floor built out of those
// pictures — 3,491,182 for one id, 1,233,222 for another — was a window the
// route had never been asked for. The scale-2 records those numbers live in are
// dropped by the rule above, which is the repair.
export const ESTIMATE_SCALE = 3;

// The brackets, by model id, as this process has them. A Map like the two
// observation maps above, for the same reason: what a route answered about one
// model is that model's, and a caller has to be able to read and replace the
// whole of the state — a test above all, whose assertions would otherwise depend
// on the order requests happened to be made in.
const BRACKETS = new Map();

// The state as a caller can hold it, and a way to put it back, in the shape
// `limitObservations` uses. Called with nothing it answers with a copy of the
// records as they stand; called with a Map it makes that map the state and
// answers with what it replaced. The records are copied rather than shared, so a
// caller that puts one back cannot be surprised by the observer that ran in
// between: a record is the one mutable thing in this file.
//
// A record put back is read the way a record out of a state file is read, and
// that includes the scale: this is the documented way to swap the whole bracket
// state, so a snapshot taken with an older estimator could be handed in here and
// would bound a window with a count whose unit was wrong — the very failure the
// scale guard was added for on the file path. "A record measured on another
// scale is not this record" is true of a caller's record as much as of a file's.
export function limitAdaptivity(restore) {
  const previous = new Map();
  for (const [id, record] of BRACKETS) previous.set(id, { ...record });
  if (restore !== undefined) {
    BRACKETS.clear();
    for (const [id, record] of restore ?? []) {
      if (!isUsableId(id) || !record || typeof record !== "object") continue;
      if (record.scale !== ESTIMATE_SCALE) continue;
      BRACKETS.set(id, { ...record });
    }
  }
  return previous;
}

// One record, copied, or undefined when this model has never been observed.
// Copied for the same reason `limitAdaptivity` copies: the caller reads a
// bracket, and a bracket it can mutate is a bracket the next request reads back.
export function limitBracket(id, brackets = BRACKETS) {
  const record = brackets && typeof brackets.get === "function" ? brackets.get(id) : undefined;
  return record && typeof record === "object" ? { ...record } : undefined;
}

// What this file declares for a model because the route taught it something.
// A record answers with the ceiling it holds — the observers are the only thing
// that moves one, so reading a bracket never raises a declaration the search did
// not decide on: a refusal that put the ceiling back at the floor would be undone
// by the next model list otherwise, which is how a search turns into a loop. A
// record with no ceiling yet derives one from its seed. A model with no record
// answers with nothing, and keeps every tier above this one.
function adoptedCeiling(id, seeded, brackets) {
  const record = brackets && typeof brackets.get === "function" ? brackets.get(id) : undefined;
  if (!record || typeof record !== "object") return undefined;
  if (!usable(record.ceiling)) record.ceiling = derivedCeiling(record, seeded);
  // The floor binds a ceiling that was never derived here as well. A record is
  // not always born in this process: it is read back from a state file, or handed
  // in by a caller, and one written by a version whose bound was not clamped
  // carries the inversion in the field this function answers with. Deriving only
  // when the ceiling is unusable means such a record is republished as it stands,
  // for as long as nothing raises it — which is exactly the case a host is in
  // before it sends its first request, and the case it stays in once the refusal
  // budget is spent and the raise path is closed. Clamping on the way out is what
  // makes the invariant hold for a record this process did not compute, and it
  // repairs the record as it goes, so the next save writes the corrected number
  // rather than the one that was read.
  const floor = usable(record.floor) ? record.floor : 0;
  if (usable(record.ceiling) && record.ceiling < floor) record.ceiling = floor;
  // A bracket may RAISE a declaration and never pull one down — but only when
  // the bracket carries no evidence of its own, because a bracket that HAS
  // evidence is the route teaching this process a smaller window, and that is a
  // stronger tier than the table.
  //
  // A record is a search state, and it is seeded from whatever the declaration
  // was when the record was born. `glm-5.3-flash-free` was seeded when the table
  // said 311,000; the table was then measured again and says 323,000, and the
  // record — read back from the state file — still answered 311,000, so the
  // model was published a third smaller than the table, and a third smaller
  // than the 323,107 tokens the route had demonstrably served. That record has
  // no refused size of its own: its ceiling was derived from its seed and
  // nothing else, so it is not a measurement at all, it is the seed remembered.
  //
  // A record that DID draw a bound of its own is left alone. The inverted case
  // is the one that matters: a refusal at 228,513 with a serve at 228,286 is
  // the route saying the wall is below the table's 326,000, and a search state
  // that has evidence of its own is a stronger tier than the table.
  //
  // The clamp repairs the record as it goes, so the next save writes the
  // corrected ceiling rather than the one that was read.
  const evidence = usable(record.ceil) || (Number.isSafeInteger(record.refusals) && record.refusals > 0);
  if (!evidence && usable(seeded) && usable(record.ceiling) && record.ceiling < seeded) record.ceiling = seeded;
  return record.ceiling;
}

// The declaration a record comes to, from what the route proved and what the
// caller would have said anyway. The upper bound is the whole point of `ceil`: a
// refusal puts a size under it, and this stops the search from ever declaring
// one the route has already turned down. A record whose own numbers are not
// usable — a state file somebody edited, a version that wrote another shape —
// falls back to the seed rather than to a guess.
function derivedCeiling(record, seeded) {
  // Written as a chain rather than a nested ternary: the seed is either the
  // caller's declaration or the one this record was born with, and which of the
  // two answered is worth reading as two cases rather than as one expression
  // shaped like a question mark. No value changes.
  let seed;
  if (Number.isSafeInteger(seeded) && seeded > 0) seed = seeded;
  else if (Number.isSafeInteger(record?.seededFrom) && record.seededFrom > 0) seed = record.seededFrom;
  const cap = Math.max(seed ?? 0, maxWindow());
  const floor = usable(record?.floor) ? record.floor : 0;
  const step = usable(record?.step) ? record.step : seedStep(seed);
  const ceil = usable(record?.ceil) ? record.ceil : undefined;
  // A record with neither a seed nor anything the route proved has nothing to
  // declare: answering `cap` would invent a window out of a constant.
  if (seed === undefined && floor === 0) return undefined;
  const base = Math.max(floor + step, seed ?? 0, usable(record?.ceiling) ? record.ceiling : 0);
  // The bound a refusal puts under the declaration. A window the route named is
  // its own number and may be declared as it stands; one this file estimated is
  // a character count, so it is stepped under rather than sat on — declaring the
  // exact size that was just refused is how a search turns into a loop.
  //
  // The cap is what holds an ESTIMATED search back, and a number the route said
  // out loud is not that: the same number is applied as it stands everywhere
  // else in this file — the refusal that named it publishes it as the
  // declaration, a statement made while the process runs overrides the table,
  // and the sweep's `named` row settles the axis — so capping it here alone made
  // a route-named window of 2,000,000 tokens come back as 1,048,576, which is
  // this file's own ceiling talking about a size the route had answered for.
  const margin = ceil === undefined || record?.exact === true ? undefined : Math.floor(ceil * (1 - REFUSAL_MARGIN));
  const bound =
    ceil === undefined
      ? cap
      : record?.exact === true
        ? ceil
        : Math.min(margin, cap);
  // A margin that is a fraction of `ceil` is not a margin at all when the bracket
  // is narrow: 2% of a refused size 4000 tokens above the floor is 80 tokens below
  // it, so the bound is on the wrong side of the floor and the clamp below pins the
  // declaration AT the floor for good. The search then reports no progress however
  // many times the host fills it — the VPS bracket of floor 326000 / ceil 330000
  // never moved, while a 60,000-token bracket climbed 91% of its own span. That is
  // a capability cap with no evidence behind it: the route refused 330000, not
  // 326001, and nothing was ever asked between them.
  //
  // So where the margin lands at or under the floor and the bracket is still open,
  // the next size is the midpoint of the interval instead. Every served midpoint
  // raises the floor without spending a refusal, and every refused one halves what
  // is left, so the declaration climbs to within a sixteenth of the span inside the
  // refusal budget — which is what `ceil` is for. The margin rule keeps every case
  // it already answered: it is only displaced where it produced no movement at all.
  const wedge = floor > 0 && ceil !== undefined && ceil > floor + 1 && (bound ?? 0) <= floor;
  if (wedge)
    // The floor clamp of the return below applies here too: the wedge branch
    // leaves before that return, and `cap` is the global default maximum window
    // (1,048,576) unless an operator configured one, so a record whose floor is
    // above it would otherwise be published below the size the route is known to
    // have served — the inverted bracket this file has a rule about. That is
    // exactly the case `OPENCODE_ZEN_FREE_MAX_WINDOW` makes reachable by hand, and
    // it is not a preference: a declaration under the floor is contradicted by
    // the request that produced the floor.
    return Math.max(floor, Math.min(Math.max(floor + 1, floor + Math.ceil((ceil - floor) / 2)), cap));
  // The declaration may never sit below the largest size the route is known to
  // have SERVED. That is not a preference about margins: `floor` is a request the
  // route answered, so a declaration under it is a number contradicted by the
  // evidence that produced it, and the host compacts a conversation it could have
  // sent. It is reachable because `bound` is a function of `ceil` alone, and a
  // refusal 227 tokens above the floor puts `ceil * (1 - REFUSAL_MARGIN)` below
  // it: the VPS on 2026-10-19 held floor 228286, ceil 228513 and declared 223942,
  // which is 223942 = floor(228513 * 0.98). It was also permanent, because the
  // un-refusal guard needs `floor >= ceil` (228286 >= 228513 is false), so the
  // refusal that drew the bound was never voided, and every later raise re-derived
  // the same bound — four raises in a row came back to 223942. Clamping here is
  // what makes the bracket an interval by construction rather than by luck.
  return Math.max(floor, Math.max(1, Math.min(base, Math.max(bound, 1))));
}

const usable = (value) => Number.isSafeInteger(value) && value > 0;

function maxWindow(env = globalThis.process?.env) {
  const named = Number.parseInt(env?.[MAX_WINDOW_ENV] ?? "", 10);
  return Number.isSafeInteger(named) && named > 0 ? named : DEFAULT_MAX_WINDOW;
}

function seedStep(seeded) {
  const base = usable(seeded) ? seeded : DEFAULT_MAX_WINDOW;
  return Math.max(MIN_STEP, Math.floor(base * STEP_SEED_RATIO));
}

function stepMax(seeded) {
  const base = usable(seeded) ? seeded : DEFAULT_MAX_WINDOW;
  return Math.max(MIN_STEP * 4, Math.floor(base * STEP_MAX_RATIO));
}

// Whether a raise is allowed at all right now. A probe costs a turn when it
// overshoots, so they are spaced: one per model per cooldown, whichever way the
// last one went. A model the host is working in does not need a window found to
// the token, and one it is not working in is not probed at all — a raise needs
// the host to have filled the declaration, which is the only demand signal there
// is.
function raisesAllowed(record, now) {
  const last = Number.isFinite(record?.raisedAt) ? record.raisedAt : 0;
  return now - last >= raiseCooldown();
}

function raiseCooldown(env = globalThis.process?.env) {
  const named = Number.parseInt(env?.[RAISE_COOLDOWN_ENV] ?? "", 10);
  return Number.isSafeInteger(named) && named >= 0 ? named : RAISE_COOLDOWN_MS;
}

function recordFor(brackets, id, seeded, now) {
  const held = brackets.get(id);
  if (held && typeof held === "object") return held;
  const record = {
    floor: 0,
    ceil: undefined,
    exact: false,
    ceiling: usable(seeded) ? seeded : undefined,
    step: seedStep(seeded),
    scale: ESTIMATE_SCALE,
    refusals: 0,
    seen: 0,
    // The largest request that had been carried when the last raise happened, so a
    // second raise can ask whether anything has been asked of the declaration since
    // the first one moved it. Seeded at zero: a model nothing has asked anything of
    // has nothing to pay a raise with either.
    raisedAtSeen: 0,
    seededFrom: usable(seeded) ? seeded : undefined,
    raisedAt: 0,
    refusedAt: 0,
    seenAt: now,
  };
  brackets.set(id, record);
  return record;
}

// A request the route served. Its size is a fact about the floor and nothing
// else: a 200 says the prompt fitted, not that the window is exactly this large.
// The raise is the interesting half — the host filling the declaration is the
// only evidence there is that it wants more room, and without it a bracket would
// freeze at whatever the table said.
export function observeServedRequest(id, size, seeded, brackets = BRACKETS, now = Date.now()) {
  if (!isUsableId(id) || !brackets || typeof brackets.set !== "function") return undefined;
  const floor = usable(size?.tokens) ? size.tokens : 0;
  if (floor === 0) return undefined;
  const record = recordFor(brackets, id, seeded, now);
  if (floor > record.floor) record.floor = floor;
  if (floor > record.seen) record.seen = floor;
  record.seenAt = now;
  // A size the route served at or above one it turned down voids that refusal.
  // Refusing and then serving the identical request is something this route does:
  // on 2026-10-19 big-pickle answered a 1,600,000-character prompt with a 400
  // that named no code and then served the same request, counting 343,131 tokens,
  // and nemotron-3.5-super-vl-free answered two asks with a 500 before serving
  // all three sizes. A bound drawn by an endpoint that was about to fail is not
  // the wall's, and left in place it is permanent — `ceil` only ever comes down,
  // so the declaration could never climb back over a size the route had in fact
  // served. The refusal it cost is given back with it, because the budget in
  // MAX_REFUSALS is for refusals this file still believes.
  //
  // A window the route named in its own words is left alone: that is the route
  // stating a limit, not one endpoint misbehaving, and the same sweep found every
  // named number it re-asked hold still.
  if (!record.exact && usable(record.ceil) && floor >= record.ceil) {
    const was = record.ceil;
    record.ceil = undefined;
    // Counted after the give-back, the way `observeRefusedRequest` counts after
    // the increment: the line says how many refusals this model has cost, and a
    // number that includes the one being handed back would say one more than
    // stands.
    if (record.refusals > 0) record.refusals -= 1;
    note({ kind: "wall-unrefused", id, value: was, served: floor, refusals: record.refusals });
  }
  const ceiling = usable(record.ceiling) ? record.ceiling : seeded;
  // A raise has to be paid for by demand the host has shown SINCE the last one.
  // `seen` is the largest request this model has carried, so it stands still while
  // the host keeps sending the same conversation: comparing it against a ceiling
  // that a previous raise just moved is comparing old evidence to a new question.
  // The VPS shape makes it concrete — a host whose real demand was 326000 against a
  // wall at 330000 got the declaration lifted to 358600 and then to 391200 on two
  // consecutive rounds with no new request behind either, so the host built to
  // 391200, was refused, and spent the refusal budget on a size nothing had asked
  // for. Four rounds of that exhausted all four refusals and left the declaration
  // at 326000 for good, 4000 tokens under a wall it had already been told about.
  //
  // A raise is therefore allowed only when the largest request has grown past what
  // it was when the last raise happened. A host that never fills the declaration is
  // never guessed at, which is the same rule that keeps an idle model from being
  // probed at all.
  if (
    record.refusals < MAX_REFUSALS &&
    usable(ceiling) &&
    record.seen >= ceiling * RAISE_AT &&
    record.seen > (usable(record.raisedAtSeen) ? record.raisedAtSeen : 0) &&
    raisesAllowed(record, now)
  ) {
    // A raise is a raise only if it raises. The declaration may be pulled down by
    // a refusal — that is what a refusal is for, and the route is the one saying
    // so — but a probe that did not move it may not lower it: the request that
    // filled the declaration was served, and publishing a smaller window over it
    // is a statement the route never made.
    //
    // The derived value could be below the declaration even though the route
    // served the request that asked for it: the bound a refusal puts under a
    // declaration is a fraction of the size that was refused, and a window the
    // route named is above the cap this file searches under. Measured 2026-10-20:
    // a route that named a window of 2,000,000 tokens had it published as
    // 1,048,576 — the declaration went DOWN under a `wall-raised` note that said
    // it had gone up.
    //
    // So the declaration is raised and the raise is recorded separately, and
    // neither happens unless the declaration actually moved: a raise that does
    // not raise may not spend the demand that pays for the next one, because
    // the host cannot send a larger request than the window it was given, and
    // that window did not grow.
    const was = ceiling;
    // The step a raise would take, computed with the declaration it would be
    // derived from: the step is how far above the proven floor the declaration
    // is willing to go, so it is part of what the raise moves and is written
    // down only when the declaration moved with it.
    const step = Math.min(Math.max(record.step * 2, record.step + MIN_STEP), stepMax(seeded));
    const raised = derivedCeiling({ ...record, step }, seeded);
    if (usable(raised) && raised > was) {
      record.step = step;
      record.raisedAt = now;
      record.raisedAtSeen = record.seen;
      record.ceiling = raised;
      note({ kind: "wall-raised", id, value: raised, was, floor: record.seen, step });
    }
  }
  scheduleSave();
  return { ...record };
}

// A request the route refused. The refusal is the upper bound, and the
// declaration goes back to what the route is known to have served: the size it
// just turned down is not a size to declare again, and a step that overshot is
// halved before the next one. A refusal that named a window states the wall
// itself, which is better than any bracket and replaces it.
export function observeRefusedRequest(
  id,
  size,
  seeded,
  brackets = BRACKETS,
  now = Date.now(),
  named,
) {
  if (!isUsableId(id) || !brackets || typeof brackets.set !== "function") return undefined;
  const ceil = usable(size?.tokens) ? size.tokens : 0;
  if (ceil === 0 && !usable(named)) return undefined;
  const record = recordFor(brackets, id, seeded, now);
  // A refusal UNDER the largest size the route is known to have served is not a
  // bound. It cannot be one: a wall refuses what is above it and serves what is
  // below, so a refusal under a served size is the endpoint's opinion rather than
  // the wall's. Measured 2026-10-20 on `glm-5.3-flash-free`, whose upstream was
  // failing intermittently: a request of 547,384 characters was answered and one
  // of 540,983 was refused — an inversion no wall produces, and the bracket it
  // made (floor 136973 over ceiling 135381) is what the declaration was then
  // pinned to, at a third of the window the table holds and a size the same
  // route served forty thousand tokens above.
  //
  // So the refusal is void: it draws no bound, it does not spend the refusal
  // budget, and it does not reset the raise cooldown. The floor is a size the
  // route answered, and it is the strongest thing this file knows; a refusal
  // under it is noise by definition. This is the mirror of what a serve at or
  // above the ceiling already does, and it is the same rule the sweep's own
  // reduction has always applied — only the running plugin did not have it.
  if (ceil > 0 && record.floor > 0 && ceil < record.floor) {
    note({ kind: "wall-refusal-under-floor", id, refused: ceil, floor: record.floor });
    return { ...record };
  }
  record.refusals += 1;
  record.refusedAt = now;
  record.raisedAt = now;
  // The declaration is about to fall back to the floor, and the host's requests
  // are capped at that floor from then on — so the demand the next raise is paid
  // for has to be measured from here. `record.seen` is the largest request ever
  // carried and `raisedAtSeen` was set to it at the last raise, so leaving it
  // alone compares the maximum with itself and pins the bracket at the floor: the
  // route serves 255,000, the declaration is raised, the host builds to the raised
  // number and is refused, the declaration falls back to 255,000, and every
  // request after it is the same 255,000 that already paid for the first raise —
  // so no second raise ever happens and the remaining refusals are never spent.
  // Resetting the baseline makes re-filling the lowered declaration demand again;
  // the cooldown above is untouched, so the probe is still spaced.
  record.raisedAtSeen = 0;
  record.step = Math.max(Math.floor(record.step / 2), MIN_STEP);
  if (ceil > 0 && (record.ceil === undefined || ceil < record.ceil)) record.ceil = ceil;
  if (usable(named)) {
    // The route named the window in its own words: an exact number outranks
    // everything here, including the floor, and it is also the refusal bound.
    record.ceiling = named;
    record.ceil = Math.min(record.ceil ?? named, named);
    record.exact = true;
    record.seededFrom = usable(seeded) ? seeded : record.seededFrom;
  } else {
    // Back to the largest size the route is known to have served. A refusal is
    // evidence that what was declared is too big, and the floor is the only
    // number that is evidence of the opposite; the next raise, a halved step
    // above it and not before the cooldown, is what climbs back. A model with no
    // served request yet has no floor, and its declaration is derived from the
    // bound the refusal just put under it.
    //
    // `derivedCeiling` is never below the floor, so the smaller of the two is the
    // floor itself; it is written out rather than assumed because this is the one
    // line that used to sink the declaration under a size the route had served.
    // See the note on that clamp: a refusal 227 tokens above the floor put the
    // declaration 4344 tokens under it, permanently.
    const derived = derivedCeiling(record, seeded);
    record.ceiling =
      record.floor > 0 && usable(derived) ? Math.min(record.floor, derived) : derived;
  }
  note({
    kind: "wall-refused",
    id,
    value: record.ceiling,
    refused: ceil,
    named: usable(named) ? named : undefined,
    refusals: record.refusals,
  });
  scheduleSave();
  return { ...record };
}

const isUsableId = (id) => typeof id === "string" && id !== "";

// ---- what survives a restart ----------------------------------------------
//
// A bracket that is forgotten on every restart is a bracket that is re-learned
// by being refused again, which is the cost this whole section exists to avoid.
// So the state is one small JSON file: no directory walking, no per-model files,
// nothing that has to be cleaned up by hand. It is written atomically — a
// temporary file beside it and a rename over it — because a half-written state
// file is worse than none: it would be read as a bracket somebody measured.
// The temporary file is named per write and the writes are serialised behind
// each other, because two of them inside one process landing on one path is
// the same half-written file arriving by another road.
//
// Nothing here may fail a request. A file that cannot be written is a bracket
// that is not remembered; a file that cannot be read is a model with no history.
// Both are silent by design, and both are visible when the diagnostics sink is
// installed.
export const LIMITS_STATE_ENV = "OPENCODE_ZEN_FREE_LIMITS_STATE";
export const LIMITS_SNAPSHOT_ENV = "OPENCODE_ZEN_FREE_LIMITS_SNAPSHOT";
export const MAX_WINDOW_ENV = "OPENCODE_ZEN_FREE_MAX_WINDOW";
export const RAISE_COOLDOWN_ENV = "OPENCODE_ZEN_FREE_LIMITS_COOLDOWN_MS";
const DEFAULT_MAX_WINDOW = 1_048_576;
const RAISE_AT = 0.9;
const RAISE_COOLDOWN_MS = 15 * 60 * 1000;
const MIN_STEP = 1024;
const STEP_SEED_RATIO = 0.05;
const STEP_MAX_RATIO = 0.25;
// How many refusals one model may cost before the search stops. Every raise is
// a size the route has not been asked for yet, so an overshoot is a refused turn
// the user pays for; four of them, each half the size of the last, bracket the
// wall to a fraction of a per cent and then the declaration stops moving. A
// budget rather than a rule about precision, because what it bounds is the cost
// to somebody's conversation and not the quality of the bracket.
const MAX_REFUSALS = 4;
const REFUSAL_MARGIN = 0.02;
const STATE_VERSION = 1;
const STATE_ENTRIES = 500;
const STATE_LIMIT = 256 * 1024;
const SAVE_DEBOUNCE_MS = 5000;

// Where the sweep writes what it measured, and how much of it is worth reading.
// The file is checked in beside this module, so the path is this module's own
// directory rather than anything the environment has to say; the ceiling is the
// same one the state file is read under, and for the same reason — it is read by
// a request path that must not be talked into a large read.
const DEFAULT_SNAPSHOT_URL = new URL("./limits-observed.json", import.meta.url);
// The document ceiling for every snapshot this package reads — the walls file
// beside this module and the protocol file beside catalog.mjs alike. It is read
// by a request path that must not be talked into a large read.
export const SNAPSHOT_LIMIT = 256 * 1024;
// The shape of the snapshot this build reads. A file that names another version
// is a file written by a build that means something else by these rows.
const SNAPSHOT_VERSION = 1;

// What a served sample is floored to before it is declared. The route counts the
// prompt it was sent and the host counts the prompt it is planning, and the two
// never agree exactly; a whole thousand is the margin the table's own entries
// were rounded by, so a sweep value and a hand-written one are the same kind of
// number.
const SNAPSHOT_STEP = 1000;

// Where the state is kept: whatever the environment names, an empty string
// meaning "keep it in memory only", and otherwise one file in the cache
// directory this platform uses. `homedir` is the one of these that exists
// everywhere, so it is the last fallback rather than the first.
export function limitStatePath(explicit, env = globalThis.process?.env) {
  if (explicit !== undefined) return explicit;
  const named = env?.[LIMITS_STATE_ENV];
  if (typeof named === "string") return named;
  const home = homedir();
  const base = env?.LOCALAPPDATA || env?.XDG_CACHE_HOME || (home ? join(home, ".cache") : "");
  return base ? join(base, "opencode-zen-freex", "limits.json") : "";
}

let stateLoads = new Map();
let saveTimer = null;

// Read the state, once per file. Answers whether anything was read; a missing
// file, an unreadable one and one holding another shape all answer the same way,
// because they all mean the same thing: this process starts with what the table
// says. Keyed by the file rather than remembered once, so a caller that names a
// path of its own — a test, or a host keeping its state somewhere else — is not
// answered with the result of somebody else's read.
export async function loadLimitState(file = limitStatePath()) {
  if (!file) return false;
  const held = stateLoads.get(file);
  if (held) return held;
  const load = (async () => {
    try {
      const text = await readFile(file, { encoding: "utf8" });
      if (typeof text !== "string" || text.length > STATE_LIMIT) return false;
      const parsed = JSON.parse(text);
      const models = parsed?.models;
      if (!models || typeof models !== "object" || parsed?.version !== STATE_VERSION) return false;
      let read = 0;
      for (const id of Object.keys(models).slice(0, STATE_ENTRIES)) {
        if (!isUsableId(id) || read >= STATE_ENTRIES) continue;
        const record = readRecord(models[id]);
        if (!record) continue;
        if (!BRACKETS.has(id)) BRACKETS.set(id, record);
        read += 1;
      }
      return read > 0;
    } catch {
      return false;
    }
  })();
  stateLoads.set(file, load);
  return load;
}

// A record as it can be trusted: own values, integers of the right sign, and
// nothing else carried in. A state file is a file, and one that has been edited
// by hand, truncated by a full disk or written by another version is not
// evidence about a model until every field has been checked.
function readRecord(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  // A record measured on another scale is not this record. The floor and the
  // ceiling are token counts this file produced, so a file written by an
  // estimator that counted something else holds numbers about a different
  // quantity: a floor of 228286 taken while a long conversation was read to a
  // fifth of its length is not a size the route was shown to serve on the scale
  // used now. Dropping it leaves the model with the table's own number, which is
  // the measurement the sweep made on this scale, instead of bounding it with a
  // count whose unit was wrong.
  if (raw.scale !== ESTIMATE_SCALE) return undefined;
  const floor = usable(raw.floor) ? raw.floor : 0;
  const ceiling = usable(raw.ceiling) ? raw.ceiling : undefined;
  if (!floor && ceiling === undefined) return undefined;
  const record = { floor, ceiling };
  record.ceil = usable(raw.ceil) ? raw.ceil : undefined;
  record.exact = raw.exact === true;
  record.step = usable(raw.step) ? raw.step : seedStep(ceiling);
  record.scale = ESTIMATE_SCALE;
  record.refusals = Number.isSafeInteger(raw.refusals) && raw.refusals >= 0 ? raw.refusals : 0;
  record.raisedAtSeen = usable(raw.raisedAtSeen) ? raw.raisedAtSeen : 0;
  record.seen = usable(raw.seen) ? raw.seen : 0;
  record.seededFrom = usable(raw.seededFrom) ? raw.seededFrom : ceiling;
  record.raisedAt = Number.isFinite(raw.raisedAt) ? raw.raisedAt : 0;
  record.refusedAt = Number.isFinite(raw.refusedAt) ? raw.refusedAt : 0;
  record.seenAt = Number.isFinite(raw.seenAt) ? raw.seenAt : 0;
  return record;
}

// Write the state, at most once per debounce window: a bracket moves on a
// request, and a request is not a reason to write a file. The write is
// deliberately not awaited by anyone — a request that has already been answered
// must not wait for a disk — and a failure is dropped rather than raised.
function scheduleSave() {
  if (saveTimer) return;
  const wait = saveDebounce();
  if (wait === 0) {
    void saveLimitState();
    return;
  }
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveLimitState();
  }, wait);
  saveTimer?.unref?.();
}

function saveDebounce(env = globalThis.process?.env) {
  const named = Number.parseInt(env?.[`${LIMITS_STATE_ENV}_DEBOUNCE_MS`] ?? "", 10);
  return Number.isSafeInteger(named) && named >= 0 ? named : SAVE_DEBOUNCE_MS;
}

// The file this process would write, as JSON. Exported so a test can hold the
// bytes rather than the file, and so a caller that writes its own state has one
// shape to write.
export function limitStateJSON(brackets = BRACKETS) {
  // A null-prototype map, for the reason `readLimitState` builds one: an id is
  // whatever a caller's Map holds, and `models["__proto__"] = row` on a plain
  // object runs `Object.prototype`'s setter instead of adding a row. The row
  // would be lost from the file — and the file is what a restart reads back as
  // a measurement. `JSON.stringify` writes the same bytes for either object.
  const models = Object.create(null);
  let written = 0;
  for (const [id, record] of brackets) {
    if (!isUsableId(id) || written >= STATE_ENTRIES) continue;
    const row = {
      floor: usable(record.floor) ? record.floor : 0,
      ceiling: usable(record.ceiling) ? record.ceiling : undefined,
      step: usable(record.step) ? record.step : undefined,
      scale: ESTIMATE_SCALE,
      refusals: Number.isSafeInteger(record.refusals) ? record.refusals : 0,
      raisedAtSeen: usable(record.raisedAtSeen) ? record.raisedAtSeen : 0,
      seen: usable(record.seen) ? record.seen : 0,
      seededFrom: usable(record.seededFrom) ? record.seededFrom : undefined,
      raisedAt: Number.isFinite(record.raisedAt) ? record.raisedAt : 0,
      refusedAt: Number.isFinite(record.refusedAt) ? record.refusedAt : 0,
      seenAt: Number.isFinite(record.seenAt) ? record.seenAt : 0,
    };
    if (usable(record.ceil)) row.ceil = record.ceil;
    if (record.exact === true) row.exact = true;
    models[id] = row;
    written += 1;
  }
  return JSON.stringify({ version: STATE_VERSION, models });
}

// The temporary file a write goes through, and the counter that keeps two
// writes from sharing one. The name used to be fixed per process, so two saves
// overlapping inside this process wrote the same path: the second truncated the
// file the first was about to rename, and the rename failed — a save that
// returned false for a state file that was there. Measured 2026-10-20: a second
// `saveLimitState()` answered false because of exactly that race.
let saveSequence = 0;

// The save in flight, if any. The writes are serialised behind it, because a
// rename is atomic but two renames of two temporary files are not one another's
// order: the state file has to hold one whole state, and the reader takes it
// as measured brackets.
let saveInFlight = Promise.resolve();

export async function saveLimitState(file = limitStatePath(), brackets = BRACKETS) {
  if (!file || brackets.size === 0) return false;
  const write = async () => {
    try {
      // The bytes are taken when the write happens, not when it was asked for:
      // a save that waited behind another one has the newer state to write.
      const text = limitStateJSON(brackets);
      if (text.length > STATE_LIMIT) return false;
      await mkdir(dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.${saveSequence++}.tmp`;
      await writeFile(temporary, text, { encoding: "utf8" });
      await rename(temporary, file);
      return true;
    } catch {
      return false;
    }
  };
  // Behind the write in flight, if there is one. A failure is not carried
  // forward: the next save is a save of its own and does not inherit the last
  // one's trouble.
  const run = saveInFlight.then(write, write);
  saveInFlight = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// Two decisions this file makes leave no trace of themselves: a live value
// taken from a refusal is applied past the staleness guard and past the
// raise-only rule, and an entry the catalogue has moved past is void in a way
// that reads exactly like an axis nobody ever measured. Neither is worth a line
// while the plugin is working — an error path that chats is its own kind of
// failure — so both are only reported when they are asked for: a host hands in
// a sink with `limitDiagnostics`, or sets this variable and reads stderr.
// Nothing a note does may reach a request: not the sink, not what it prints.
export const LIMITS_DEBUG_ENV = "OPENCODE_ZEN_FREE_LIMITS_DEBUG";
let diagnostic = null;

// Install the sink these notes are handed to, and return the one it replaced
// (null when there was none) so a caller can put back what it found.
export function limitDiagnostics(sink) {
  const previous = diagnostic;
  diagnostic = typeof sink === "function" ? sink : null;
  return previous;
}

function note(entry) {
  try {
    if (diagnostic) diagnostic(entry);
    else if (globalThis.process?.env?.[LIMITS_DEBUG_ENV])
      console.warn(`[opencode-zen-freex] ${describe(entry)}`);
  } catch {
    // A note is not worth a failed request.
  }
}

function describe({ kind, id, axis, value, measuredAgainst, declared, was, floor, step, refused, named, served, refusals, wall, at }) {
  if (kind === "route-statement")
    return `${id} ${axis}=${value} — named by a refusal this process saw, so it is applied as it stands (the catalogue declares ${declared === undefined ? "nothing for this axis" : declared})`;
  if (kind === "sweep-statement")
    return `${id} ${axis}=${value} — measured by the scheduled sweep (${wall === undefined ? "wall not recorded" : wall}${at === undefined ? "" : `, ${at}`}), so it is applied as it stands (the catalogue declares ${declared === undefined ? "nothing for this axis" : declared})`;
  if (kind === "wall-raised")
    return `${id} context=${value} — up from ${was}: the host filled ${floor} of it and the route served that, so the declaration is probing ${step} further`;
  if (kind === "wall-refused")
    return `${id} context=${value} — back under the wall: the route refused a request of about ${refused} tokens${named === undefined ? "" : ` and named a window of ${named}`}, ${refusals} refused so far`;
  if (kind === "wall-unrefused")
    return `${id} context — the refusal of about ${value} tokens is dropped: the route went on to serve ${served}, which that bound had ruled out, and the refusal it cost is given back (${refusals} refused so far)`;
  return `${id} ${axis}=${value} was measured against a catalogue that declared ${measuredAgainst}, and this one declares ${declared === undefined ? "nothing for this axis" : declared}: not applied`;
}

// The window a refusal names, or undefined when the body says nothing
// attributable. Exported for the tests and for anyone reading a capture.
export function namedContextWindow(text) {
  return namedFrom(NAMED_CONTEXT, text)?.value;
}

// The completion ceiling a refusal names, or undefined. Same rule as the window:
// the body has to name the parameter and a number, or it says nothing. Two
// wordings state it, and one that matches but names no usable number — "supports
// at most 0 completion tokens" — is not an answer; the next wording may be.
export function namedOutputCap(text) {
  return namedFrom(NAMED_OUTPUT, text)?.value;
}

// The first of `patterns` that names a usable number, with the match it was read
// from. The match and the number have to be the same one: a caller that guards a
// match and then reads its number elsewhere is judging one sentence and
// returning another.
function namedFrom(patterns, text) {
  const subject = typeof text === "string" ? text : "";
  for (const pattern of patterns) {
    const match = pattern.exec(subject);
    const value = numberFrom(match);
    if (value !== undefined) return { match, value };
  }
  return undefined;
}

// The number a match names, or undefined when it names nothing usable: a
// sentence about a parameter that happens to mention zero names no ceiling.
function numberFrom(match) {
  if (!match) return undefined;
  const tokens = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined;
}

// Read at most `limit` characters of a response without buffering the rest:
// this is an error path on a request whose caller is waiting, so a body that is
// not small is dropped as soon as the part that is read is in hand. Returns the
// text, and whether the read stopped because the body ended (`ended`) or because
// the budget was reached (`over`).
//
// It reads the response's own body, not a copy of it. `response.clone()` tees a
// body, and cancelling one branch of a tee settles only once the other branch is
// drained or cancelled — which for the caller's path is never, because the
// sibling branch is read later, after this returns. A clone here hangs the whole
// request on any refusal larger than the budget that arrives in more than one
// read (measured: a 7 KB 400 in 1400-character chunks never settles, and an
// abort does not unwedge it). The body is read once and the bytes go back to
// the caller, so nothing needs a second copy.
//
// The read is bounded in time as well as in size, because a body can stall as
// well as be large. Measured: a 403 whose `content-length` promised 999 bytes
// and delivered 120 left `read()` pending for good, which hung the request just
// as surely as the clone did — an upstream that dies mid-body, or a proxy that
// pads a length, is the same shape. `signal` is the caller's own cancellation;
// without one the budget below is all the wait this evidence is worth, since a
// number out of a refusal that is not arriving is not worth a caller's turn.
//
// A body that fails halfway is still worth what was read of it, and a read that
// throws is not an error about the request: the callers of this are error paths
// themselves.
const READ_DEADLINE_MS = 3000;

// The two ways a wait may end, as one signal.
//
// `AbortSignal.any` was added in Node 20.3 and backported to 18.17, so the
// package's declared floor has it. The helper below still keeps a hand-made
// combination for a runtime that does not (an older 18.x a host might run, or a
// non-Node runtime): a discovery or refusal read that cannot combine its waits
// must not lose the abort on the error path. The native call is preferred when
// it exists; the fallback is the same rule, not a different one.
//
// Exported because the same call is made elsewhere in this plugin for the same
// reason, and one implementation of it is one thing to get right.
export function linkAbortSignals(signals) {
  const controller = new AbortController();
  const bound = [];
  for (const source of signals) {
    if (!source || typeof source.addEventListener !== "function") continue;
    if (source.aborted) {
      controller.abort(source.reason);
      break;
    }
    const onAbort = () => {
      if (controller.signal.aborted) return;
      controller.abort(source.reason);
    };
    source.addEventListener("abort", onAbort, { once: true });
    bound.push([source, onAbort]);
  }
  return {
    signal: controller.signal,
    // The sources are somebody else's — one of them is the caller's own
    // cancellation — and a listener left on them outlives the wait that asked
    // for it. `AbortSignal.any` does not need this; the hand-made one does.
    dispose() {
      for (const [source, onAbort] of bound) source.removeEventListener("abort", onAbort);
      bound.length = 0;
    },
  };
}

// The combination, with the runtime's own when it has one. Answers a signal and
// the way to let go of it, so a caller reads the same either way.
export function anyAbortSignals(signals) {
  if (typeof globalThis.AbortSignal?.any === "function")
    return { signal: globalThis.AbortSignal.any(signals), dispose() {} };
  return linkAbortSignals(signals);
}

export async function readBoundedText(response, limit = 4096, { signal } = {}) {
  let reader;
  try {
    reader = response?.body?.getReader?.();
  } catch {
    // A body somebody else is holding cannot be read, and nothing of it was
    // read: what came back is not the whole of a body, and says so.
    return { text: "", ended: false, over: true };
  }
  // A response with no stream has no body to read and none to buffer — which is
  // why the fallback that read one whole is gone: the only responses that
  // reached it were body-less, and a body-less response's text is empty either
  // way.
  if (!reader) return { text: "", ended: true, over: false };
  const deadline = AbortSignal.timeout(READ_DEADLINE_MS);
  const combined = signal ? anyAbortSignals([signal, deadline]) : undefined;
  const bound = combined ? combined.signal : deadline;
  // The wait ending is this read's to remember, not the reader's: cancelling a
  // stream resolves its pending `read()` as done, so a body cut short by the
  // deadline would come back looking like one that ended — and a number at the
  // end of it like a whole one. Measured before this flag existed: a stalled
  // refusal whose last characters were `...is not less or equal to 2621`, out of
  // `262144`, was stored and applied as a completion ceiling. It is set twice:
  // here, where the wait is over, and in the loop below, where a cut lands
  // inside a character and the half of it is dropped rather than kept.
  let cut = false;
  const abort = () => {
    // The wait is over and the bytes already read are all this evidence is
    // going to be; stop pulling on a body that is not answering.
    cut = true;
    reader.cancel().catch(() => {});
  };
  if (bound.aborted) abort();
  else bound.addEventListener("abort", abort, { once: true });
  const decoder = new TextDecoder();
  let text = "";
  let ended = false;
  try {
    // The loop runs while the budget has room for one more character, so a body
    // that lands exactly on the budget still gets the read that says it ended,
    // and one that goes on is caught by the buffer stopping a character past it.
    while (text.length <= limit) {
      const { value, done } = await reader.read();
      if (done) {
        ended = true;
        break;
      }
      // At most one character past the budget: enough to know the body went on,
      // and the rest of the chunk is dropped rather than materialised. The cut
      // is a code-unit cut, so it has to be moved off a surrogate pair: a
      // character outside the basic plane — an emoji, a rare ideograph, anything
      // above U+FFFF — is two code units, and keeping the high half on its own
      // leaves the text ending in half a character, which `String.length` counts
      // as one and which a caller repeating this body has no way to render. The
      // half is dropped rather than completed — the character it belongs to is
      // past the budget either way, and reading a character further to keep a
      // whole one is exactly the promise this loop does not make — and the read
      // remembers that it did not keep everything it read: a character the body
      // held is missing from `text`, so this is not the whole body however the
      // stream ends. That is `cut`'s own meaning, and the one place it is set
      // outside the wait being over.
      const decoded = decoder.decode(value, { stream: true });
      let taken = Math.min(decoded.length, limit + 1 - text.length);
      const last = decoded.charCodeAt(taken - 1);
      if (last >= 0xd800 && last <= 0xdbff) {
        taken -= 1;
        cut = true;
      }
      text += decoded.slice(0, taken);
    }
  } catch {
    // Keep what was read; a failed read names nothing new. A read that was
    // cancelled by the deadline lands here too, which is the point of it.
  }
  bound.removeEventListener("abort", abort);
  // ...and the sources the wait was watching go back to whoever owns them.
  combined?.dispose();
  // A read the wait cut short saw no end of body, whatever the cancelled reader
  // said about it.
  if (cut) ended = false;
  // The reader is this function's to release, and the body is abandoned rather
  // than left open: the caller has what it needs and will not read on.
  //
  // The cancel is deliberately not awaited. It stops the upstream either way,
  // but the promise it returns settles only once the source reacts — and this
  // path is an error body on a request whose caller is waiting. A body that
  // never ends (a stalled upstream, or headers promising more bytes than the
  // response delivers: measured, a 403 with `content-length: 999` over a 120-byte
  // body) would leave the await pending for good, which is the same hang this
  // function was rewritten to remove. Nothing downstream reads this body again,
  // so its release is nobody's to wait for.
  reader.cancel().catch(() => {});
  // `over` is the read having stopped before the body did — the budget reached,
  // the read failed, the deadline passing, or a character the cut broke in half
  // and this read did not keep — which is the only honest source for "this may
  // be cut".
  return { text, ended, over: !ended };
}

// Read a refusal for the names it makes about this model's limits. Only non-2xx
// responses are read, and only the first `limit` characters of one.
//
// A response body can only be read once, and the response handed in is treated
// as read once this returns: the bytes come back as `text` so that a caller
// which has to keep them (provider.mjs rebuilds the message a user reads) can
// do so without a second read of a body that no longer exists.
//
// `cut` says the read stopped at the budget rather than at the end of the body.
// It is the read that says so, not the length of what was read: a body whose
// first read lands exactly on the budget leaves `text.length === limit` while
// the stream is still going, and a number sliced there (`262144` read as
// `2621`) must not be taken for a limit the route stated.
//
// `ended` is the read's own answer to "is this the whole body?": true when the
// body was read to its end, false when the budget, the deadline or a failed
// read stopped it short — a read that got nothing at all included, which is the
// same answer for a different reason. A caller that hands these bytes on has to
// know which of the two it holds: a prefix presented as the whole reply is a
// lie the caller cannot see, and the bytes cannot be gone back for, since this
// read is the body's one reader.
//
// Returns undefined only when nothing was read — a response that is not a
// refusal, or one with no body to read — and otherwise whichever axes the text
// named, with that text alongside them. An axis the body did not name is
// undefined; a body that named nothing still comes back, because a caller that
// has to hand it on has nowhere else to get it from.
export async function observeRouteStatement(id, response, limit = 4096, { signal } = {}) {
  try {
    if (typeof id !== "string" || !id || response?.ok !== false) return undefined;
    // A response with no body was not read and is not consumed: the caller
    // still holds the one it had, and undefined says so. Written out rather
    // than left to a loose comparison, which the project's rules do not allow
    // and which would also answer for a body that is not one of these two.
    if (response.body === null || response.body === undefined) return undefined;
    const { text, over, ended } = await readBoundedText(response, limit, { signal });
    const { context, output } = namedAxes(text, limit, over);
    if (context !== undefined) OBSERVED.set(id, context);
    if (output !== undefined) OBSERVED_OUTPUT.set(id, output);
    return { context, output, text, ended };
  } catch {
    return undefined;
  }
}

// Where the number a match named ends, in the text it was matched against. The
// `d` flag is what makes this exact: `NAMED_CONTEXT` and the first
// `NAMED_OUTPUT` run on past the digits (" completion tokens"), so judging the
// cut by the match's own end threw away numbers that were provably whole — the
// digits ended well before the read did, with text after them that the greedy
// `(\d+)` had refused to consume.
function digitsEnd(found) {
  const at = found?.match?.indices?.[1]?.[1];
  // The match's own end is the conservative answer when the pattern cannot say
  // where the digits are: it drops a whole number rather than reading a cut one,
  // which is the direction this guard has to fail in.
  return Number.isSafeInteger(at) ? at : found.match.index + found.match[0].length;
}

// The axes the first `limit` characters of `text` name. `cut` says the read
// stopped before the body did, so a number whose own digits reach the last
// character read may have had digits past it: that axis is left unread rather
// than reported a digit short. Any character after the digits inside the head
// proves the number ended, since a greedy `\d+` would have taken it — only
// digits touching the boundary are ambiguous. Each axis is read from the match
// its number came from, so the match the guard judges and the number that is
// returned cannot be two answers.
export function namedAxes(text, limit, cut) {
  const head = text.slice(0, limit);
  const context = namedFrom(NAMED_CONTEXT, head);
  const output = namedFrom(NAMED_OUTPUT, head);
  const onCut = (found) => cut && found !== undefined && digitsEnd(found) >= head.length;
  return {
    context: onCut(context) ? undefined : context?.value,
    output: onCut(output) ? undefined : output?.value,
  };
}

// Which axis a refusal is about, or none at all. This route answers a 400 with a
// body for everything it does not like, and only some of those say anything
// about a size: a rate limit, a gateway fault, and a 400 about a parameter this
// route did not accept all arrive the same way. Feeding one of those to the
// bracket lowers a declaration over a fault that had nothing to do with length,
// and it spends part of a refusal budget that is four refusals deep.
//
// So the axis is read from what the refusal says. A number it names decides it
// first, because a numbered sentence is the route stating a limit and cannot be
// anything else. A refusal that names no number is read from its own words, and
// the unnamed too-long refusal this route sends most often is in those words:
// `context_length_exceeded`, and a sentence about the maximum context length the
// request went past. A refusal about `max_tokens` is the other axis, and one
// that says neither — `invalid request`, an empty body, a 500 — is about no axis
// and moves nothing.
//
// Only 400 and 413 can be about size. A 5xx is the endpoint failing rather than
// the request being long, which is not a distinction to guess at: on 2026-10-19
// nemotron-3.5-super-vl-free answered 500 to two asks and then served the
// identical requests, and a 500 read as a refusal would have declared that model
// a third smaller than it is. A 401 or a 429 says nothing about the request that
// was sent at all.
const SIZE_STATUS = new Set([400, 413]);
const CONTEXT_TALK = [
  /context length/i,
  /context_length_exceeded/i,
  /token count exceeds/i,
  /reduce the length of the messages/i,
  /prompt is too long/i,
  /messages are too long/i,
  /exceeds the maximum/i,
  // "invalid params, context window exceeds limit (2013)" — the same refusal in
  // the route's other words, measured 2026-10-20 on `minimax-m3.1-flash-free`
  // and `beam-free`, and it was missing here: a 400 that names no number and
  // says none of the sentences above read as about no axis at all, so the
  // plugin did not learn a wall the route had just named in the only words it
  // used, and the sweep — which counted every 400 as a bound — learned it
  // anyway. The two disagreed about the same event, and the one that was wrong
  // about it was the careful one.
  /context window exceeds/i,
];
const OUTPUT_TALK = [/max_tokens/i, /completion tokens/i];

export function refusalAxis(status, text, axes = {}) {
  const named = axes && typeof axes === "object" ? axes : {};
  if (usable(named.context)) return "context";
  if (usable(named.output)) return "output";
  if (!SIZE_STATUS.has(status)) return undefined;
  const said = typeof text === "string" ? text : "";
  if (CONTEXT_TALK.some((pattern) => pattern.test(said))) return "context";
  if (OUTPUT_TALK.some((pattern) => pattern.test(said))) return "output";
  return undefined;
}

const ROUTE_TIERS = new Set(["route", "route-twin", "route-sweep"]);

// The tier a measured wall is published under, and the wording the diagnostics
// sink uses for it.
const SWEEP_SOURCE = "route-sweep";

// Where the last sweep's measurements are read from: whatever the environment
// names, and otherwise the file the sweep writes beside this module. Returned as
// a path rather than read here, so a caller that names one of its own — a test,
// a host keeping the file somewhere else — is answered with its own file.
export function limitsSnapshotPath(explicit, env = globalThis.process?.env) {
  if (explicit !== undefined) return explicit;
  const named = env?.[LIMITS_SNAPSHOT_ENV];
  if (typeof named === "string") return named;
  return fileURLToPath(DEFAULT_SNAPSHOT_URL);
}

// The measurements, one read per file and never a second one: the file is an
// input that changes when somebody commits a run's result, not while a process
// serves requests, and re-reading it on every model list would be a syscall per
// listing for an answer that cannot have moved.
const wallReads = new Map();

// The remote snapshot this process has installed, if any. It is kept apart from
// `wallReads` because it is not a read of a file: it is an answer that arrived
// over the network or out of the remote cache, and `measuredWalls(undefined)`
// answers from it before it looks at any path. It has no path to key a read on,
// which is why the per-file cache cannot hold it.
let installedSnapshot;

// Whether a row tells one story about its own ceiling. The sweep writes the
// first refused size twice — as `refusedChars` and as the head of
// `refusedSizes` — and a row whose two copies disagree was edited by hand into
// a state where it says two things about one number. There is no reading of
// that which is the measurement, so the row is not one.
function rowAgreesWithItself(row) {
  const scalar = row?.refusedChars;
  const list = row?.refusedSizes;
  // A row that names neither carries no copy of the ceiling and contradicts
  // nothing: the sweep writes both, but a row written by hand may carry only
  // what it was asked for.
  if (scalar === undefined) return true;
  if (list !== undefined && !Array.isArray(list)) return false;
  const first = Array.isArray(list) ? list[0] : undefined;
  // "Nothing was refused" is `null` beside an empty list, and one of the two
  // without the other is a row that says a refusal happened and does not say
  // which.
  if (scalar === null) return first === undefined;
  return first === scalar;
}

// What the sweep measured, as the context axis may use it. One entry per id that
// has a served sample: the largest prompt the route was watched to serve, floored
// to a whole thousand so a host whose count differs from the route's is still
// under it — the same rounding, and for the same reason, as the values in the
// table above.
//
// `settles` is whether the sweep hit the wall at the number: a bracketed wall had
// something bigger refused, so the sample is a point the wall is known to sit
// above and the axis can be answered with it either way. A wall the sweep never
// hit is a floor — the route served this much and said nothing about the rest —
// and a floor under the declaration says nothing about the declaration, so it may
// only raise.
//
// A missing file, an unreadable one and one holding another shape all answer the
// same way — no measurement — because they all mean the same thing: this build
// declares what its table and its catalogue say and nothing else. Nothing here
// may fail a request, so nothing here throws.
//
// A version this build does not know is the same answer. The `version` field
// says what shape the rows are in, and a file written by another build may hold
// rows this one would read as measurements of something else — which is what
// the field is for. The state file is read the same way, and has been since it
// was written.
//
// A row that says how many CHARACTERS the route served and not how many tokens
// is not read here either, and that is a decision rather than an oversight. The
// route served the prompt but sent back no count of its own, so the row holds a
// size this file did not receive from the route — and the only way to turn
// characters into tokens here is the estimator's own ratio, which exists to
// guess how big a REQUEST is so that a request may be sent. `estimateTokens`
// says so itself: the sweep does not use it at all, it asks the route and reads
// `prompt_tokens`. The same ratio turned into a declaration would publish an
// estimate as the wall the route enforces, which is the one thing a declaration
// is not allowed to be: the numbers on this axis are the route's own counts or
// the ones the sweep read back, and a row without one of those is a floor this
// file cannot state.
//
// So such a row is invisible here on purpose. The sweep keeps it — a route that
// served without counting is evidence that it serves — and the table's own
// number still stands for that model, which is the declaration a build makes
// when nothing here has measured anything.
export function measuredWalls(file) {
  // An installed remote answer is the answer for "no file named" — but only
  // then, and only while no local source is pinned. The precedence the provider
  // relies on is: explicit file > env path > installed remote > bundled, with the
  // installed map standing in for the bundled file rather than over a local file
  // an operator named. An explicit file (including `""`, which says "no source")
  // asked about that source; an env path is the same choice made once for the
  // process; only with neither is the remote answer the one to read.
  //
  // Presence, not truthiness: `OPENCODE_ZEN_FREE_LIMITS_SNAPSHOT=""` is the
  // operator saying "no snapshot at all", and an installed answer must not
  // survive that decision. `Object.hasOwn` distinguishes a variable set to empty
  // from one nobody set.
  if (file === undefined && installedSnapshot) {
    const env = globalThis.process?.env;
    if (!(env && Object.hasOwn(env, LIMITS_SNAPSHOT_ENV))) return installedSnapshot.walls;
  }
  const path = limitsSnapshotPath(file);
  if (!path) return new Map();
  const held = wallReads.get(path);
  if (held !== undefined) return held;
  const walls = new Map();
  wallReads.set(path, walls);
  try {
    const text = readFileSync(path, { encoding: "utf8" });
    if (typeof text !== "string" || text.length > SNAPSHOT_LIMIT) return walls;
    const document = JSON.parse(text);
    if (document?.version !== SNAPSHOT_VERSION) return walls;
    const models = document?.models;
    if (!models || typeof models !== "object" || Array.isArray(models)) return walls;
    for (const [id, row] of Object.entries(models)) {
      if (!isUsableId(id)) continue;
      // A row that disagrees with itself is not a measurement. `refusedChars` is
      // the first refused size written down twice — once as a number and once
      // as the head of the list — and a row edited by hand into a state where
      // the two copies differ says two things about one ceiling. Which of them
      // to believe is a guess, so the row is not read at all: it is the same
      // answer as a row that was never measured.
      if (!rowAgreesWithItself(row)) continue;
      const wall = typeof row?.wall === "string" ? row.wall : undefined;
      const at = typeof row?.at === "string" ? row.at : undefined;
      // A window the route stated in its own words answers the axis outright: it is
      // the route's own number, not a bracketed floor, so it settles the axis and
      // needs no rounding down. This is the strongest evidence any tier here has,
      // and the sweep keeps it beside the bracket it also measured.
      const named = row?.named;
      if (usable(named)) {
        walls.set(id, { value: named, settles: true, wall: "named", at });
        continue;
      }
      const tokens = row?.servedTokens;
      if (!usable(tokens)) continue;
      const value = Math.floor(tokens / SNAPSHOT_STEP) * SNAPSHOT_STEP;
      if (!usable(value)) continue;
      walls.set(id, { value, settles: wall === "bracketed", wall, at });
    }
  } catch {
    // No measurement is not a failure: it is a build that declares what it says.
  }
  return walls;
}

// ---- the snapshot as a remote input -----------------------------------------
//
// The snapshot beside this module is the scheduled sweep's own answer, written by
// a workflow and committed with the table it corrects. It is right for a checkout
// of this repository and right for the tarball, and it is wrong for the hour
// after a sweep has published a new measurement and before the next release has
// been cut: a host runs the number that shipped with it, not the number the route
// taught since.
//
// So the same file is also published where a host can read it, and this section
// is only the core of that: where the URL is, where the cache is, how often and
// how long one fetch may take, one parser both sources share, and one installed
// Map that `measuredWalls()` answers from before it reaches for the bundled file.
// The provider owns the when (the refresh timer, the fallback order, the
// diagnostics line); nothing here starts a timer, installs anything by itself or
// fails a request.
//
// Every path into this section is bounded and fallible in the same direction: a
// URL, a cache file and a response are all inputs this file did not write, so a
// bad one is no measurement rather than a throw, and a remote answer is installed
// only after the whole document has been parsed and validated. An installed Map
// is replaced as a whole or not at all — `installSnapshot` copies before it
// assigns — so a half-read document can never be the state a request reads.
export const LIMITS_SNAPSHOT_URL_ENV = "OPENCODE_ZEN_FREE_LIMITS_SNAPSHOT_URL";
export const LIMITS_SNAPSHOT_CACHE_ENV = "OPENCODE_ZEN_FREE_LIMITS_SNAPSHOT_CACHE";
export const LIMITS_SNAPSHOT_REFRESH_ENV = "OPENCODE_ZEN_FREE_LIMITS_SNAPSHOT_REFRESH_MS";
export const LIMITS_SNAPSHOT_TIMEOUT_ENV = "OPENCODE_ZEN_FREE_LIMITS_SNAPSHOT_TIMEOUT_MS";
export const DEFAULT_LIMITS_SNAPSHOT_URL =
  "https://raw.githubusercontent.com/tkhs101/OpenCode-Zen-FreeX/main/limits-observed.json";

// The remote document's own bounds. They mirror the sweep's write-side rules and
// `limits-watch.mjs`'s check: a file a host downloads is even less trusted than
// one it reads beside itself, because nobody reviewing a diff has seen it. The
// token/character bounds are deliberately generous — the largest window this
// route serves is 1,048,576 tokens and the ladder stops around 4.2M characters —
// and exist to catch a unit error or a runaway probe, not to second-guess a
// measurement.
// A 256 KiB document can legally hold more than a thousand rows, but only if
// each is near the minimum; ten thousand was a bound no real snapshot would
// reach and, at this document ceiling, one no test could construct either. A
// thousand is still far above the sweep's current shape (single digits) and
// leaves the row bound reachable and tested.
const SNAPSHOT_ROWS_LIMIT = 1_000;
const SNAPSHOT_TOKENS_LIMIT = 4_000_000;
const SNAPSHOT_CHARS_LIMIT = 32_000_000;
const SNAPSHOT_TOKEN_CHAR_SLACK = 4096;
const SNAPSHOT_REFRESH_DEFAULT = 3_600_000;
const SNAPSHOT_TIMEOUT_DEFAULT = 5_000;
const SNAPSHOT_TIMEOUT_MIN = 100;
const SNAPSHOT_TIMEOUT_MAX = 60_000;
const SNAPSHOT_WALLS = new Set(["bracketed", "single-refusal", "openEnded", "named"]);

// A whole-number setting with a floor, a ceiling and a default. Only a safe
// integer in range counts; an explicit value that is not one is not a reason to
// read the environment after it — the caller said something, and the default is
// the honest answer to "something this file does not understand".
function numberSetting(explicit, env, name, { min, max, fallback }) {
  const usable = (value) => Number.isSafeInteger(value) && value >= min && value <= max;
  if (explicit !== undefined) {
    const value = typeof explicit === "string" && explicit !== "" ? Number(explicit) : explicit;
    return usable(value) ? value : fallback;
  }
  const named = env?.[name];
  if (typeof named === "string" && named !== "") {
    const value = Number(named);
    return usable(value) ? value : fallback;
  }
  return fallback;
}

// Where the remote snapshot is read from. An operator who pinned a local snapshot
// path — `LIMITS_SNAPSHOT_ENV` present at all, including empty — has chosen the
// source, and the remote is off rather than fighting that choice. An explicit
// string is the caller's own answer and wins over both; `""` disables the remote
// the same way in every layer.
export function limitsSnapshotURL(explicit, env = globalThis.process?.env) {
  if (explicit !== undefined) {
    if (typeof explicit !== "string") return undefined;
    return explicit === "" ? undefined : explicit;
  }
  // A pinned local source is a decision about where the snapshot comes from, so
  // it settles the question before the URL variable is read. This is checked
  // first for presence, not truthiness: `""` (no snapshot) is still a decision,
  // and it must disable the remote rather than race it.
  if (env && Object.hasOwn(env, LIMITS_SNAPSHOT_ENV)) return undefined;
  // Presence and emptiness are different answers: a URL written is a URL chosen,
  // and `""` is how the environment says "no" — an absent variable is not a
  // disable, it is "nothing said here", which falls through to the default.
  const named = env?.[LIMITS_SNAPSHOT_URL_ENV];
  if (typeof named === "string") return named === "" ? undefined : named;
  return DEFAULT_LIMITS_SNAPSHOT_URL;
}

// Where the remote snapshot is cached between runs. The default is the same
// platform cache directory the limits state uses, with a file name of its own so
// a remote answer is never mistaken for the state this process wrote. An empty
// string disables the cache, which is a supported deployment: the snapshot is an
// optimisation, not a requirement.
export function limitsSnapshotCachePath(explicit, env = globalThis.process?.env) {
  if (explicit !== undefined) {
    if (typeof explicit !== "string") return undefined;
    return explicit === "" ? undefined : explicit;
  }
  const named = env?.[LIMITS_SNAPSHOT_CACHE_ENV];
  if (typeof named === "string") return named === "" ? undefined : named;
  const home = homedir();
  const base = env?.LOCALAPPDATA || env?.XDG_CACHE_HOME || (home ? join(home, ".cache") : "");
  return base ? join(base, "opencode-zen-freex", "limits-observed.remote.json") : undefined;
}

// How long a successful answer is trusted before the provider asks again. An
// hour: the scheduled sweep is hourly, and a host that restarts more often than
// that should read its cache rather than spend a request per start.
export function limitsSnapshotRefreshMs(explicit, env = globalThis.process?.env) {
  return numberSetting(explicit, env, LIMITS_SNAPSHOT_REFRESH_ENV, {
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
    fallback: SNAPSHOT_REFRESH_DEFAULT,
  });
}

// How long one fetch may take. Five seconds by default, bounded to 100ms..60s:
// shorter is not a network round trip and longer is a request path holding a
// start-up open for a file that is only an optimisation.
export function limitsSnapshotTimeoutMs(explicit, env = globalThis.process?.env) {
  return numberSetting(explicit, env, LIMITS_SNAPSHOT_TIMEOUT_ENV, {
    min: SNAPSHOT_TIMEOUT_MIN,
    max: SNAPSHOT_TIMEOUT_MAX,
    fallback: SNAPSHOT_TIMEOUT_DEFAULT,
  });
}

// A remote (or cached) snapshot document, as the walls it measures. The rules are
// the sweep's own write-side rules, restated here rather than trusted from the
// document: version shape, a bounded number of rows, ids and rows that are what
// they claim, a row that does not disagree with itself about its refused size, a
// wall this file knows, and a window inside the units it says it is in.
//
// The whole document is rejected when it names another version, too many rows or
// no valid row at all. That last one is the important one: an empty or wholly
// invalid document is not an empty measurement, it is a document this build
// cannot read, and installing it would wipe the bundled table for every host
// behind this process. Individual bad rows are skipped — one dirty row upstream
// is not every model's problem — and the document survives as long as one row
// does.
export function parseSnapshotDocument(text) {
  try {
    if (typeof text !== "string" || text.length > SNAPSHOT_LIMIT) return undefined;
    const document = JSON.parse(text);
    if (document?.version !== SNAPSHOT_VERSION) return undefined;
    const models = document?.models;
    if (!models || typeof models !== "object" || Array.isArray(models)) return undefined;
    const entries = Object.entries(models);
    if (entries.length > SNAPSHOT_ROWS_LIMIT) return undefined;
    const walls = new Map();
    for (const [id, row] of entries) {
      if (!isUsableId(id) || id === "__proto__") continue;
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      if (!rowAgreesWithItself(row)) continue;
      const wall = typeof row.wall === "string" ? row.wall : undefined;
      if (!SNAPSHOT_WALLS.has(wall)) continue;
      const at = typeof row.at === "string" ? row.at : undefined;
      // A window the route stated in its own words is the route's number and is
      // published as it stands, exactly as the bundled reader does — but it is
      // still a token count, and a count past the same ceiling as a served one
      // is a unit error, not a window. `named` used to `continue` before every
      // bound, so a 9,000,000,000-token "named" window was installed as-is.
      if (usable(row.named)) {
        if (row.named > SNAPSHOT_TOKENS_LIMIT) continue;
        walls.set(id, { value: row.named, settles: true, wall: "named", at });
        continue;
      }
      const tokens = row.servedTokens;
      if (!usable(tokens) || tokens > SNAPSHOT_TOKENS_LIMIT) continue;
      if (row.servedChars !== undefined && row.servedChars !== null) {
        // A token is at least one character for every script this route takes;
        // a token count more than twice its character count is a row about two
        // different things, which one bad run or one unit error produces.
        if (!usable(row.servedChars) || row.servedChars > SNAPSHOT_CHARS_LIMIT) continue;
        if (tokens > row.servedChars * 2 + SNAPSHOT_TOKEN_CHAR_SLACK) continue;
      }
      const value = Math.floor(tokens / SNAPSHOT_STEP) * SNAPSHOT_STEP;
      if (!usable(value)) continue;
      walls.set(id, { value, settles: wall === "bracketed", wall, at });
    }
    return walls.size > 0 ? walls : undefined;
  } catch {
    // A document that is not JSON, not text or not shaped like a snapshot is no
    // measurement. Nothing on a request path may throw because an input was bad.
    return undefined;
  }
}

// The last remote answer written to disk, with the time it was written (the
// file's mtime). A missing, unreadable, unparsable or empty cache is undefined
// and never a throw: the caller has a bundled file and a network for exactly this
// answer.
export function readSnapshotCache(file) {
  try {
    if (typeof file !== "string" || file === "") return undefined;
    const info = statSync(file);
    // Startup reads this synchronously. A directory, a FIFO, a device or a file
    // past the snapshot ceiling is not the cache this process wrote; stat gives
    // both answers before the read, so a corrupt cache cannot block or exhaust
    // the start it is only an optimisation for.
    if (!info.isFile() || info.size > SNAPSHOT_LIMIT) return undefined;
    const text = readFileSync(file, { encoding: "utf8" });
    const walls = parseSnapshotDocument(text);
    if (!walls) return undefined;
    return { walls, fetchedAt: info.mtimeMs };
  } catch {
    return undefined;
  }
}

// Install a parsed remote answer as this process's snapshot. The input is a Map
// of one or more walls; anything else is no answer and leaves the installed state
// alone. The Map is copied before the assignment, so a caller that keeps building
// on the one it handed in cannot change what requests read, and a replacement is
// visible all at once rather than row by row.
export function installSnapshot(walls, meta = {}) {
  if (!(walls instanceof Map) || walls.size === 0) return false;
  const copy = new Map();
  for (const [id, wall] of walls) {
    if (!isUsableId(id) || id === "__proto__") continue;
    if (!wall || typeof wall !== "object" || Array.isArray(wall)) continue;
    copy.set(id, { ...wall });
  }
  if (copy.size === 0) return false;
  installedSnapshot = {
    walls: copy,
    source: typeof meta?.source === "string" ? meta.source : "installed",
    fetchedAt: Number.isFinite(meta?.fetchedAt) ? meta.fetchedAt : Date.now(),
    url: typeof meta?.url === "string" ? meta.url : undefined,
  };
  return true;
}

// Drop the installed answer. Only for tests and for a provider that has been told
// to stop reading remotely: it is the one way back to the bundled file.
export function clearInstalledSnapshot() {
  const had = installedSnapshot !== undefined;
  installedSnapshot = undefined;
  return had;
}

// What is installed, as a copy. `ageMs` is the answer's age, not the process's:
// a cache loaded at start-up is old from the moment it is read, which is exactly
// what the provider needs to decide whether to ask again.
export function snapshotState() {
  if (!installedSnapshot) return undefined;
  return {
    source: installedSnapshot.source,
    fetchedAt: installedSnapshot.fetchedAt,
    url: installedSnapshot.url,
    ageMs: Math.max(0, Date.now() - installedSnapshot.fetchedAt),
  };
}

// The write counter that keeps two cache writes in one process off one path. The
// same rule as the state file's: a temporary file is per write, not per process.
let snapshotWriteSequence = 0;

// One cache write: a temporary file beside the target, 0600, renamed over it.
// Cache trouble is never the refresh's trouble — a read-only cache directory is
// a host that asks again next start, not a snapshot that failed to install — so
// this function answers nothing and a failure inside it is swallowed after its
// temporary is cleaned up. The temp is best-effort removed, because what is left
// when the write failed is exactly what the write failed on.
async function writeSnapshotCache(file, text) {
  let temporary;
  try {
    await mkdir(dirname(file), { recursive: true });
    temporary = `${file}.${process.pid}.${snapshotWriteSequence++}.tmp`;
    await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
  } catch {
    if (temporary !== undefined) {
      try {
        await rm(temporary, { force: true });
      } catch {
        // Nothing here is worth a second failure.
      }
    }
  }
}

// Consume a response body without letting it exceed the snapshot ceiling. A
// content-length header is a promise, not a guarantee: a chunked or HTTP/2
// mirror can omit it, and `response.text()` would allocate the whole body before
// the parser ever sees its size. When a stream is available, read it in chunks
// and cancel the moment the running total passes the bound; only a response with
// no readable stream falls back to `text()` (fake responses in tests, and a
// shape some fetch implementations use).
async function cancelReader(reader) {
  try {
    const canceled = reader?.cancel?.();
    if (canceled && typeof canceled.catch === "function") await canceled.catch(() => {});
  } catch {
    // The reader is already being abandoned; a second failure is not worth one.
  }
}

async function readSnapshotBody(response) {
  const body = response?.body;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || typeof value.byteLength !== "number") {
          await cancelReader(reader);
          return { reason: "invalid" };
        }
        total += value.byteLength;
        if (total > SNAPSHOT_LIMIT) {
          // Stop the transfer rather than draining a body this build will never
          // use; a mirror that ignores cancel is still bounded by the abort
          // signal on the fetch that owns this stream.
          await cancelReader(reader);
          return { reason: "too-large" };
        }
        chunks.push(value);
      }
    } finally {
      try {
        reader.releaseLock?.();
      } catch {
        // The reader that failed is not a second failure worth reporting.
      }
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { text: new TextDecoder().decode(bytes) };
  }
  const text = await response.text();
  if (typeof text !== "string" || text.length > SNAPSHOT_LIMIT) return { reason: "too-large" };
  return { text };
}

// Drop a response body this build is not going to read. Called on every early
// return; a body left undrained holds a connection and, on a streamed response,
// costs the mirror bytes nobody will use.
function cancelSnapshotBody(response) {
  try {
    const canceled = response?.body?.cancel?.();
    if (canceled && typeof canceled.catch === "function") canceled.catch(() => {});
  } catch {
    // Cancelling is best effort; the answer is already "no".
  }
}

// One remote refresh, never throwing. The URL is validated before anything is
// fetched (an `ftp:` URL is a configuration error, not a network one), the fetch
// carries its own deadline, and the response is accepted only if it is a 2xx, not
// larger than the snapshot bound (by header or by streamed body) and a document
// the parser above accepts whole. Only then is it installed and written to the
// cache.
//
// A failed refresh returns the reason and leaves whatever was installed in place:
// an installed answer from an hour ago is a better snapshot than a bundled table
// from a released build, and one bad fetch is not a reason to lose it. The cache
// write is the last step and its failure does not undo a successful install.
//
// `parse` and `install` are the two halves this function is parameterised on.
// The defaults are this file's walls snapshot; catalog.mjs passes its own pair,
// and the contract both sides are held to is the one group visible here: parse
// answers the parsed answer or undefined, install puts it in front of readers
// and answers whether it took. Everything else — the bounds, the deadline, the
// byte-capped read, the atomic cache write, the reasons returned — is one path
// two kinds of document walk.
export async function refreshSnapshot({
  url,
  cachePath,
  timeoutMs = SNAPSHOT_TIMEOUT_DEFAULT,
  fetchImpl = globalThis.fetch,
  parse = parseSnapshotDocument,
  install = installSnapshot,
} = {}) {
  let target;
  try {
    target = new URL(url);
  } catch {
    return { ok: false, reason: "url" };
  }
  if (!["http:", "https:"].includes(target.protocol)) return { ok: false, reason: "url" };
  if (typeof fetchImpl !== "function") return { ok: false, reason: "fetch" };
  const wait =
    Number.isSafeInteger(timeoutMs) && timeoutMs >= SNAPSHOT_TIMEOUT_MIN && timeoutMs <= SNAPSHOT_TIMEOUT_MAX
      ? timeoutMs
      : SNAPSHOT_TIMEOUT_DEFAULT;
  const timeoutReason = (error) =>
    error?.name === "TimeoutError" || error?.name === "AbortError" ? "timeout" : "fetch";
  let response;
  try {
    response = await fetchImpl(target.href, {
      signal: AbortSignal.timeout(wait),
      headers: { accept: "application/json" },
    });
  } catch (error) {
    return { ok: false, reason: timeoutReason(error) };
  }
  try {
    if (!response || typeof response !== "object" || response.ok !== true) {
      cancelSnapshotBody(response);
      return { ok: false, reason: "http" };
    }
    // A header that promises more than the bound is believed before the body is
    // read: the point of the bound is not to read a large document and then
    // reject it.
    const length = response.headers?.get?.("content-length");
    if (typeof length === "string" && /^\d+$/.test(length) && Number(length) > SNAPSHOT_LIMIT) {
      cancelSnapshotBody(response);
      return { ok: false, reason: "too-large" };
    }
    let text;
    try {
      const read = await readSnapshotBody(response);
      if (read.reason) return { ok: false, reason: read.reason };
      text = read.text;
    } catch (error) {
      return { ok: false, reason: timeoutReason(error) };
    }
    if (typeof text !== "string" || text.length > SNAPSHOT_LIMIT) {
      cancelSnapshotBody(response);
      return { ok: false, reason: "too-large" };
    }
    const parsed = parse(text);
    if (!parsed) return { ok: false, reason: "invalid" };
    const fetchedAt = Date.now();
    install(parsed, { source: "remote", fetchedAt, url: target.href });
    if (typeof cachePath === "string" && cachePath !== "") await writeSnapshotCache(cachePath, text);
    return { ok: true, fetchedAt, walls: parsed };
  } catch {
    // A response object that throws, a body that cannot be read, a header getter
    // that fails: all of it is the fetch failing, and none of it is the caller's.
    cancelSnapshotBody(response);
    return { ok: false, reason: "fetch" };
  }
}

// ---- models.dev as a second opinion -----------------------------------------
//
// The catalogue is not the only place a free id's window is written down.
// models.dev republishes the same records — same schema, same
// `canonical_model_id`, in practice the same upstream of the catalogue — across
// several hundred providers, and it is the only cross-provider view of a model
// that exists without asking the model.
//
// It is not an oracle. It has one failure the catalogue shares and one it does
// not. The shared one is rounding: MiniMax's own entry says a "1M context
// window" and writes 1000000, the decimal million, for a wall that is 1048576
// — seventeen of the nineteen entries for that canonical model repeat it, and
// only llmgateway says 1048576. Taking a majority vote over that population is
// therefore the wrong aggregation and the reason this reads the MAXIMUM: a
// provider that under-states a window costs its own users the difference, and
// one that over-states it is refused at the top of its window, so among
// providers claiming to serve the same weights the largest declaration is the
// one that is trying to use all of it.
//
// What it is used for is one rule, and only for the ids the catalogue already
// declares at a million or more: those are exactly the ids whose declaration is
// a round number that no measurement here has falsified, and the largest
// models.dev figure for the same canonical model says what scale that round
// number was meant in. It never lowers a declaration, and an id the catalogue
// declares under a million is left to measurement — `MODELS_DEV_MIN` is where
// that line is, and the reason is that a big claim is checkable by one refused
// request while a small one is only checkable by climbing to it.
export const MODELS_DEV_MIN = 1_000_000;

// The declarations, by canonical model id, as a caller can hold them. Filled by
// `modelsDevClaims` from a document a caller fetched, so nothing here reaches
// the network: a plugin that blocked a model list on a third party would be
// slower for everybody and wrong for anybody behind a firewall.
const MODELS_DEV = new Map();
// The completion ceilings, by the same canonical id. The output axis is not
// measured any more, but the largest entry is not its rule either: several
// providers write their CONTEXT into `limit.output` (W&B and DigitalOcean both
// said 1048576 for DeepSeek V4.1 Flash, whose completion ceiling is 384000), and
// a plain maximum turns those outliers into a ceiling four times the model's.
// The output map therefore prefers the canonical model's first-party provider
// (the provider key matching the canonical prefix) and otherwise takes the most
// commonly published output, with the larger value winning a tie. This is the
// provider's own figure, not a hand sample; the table's output entries remain
// only for an id models.dev does not describe.
const MODELS_DEV_OUTPUT = new Map();
// What a canonical id is claimed at, and by whom, for diagnostics.
const MODELS_DEV_BY = new Map();
const MODELS_DEV_OUTPUT_BY = new Map();
// The paid twin's completion ceiling, by models.dev's own model id (no `-free`
// suffix), from the repository's `opencode` provider. A route id is looked up
// here after its `-free` suffix is removed: the free entry in models.dev often
// declares the free tier's under-reported 32000 output, while the paid twin is
// the same weights' real ceiling (DeepSeek V4.1 Flash: 384000, not 1048576 and
// not the free entry's 32000). Other providers' ids are not mixed in here; their
// declarations are used only through the canonical fallback.
const MODELS_DEV_PAID_OUTPUT = new Map();
const MODELS_DEV_PAID_OUTPUT_BY = new Map();
// The completion ceiling models.dev publishes for a route id under its OWN name
// in the `opencode` provider, free suffix and all: what that provider says about
// the tier it is describing, as opposed to what the canonical aggregate says
// about the weights on whichever host published them. The two disagree in both
// directions — `opencode/nemotron-3.5-super-vl-free` declares 131072 while
// `nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b` declares 8192, NVIDIA's own
// service default — and there is no ordering that reads both right, so the
// lookup takes the larger of the two: a route row below the consensus is one
// distributor's default under a model that answers at the larger size, and a
// canonical claim below the route row is the weights' ceiling that the row has
// under-declared.
const MODELS_DEV_ROUTE_OUTPUT = new Map();
const MODELS_DEV_ROUTE_OUTPUT_BY = new Map();
// Who claimed each canonical id. The winning claim alone cannot say how many
// providers described a model: only the largest is kept, so the count was a
// count of models with a claim at all — every one of them — and the evidence
// the number was for, a model one provider describes saying nothing a
// catalogue would not, was thrown away with the claims that lost.
const MODELS_DEV_PROVIDERS = new Map();

// Reads a models.dev document into the maps above. Returns how many models it
// saw two or more claims for, which is the number worth logging: a model one
// provider describes says nothing a catalogue would not. A claim is a provider
// describing a model, so the count is of the models more than one provider
// described — and the claims that lost are counted too, because the evidence is
// that a second provider said the same thing, not that it said it louder.
//
// Context and output are collected independently: a provider may declare one
// and not the other, and the output map must not be limited to rows that also
// declare a context. The two maxima are each over the entries that declare that
// axis, not over a single winning row.
export function modelsDevClaims(document) {
  MODELS_DEV.clear();
  MODELS_DEV_OUTPUT.clear();
  MODELS_DEV_BY.clear();
  MODELS_DEV_OUTPUT_BY.clear();
  MODELS_DEV_PAID_OUTPUT.clear();
  MODELS_DEV_PAID_OUTPUT_BY.clear();
  MODELS_DEV_ROUTE_OUTPUT.clear();
  MODELS_DEV_ROUTE_OUTPUT_BY.clear();
  MODELS_DEV_PROVIDERS.clear();
  // Per canonical id: how often each output value is published, where it was
  // published, and the first-party provider's own value when that provider
  // describes the weights. Kept local to the read so a document does not leave
  // aggregation state behind, unlike the two maps a caller asks about.
  const outputCounts = new Map();
  const outputSources = new Map();
  const officialOutputs = new Map();
  for (const [provider, entry] of Object.entries(document?.providers ?? document ?? {})) {
    const models = entry?.models;
    if (!models || typeof models !== "object" || Array.isArray(models)) continue;
    for (const [modelId, model] of Object.entries(models)) {
      const canonical = typeof model?.canonical_model_id === "string" ? model.canonical_model_id : undefined;
      const output = model?.limit?.output;
      // Every row `opencode` publishes is a statement about this route, and the
      // one under the route's own name is the only place the free tier's ceiling
      // is stated by the provider rather than inferred from the weights. Kept
      // whether or not the row has a canonical id, and before the branches below,
      // one of which gives up on rows without one.
      if (provider === "opencode" && usable(output)) {
        const held = MODELS_DEV_ROUTE_OUTPUT.get(modelId);
        if (held === undefined || output > held) {
          MODELS_DEV_ROUTE_OUTPUT.set(modelId, output);
          MODELS_DEV_ROUTE_OUTPUT_BY.set(modelId, `${provider}/${modelId}`);
        }
      }
      // A row with no canonical id cannot join the canonical claims, but its id
      // is still the route's own model name and models.dev's `opencode` provider
      // is where the paid twin lives: `big-pickle` has no canonical at all and
      // is still described there. Remember that direct output before giving up
      // on the canonical maps.
      if (!canonical) {
        if (provider === "opencode" && usable(output) && !modelId.endsWith("-free")) {
          const held = MODELS_DEV_PAID_OUTPUT.get(modelId);
          if (held === undefined || output > held) {
            MODELS_DEV_PAID_OUTPUT.set(modelId, output);
            MODELS_DEV_PAID_OUTPUT_BY.set(modelId, `${provider}/${modelId}`);
          }
        }
        continue;
      }
      const context = model?.limit?.context;
      const hasContext = usable(context);
      const hasOutput = usable(output);
      if (!hasContext && !hasOutput) continue;
      // Every provider that describes the model is counted, whoever won: two
      // providers describing the same weights is the cross-provider evidence,
      // and one provider describing the same model twice is still one provider.
      const claimed = MODELS_DEV_PROVIDERS.get(canonical) ?? new Set();
      claimed.add(provider);
      MODELS_DEV_PROVIDERS.set(canonical, claimed);
      if (hasContext) {
        const held = MODELS_DEV.get(canonical);
        if (held === undefined || context > held) {
          MODELS_DEV.set(canonical, context);
          MODELS_DEV_BY.set(canonical, `${provider}/${modelId}`);
        }
      }
      if (hasOutput) {
        let counts = outputCounts.get(canonical);
        if (!counts) {
          counts = new Map();
          outputCounts.set(canonical, counts);
        }
        counts.set(output, (counts.get(output) ?? 0) + 1);
        let sources = outputSources.get(canonical);
        if (!sources) {
          sources = new Map();
          outputSources.set(canonical, sources);
        }
        if (!sources.has(output)) sources.set(output, `${provider}/${modelId}`);
        // The opencode provider holds the route's own paid twin. Keep it by its
        // own id so a route id can be looked up with `-free` stripped; the free
        // entry itself is not a paid twin and is ignored here.
        if (provider === "opencode" && !modelId.endsWith("-free")) {
          const held = MODELS_DEV_PAID_OUTPUT.get(modelId);
          if (held === undefined || output > held) {
            MODELS_DEV_PAID_OUTPUT.set(modelId, output);
            MODELS_DEV_PAID_OUTPUT_BY.set(modelId, `${provider}/${modelId}`);
          }
        }
        // The canonical id's own provider is the first-party entry: `deepseek/…`
        // in the `deepseek` provider, `nvidia/…` in `nvidia`, and so on. It is
        // the vendor's declaration, not a reseller's copy of the context.
        const prefix = canonical.includes("/") ? canonical.slice(0, canonical.indexOf("/")) : undefined;
        if (prefix === provider) {
          const held = officialOutputs.get(canonical);
          if (held === undefined || output > held.value)
            officialOutputs.set(canonical, { value: output, source: `${provider}/${modelId}` });
        }
      }
    }
  }
  // Choose the output once per canonical id: the first-party entry when one
  // exists, otherwise the most common published value (the larger value wins a
  // tie, which keeps an even split from choosing the smaller ceiling).
  for (const [canonical, counts] of outputCounts) {
    let chosen = officialOutputs.get(canonical);
    if (!chosen) {
      let bestCount = -1;
      let bestValue;
      for (const [value, count] of counts) {
        if (count > bestCount || (count === bestCount && value > bestValue)) {
          bestCount = count;
          bestValue = value;
        }
      }
      chosen = { value: bestValue, source: outputSources.get(canonical)?.get(bestValue) };
    }
    if (usable(chosen?.value)) {
      MODELS_DEV_OUTPUT.set(canonical, chosen.value);
      if (typeof chosen.source === "string") MODELS_DEV_OUTPUT_BY.set(canonical, chosen.source);
    }
  }
  let contested = 0;
  for (const providers of MODELS_DEV_PROVIDERS.values()) if (providers.size > 1) contested += 1;
  const described = new Set([...MODELS_DEV.keys(), ...MODELS_DEV_OUTPUT.keys()]);
  return { models: described.size, contested };
}

export function modelsDevLimit(canonical) {
  return typeof canonical === "string" ? MODELS_DEV.get(canonical) : undefined;
}

export function modelsDevSource(canonical) {
  return typeof canonical === "string" ? MODELS_DEV_BY.get(canonical) : undefined;
}

export function modelsDevOutput(canonical) {
  return typeof canonical === "string" ? MODELS_DEV_OUTPUT.get(canonical) : undefined;
}

export function modelsDevOutputSource(canonical) {
  return typeof canonical === "string" ? MODELS_DEV_OUTPUT_BY.get(canonical) : undefined;
}

// The output a route model id should use. `-free` is stripped first, because
// models.dev's free entry is the under-reported tier and its paid twin is the
// same weights' real ceiling; that paid entry is read from the `opencode`
// provider. With no paid twin, the route's own row in that same provider and the
// canonical aggregate above are both read, and the larger of the two answers —
// neither ordering is right: NVIDIA's canonical row says 8192 for weights
// models.dev's own route row declares 131072 for, and minimax's canonical row
// says 524288 for a route row that says 512000 and a route that named 524288 in
// a refusal. This is the lookup the plugin's own route ids need;
// `modelsDevOutput(canonical)` remains the canonical-only accessor.
export function modelsDevOutputFor(id, canonical) {
  const stripped =
    typeof id === "string" && id.endsWith("-free") ? id.slice(0, -"-free".length) : id;
  const paid = typeof stripped === "string" ? MODELS_DEV_PAID_OUTPUT.get(stripped) : undefined;
  if (usable(paid)) return paid;
  const route = typeof id === "string" ? MODELS_DEV_ROUTE_OUTPUT.get(id) : undefined;
  const aggregate = modelsDevOutput(canonical);
  if (usable(route) && usable(aggregate)) return Math.max(route, aggregate);
  return usable(route) ? route : aggregate;
}

export function modelsDevOutputSourceFor(id, canonical) {
  const stripped =
    typeof id === "string" && id.endsWith("-free") ? id.slice(0, -"-free".length) : id;
  const paid = typeof stripped === "string" ? MODELS_DEV_PAID_OUTPUT.get(stripped) : undefined;
  if (usable(paid)) return MODELS_DEV_PAID_OUTPUT_BY.get(stripped);
  const route = typeof id === "string" ? MODELS_DEV_ROUTE_OUTPUT.get(id) : undefined;
  const aggregate = modelsDevOutput(canonical);
  const fromRoute =
    usable(route) && (!usable(aggregate) || route >= aggregate) ? MODELS_DEV_ROUTE_OUTPUT_BY.get(id) : undefined;
  return fromRoute ?? modelsDevOutputSource(canonical);
}

// What this plugin declares for a model instead of what the catalogue says, as
// a plain object to spread over the catalogue's own limit. Empty when there is
// no evidence, when the evidence was measured against a different catalogue, or
// when it would change nothing.
export function limitOverrides(
  id,
  declared = {},
  table = LIMITS,
  observed = OBSERVED,
  observedOutput = OBSERVED_OUTPUT,
  brackets = BRACKETS,
  walls = measuredWalls(),
  canonical,
) {
  const overrides = {};
  // A record has to be this table's own. `table[id]` otherwise answers out of
  // Object.prototype for `toString` and the rest, and out of whatever prototype
  // an object handed in as `table` carries — evidence for a model nobody
  // declared, from a table that never named it.
  const record = table && Object.hasOwn(table, id) ? table[id] : undefined;
  // What the sweep measured for this id, once: it answers the context axis, and
  // it answers the input axis through the window rather than beside it, so both
  // readings have to be the same one.
  const measuredWall = walls?.get?.(id);
  // The window this id is published with before anything is observed live, and
  // whether the sweep is what decided it. The input axis is the second half of
  // the same answer: magpie answers `context_window` and `max_input_tokens` from
  // `limit.input` when it is declared, and shows the smaller of the two axes, so
  // an input left at a catalogue number the route has outgrown is not a second
  // opinion — it is what the model's size appears to be. 160000 was on screen
  // for a model serving 343000 exactly that way.
  const contextEntry = record && Object.hasOwn(record, "context") ? record.context : undefined;
  const contextDeclared = declared && Object.hasOwn(declared, "context") ? declared.context : undefined;
  // `null` is an own value a row may carry — a state file or a caller can write
  // it for an axis that was not measured — and `!== undefined` alone let it
  // through to `.declaredAt` and threw a TypeError out of a model list. It is
  // not a measurement, so the axis falls back to the weaker tiers like a row
  // that never named it.
  const contextApplies =
    contextEntry !== undefined &&
    contextEntry !== null &&
    contextDeclared !== undefined &&
    contextEntry.declaredAt === contextDeclared;
  const settledWindow = settledFor(contextApplies, contextEntry, contextDeclared, measuredWall);
  // A window this process was told about is the strongest thing this axis has, and
  // it is what the input axis follows like any other measured window: a route that
  // names its window while the plugin runs must not have that answer shown as a
  // smaller catalogue input instead. A window a refusal named is taken as it
  // stands here as everywhere else, so the live value is not re-derived from the
  // catalogue — it replaces the settled one for this purpose.
  const liveWindow = observed?.get?.(id);
  const window = usable(liveWindow) ? { value: liveWindow, source: "route" } : settledWindow;
  for (const axis of ["context", "input", "output"]) {
    // Own property, like the table lookup two lines up: `declared` is handed in
    // by a caller, and a `context` inherited from a custom prototype — or from a
    // polluted `Object.prototype` — would otherwise be read as a declaration the
    // catalogue never made, feeding the staleness compare and the raise-only
    // check with a number nobody declared.
    const declaredValue = declared && Object.hasOwn(declared, axis) ? declared[axis] : undefined;
    // The completion ceiling is not a measured axis any more. models.dev is
    // read with this route id's `-free` suffix removed: its paid twin's output
    // (when the `opencode` provider has one) is the same weights' real ceiling,
    // and otherwise the larger of the route's own rows and the canonical
    // aggregate answers. The value is not raise-only — an entry below a stale
    // catalogue figure lowers it too — and it bypasses the route/table tiers;
    // those remain the fallback only for an id models.dev does not describe.
    //
    // The one tier it does not bypass is a ceiling the route stated itself. That
    // is evidence about this route, while a models.dev figure is about the
    // weights as read on somebody's host, and the two are not rivals: when the
    // route's number is the larger one, the smaller claim is not a second
    // opinion, it is the wrong route. `big-pickle` is the case — the route named
    // 131072 in a refusal, models.dev's paid twin declares 32000, and the
    // declaration on screen was 32000 for a model that answers. A claim LARGER
    // than the route's statement still wins, which is the case this tier exists
    // for: the free tier declares 32000 where the paid twin answers 384000, and
    // models.dev was read for exactly that correction. A refusal this process
    // saw is the same statement and newer than the table, so it is read here too.
    if (axis === "output") {
      const claimed = modelsDevOutputFor(id, canonical);
      if (usable(claimed)) {
        const stated = record && Object.hasOwn(record, "output") ? record.output : undefined;
        const statedValue =
          stated && typeof stated === "object" && usable(stated.value) ? stated.value : undefined;
        const routeStated = stated?.source === "route" || stated?.source === "route-twin";
        const liveOutput = observedOutput?.get?.(id);
        const routeLarger =
          (routeStated && statedValue > claimed) || (usable(liveOutput) && liveOutput > claimed);
        if (!routeLarger) {
          if (claimed !== declaredValue) overrides.output = claimed;
          continue;
        }
      }
    }
    // Own property, the same rule as the two lines around it. Read through the
    // prototype, an axis the record merely inherits — from a table built with
    // `Object.create`, or from a polluted `Object.prototype` — read exactly like
    // a measurement: it passed the guard below, because the guard is about the
    // declaration and not about the record, and it then took an override past
    // the staleness check and past the raise-only rule.
    const entry = record && Object.hasOwn(record, axis) ? record[axis] : undefined;
    // Only the axes a refusal names have a live form — a window and a
    // completion ceiling. An input axis is answered from the table alone: the
    // refusals this route sends name the window that bounds it, never an input
    // cap of its own, so there is nothing to observe into it.
    const live =
      (axis === "context" ? observed : axis === "output" ? observedOutput : undefined)?.get(id);
    // A route statement made while this process was running is the same tier as
    // the table and newer than it, so it is taken as it stands. Everything else
    // has to have been measured against the catalogue in front of us now: the
    // value it was measured against has to exist and still be the declaration,
    // and one that names no such value was measured against nothing.
    //
    // The bracket the route taught this process comes before the table, not
    // after it: a record exists only because a request was served or refused,
    // which makes it evidence about the wall as it is enforced now, while the
    // table is a measurement of the same axis taken earlier. A record is seeded
    // from the settled value below when it is created, so the table still has the
    // first word — it just does not have the last one. A model nothing has been
    // asked of has no record, and its axes are the settled ones and nothing else.
    // `null` is an own value, and an entry that owns `null` is not one that
    // measured anything: `!== undefined` let it through to `.declaredAt` and
    // ended the model list with a TypeError. It is treated like a row that
    // never named the axis, and the settled value below answers instead.
    const applies =
      entry !== undefined &&
      entry !== null &&
      declaredValue !== undefined &&
      entry.declaredAt === declaredValue;
    let settled = settledFor(applies, entry, declaredValue, axis === "context" ? measuredWall : undefined);
    // The input axis has no measurement of its own to take: what the route served
    // was a prompt, and the window is how this file states that. So where the
    // window is a measured one — from the table, from the sweep, or named by a
    // refusal while this process runs — an input the catalogue declares under it is
    // raised to it. That is the precedent the table set by hand for
    // space-bunny-free and big-pickle, and the only place those two axes can
    // disagree in a way that shows: magpie reads `context_window` from the smaller
    // of them, so an input left behind is a model drawn smaller than it is, and a
    // window the route just named is drawn as the catalogue's input instead.
    // 160000 was on screen for a model serving 343000 exactly that way.
    //
    // Raised and never lowered, and only where the catalogue declares one: with no
    // input declared, magpie's own fallback already reads the window, and where
    // the table names this axis the entry has its own samples. Both of those are
    // answers this file would only be restating.
    if (axis === "input" && settled.source === undefined && usable(declaredValue) && window.source !== undefined)
      settled = {
        value: Math.max(declaredValue, window.value),
        source: window.source,
        measured: window.measured,
      };
    const seeded = settled.value;
    const adopted = axis === "context" ? adoptedCeiling(id, seeded, brackets) : undefined;
    // A second opinion on the scale of a round number, and only there: the
    // catalogue declares this axis at a million or more, nothing here has
    // measured it, and models.dev publishes a figure for the same canonical
    // model. `MODELS_DEV_MIN` is the line because a big claim is falsifiable by
    // one refused request while a small one is only falsifiable by climbing to
    // it — and every id under the line is measured instead, which is what the
    // sweep is for. It never lowers anything: `value < declaredValue` falls to
    // the raise-only rule below like any other weak tier.
    // `settled.source === undefined` was in this guard and is not any more: it
    // meant "no table entry and no sweep", which excluded the very ids this
    // half is for. A table entry for a million-token id is a MEASUREMENT of the
    // wall, and the second opinion is about the SCALE its round number was
    // written in — the two are not rivals, and the entry `minimax` now carries
    // says `models.dev` for exactly that reason. What still outranks it is
    // evidence about this route: a live refusal, or a bracket the route drew.
    // What a claim may still be beaten by is evidence about THIS route: a live
    // refusal, or a size the route is known to have refused. `adopted` is
    // neither — it is the bracket this process learned, seeded from the
    // catalogue's own number, so before the route has said anything about a
    // million-token id it IS that number (1000000 here) and would pin the answer
    // there for ever. It is taken as a floor for the claim instead.
    let secondOpinion;
    if (
      axis === "context" &&
      live === undefined &&
      Number.isSafeInteger(declaredValue) &&
      declaredValue >= MODELS_DEV_MIN
    ) {
      const claimed = modelsDevLimit(canonical);
      const floor = usable(adopted) ? adopted : 0;
      if (usable(claimed) && claimed > Math.max(declaredValue, floor)) {
        secondOpinion = { value: claimed, source: "models.dev" };
      }
    }
    let value;
    let source = settled.source;
    if (live !== undefined) {
      value = live;
      // Live is the route answering about itself, so it stands whatever tier the
      // axis was answered from a moment ago.
      source = "route";
    } else if (adopted !== undefined) {
      // A claim that beat the adopted bracket is the value; the bracket only
      // wins when it is the larger of the two.
      value = secondOpinion && secondOpinion.value > adopted ? secondOpinion.value : adopted;
      if (secondOpinion && secondOpinion.value > adopted) source = secondOpinion.source;
    } else {
      // The second opinion raises the settled value rather than replacing it: a
      // table entry that measured 1,048,092 and a claim of 1,048,576 agree, and
      // a claim BELOW a measurement must not pull the measurement down.
      value = secondOpinion ? Math.max(settled.value, secondOpinion.value) : settled.value;
      if (secondOpinion && secondOpinion.value > settled.value) source = secondOpinion.source;
      if (entry && !applies) {
        // Measured against a catalogue that has moved, or against an axis the
        // catalogue no longer declares. Its value is void, and saying so is the
        // whole point of the note: otherwise this is indistinguishable from a
        // model nothing was ever measured for. The note says nothing about what
        // replaced it, which is the sweep's own note below when that is what did.
        note({
          kind: "catalogue-drift",
          id,
          axis,
          value: entry.value,
          measuredAgainst: entry.declaredAt,
          declared: declaredValue,
        });
      }
    }
    if (value === undefined || !Number.isSafeInteger(value) || value <= 0) continue;
    if (value === declaredValue) continue;
    // Weaker evidence may only raise. Live is the route itself, a bracket was put
    // under the declaration by the route answering, and a tier that is neither of
    // those has to be on its own entry: this is what keeps a vendor's page, a
    // watched generation, and a floor the sweep found but never hit from narrowing
    // a window somebody else measured.
    if (
      live === undefined &&
      adopted === undefined &&
      source !== undefined &&
      !ROUTE_TIERS.has(source) &&
      Number.isSafeInteger(declaredValue) &&
      value < declaredValue
    )
      continue;
    overrides[axis] = value;
    // A live value is the one override taken past the staleness guard and past
    // the raise-only rule, so it is the one nobody can account for afterwards:
    // say what was applied and what it stands in for. A sweep value can be taken
    // past both as well, so it says where it came from.
    if (live !== undefined) note({ kind: "route-statement", id, axis, value, declared: declaredValue });
    else if (source === SWEEP_SOURCE && adopted === undefined)
      note({
        kind: "sweep-statement",
        id,
        axis,
        value,
        declared: declaredValue,
        wall: settled.measured?.wall,
        at: settled.measured?.at,
      });
  }
  return overrides;
}

// What the caller would have declared for this axis with no bracket in play: the
// shipped entry when it still applies, else what the sweep measured, and the
// catalogue's own number when neither answers. It is the seed a record is created
// from, and the value a search that has not moved yet derives from — never a
// second opinion about a record that already has one.
//
// `applies` is decided by the caller rather than compared again here: the loop
// that hands this the entry is the same loop that has to say whether an entry it
// is not using was measured against a catalogue that moved, and one comparison
// answering both questions is one comparison that cannot disagree with itself.
function settledFor(applies, entry, declaredValue, measured) {
  if (applies) return { value: entry.value, source: entry.source };
  if (measured !== undefined && (measured.settles || !usable(declaredValue) || measured.value > declaredValue))
    return { value: measured.value, source: SWEEP_SOURCE, measured };
  return { value: declaredValue, source: undefined };
}
