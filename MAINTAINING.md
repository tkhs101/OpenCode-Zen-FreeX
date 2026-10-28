# Maintaining this plugin

The plugin is one file of logic and two pieces of data, and the data is the part
that goes out of date. This is how to look after it.

## What is actually fragile

`fingerprint.json` holds a capture of a real OpenCode: the wording of the tools
its free tier knows by name, and the User-Agent that identifies it. Two more
captures of the same releases sit beside it: `opencode-prompt-v1.txt`, the CLI's
own system prompt, and `official-tools.json`, the complete tool set a CLI
session carries. Zen accepts a request only when the whole of it matches one
generation of OpenCode — it reads the prompt and the tool definitions out of the
body, not only the headers — so when OpenCode changes any of that, the copies
here stop being accepted.

Nothing about a stale copy looks different from a working one. The symptom is a
`403 FreeTierError` on every request, which reads as "you are not OpenCode" and
sends people off to change headers.

## Limits Zen under-reports

`models.mjs` declares each model's limits from Zen's catalogue, and for some free
ids the catalogue is wrong in the one direction nothing complains about: too
small. `mimo-v2.6-flash-free` is declared 200000/32000 against a model whose own
vendor publishes 1048576/131072. The ids the tier added on
2026-10-16 were under-reported the same way on the day they appeared:
`ll-alpha-free` names a 262144-token completion ceiling in its own refusal
against a declared 65536, and `glm-5.3-flash-free` is declared 200000/32000
while its paid twin `glm-5.3-flash` is declared 1000000/131072 in the same
catalogue — and a 232685-token prompt was served through the free id, which the
declared window does not allow. `space-bunny-free` under-reports on a third
axis, its `input`: the catalogue derives that number from its own pair
(`context − output`, 524288) while prompts of 535,110, 935,110 and 979,550
tokens were served through the free id, and the axis is what a host that shows
a window shows: magpie's `context_window` and `max_input_tokens` both follow it
when one is declared, and the window it reports is the smaller of the two, so
the derivation was on screen as half a window. That is the same fact the rule
below restates at run time, which is why an under-declared `input` now follows
the window, wherever that window came from.

All of these numbers are acted on. The window decides when a conversation is
compacted and how much of it is ever sent; the output cap is sent as
`max_tokens` on every request, so a reply is cut at it with a finish reason that
reads like the model's own decision; the `input` axis is the size a
window-showing host displays. A window that is too small is never refused, it is
just quietly never used, which is why this stayed invisible for so long.

**The output cap is not measured any more.** A sweep brackets prompts, because a
prompt is what a host plans from and what a refusal can prove; it asks for
sixteen completion tokens and stops. The completion ceiling now follows
models.dev, looked up with the route id's `-free` suffix removed: the paid twin
in models.dev's own `opencode` provider is the same weights' real ceiling
(`deepseek-v4.1-flash-free` reads `deepseek-v4.1-flash`, 384000, not the free
entry's 32000 and not the 1048576 some resellers copy from context). With no
paid twin, the canonical model's first-party output (or the most commonly
published one on a tie) answers. The value is taken as-is in both directions,
so it may raise a stale catalogue figure and lower one. The table's output
entries are historical fallback only, for an id models.dev does not describe;
the runtime tiers below that mention output apply only in that fallback.

`limits.mjs` holds what was measured, per axis, with the catalogue value it was
measured against. Each axis carries `samples` and `how`; the short of it. The
`output` rows below are historical fallback only: when models.dev describes the
route id (with `-free` stripped), its paid twin's `limit.output` is what the
plugin uses, and the table's number is not consulted.

| id | axis | value | from |
| --- | --- | --- | --- |
| `deepseek-v4.1-flash-free` | context | 326000 | the last point this route is measured to serve (326,702), rounded down on 2026-10-19 because its refusal names no number and refuses 326,750 itself |
| `deepseek-v4.1-flash-free` | output | 384000 | the paid twin's figure, and nothing on this route confirms it today: the `[1, 393216]` sentence did not reproduce on a 2026-10-19 re-ask, which was answered 200 |
| `mimo-v2.6-flash-free` | context | 375000 | the route's own enforcement, found by bracketing on 2026-10-20 (375,142 tokens served, 1,750,000 characters; the nearest reproduced refusal is 1,787,500 characters, and an earlier probe was refused at 2,800,000), not the 1048576 the route used to state |
| `mimo-v2.6-flash-free` | output | 131072 | the vendor's own catalogue entry |
| `big-pickle` | context | 375000 | the route's own enforcement, found by bracketing on 2026-10-20 (375,142 served, 1,750,000 characters; the nearest reproduced refusal is 1,787,500 characters, and an earlier probe was refused at 2,800,000), an axis an earlier sweep had left to the catalogue |
| `big-pickle` | output | 131072 | historical fallback: models.dev has no canonical entry for this Zen-only id; the route names this ceiling when asked for too much |
| `big-pickle` | input | 375000 | the window, not the sample: the catalogue's 160000 was falsified by a served prompt of 343,131 tokens, and this route names no input cap of its own, so the axis is declared at the window |
| `nemotron-3.5-lightning-free` | context | 1000000 | the route's own refusal, in its own words |
| `longcat-2.5-preview-free` | output | 262144 | the ceiling the route names when it is asked for too much |
| `ll-alpha-free` | output | 262144 | the ceiling the route's own refusal names, against a declared 65536 |
| `glm-5.3-flash-free` | context | 323000 | the route's own enforcement, found by bracketing on 2026-10-20 (323,107 tokens served, 1,506,250 characters; the nearest reproduced refusal is 1,525,000 characters, and a prompt of about 343,000 tokens - 1,600,000 characters - was refused earlier), not the paid twin's 1000000 |
| `glm-5.3-flash-free` | output | 131072 | the paid twin's figure for the same upstream model |
| `minimax-m3.1-flash-free` | context | 1048576 | the wall behind the catalogue's round million: models.dev declares 1048576 for this canonical model - two of nineteen provider entries say so, against seventeen that repeat 1000000 - and the bisection agrees with those two, 1,048,092 tokens served and 1,082,359 refused |
| `minimax-m3.1-flash-free` | output | 512000 | the catalogue's own declaration for this id, left as declared: nothing above 32000 was watched on it, and lowering a ceiling on no evidence cuts replies off |
| `beam-free` | context | 1048576 | the route's own enforcement, found by bisection: 1,048,361 tokens served, 1,071,887 refused - the binary wall, which is the scale the catalogue's 1048576 already names |
| `beam-free` | output | 131072 | the catalogue's declaration for this id; nothing here measured it, and the axis is left as declared |
| `space-bunny-free` | input | 1048576 | the window this route declares for the same id, with prompts of up to nearly twice the declared input served |

A prompt sized just over the window is refused with

```
This model's maximum context length is 1048576 tokens. However, you requested
1422278 tokens (1038278 in the messages, 384000 in the completion).
```

which is the route stating its own window, and better evidence than any vendor
page. The output figure is not read from this route any more: models.dev is
looked up with the route id's `-free` suffix removed, its paid twin's
`limit.output` is the declaration, and the hand-watched 384000 is historical
fallback only. A single reply of 306,880
completion tokens (`finish_reason: stop`) was the old witness; the route states a
ceiling on some endpoints and not others, which is exactly why the completion
axis no longer asks it.

The DeepSeek id was the first entry measured this way and is no longer one: its
1,048,576-token window was withdrawn on 2026-10-19, when the route began
refusing prompts past a wall it no longer names. The paragraph below is for a
route that still names its window; what to do when it stops is the subsection
after it.

**Re-measuring.** The window: send a prompt of about 1.05M tokens and read the
number out of the refusal, three times, interleaved, per the rule below. The
filler measured 4.887 characters per token with about 1700 tokens of fixed
request overhead, and a request that is *served* says nothing about where the
wall is — it is what the calibration is checked against, since
`usage.prompt_tokens` is the real count while the refusal's "requested about"
figure is a rough one (characters, not tokens) and must not be read as a count.
A second upstream words the same fact as "This endpoint's maximum context length
is …" and breaks the request into text input, tool input and output.

**When the refusal stops naming the number.** Measured 2026-10-19 on
`deepseek-v4.1-flash-free`, and the shape to expect on any id this route starts
validating: a prompt past the window came back 400 with a body that names no
number at all —

```
{"error":{"message":"Your request resulted in more tokens than this model's
maximum context length allows. Please reduce the length of the messages or run
compaction.","type":"invalid_request_error","code":"context_length_exceeded"}}
```

— while the same run's `max_tokens` over the ceiling was refused *with* its
range: `Invalid max_tokens value, the valid range of max_tokens is [1, 393216]`.
The route states that ceiling on some endpoints and not others, though: a re-ask
the same day for `max_tokens` 1000000 was answered 200 with no number in it, so
that sentence is a statement to read when it appears rather than one to count on.
Nothing in `limits.mjs` reads the first wording, and it should not be made to:
it states no number, so any value taken from it would be the reader's guess.
What is left is a bracket, and it has to be measured in characters rather than
tokens, because a refused request reports no `usage.prompt_tokens`: 1,522,400
characters of this file's filler were served and counted 326,702 tokens, while
1,522,800 was refused — putting the wall within roughly a hundred tokens of
326,750, at 4.66 characters per token measured on that run. Two further probes
placed it there: 1,522,000 characters (326,617 tokens) served, 1,524,000
refused, and `max_tokens: 100000` alongside a 300,573-token prompt served, so
the two limits are enforced independently of each other. Six more sessions were
asked 250,413-token prompts and all six were served, which says the wall is not
somewhere below the biggest served sample.

The axis is set from that bracket, not from a statement: `limits.mjs` carries
**326000** for this id — the largest point the route is measured to serve
(326,702), rounded down, because a host has to stop below the wall and the wall
itself refuses the exact figure too: 1,522,600 characters, about 326,745
tokens, was asked three times and refused three times, so 326,750 cannot be the
declared budget. It is deliberately not the catalogue's 200000: the route
serves more than that from every session tried, and a window set there is the
quiet under-use this file exists to remove. It is not the old 1,048,576 either —
the refusal that named that figure has been replaced by one that refuses a third
of it. The remaining margin is also about the endpoints: on the same day, a
host's 254,196- and 279,095-token requests were refused in the same words while
a 331,989-token request was served, so an endpoint that says no sooner can be
reached at any size above 200000. Re-measuring means bracketing on fresh
samples, not reading a number: this refusal will not name one, and the wall
behind it moves.

**The input**, the third axis: nothing cheap names it — the refusals on this
route name the window, and this id's own refusal names nothing at all — so it is
measured by serving. A prompt sized past the declared input is the measurement
(535,110, 935,110 and 979,550-token prompts each came back with the needle at
their end echoed, and `usage.prompt_tokens` is the count that says how much was
served), and the window the catalogue declares for the same id bounds the value
from above: a request placed over it is refused. A measurement of its own is no
longer the only way the axis moves: at run time the axis follows the window, from
the table, from the sweep or from a window the route names while the plugin runs,
and an `input` the catalogue declares under that window is raised to it, which is
the rule stated in full under what a model is actually given below.

The ceiling, which is cheaper than the window: ask for `max_tokens: 1000000` on a
short prompt and stop reading as soon as the answer starts. An upstream that
validates the ceiling refuses and names it — `max_tokens is too large: 1000000.
This model supports at most 131072 completion tokens`, or LongCat's
`/max_tokens: 1000000 is not less or equal to 262144` — and one that does not
just begins to answer, so the cost of asking every model is a few tokens each.
There are three wordings now, all of them in `limits.mjs` (`namedOutputCap`) and
all of them read from production refusals as well, which is how a ceiling that
moves gets noticed without anyone running anything: the two above, and this
route's own range — `Invalid max_tokens value, the valid range of max_tokens is
[1, 393216]` — where the ceiling is the upper end of the interval it says it
accepts. The range pattern carries its own end, the closing bracket being part of
it, so a read that stopped inside the digits matches nothing and leaves the axis
unread; the two older wordings end on their number, and those depend on the
reader noticing where the read stopped (`digitsEnd`) before it trusts what it
read.

The output is no longer read from any of these sources. It is models.dev's paid
twin for the route id with `-free` removed (the `opencode` provider's own
record), or the canonical first-party/most-common claim when no paid twin
exists, applied as-is in both directions; the table's output entries and the old
twin/vendor/witnessed tiers are historical fallback only for an id models.dev
does not describe. A
value Zen accepts is still not evidence — `max_tokens: 2000000` under a short
prompt answers 200 and writes nothing like it — and neither is a generation
nobody watched finish, which is why the completion axis stopped being measured
rather than gaining another tier.

The evidence tiers are `route`, `route-twin`, `route-sweep`, `models.dev` (the
same records republished across providers, which says what scale a round million
was meant in), `vendor` and `witnessed`, in that order. The table here draws on
`route`, `route-twin`, `models.dev` and
`vendor` only: `route-sweep` is a measurement on this same route taken by a
machine rather than by hand, read at run time from the file the scheduled sweep
writes rather than written into this file, and it answers where the table has
nothing to say (below); `witnessed` - a generation somebody watched finish - is
used by nothing that ships here, and is accepted because `limitOverrides` is
exported and a caller may hand it a table that says so, while no shipped entry
says it. A live refusal is not an entry either: `observeRouteStatement` applies
one to the running process, for the rest of that process, and needs no record in
this file.

**What voids it.** Each axis records the catalogue value it was measured
against, and an axis whose declaration moved is dropped rather than kept: a
measurement of one question is not an answer to another. A catalogue that raises
the free id to the paid twin's figures therefore makes this file inert on its
own, which is the intended end state.

**While the plugin runs.** A refusal that names a window is read on its way past
(`observeRouteStatement`, called from the provider's `fetch`), and it corrects
that model's window for the rest of the process. The list is rebuilt at every
start and hourly after, so a route that changes the window it enforces is
followed without anyone editing this file. That correction is not written down: a
restart falls back to what is measured here and to the bracket below. The `input`
axis has no live form of its own: the refusals this route sends name a window and
a completion ceiling, and never an input cap. It does follow a window this
process was told about, though, exactly as it follows one from the table or from
the sweep: where the route names a window that the catalogue's `input` sits
under, that `input` is raised to it for the rest of the process, which is what
keeps the route's own answer from being shown as a smaller catalogue number.

**The wall is learned while the plugin runs.** Everything above was measured by
somebody by hand and written into a table, and that does not scale: the wall this
route enforces moved under one id on 2026-10-19, and the only reason it was
noticed is that a conversation filled the window and every request after it was
refused. The plugin already sees the traffic that would have shown it, so
`limits.mjs` keeps a bracket per model id and moves it only by what the route
itself answers, out of requests the host was making anyway. Nothing in this layer
sends a request of its own: a model nobody asks anything of is never probed, and
its declaration is exactly what the table and the catalogue said.

The two ends of the bracket are the two answers a route can give. `floor` is the
largest request the route is known to have served and `ceil` the smallest it is
known to have refused; `ceiling` is what the plugin then declares, and the one
number a host acts on, because it is what a conversation is compacted at and what
decides whether a request is worth sending at all. Both ends are read from the
characters of the request through one estimate rather than two, because a floor
and a ceiling read through different estimates are numbers on different scales
and the search between them would be searching a scale nobody declared in:
`estimateTokens` counts a Chinese, Japanese or Korean character at 0.7 of a token
and everything else at the route's own measured 4.66 characters per token, and it
reads only the strings a request body carries, so the JSON written around them is
not counted either. The script awareness is the point of it — a window declared
from a Latin ratio alone would come out at a third of the real one for a wall of
Chinese text, which is the under-declaration this section exists to remove — and
what keeps the estimate honest is the structure around it rather than its
precision.

**What the declaration is, and what moves it.** `ceiling` is the largest of three
numbers: the proven floor plus the current step, the seed, which is the table's
value while the catalogue still declares what it was measured against and the
catalogue's own number when it does not, and the value already declared. It is
then held under the bound a refusal puts on it and under the cap, and never below
1. `step` is how far above the proven floor the declaration is willing to go:
seeded at 5% of the seed and at least 1024, doubled each time a raise is taken
that really moved the declaration (by at least 1024, and capped at a quarter of
the seed, with 4096 as the smallest that cap may be) and halved on every refusal
(never below 1024). A raise that does not raise doubles nothing: the step is
part of what a raise moves, so it is written down only when the declaration
moved with it.

The bound is the
size the route refused, once it has refused one: a declaration may not sit on a
size the route turned down, and where the refusal named no number the bound is 2%
under it — unless that margin lands at or under the floor, where it is a margin
of nothing, and the next size is the midpoint of the bracket instead of a bound
the route has already contradicted — while a window the route named is exact and
may be declared as it stands. The cap is `OPENCODE_ZEN_FREE_MAX_WINDOW`, 1048576
by default, and it is read as at least the seed, so it only ever holds back a
value the search raised and never cuts down a number the table or the catalogue
declared. It does not cut down a window the route named in its own words either:
that number is the route's own and is published as it stands, so a route that
named 2,000,000 tokens is not brought back to this file's 1,048,576.

**Not every refusal is about the window.** An answer that is not 200 is not
evidence about size by itself: the route's failures wear the same clothes, and a
500, a rate limit and a 400 about a parameter it did not accept arrive as readily
as a prompt that was too long. Reading one of those as a wall would declare a
model smaller than the route had just served it, at the cost of part of a budget
that is four refusals deep: on 2026-10-19 `nemotron-3.5-super-vl-free` answered
two asks with a 500 and then served the identical sizes, and `space-bunny-free`
answered a ceiling question with `400 invalid request`. So the axis is decided
before anything is recorded (`refusalAxis` in `limits.mjs`), and only an answer
that is about the window moves the window. A number the refusal names decides it
first, because a numbered sentence is the route stating a limit and cannot be
anything else; failing that, only 400 and 413 can be about size, and the words
have to say so — `context_length_exceeded`, a maximum context length or a token
count the request went past, a prompt or messages said to be too long, or the
instruction to reduce the length of the messages. A refusal about `max_tokens` is
the other axis and is recorded as one; an answer that says neither —
`invalid request`, an empty body, a 500 — is about no axis and moves nothing.

**A refusal the route contradicts stops counting.** `ceil` only ever comes down,
so a bound drawn by one endpoint that was about to fail would be permanent, and
the declaration could never again climb over a size the route had in fact served.
That is not hypothetical: on 2026-10-19 `big-pickle` answered a 1,600,000-character
prompt with a 400 and then served that identical request, counting 343,131
tokens. So a served request at or above a size that was refused clears the bound
and gives the refusal back to the budget, and the note it reports is
`wall-unrefused`; `refusals` counts the refusals the file still believes rather
than the refusals that happened. A window the route named in its own words is
exempt, because that is the route stating a limit rather than one endpoint
misbehaving: every named number the sweep re-asked held still.

A raise is demand-driven, and that is the whole of the search. The host filling
the declaration, which is the largest request the route has served reaching 90%
of what was declared, is the only evidence there is that it wants more room: a
model whose traffic sits well under its window is left alone rather than given a
bigger one to not use, and when the host does fill it the declaration moves above
the floor and the step doubles with it. A raise that moves nothing is not a
raise: it spends none of the demand that pays for the next one — the host
cannot send a larger request than the window it was given, and that window did
not grow — and it starts no cooldown. A raise also waits out a cooldown
(`OPENCODE_ZEN_FREE_LIMITS_COOLDOWN_MS`, 900000 by default, which is fifteen
minutes), and a refusal stamps the same clock, so probes are spaced whichever way
the last one went. The cost is the part worth being plain about: a probe that
overshoots costs one refused turn, paid for by whoever was working with the
model, so a refusal below the bound so far tightens it to 2% under the size it
refused, halves the step and returns the declaration to the floor, and once four
refusals the file still believes have accumulated, the search stops raising for
that model; a record counts those refusals so an entry can be explained
afterwards. That is what makes the probes converge instead of oscillating: the
first refusal in a run is the largest, the next probe is under 98% of it, and the
declaration comes to rest at or under the largest size the route is known to have
served rather than on one nobody proved.

**What survives a restart.** A bracket forgotten on every restart is a bracket
re-learned by being refused again, which is the cost this layer exists to avoid,
so it is written to one small JSON file rather than derived again.
`OPENCODE_ZEN_FREE_LIMITS_STATE` names that file, and an empty value keeps the
state in memory only; unset, it is `limits.json` under `opencode-zen-freex` in
the cache directory the platform uses — `%LOCALAPPDATA%` on Windows, else
`$XDG_CACHE_HOME`, else `~/.cache`. The write is atomic, a temporary file beside
the target and a rename over it, because a half-written state file would be read
as a bracket somebody measured; the temporary file is named per write and the
writes are serialised behind each other, because two of them inside one process
landing on one path is the same half-written file arriving by another road. It
happens at most once per
`OPENCODE_ZEN_FREE_LIMITS_STATE_DEBOUNCE_MS` (5000 by default, and 0 writes
straight away) and never delays a request. The read is tolerant in the same
direction: a missing file, an unreadable one, one holding another shape or a
version this build does not know is simply no state, and the process starts from
the table; every field is checked before it becomes a record, and the file is
bounded at 500 models and 256 KiB. Nothing here may fail a request: a file that
cannot be written is a bracket that is not remembered, and a file that cannot be
read is a model with no history.

**What a model is actually given.** The context axis has five tiers, and the
order is the order they are consulted in: a window a refusal named while this
process was running, which is exact and applied as it stands; then the bracket's
ceiling, which exists only because a request was served or refused and so speaks
about the wall as it is enforced now; then the shipped table's entry, while the
catalogue still declares what it was measured against, so the table has the first
word for an id it names; then what the scheduled sweep measured on this same
route, which is the tier that answers for an id the table never named and for an
axis whose catalogue value has moved since, and which may lower a declaration
only when the wall behind it was bracketed or when the row carries a window the
route named in its own words; and last the catalogue's own number.
Whichever of them settles an axis is also what a fresh record is seeded from, so
the search starts from the table's number where the table answers and from the
sweep's where it does not, while the bracket the route teaches keeps the last
word either way. The bracket is route evidence by construction and is not bound
by the raise-only rule the weaker tiers obey, which is the point of it: it may
lower a declaration as well as raise it, and what it lowers to is the largest
size the route is known to have served. The output axis is no longer measured:
models.dev is read with the route id's `-free` suffix removed, its paid twin's
`limit.output` is taken as-is, and the table/live tiers below are not consulted.
The old live output tiers still exist only as the fallback for an id models.dev
does not describe — the completion ceiling an upstream names when it refuses the ask
(`supports at most N completion tokens`), LongCat's `is not less or equal to`
form, and the range this route answers an oversized `max_tokens` with, whose
upper end is the ceiling it says it accepts up to. The
`input` axis still has no refusal form - no refusal this route sends names an
input cap - but it is not static any more: it follows the window, and the window
may be answered by the table's entry while that entry still applies, by the
sweep, or by a refusal that named it while this process was running, which is the
strongest of the three and is taken as it stands. Where the catalogue declares an
`input` under that window, the axis is raised to it, because the two axes are one
fact stated twice and magpie reads `context_window` from the smaller of them. The
raise goes one way only - a declared `input` above the window is left alone - and
it happens only where the catalogue declares an `input` at all, since with none
declared magpie's own fallback already reads the window, and the table's own
entry for this axis wins while that entry still applies, because the entry
carries the samples behind it.

**What the sweep leaves, and how it is read back.** The scheduled workflow
(`.github/workflows/walls.yml`, hourly at :17) runs
`bun limits-watch.mjs --sweep --write`, which measures the ids the listing
offers and the snapshot does not name yet,
plus the ids whose wall was never found - a snapshot row that says `openEnded`
while the catalogue declares more than the snapshot ever served is an id whose
wall is one rung up - and measures those at most once a week, because the ladder
is the same on every run and only the catalogue's number and the route's own
build change, and neither of those is an hourly event. It does not measure the
ids the catalogue declares at a million or more at all: those are answered from
models.dev, the largest entry any provider declares for the same canonical
model, and an id answered from there is never measured, so it is never "new"
either. The rows of those ids are dropped from the snapshot as well - they are
rows about a window nobody asked about - and the run names the ones it dropped.
Each result is folded into `limits-observed.json` beside `limits.mjs`: the file
is pushed to the rolling `walls/observed` branch and carried by its pull
request - opened on the first changed run and updated in place on the ones after
it - with a compare link in the run summary where the repository does not let
Actions open one, and it never reaches `main` as a push - what reaches `main` is
a merged pull request, which in a repository that allows it is what the run does
itself (below). A wall that moves under an id already measured is not re-measured
on that timer, and `--sweep --all` is a person asking for a fresh reading of
everything that may be measured - the ids models.dev answers are not among them.
That file is an input at run time
now rather than only a workflow artifact: `measuredWalls()` reads it once per path
and keeps the answer, taking the path from its argument, else
`OPENCODE_ZEN_FREE_LIMITS_SNAPSHOT`, else the installed remote answer when there
is one, else the file beside the module, with an empty
value of that variable meaning no snapshot at all (and no remote either - a
named source is a decision). A missing file, an unreadable
one, one that is not JSON, one whose `models` is not an object, one whose
`version` this build does not know and one past 256 KiB answer the same way - no
measurement - because a build that cannot read a measurement declares what its
table and its catalogue say, and nothing here may fail a request.

**The snapshot from `main`.** A checkout reads the bundled file, and a tarball
waits for the next release for a measurement; since 0.4.0 the same document is
also fetched from
`https://raw.githubusercontent.com/tkhs101/OpenCode-Zen-FreeX/main/limits-observed.json`,
which is where the scheduled workflow's merged pull request already puts it. It
is the same committed file, not a new artifact: the workflow needs no change,
and a measurement reaches hosts without an npm release. 0.3.x does not read the
remote at all; one upgrade to 0.4.0 is what turns it on.

Where a snapshot comes from is a precedence, not a merge: an explicit file
argument (a host's or a test's) wins first; then
`OPENCODE_ZEN_FREE_LIMITS_SNAPSHOT` (a path, with `""` meaning no snapshot);
then the installed remote answer - the startup cache, then a background fetch;
then the bundled file beside `limits.mjs`. Naming that variable at all, even
empty, disables the remote rather than racing it, because an operator who names
a source has chosen one; `OPENCODE_ZEN_FREE_LIMITS_SNAPSHOT_URL=""` turns off
the remote layer alone. `limits-watch.mjs --check` and `--status` keep their own
positional file and never read the remote.

The cache is read synchronously at startup, before the first model-list answer
is built, and installed before any refresh is started; its mtime is the
answer's age, so a restart with a fresh cache spends no request. The default
path is `%LOCALAPPDATA%`, else `$XDG_CACHE_HOME`, else `~/.cache`, then
`/opencode-zen-freex/limits-observed.remote.json`;
`OPENCODE_ZEN_FREE_LIMITS_SNAPSHOT_CACHE` names another, and `""` disables the
cache - a supported deployment, since the snapshot is an optimisation. The
write is atomic (a temporary beside the file, then a rename) and 0600, and a
cache that cannot be written is a next start that fetches, not a refresh that
fails.

The refresh is background: `models()` starts it and never awaits it, so no
request waits on GitHub. One flight per process, and an attempt - successful or
not - sets the attempt time, so a dead URL is not a request per model-list open.
The TTL is an hour (`OPENCODE_ZEN_FREE_LIMITS_SNAPSHOT_REFRESH_MS`, default
3600000 ms), measured from the cache's mtime when one was installed and from
the last attempt otherwise; each fetch has a five-second deadline
(`OPENCODE_ZEN_FREE_LIMITS_SNAPSHOT_TIMEOUT_MS`, default 5000, bounded to
100..60000). A failed fetch leaves whatever was installed - the cache, or the
bundled file when there is none - and the next attempt is the next TTL. A host
that wants to see what answered asks the model map for
`Symbol.for("magpie.limitsSnapshot")`: `{source, fetchedAt, url, ageMs}` as of
the moment it asks. `url` is present only when the answer came from a fetch; a
cache file does not record which URL wrote it, so a cache-loaded answer reports
no URL rather than claiming the currently configured one.

The network cost is at most one small request per process per hour to
`raw.githubusercontent.com`. That host is not reachable everywhere - mainland
China is the case this was built with - and its absence changes nothing a
request does: the cache and then the bundled table answer, and nothing waits on
the fetch. `OPENCODE_ZEN_FREE_LIMITS_SNAPSHOT_URL` takes a mirror URL (any
`http:` or `https:`), which is the supported way to read the same document from
somewhere else; an empty value disables the remote.

A downloaded document is data, never code: JSON parsed, not evaluated. It is
rejected whole when it is not text, larger than 256 KiB, not version 1, not an
object of rows, or holds more than 1,000 rows - and also when no row survives,
so an empty or wholly invalid download cannot wipe the table a build shipped
with. Individual rows are skipped instead: an unusable id, a row that disagrees
with itself about its refused size, a wall this build does not know, and
numbers outside the sweep's own bounds (a named window or served token count above
4,000,000, a character count above 32,000,000, a token count above twice its
character count plus 4096) are not measurements. A body without a
`content-length` is read in chunks and cancelled as soon as the running total
passes 256 KiB, so the bound is bytes read rather than bytes remembered.
Only a whole valid document is installed, and the installed Map is replaced as
a whole. `unavailable` is history here as everywhere: the remote reader ignores
it, and no snapshot - bundled or downloaded - can hide, disable or reroute a
model.

`limits:sweep` says what a run learned in its exit code: a run that asked about
models and learned nothing about any of them exits 1, and a run that asked
nothing at all - every id was answered from models.dev - exits 0, because
nothing failed and nothing was learned.

**When the timer is not hourly.** GitHub's `schedule` event is best effort: it
is delayed under load and can be coalesced, and on this repository it has
arrived every three to five hours rather than hourly. A deployment that needs
the interval can dispatch `walls.yml` with `automatic=true` from its own timer
(the oc deployment does this at :17) while the repository keeps the cron as a
fallback. The `guard` job reads the last successful `walls` run and skips the
trigger when it is less than 55 minutes old, so a late cron, the external timer
and both together still cost one measurement; concurrency serialises the two
runs and the queued one then sees the fresh success. A manual dispatch leaves
`automatic=false` and bypasses the guard - a person asking is not the timer
asking.

`limits:watch` tells three answers apart, because the workflow reads the code to
know what it has: 0 when the route was reached and offered at least one free id,
1 when the route, the catalogue or the snapshot could not be read or written, and
2 when the route was reached and offered no free id at all. An empty listing is
not an outage, so 2 is reported as reached with nothing to publish rather than
as a dead route.

Each row contributes what it measured and no more: the largest prompt the route
was watched to serve, floored to a whole thousand, the same rounding and for the same
reason as the numbers in the table above; whether the sweep hit a wall at
all, which is whether its `wall` is `bracketed`; and, when one of the refusals
stated the window, the window it stated. A bracketed wall had two refused
sizes behind it, so the served sample is a point the wall is known to sit above
and the axis may be answered with it either way, which is what lets a sweep value
lower a declaration as well as raise one. A window the route named in its own
words is the route's own number and settles the axis outright, as it stands -
and such a row survives the rule that drops the rows models.dev answers, because
a vendor raising a declaration over a million does not un-state what the route
said about itself. A wall the sweep never hit is a floor -
the route served this much and said nothing about the rest - and a floor under
the declaration says nothing about the declaration, so it may only raise one. The
sweep's other two labels, `openEnded` and `single-refusal`, are that same floor
when the row has a served sample; a row with none, which is what a sweep that was
refused everything leaves behind, is no measurement at all. The sweep asks
for sixteen completion tokens and measures a prompt, so it answers the context
axis only: the output axis is not measured at all and follows models.dev's paid
twin for the route id with `-free` removed (or the canonical/catalogue/table
fallback for an id models.dev does not describe), and `input` is still measured
by nothing here, though the window that axis follows may be the one the sweep
settled rather than the table's (above).

A row may also carry `unavailable`, the day the sweep last heard the route call
the model itself gone. Only an explicit answer counts: a 404 or 410, or wording
that names the model as not found, unavailable, retired or no longer there, and
only when every answer of that run was an error. A 429, a 5xx, a timeout, a
transport failure, an auth rejection or a malformed answer is not a liveness
verdict - the run could not ask, and the next run may be answered. The field is
history and not a switch: nothing hides, disables or reroutes a model, a row
that later serves or refuses the model is rewritten without it, and `--status`
reports `model_unavailable` only while the day is recent (a week, the same bound
the suspicion rule uses).

A row that counts characters and no tokens is invisible to the plugin, and that
is a decision rather than an oversight: the route served the prompt but sent back
no count of its own, and the only way to turn characters into tokens here is the
estimator's own ratio, which exists to guess how big a *request* is so that a
request may be sent. The same ratio turned into a declaration would publish an
estimate as the wall the route enforces, which is the one thing a declaration is
not allowed to be. The sweep keeps such a row - a route that served without
counting is evidence that it serves - and the table's own number still stands
for that model.

The file says what its numbers are, because the names cannot change: a
top-level `_units` names the unit of every field - `servedTokens` and `named`
are tokens, `servedChars`, `refusedChars` and `refusedSizes` are characters,
`at` is the day it was measured and `unavailable`, when a row has it, is the day
the route called the model gone - and a reader who takes one for the other is
wrong by a factor of four. `bun limits-watch.mjs --check` reads the
`limits-observed.json` beside `limits-watch.mjs` and says, line by line, what is
wrong with it; it asks nothing and writes nothing, so it can be a gate on the
file a run is about to publish. It does not follow
`OPENCODE_ZEN_FREE_LIMITS_SNAPSHOT` - the default path is that repository file
- so name another path on the command line to check one; neither it nor
`--status` reads the remote snapshot.

`bun limits-watch.mjs --status [--json] [--stale-after N]` asks a different
question about the same file: whether it is fresh and healthy rather than
whether it is one the plugin can read. It stats and reads the file, never asks
the route and never writes. `--json` makes the report one machine-readable line
(`snapshotPath`, `generatedAt`, `ageSeconds`, `staleAfterSeconds`, `stale`,
`models`, `rows`, `issues`), where each row carries `id`, `wall`, `at`, `tried`,
`ageDays`, `stale` and, when the row has one, `unavailableAt`, and each issue is
a `code` and a `message` (`snapshot_missing`, `snapshot_unreadable`,
`snapshot_not_json`, `snapshot_invalid`, `snapshot_stale`, `row_stale`,
`no_measurements`, `model_unavailable`). The staleness bound is two hours
(`STATUS_STALE_AFTER_SECONDS`), changed with `--stale-after <seconds>`; the file
follows `--check`'s rule - the first argument that is not a flag - with that
flag's value skipped. Its exit codes are its own because the question is: 0 when
the snapshot is readable, valid and fresh; 2 when it was read and is degraded
(an invalid row or unit, the file or a row past its age bound, no rows at all,
or a recent `unavailable` row); 1 when it cannot be read at all. `--check`
remains the publish gate and answers only 0 or 1, because it
asks nothing and "not reached" is not one of its answers.

Applying one is reported as it happens: `OPENCODE_ZEN_FREE_LIMITS_DEBUG=1` gets a
`sweep-statement` line naming the model, the axis, the value, the wall behind it
and the date the sweep wrote. Where the sweep is what settles an axis, its value
is also what a record is seeded from, so a wall that moved and was measured again
is the number the runtime bracket searches around rather than the one the
catalogue still prints.

**What happens to a run.** A run that measured something new leaves one changed
file on the rolling `walls/observed` branch, carries it in that branch's pull
request - opened on the first changed run, updated in place on the ones after
it - and merges it, so the measurement is on `main` before the run ends and an
id Zen made free an hour ago has a measured window this hour instead of waiting
for somebody to notice. The file is checked
and the suite is run over it before that happens: a workflow started with
`GITHUB_TOKEN` starts no workflow of its own, so the pull request on that branch
runs no `ci.yml` of its own and the squash merge produces no `push` run either -
this job checks what it is about to publish and runs the tests over it. The
report travels in
the pull request body and the diff beside it: a row per model, the sizes that were
served,
the sizes that were refused and the labels above.

Merging unattended is defensible here for two reasons, and the workflow checks
both rather than assuming them. The pull request is `limits-observed.json` and
nothing else, compared against the file list GitHub reports for it - a pull request
that turns out to carry anything else is left open with a warning instead. And the
numbers are bounded by construction: a row's value is the largest prompt the route
was watched to serve, floored, and the table keeps the first word for every id it
names, so an automatic merge can only move an id the table does not answer, and
only to a size something was actually served at. A measurement can still be wrong
in a way a person could have seen - an endpoint that answered a size it should not
have, a model measured on the wrong protocol - and that is what the pull request
record is for afterwards, since a merged commit is reverted as easily as it was
merged.

A repository that wants the click back sets the variable `WALLS_AUTOMERGE` to
`off`: the pull request is then left open, and the run summary says so.

A host picks the file up when it next starts, because it is read once per process;
an id that appeared on Zen is offered whether or not this file mentions it, at
whatever the catalogue declares, until that happens.

**What this does not do.** It cannot learn a wall above the sizes the host
actually sends: the declared ceiling is what gives the host a reason to send a
bigger request, and a host that compacts at the declaration never reaches a wall
far above it, so the bracket climbs one declaration at a time and only while
something is filling each one. A learned value also reaches the host at its next
model-list rebuild — the start, an hour later, or an explicit `refresh()` — and
not on the request that learned it, which is what keeps this from being a loop:
the bracket moves on traffic the host sent against the declaration it was given,
not against the one being computed now. And the estimate is read from characters
while the route counts tokens, so a bracket proves a size a few per cent away
from what a tokenizer would say.

**Re-measuring, now that the plugin measures too.** The hand measurement above is
still the ground truth where it speaks, and is still what a bracket is seeded
from for an id it names while the catalogue has not moved; for an id it does not
name, the sweep's measurement is that seed instead, and the plugin's own learning
is no substitute for either, since it can never reach a wall the traffic does not
touch. A single refusal is not a wall on this route either: the same id
has refused a prompt and then served the identical request, so what a hand
measurement looks for is two refused sizes behind one wall, which is the runtime
counterpart of the bound this layer drops when the route serves past it. What the
plugin believes is in the state file named above, and each movement is reported as
it happens when `OPENCODE_ZEN_FREE_LIMITS_DEBUG=1` is set: each raise that moves
the declaration, each refusal that moves it back, and each refusal the route goes
on to contradict gets a line of its own, naming the model and the numbers behind
it — the value the declaration moved to, the size the route served or refused, the
window a refusal named when it named one, and how many refusals the model has
cost. A bracket that has learned something wrong is forgotten by deleting that
file, or by pointing `OPENCODE_ZEN_FREE_LIMITS_STATE` at an empty string for a run
that should not remember anything. What comes out of the state file is not
evidence for the table in this file: it is one process's traffic, and the table
wants a measurement.

**The same shape on a second upstream.** `mimo-v2.6-flash-free` is declared
200000/32000 in the catalogue, the under-report the DeepSeek id has, and the route
once named its window in its own words: an 850,249 token prompt was served first,
its needle echoed back, and then a prompt just over the wall was refused with

```
This endpoint's maximum context length is 1048576 tokens. However, you requested
about 1496523 tokens (1295079 of text input, 1444 of tool input, 200000 in the
output).
```

which is the route naming its own window, on an upstream that words it
differently from the DeepSeek ids. That figure was overtaken on 2026-10-19, when
a prompt of about 408,000 tokens was refused — less than half of it — so the axis
is the route's own enforcement found by bracketing (375,142 tokens served on
2026-10-20, the nearest reproduced refusal at 1,787,500 characters, after an
earlier probe was refused at 2,800,000) rather than the number the route
stated, the same way the DeepSeek id's stated million went. Its output is now models.dev's paid-twin lookup for
`mimo-v2.6-flash` (no paid twin, so the canonical consensus), 131072; the old
vendor-derived number is fallback only. That same refusal came back with the
200000 it was asked for, unclamped, so this route states no completion ceiling of
its own — the reason the completion axis is no longer measured here.

**Looking for the next one, instead of waiting to notice it.** `bun run
limits:audit` asks the route which free models it still offers — the listing's
ten, not the forty the catalogue still describes — and asks each one the cheap
question above. It groups them by the `x-opencode-upstream-model-id` the route
answers with, because two ids naming one upstream model are one capability, so a
declaration that differs inside a group is the question worth asking. It prints
those, the ceilings it was told, the windows a refusal named, and the ids that
are gone (410) or unavailable (400); it writes nothing and measures no window.
Its first run named
`big-pickle`'s ceiling and two ids declared below what the route says
(`nemotron-3.5-lightning-free` at a quarter of its window, `longcat-2.5-preview-free`
at half its ceiling), which is the whole argument for having it. The run behind
the 2026-10-19 table above was that work done by hand, and the audit after it
reports no candidates at all — nothing offered is under-declared relative to the
sibling the route groups it with — which is the state the table was moved to reach
rather than a reason to stop asking, since the walls move.

## The loop

```sh
bun test              # the unit tests; these never touch the network
bun run limits:audit  # what the route offers, what limits it states, what to measure
bun run check:gate    # asks Zen which generations are still accepted
bun run capture -- --dry   # takes a fresh capture and reports the difference
bun run capture            # writes it
bun run check:gate         # did that fix it
```

`bun test` reads the tree; a running gateway does not. Magpie's plugin host
imports the plugin once, when it starts, and no `magpie plugin` subcommand
reloads it — pointing a gateway at this tree does not make it watch the tree, so
a change to be measured through a live gateway needs that gateway restarted
first.

`check:gate` is the one that matters. It asks each generation twice, because the
plugin sends two shapes and Zen does not answer them alike:

| shape | tools sent | what it is |
| --- | --- | --- |
| `floor` | the names in `required` | what the plugin stands in for a host that is not OpenCode and has none of these tools by name |
| `full` | every tool in the profile | what a host that is OpenCode itself sends |

It reports each request as:

| verdict | meaning |
| --- | --- |
| `answered` | Zen served it; this shape is current |
| `refused` | Zen did not recognise it (403) |
| `superseded` | Zen wants a newer OpenCode than the profile claims (426) |
| `failed` | Zen answered with something other than a 403, so it never judged the fingerprint |
| `malformed` | the request could not be built: a name in `required` has no tool behind it in `fingerprint.json`. Zen was never asked, and the line names the generation, the shape and the name |
| `unreachable` | Zen could not be asked at all |
| `timed-out` | the request was still in flight when the deadline passed: the route did not say no about the wording, and it did not say nothing because it could not be reached - it did not answer at all, which is neither a refusal nor an outage |

A `malformed` row is a `fingerprint.json` problem, not a network one, and the
summary says so rather than sending the reader to `capture`. It is deliberately
not counted as `answered`: a run whose floors are all `malformed` exits non-zero.

The `floor` decides the exit code, because it is the shape this plugin exists to
send. The `full` is reported for what it says about a wording that has gone
stale. Asking only the full shape left a real gap: `read` alone is `answered` and
everything but `read` is `refused`, so a Zen that began insisting on one more
name would keep `full` passing while the shape actually sent was refused. The
diagnosis at the end reads the floor rows only: a stray 5xx on a `full` request
says something about that request and nothing about whether the wording is
current, so it must not turn "nothing was served" into "check the network".

Only a 403 and a 426 are Zen answering about the fingerprint. A 5xx, a 429 or a
401 says nothing about the wording, and the gate says so rather than sending the
reader to `capture` over an outage — as it does when nothing was reached, or when
part of a run answered and part of it did not.

`capture` needs Bun and `opencode` on PATH. It points a real OpenCode at a
server running locally and reads the request it makes, so nothing is sent to Zen
and no key is involved.

It compares against the file it is about to write, not the copy this repository
keeps, so `--fingerprint <path>` is the baseline and the tools it does not
observe are carried over from that file. A capture that is missing, that is not
JSON, or that is not a table of profiles is written from scratch rather than
refused: refusing would name a remedy - "run `bun run capture`" - that the broken
file would have killed at its import, and the command that repairs it has to be
able to start. A file that holds no `profiles` object keeps the rest of it and
has its profiles written afresh. What the file held is said out loud, because a
file replaced without a word is a file nobody knows was there. The Node floor
`package.json` declares covers the modules a host imports, not this one:
`capture` uses `Bun.serve` and `Bun.write`, so it runs under Bun, which is what
`bun run capture` gives it.

A capture writes `fingerprint.json` only. The prompts and the complete tool set
are captures of the same releases — `opencode-prompt-v1.txt` is the 1.x CLI's
system prompt from 1.19.3, `opencode-prompt-v2.txt` is 2.1.4's (the 2.1 line
rewrote the prompt as new prose, so it is its own file and carries placeholders
for the model, the date and the environment block), and `official-tools.json`
holds the full tool sets, 1.x from 1.19.3 and 2.x from 2.1.4 — and no tool
rewrites them: a capture rewrites a profile entire (`{ agent, required, tools
}`), so a table stored inside it would be dropped by the next capture. A
release that moves to a newer OpenCode takes all of them from the same one:
`capture` for the fingerprint, and the prompts and the tool sets by hand from
that CLI's own request. The 2.x prompts and tools on 2026-10-25 came out of the
2.1.4 desktop CLI through `mini-capture.mjs` (a local server the CLI is pointed
at, the same trick as `capture.mjs` but driving the desktop binary), and the
raw request it read is kept beside them as
`genuine-2.1.4-request.json`.

The next move of that loop, on 2026-10-28, is the worked example the watchers
promise: `releases-watch` named 2.2.0, and `capture` — pointed at the installed
2.2.0 desktop CLI, which a desktop build only runs when given `--standalone`
(said in `capture.mjs` where the flag is passed) — moved the fingerprint. Two
shapes changed and were recorded as they arrived: the agent string's client
segment, `cli` on 2.1.4, reads `desktop` on the 2.2.0 build, and the `read` and
`shell` definitions grew the `additionalProperties: false` this capture shows.
The prompts and the other ten tools came through byte for byte unchanged —
checked against the raw request, kept beside its predecessor as
`genuine-2.2.0-request.json` — so nothing was rewritten by hand this time; the
one new block in the 2.2.0 prompt, the skill listing, is the one `official-
prompt.mjs` strips, for the measured reason recorded there.

The `anthropic` provider-utils in `fingerprint.json` is the one entry a capture
cannot take: no free model speaks that protocol, so the anthropic request shape
is refused and the value in the file is one a human has to keep. It is
maintained by hand and has to be checked when `@ai-sdk/anthropic` is bumped, and
every capture that writes the file says so - it cannot tell whether that value
is current, and it must not let the file look as current as the rest of it.

The wording it reads is the host's, so the host's own details are put back to
something neutral before the capture is written: the OS banner, the scratch
directory, and now the shell's version. That last one was live — opencode 1.19.0
words `bash`'s description after the machine it runs on, one host saying
"Executes a given Windows PowerShell (5.1) command…" and another "PowerShell
(7+)…", and Zen reads those bytes out of the request, so two machines disagreed
about a description that belongs to neither. The version is dropped, which is
also what a capture on Linux already says; the live gate answered the neutral
wording four times running on 2026-10-16. What any wording is worth is settled by
`check:gate`, never by this file.

## Reading a failure

**Every `floor` `refused`.** OpenCode reworded its tools, or moved the endpoint.
Run `bun run capture`, then `check:gate` again. If the endpoint moved,
`DEFAULT_BASE` in `provider.mjs` is what has to change.

**One `floor` `refused`, the other `answered`.** OpenCode has released and this
generation is retired. Capture from a current OpenCode: it will be detected as
the other generation, so what is captured goes into that profile.

**A `floor` `refused` while its `full` is `answered`.** Zen has begun insisting
on a tool this plugin does not stand in, which the gate names in a line of its
own. What gets stood in is `required` in `fingerprint.json`, and the wording it
is stood in with is that profile's `tools`, so the name has to reach both, from a
capture taken of an OpenCode that has it. A host that brings its own tool by that
name is served either way, which is why only the `floor` shows this.

**`superseded` (426).** Zen raised the minimum version this profile claims. Raise
`agent.opencode` in `fingerprint.json` above what it asks for. 426 is Zen saying
"your client is too old", which is a different problem from 403 and is not fixed
by changing tools.

**`malformed`.** `fingerprint.json` names a tool in `required` that the same
profile does not carry under `tools`, so the gate could not build the request it
wants to ask with. This is not a network problem and not something Zen said: the
line names the generation, the shape and the missing name. Fix the file — a
capture from a current OpenCode is the usual way — and ask again. The run exits
non-zero, and the summary says the same thing in one sentence.

**`unreachable`.** Not a fingerprint problem. Check the network, and whether
repeated refusals from this address have put it in a cooldown — they can, and
the cooldown answers like a refusal.

**`timed-out`.** The request was still in flight when the gate's deadline
passed. The route did not say no about the wording, and it did not say nothing
because it could not be reached either — it did not answer at all. Ask again,
or look at the route's load: a request that is still in flight is not a
refusal, and the summary says so rather than sending the reader to the network
or to `capture`.

**`failed`.** Zen answered, but not with 403: a 5xx or a 429, or a 401 if the
request was not authorized. Not a fingerprint problem either, and the gate says
so rather than naming the wording. A 429 is the one to read twice: repeated
refusals from this address can put it in a cooldown, and a cooldown answers
quickly and often — and since 2026-10-28 the same `FreeUsageLimitError` body
("free usage limit reached") is also what a *promptless* request earns, on any
egress, under any session id old or new: the tier stopped serving requests
without the generation's system prompt and answers them from the quota page of
its error catalogue. The gate's probes now carry the prompt (the gate's
`chatRequest`, where the measurement is dated), so a `failed 429` here means
what it says again.

## What the request path already carries

The observations below were taken from a byte-capture of a real OpenCode request
the same way the fingerprint itself was never guessed, and the plugin read
them and answered by building the response into what it already does rather
than by leaving a plan in a comment. Three of them read like features of
this proxy — they are, and each is a sentence or two about a lane the gate
already reads.

**The gate reads the stream flag.** The route's own spec, measured from
a capture replay, names three things a request must carry and names the stream
flag among them — a request with `stream: false` is refused on the shape it
presents. What this plugin does about it is older than the observation: every
request leaves with `stream: true` set, and a host that asked for a plain JSON
answer gets one anyway, because `stream.mjs`'s `collapseResponse` is what the
request path returns through when the host did not ask to stream. The
contingency is not a plan; it is the default path. What could still break it is
an upstream that starts distinguishing *how* it streams (chunking, ordering,
envelope), and the answer for that would be a capture of a streaming request
rather than new code.

**Identity hops in bursts are blanket-refused.** The same replay measured that
a burst of requests that each hop to a fresh identity (a new session id, a new
project id) from one egress gets refused as a batch, while the same requests
spaced roughly half a second apart pass. The retry loop's own wait is a spacer
already and need not be touched — what was missing was the spacer between a
host's own consecutive requests, whose burst shape is the host's and not this
file's. `OPENCODE_ZEN_FREE_PACING_MS` waits a gap before each outbound request,
default off, because a delay on every request needs evidence in refusals and a
deployment that has them is the one that turns it on. The retry keeps its own
schedule: a retry is one replacement ledger, awaited, and not a burst.

**The window a 429 names can be honoured.** A route's 429 may carry a
`retry-after` header that says when the same bucket answers again. The retry
schedule above deliberately ignores it by default — its defaults are short and
its opinion is already documented — but `OPENCODE_ZEN_FREE_RETRY_AFTER=1` hands
the wait to the route whenever it makes one: one attempt's wait replaced by the
route's window (bounded by `RETRY_WAIT_MAX_LIMIT_MS`, so no spelling of a header
can park a host), the schedule untouched for the next refusal without a window.
`retryAfterHeaderMs` in `provider.mjs` reads both HTTP spellings because both
are ones the tier has used.

**A retry's ledger is minted as one pair.** The tier reads a session id and a
project id as one conversation in one project, so a retry replaces both halves
together (`mintIdentity` in `provider.mjs`), from one reading of the clock, and
the pair's ids that replace each other are a pair that says one thing. The
first attempt keeps `sessionID`'s answer: under affinity that id IS the
conversation, and outside it the window's pair is already the first attempt's
own half.

## The watchers

Two scheduled watchers ask questions elsewhere, so a move is noticed rather
than reported; both are checkout tools, and both follow the walls workflow's
conventions (an interval guard, a report in the run summary, a pull request for
a file whose values a host reads).

- `models-watch.mjs` (`catalog.yml`, hourly) reads OpenCode's docs table — the
  page `models.mjs` parses on every discovery — and commits what the same parser
  made of it as `models-observed.json`. It is derived data, not a measurement:
  it costs one page's read and no Zen credential at all. The runtime layer is
  `catalog.mjs`, which installs the answer under everything newer (the cache,
  then the bundled floor, then the bootstrap table) and over nothing that the
  live docs name. The shape rules both ends obey are the parser's, and the
  file a workflow publishes is preflighted by `--check` before the network is
  asked and re-checked before it is published.
- `releases-watch.mjs` (`releases.yml`, daily) reads OpenCode's releases feed and
  compares it with the version `fingerprint.json` says it was captured from. It
  answers with a fact, never with a change: a newer release means the floor may
  have moved, and what acts on that is the capture loop. A new release opens the
  one open issue that asks for it, and the watcher itself rewrites nothing — a
  version that moved without its prompt and its tools is the one shape the gate
  reads as incoherent.

## Things that are easy to break

**Marking a list as fallen back when Zen's own list was read.** `discover()`
returns every id Zen's `/models` lists; the catalogue and the console docs only
add what each model *is* — name, protocol, limits. When either of those two
cannot be read, the list is not a fallback: it is Zen's, current, and complete to
the last id. Saying so costs a user something real, because the host reacts to
that marker by keeping the last list it read in full, and a machine that cannot
reach `raw.githubusercontent.com` or `models.opencode.ai` — mainland China, for
one — then never sees a model Zen made free since. The marker belongs to the one
case that describes it: the listing itself could not be read, so what is returned
really is the last list there was (`yetone/magpie#2385`).

**Keeping the last successful listing.** A discovery round that reached the
route is remembered in `discovery.json` under the platform cache directory -
`%LOCALAPPDATA%`, else `$XDG_CACHE_HOME`, else `~/.cache`, then
`/opencode-zen-freex/discovery.json` - and `OPENCODE_ZEN_FREE_DISCOVERY_CACHE`
names another path; an empty value keeps discovery in memory only. The file
carries `version` (the one schema this build writes and reads), `listedAt` (the
ISO date and time of the read), the model records and the protocol map as the
route answered them. It is an input to discovery, not a second source of truth:
read once at startup as the starting table (it replaces the older shipped
bootstrap table, so an id only the bootstrap knows is not advertised after the
route dropped it; its `listedAt` becomes the last-read time, so a restart does
not re-ask inside the re-list interval), and it is what the listing-failure
fallback carries - a live read always wins and overwrites it. Its age travels to the host as
`Symbol.for("magpie.discoveryAgeMs")`, a non-enumerable symbol beside
`magpie.fellBack`, so a host can tell a cached answer from a read made a moment
ago; with no cache and no successful read there is no age to state. The write is
best effort and atomic (a temporary beside the file, then a rename), never
awaited on the request path, and a cache that cannot be read or written behaves
exactly as if it were not there.

**Waiting for the catalogue before offering a model Zen already lists.** An id
ending in `-free` that neither the catalogue nor the docs describe is offered
anyway, asked through the provider's own protocol (openai-compatible, and so
chat) — the way OpenCode asks a model with no package of its own. Zen lists a
model the hour it turns free and the catalogue catches up later; a host should
see it in between. An id that does not call itself free still needs the
catalogue's word, and one the snapshot or the docs name keeps that say:
`jev-1.13-free` is SystemOne and stays out.

**Adding a header.** The set sent has one owner: `outboundHeaders` in
`provider.mjs`, which the plugin builds its request with and which the gate asks
Zen with, so neither can drift from the other on its own. `index.test.mjs` pins
the names on the wire. `x-opencode-request`, `x-session-affinity` and
`x-session-id` are all in OpenCode's own header set upstream and none is sent;
measured 2026-10-15, each of the three answers on its own while
x-opencode-request with x-session-affinity is refused. A header cannot be judged
by adding it on its own, so add it in `outboundHeaders` and let the pinned test
and a live `check:gate` say what it did.

**Reading the session name.** The default holds one `ses_` id for the window
`OPENCODE_ZEN_FREE_IDENTITY_TTL_MS` sets — a fresh pair at each window's start
— and reads none of what follows: the tier keeps what it thinks of traffic
against the session, and a session minted at the start of a window carries none
of the memory the one before it left. The mint is `opencodeID`, whose timestamp is the
current moment — the one constraint that matters, because the tier decodes the
timestamp and answers an id dated far from now with the same 429 a genuinely
exhausted quota returns (measured by opencode2api on 2026-10-25: hash-derived
timestamps landed in 1970 and made healthy egresses look blocked, its 9533101;
its own fix anchors to today minus at most 30 days to keep ids deterministic,
which per-request rotation has no need of). Never write a hash into the time
field. `OPENCODE_ZEN_FREE_SESSION_AFFINITY=1` puts the ladder below back in
charge, and then the name a conversation is keyed by comes from the
first signal that has one, in this order: the headers `x-opencode-session`,
`x-opencode-session-id`, `x-session-affinity`, `x-session-id`, `session_id`,
`conversation-id`, `conversation_id`; then the body's `conversation_id`,
`metadata.session_id`, and the Claude Code `metadata.user_id` (its
`_session_<uuid>` tail, or a JSON object carrying `session_id`). An empty string
is no name at all - folding those together would give every such host one Zen
session. When nothing names the conversation, the seed is the system prompt and
the first user turn together: `system` and `instructions`, then
`system`/`developer` messages ahead of the first user message; the pair is
hashed, so a changed system prompt is a different conversation and two agent
clients that open with the same boilerplate turn do not collide.
`previous_response_id` is the last explicit signal, read only when there is no
opening to key by, and a conversation with none of these gets a fresh `ses_` id
per call. An id already in OpenCode's shape passes through untouched.

**Reading the protocol table by its columns.** The console docs are read as a
table whose rows name an id and the endpoint that id is asked at, and the
endpoint is found by the cell that holds one — not by a column number — so a
table that gains a column, loses one or renames one still says which id it is
talking about. A table that holds no endpoint this plugin asks about is not the
same as a document that says nothing, and the two are told apart: a model left
on the snapshot's own protocol is asked at the wrong one and fails upstream in a
way a host cannot explain, so `OPENCODE_ZEN_FREE_MODELS_DEBUG=1` says how many
rows the document had and that none of them names an endpoint.

**Renaming the host's tools.** The host's tools go out under `clint_` names with
their own wording and parameters, and the complete official set follows them, so
the name a host declared never has to impersonate an OpenCode one. What the
renaming may touch is the name only: the parameters go out as the host declared
them, so the call the model makes still fits the tool that runs it, every
reference in the body follows the rename, and the reply's names are restored to
the ones the host declared — a host that saw a `clint_` name would answer a tool
it never had. Rewriting the parameters as well looks tidier and breaks the
agent.

**Sending the host's wording in place of OpenCode's.** That is what 0.1.5 and
earlier did — the host's names carrying invented descriptions — and it is a
guaranteed refusal; the official set is sent whole instead, beside the host's
own tools.

**Advertising a skill the host does not have.** The prompt 0.5.4 sent ended
with a listing of OpenCode's built-in skills — `customize-opencode`, "use when
editing opencode's own configuration … agents, plugins, MCP servers". A model
asked to register an MCP server on 2026-10-25 read exactly that and called the
official `skill` tool for the name, twice; the host happened to carry a `skill`
tool of its own and answered `skill "customize-opencode" is unknown or no
longer available`, which reads as the tier's error wearing the host's name. The
listing is not part of the shape Zen is known to read — opencode2api's deployed
prompts end at `</env>` and name no skills — so it was pure cost: an invitation
to call a tool nothing stands behind. The prompt ends at the environment block,
and a skill may be named in it only if something on the host side will answer
for it.

**Sending the request from a host that is not Bun.** The tier reads the TLS
handshake before it reads the body, and the official clients handshake as Bun:
on 2026-10-25, from one live exit with the minute held equal, the genuine
request replayed byte for byte answered 200 under Bun's BoringSSL ClientHello
and 429 Free usage limit under Node's OpenSSL one — the same disguised refusal
an exhausted quota returns. opencode2api built a whole `BunTransport` (uTLS
replaying Bun 1.4.3's ClientHello) for exactly this; nothing in this package
can reshape Node's handshake, so the plugin's fetch must simply run inside a
Bun host. Magpie runs its plugins under the Bun it ships (`magpie-bun.exe`,
downloaded beside the plugin host), which is why plugin traffic passed while
every Node-run diagnostic probe beside it was refused. Probing the tier from a
checkout means `magpie-bun` too — `bun tools-smoke.mjs` already qualifies, a
`node` one does not.

**Sending a request down a retired lane.** The 1.x lane — 1.19.3's prompt, its
tool set, its User-Agent — stopped being answered on 2026-10-25: from a live
exit under Bun, the 1.x shape 429'd where the 2.x shape 200'd, and a DeepSeek
Harness session died mid-afternoon exactly there, because its tools named
neither `bash` nor `shell` and the old default sent it as 1.x. No IP, session
or wording recovers a lane the tier no longer serves, so the request path
presents 2.x whatever the host declares (`DEFAULT_GENERATION` in
`provider.mjs`); `generationOf` still exists for diagnostics, and the gate
still probes 1.x — its `refused` floor is now the retirement showing, not a
wording gone stale.

**Teaching Code Mode to a host that cannot run it.** The 2.1.4 prompt commands
the model to "use the `execute` tool to call the tools listed below", and the
official set — `execute`, `shell` and the rest — rides in the tools array
beside the host's own, because the gates read it. A model that believes its
prompt opens with `execute` and is answered `unknown tool`: measured 2026-10-25
on DeepSeek Harness, `execute` first, then the catalog's `shell`, and only the
third call found the `clint_` names — two failed calls at the head of every
session. The correction travels as the prompt's own convention for harness
instruction, a `<system-reminder>` appended after it (the tier does not check
the prompt byte for byte: the skills listing was removed in 0.5.5 and the whole
2.1.4 text was swapped in 0.5.7, both answered): Code Mode is not active here,
the callable tools are the `clint_` names — enumerated per request, from the
body as the renaming left it — and a host that declared nothing is told so
outright. The note is built in `toolAvailabilityNote` and pinned in
`official-prompt.test.mjs`; it says nothing about generations or gates, only
what a model in this session needs to choose its first call.

**Sharing a project id with the rest of the internet.** The tier ledgers its
free quota per project id and egress together, not per egress alone: on
2026-10-26, from an exit that answered 429 to the genuine CLI under one
project id, the same CLI under a brand-new project id answered 200 — and a
random 40-hex id in the plugin's own shape answered 200 from a spent exit
twice. The old default, `global`, is the id every freeriding plugin user's
traffic carries, so its buckets on popular exits arrive pre-burned: that is
how a popular exit answered 429 twenty-one seconds after this deployment first
used it (2026-10-25, Miami). A host that names its project — by header or with a
git one magpie hands over — keeps its own name; a host that does not gets a
git-hash-shaped id of its own, held for the window above (`randomProjectID` in
`provider.mjs`), a ledger no other traffic shares wherever the request lands.
The gate probes the same way (`tools-smoke.mjs`), or it would report a
wording refusal where the truth is a spent `global` bucket. Nothing is known
to read the id beyond its shape.

**…but a saturated exit has no ledger to switch into.** The per-(id, egress)
ledger is only visible while the egress itself has room. The `public`
credential identifies no one, so nothing can be ledgered against it: the
tier keys its limits to what does distinguish traffic — the egress IP, and
beneath it the project id (the session carries its own memory of the
traffic, but no quota is known to hang from it). The egress-level budget is
spent by everyone routed through the same exit, which is most of what makes
popular VPN exits pre-burned: on 2026-10-27 an exit whose admission probe
had just answered 200 (a few-KB request) refused a ~32k-token request five
times and then a ~5k one five more — ten fresh project ids, ten fresh
session ids, one answer: 429 "Free usage limit reached". Our own spend on
that IP in the minutes between the passing probe and the first refusal was
~10k tokens, so the exhaustion was the world's, not ours. The same morning a
death spiral on another exit produced thirty such fresh-id refusals over
7.5 minutes (tiny probes on another exit passed in the same
minutes). So the model that fits both measurements is a min of two budgets:
the per-(id, egress) ledger the retry can reset, and a per-egress budget it
cannot. On popular VPN exits the egress budget is what answers, and the only
fix is time. Measuring this takes real-size requests: a
probe the size of the admission ping sees the per-id ledger and misses the
ceiling entirely. How deep the per-id ledger itself goes is bounded from
below, not measured: one fixed project id served ~15M tokens on
2026-10-27 without a single refusal — ~2.3M on one exit, then ~12.7M more
spread across seventeen exits over ~75 minutes (each exit freshly admitted
and carrying only a few requests, so the egress budget could not answer for
it; ~115k-token requests at
~400k tokens/min, the tens-of-millions question asked and answered). If an
id-level total cap exists it is larger than that, or the ledger refills at
least that fast — so in practice the egress budget is almost always the one
that answers first, and after a 429 the project and session ids do not need
changing, only the egress does.

**That bound is now in doubt.** On 2026-10-28 an operator reported a spent
tier answering again after the local state was wiped (a new project id) *and*
the egress replaced. The two-budget model above does not predict that: a fresh
egress is already a fresh (id, egress) pair, so the wipe should have bought
nothing. Either the wipe was not what recovered it and the fresh egress was,
or an id-level budget exists that the 15M run never reached — the run above
bounds that cap from below, it does not rule one out. One experiment tells the
two apart: change only the egress and keep the id. Until that is run, treat
the 15M bound as the floor of an unmeasured quantity rather than as a
statement that no id-level cap exists.

**One pair, held for a window, one per conversation.** The pair is no longer
minted per request. `currentIdentity` keeps one (project id, session id) pair
per conversation for `OPENCODE_ZEN_FREE_IDENTITY_TTL_MS` — 60 seconds by
default — and replaces both halves together when the window ends; a retry still
replaces it at once (`rotateIdentity`), and the pair that answered becomes that
conversation's window, because a ledger proven to answer is worth more than the
one it replaced. The slot is `conversationKey`: a digest of the host's own name
for the conversation, read by the same ladder `sessionID` walks (the session
header the CLI sends on every request, then the body's `conversation_id`,
`metadata.session_id` or Claude Code user id). The name is never sent — only the
pair minted for it — so keying by it costs nothing at the tier and keeps two
conversations from sharing one session, one memory and one refusal. The opening
and `previous_response_id` are deliberately not names: the opening moves when a
host shortens its history and a continuation id is new on every turn, so keyed
by either a conversation would answer a new pair every turn — the hop burst the
window exists to avoid, arrived at by accident. A request that names nothing
shares the unnamed slot, which is the single pair this package used before the
window existed.

The reason for the window is the one the pacing setting already records: a burst
of requests that each hop to a fresh identity is refused as a batch while the
same requests spaced about half a second apart pass, so a client that appears as
a hundred strangers in a minute is a client the gate has an opinion about.
Holding a pair is also the shape a real client has — it opens a conversation,
uses it for a while, opens another. `0` restores per-request minting, which is
the value to measure a ledger with: an id that rotates cannot answer a question
about one id. Session affinity still owns both halves when it is set, and a
project id the host named is never re-minted; the window is this package's own
bookkeeping and moves only what this package minted.

**Handing a 429 on when a new ledger would have answered.** The 2026-10-26
measurement above is the whole reason the retry exists: a spent bucket is
not a spent exit, so the same request under a fresh project id can answer
200 where it just answered 429 — when the exit's aggregate has room for a
new ledger. When it does not, the same retry buys nothing but a slower
failure, and that is the case the defaults are tuned for: two tries, ~3.6s
of waiting in total, so a saturated exit costs seconds rather than a turn.
A host does not recover from a 429 on its own — DeepSeek Harness ends the
turn and reports the quota as exhausted — so the plugin spends a retry
before it hands the refusal on. Each attempt mints a project id and a
session id nothing has spent and sends the same bytes (`attempt` in
`provider.mjs`); the wait starts at `RETRY_WAIT_DEFAULT_MS` and doubles, and
the whole thing is off with `OPENCODE_ZEN_FREE_RETRY_429=0`.

What it deliberately does not retry is as important as what it does. A 403 is
about the fingerprint or the egress, a 426 about the version, and a 5xx is the
endpoint failing — none of those is answered differently under a new project
id, so retrying one buys nothing but a slower failure. A 429 whose body names
abuse of the egress is not retried either: an id is not an IP, and the 403
branch already documents why no local action helps a block. And the refusal
that finally leaves is the route's own, untouched — a genuinely exhausted
account must still read as one, or the retry would be hiding the one fact the
user has to act on.

Two things a maintainer should keep true if this is ever reworked. The retry
must not re-shape the body: it is the same request under a new ledger, and
re-running `normalizeTools` or the prompt injection a second time would send a
body that differs from the one the first attempt sent. And a host that named
its own project id keeps it — `x-opencode-project` and magpie's git id are
statements the host made about itself, so only the id this package minted is
re-minted (`namedProject`/`hostProject` in the same function).

**Leaving out a call the agent has no tool for.** A call whose name folded onto
no declared tool was dropped from the reply with a note in its text, and a reply
whose every call was dropped ended as a plain `stop`. An autonomous host reads
that as an answer: DeepSeek Harness ended 16 of the 19 such turns one user
measured and the model never saw an error it could correct
(`magpie-community/plugins#209`; upstream made the same change in its 0.1.11).
The name now goes on as the model wrote it — same name, same id, same arguments,
a tool-call finish — and the host answers it with its own unknown-tool error,
which is the correction signal. A name two declared tools fold to is still never
guessed: it goes on as called. Only a call with **no name** is left out now, and
`droppedNote` says so. Measured 2026-10-18 through a local magpie pointed at
this tree, `deepseek-v4.1-flash-free`, declaring `pwsh` and calling `bash`:
before, `200` + `finish_reason: "stop"` + the note; after, `200` + `tool_calls`
+ `bash` carrying its id. Do not put the drop back to "protect" a host —
answering is the host's to do, and a silent `stop` is the failure this replaced.

**Merging a tool call's frames over its id.** The route puts `"id": null` on
the continuation frames of a call whose first frame named it (measured
2026-10-17 on `deepseek-v4.1-flash-free`), and a host that keys a tool result
by the id — dsh writes `tool/result` records keyed by it — fails its turn on
an empty one and cannot reload the session afterwards ("tool call id requires
a nonempty string"). Merging frames must read the id as a name that only
replaces itself, and a call the route never names has to leave with an
invented one - one that misses every id the whole reply already carries, not
only the ones of the choice it sits in, because the reply's calls are read
together rather than one choice at a time. Both live in `tool-response.mjs` — the
merge's keep, and `ensureCallIDs` at the two places a call is published — and
`stream.mjs`'s collapse reads the same rule.

Both of those places publish the **chat** shape. A Responses or Messages reply
whose call carries no id of its own used to be handed on as it stands — no id, no
`call_id` — and both protocols require the field; the id a client answers the
call by is minted for it now (Responses' `call_id`, the Messages block's `id`),
once for the call, so its added, done and terminal copies answer one id. The
Responses item's own `id` is still not filled in: on the stream path the
upstream may name it later, and a name given before the upstream's would make
one call two ids. Measured 2026-10-18, no free model is served on either route:
the tier's own `/models` listed none, `muse-spark-1.3-contributor-free` answered
410 `ModelDeprecated` and the four Messages models answered "Model is
unavailable". So the gap is real but not reachable today, and the sentence above
— every published call leaves with a non-empty id — is chat's. A free model on
either route puts the rest of it back in scope, and then the item id has to be
minted across the same copies, the way the dropped ones already are.

**Appending Chat `function.name` fragments.** A name fragment is not always the
next piece of a name: some vendors re-send the whole name on the frame that
carries the arguments, and some send a name that has grown. Appended blindly,
`Read` followed by `Read` became `ReadRead`, which folded onto no declared tool
and was reported as an unknown tool. `stream.mjs`'s `mergeFunctionName` is the
one rule both paths read — the same bytes again keep the name, a fragment that
starts with it replaces it (the name has grown), a shorter prefix re-sent keeps
the longer name, anything else appends — and `tool-response.mjs`'s guard buffers
the same fragments through it, so one upstream reply cannot fold two ways.
`arguments` keep the blind append in both paths: a JSON payload is bytes in
order, not a name being stated again.

**Treating every 403 as the fingerprint.** Three 403s reach the host and they
are not the same. The free tier's refusal about the wording carries
`FreeTierError` and is the one `explain` rewrites into a generation hint. A
foreign 403 is passed through with its body intact. And the free tier's IP-abuse
refusal — wording about abusive traffic, or about its free models not being
available from the current network — is about the egress IP, not about anything
this package sends: `explain` names that plainly, because no rewrite, retry or
session change from the same IP can help, and it adds no local cooldown, because
the block is the upstream's and a process that cooled down would keep refusing a
network that had already been unblocked.

**Trusting one observation.** The gate is not steady: it moved more than once in
a day while this was being worked out, and identical requests were answered both
ways minutes apart. Anything measured once is not a fact. Measure it three times,
interleaved, before believing it. When two sources disagree, prefer the shape
that passes under the stricter of them, since the looser one will not last.

## Layout

| file | what it is |
| --- | --- |
| `fingerprint.json` | the capture: the wording and User-Agent Zen accepts |
| `opencode-prompt-v1.txt` | the 1.x CLI's own system prompt, captured verbatim |
| `opencode-prompt-v2.txt` | the 2.1.4 CLI's own system prompt, placeholders for model, date and env |
| `official-tools.json` | the CLI's complete tool sets, one per generation |
| `genuine-2.1.4-request.json` | the raw request the 2026-10-25 2.1.4 assets were read from |
| `genuine-2.2.0-request.json` | the raw request behind the 2026-10-28 fingerprint, same shape of proof |
| `core-tools.mjs` | reads the capture; says which generation a request is |
| `official-prompt.mjs` | injects the official prompt in front of the host's instructions |
| `official-tools.mjs` | renames the host's tools `clint_` and appends the official set |
| `provider.mjs` | the plugin: discovery, headers, tools, the diagnostic |
| `models.mjs` | which models are free, and what protocol each speaks |
| `catalog.mjs` | the protocol snapshot's runtime layer: the bundled copy, the remote answer, and the floor they give discovery |
| `models-observed.json` | what the docs table last said, read at run time as the endpoint floor |
| `limits.mjs` | what a model's limits are, where the catalogue under-reports them |
| `stream.mjs`, `tool-response.mjs` | replies Zen cuts short, and tool calls |
| `limits-audit.mjs` | asks the route which ids it still offers and which look under-declared (`limits:audit`) |
| `limits-sweep.mjs` | brackets one id's prompt wall on the live route (`limits:sweep`) |
| `limits-watch.mjs` | the scheduled diff and sweep: what is offered, what was measured, what to measure, and the snapshot's freshness report (`limits:watch`) |
| `limits-observed.json` | what the last scheduled run measured: read at run time as the `route-sweep` tier |
| `models-watch.mjs` | the docs table's own survey: what is offered, what moved, and the snapshot's check (`models:watch`) |
| `releases-watch.mjs` | the release watcher: what OpenCode shipped, against what was captured (`releases:watch`) |
| `make-llms.mjs` | rewrites `llms.txt` and `llms-full.txt` from the English README and this document (`docs:llms`) |
| `capture.mjs` | takes a new capture |
| `mini-capture.mjs` | the same trick driving the desktop CLI binary, for captures of an installed OpenCode |
| `tools-smoke.mjs` | asks Zen what it accepts (`check:gate`) |
| `assert-bun-version.mjs` | checks that the Bun on PATH is the one `package.json` declares (CI only) |

`capture.mjs`, `mini-capture.mjs`, `limits-audit.mjs`, `limits-sweep.mjs`,
`limits-watch.mjs`, `models-watch.mjs`, `releases-watch.mjs`,
`make-llms.mjs`, `tools-smoke.mjs` and `assert-bun-version.mjs` are maintenance
tools for this repository, not part of what a host loads: they are not in
`package.json`'s `files`, so a published tarball
carries the modules a host imports, `fingerprint.json`, `limits-observed.json`
(which `limits.mjs` does read at run time), `models-observed.json` (which
`catalog.mjs` reads the same way), the prompt and tool-set captures
(`opencode-prompt-v1.txt`, `opencode-prompt-v2.txt` and `official-tools.json`,
which `official-prompt.mjs` and `official-tools.mjs` read at run time) and the
four documents beside them
(`README.md`, `MAINTAINING.md`, `LICENSE`, `NOTICE`) — twenty named in `files`,
which with `package.json` and the English `README.en.md` (a README under any
name is packed whatever `files` says) makes twenty-two in the tarball. The same list
is why `npm run` has nothing to run in an installed package: `check:gate`,
`limits:audit`, `capture`, `limits:sweep`, `limits:watch`, `models:watch`,
`releases:watch` and `docs:llms` are entry points for
a checkout, and the tools they name stay here - each of them now says in one
line that it runs from a repository checkout, and exits, rather than failing
with a module it cannot find. `package.json`'s `exports` names
those public modules one by one rather than mapping `./*`, so a file that was
never meant to be imported cannot
be reached as a subpath — `capture.mjs` in particular starts a server and
rewrites `fingerprint.json` when it runs.

## Which copy of the icon and the concurrency is authoritative

`icon` and `maxConcurrency` are declared twice, and neither copy can be read by
the other: `package.json`'s `magpie` block is host-facing JSON, and the `auth`
object in `provider.mjs` is the runtime's. Nothing builds one from the other, so
a change to either alone drifts.

The runtime values are authoritative for what the plugin asks for. The manifest
block is what a host reads before it loads the plugin, so a host that reads it
will act on that copy, and one that does not will act on the runtime's — which
means editing one and not the other silently changes how many requests the host
makes at once (too high and Zen rate-limits them, too low and they queue behind
each other). Change both, and keep them saying the same thing.

## What runs this

Every script in `package.json` names `bun`: `bun test` is the suite, and
`check:gate`, `limits:audit`, `capture`, `limits:sweep`, `limits:watch`,
`models:watch`, `releases:watch` and `docs:llms` are
the tools. `bun test` is what CI runs, at the version pinned in
`.github/workflows/ci.yml` so a run says something about the commit rather than
about whatever Bun was newest that morning, and `assert-bun-version.mjs` is
what compares that pin with the `packageManager` field in `package.json` and
with the Bun that is actually on PATH: three places name the version and
nothing else compares them, so an upgrade on one side alone would leave the
suite and the gate running on a Bun the project no longer declares, and nothing
would fail.

Nothing here is installed with Bun — there are no dependencies — so Bun is the
tools only, and the floor a host's runtime has to clear is the newest API the
modules a host imports reach for. That was `AbortSignal.any` (`provider.mjs`,
`limits.mjs`), which Node added in 20.3.0 and backported to 18.17.0: it is
feature-detected now — the runtime's own where it has one, a hand-made
combination of the signals where it does not — so `engines.node` says
`>=18.17.0` and not `>=20.3.0`, which would have warned hosts that work.
Everything else those modules use is older: `AbortSignal.timeout`
and `throwIfAborted` (17.3), `findLast` (18.0), `Object.hasOwn` (16.9), and the
fetch globals (18.0 unflagged).

`import.meta.main` is what decides whether `tools-smoke.mjs` runs its
gate or is being imported by a test, and a Node older than 22.18 does not define
it: the gate falls back to comparing the entry path. That comparison resolves
both paths and then their real paths, so a symlink or a junction naming this file
is still recognised as this file, and a hard link is compared by device and inode
(only where the filesystem reports an inode at all). A question it cannot answer
exits non-zero saying nothing was asked — never a silent success, which is the
one outcome a release gate must not have.

Both scripts read their endpoint and model from the environment when the
defaults are wrong: `ZEN_BASE_URL`, `ZEN_CHECK_MODEL` (gate), `ZEN_CATALOG_URL`,
`ZEN_GENERATION` (audit) and `CAPTURE_PORT` (capture). `.env.example` lists them
with their defaults; it is in a repository checkout only, because it is not in
`package.json`'s `files`. Nothing loads a file by itself, so export them or, in a
checkout, copy that file to `.env` and export from it. Several knobs belong to
the runtime rather than to a script: `OPENCODE_ZEN_FREE_LIMITS_SNAPSHOT` and the
remote layer's four (URL, cache path, refresh interval, timeout - above), plus
`OPENCODE_ZEN_FREE_DISCOVERY_CACHE`, unset leaving the discovery cache
beside the limits state under the platform cache directory and an empty value
keeping discovery in memory only.

## Publishing

The package is `opencode-zen-freex`; the provider it registers is
`opencode-zen-free`, which is the same one magpie-community/plugins' version
registers. That is deliberate: a model is written `opencode-zen-free/<model>`
either way, so one stays in place whichever is installed. It does mean the two
are mutually exclusive — installing both leaves two plugins claiming one
provider id, and which one wins is down to load order. Pick one.

To publish: bump `version`, commit, `npm publish` in a terminal, and tag — in
that order, so the tarball, the commit the tag names, and the tree both were
built from are one thing. `magpie plugin add opencode-zen-freex` installs it by
that name.

What ships is `package.json`'s `files` list, and it is deliberately narrower than
the repository: the maintenance scripts (`capture.mjs`, `tools-smoke.mjs`,
`limits-audit.mjs`, `limits-sweep.mjs`, `limits-watch.mjs`) and the CI-only
`assert-bun-version.mjs` stay here, because a
host never loads them and one of them rewrites the shipped `fingerprint.json`
when it is run, while `limits-observed.json` does ship, because `limits.mjs`
reads it at run time. `LICENSE` is
MIT with its text unmodified and both copyright lines in place — upstream's and
this fork's — so what a licence scanner reads is a standard MIT file; the fork's
provenance is in `NOTICE`, which is where a reader finds why this fork exists.

**The second factor is a browser, not a password.** Run `npm publish` in a
terminal. When the account has 2FA on, the command stops and offers the whole
exchange at once:

```
Authenticate your account at:
https://www.npmjs.com/auth/cli/...
Press ENTER to open in the browser...
```

Press ENTER, authorize in the browser, and the same command carries on by
itself. Nothing is typed back into the terminal and nothing is passed to a
script: the address is tied to the browser session that printed it and differs
every time, so it is read out of the running command rather than composed in
advance. Whoever is at the browser authorizes, so the command can be started for
them and left waiting — the one thing it needs from them is the ENTER that opens
it.

Both halves of that depend on the command having a terminal. Run as a background
job or piped into a file, npm has no browser to offer, redacts the address to
`https://www.npmjs.com/auth/cli/***` and exits `EOTP` rather than waiting, so a
log of the failed attempt cannot be used to finish it — start it again in a
terminal.

An account with no second factor to give publishes in one step. So does
`npm login --auth-type=web`, which is the same browser exchange kept as a
session, and so does a granular token below.

**With a granular token** (unattended, CI). A token with publish permission
authorizes the publish on its own and never asks for the second factor. Write it
to an npmrc outside the repository and point npm at it for that one command, so
it does not land in a tracked file:

```sh
printf '//registry.npmjs.org/:_authToken=npm_...\n' > "$TMP/npmrc"
npm publish --userconfig "$TMP/npmrc"; rm -f "$TMP/npmrc"
```

Whatever carries a token — a shell, a chat, a CI log under
`%LOCALAPPDATA%\npm-cache\_logs` — is now a place the token has been, and
npm's debug log records the whole command line. Rotate it once the publish is
done. It is not needed to install the package afterwards.

Two things that read as failures and are not. A version already published
cannot be published again, so a republished README means a new `version`, not
a retry — `README.md` is in `files`, so it ships and npmjs.com renders it.
And for a minute or two after a successful publish, `npm view` still 404s
while the registry replicates; wait rather than publishing under a second
number.

One trap worth knowing: a token that is missing, truncated or malformed is
reported by npm as

```
404 The requested resource 'opencode-zen-freex@0.2.1' could not be found or
you do not have permission to access it.
```

which reads exactly like the package not existing. It is the same status npm
gives a genuine permission failure, so a 404 from a publish says nothing at
all until the token has been checked.

**A publish that no longer offers the browser at all.** A token can be dead
while npm says nothing about it until a write is attempted. Measured: `npm
whoami` answers

```
npm error 401 Unauthorized - GET https://registry.npmjs.org/-/whoami
```

and the publish answers that same 404 without ever printing an auth address,
because with no usable credential the request goes out unauthenticated and npm
reports the result as not-found. `npm login --auth-type=web` is the fix — the
browser exchange again, which replaces the stored token — and the publish after
it asks for the second factor in the browser once more. **Two authorizations in
a row is the normal shape of this**, not a sign that something is wrong. So on a
404 from a publish, ask `npm whoami` before anything else: 401 is a session that
has to be renewed, and everything else is the permission problem above.

npm says on login that "tokens that bypass 2FA are being restricted for account
changes and direct publishing", so the granular route below is on its way out as
a way to publish; the browser is the road, and the token is the exception it is
already written to be.