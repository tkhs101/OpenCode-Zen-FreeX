import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// `models()` reads the file the adaptive limits live in, and a test run may not
// touch the operator's copy of it: an empty value keeps that state in memory,
// which is what every case here wants. The cases that exercise the file itself
// are in limits.test.mjs, against a path of their own.
process.env.OPENCODE_ZEN_FREE_LIMITS_STATE = "";

// The discovery cache is a file in the operator's cache directory too, and it is
// not only read there: a successful discovery writes it, and a cache younger
// than provider.mjs's RELIST_AFTER answers the next `models()` call without
// reading anything at all. Left on, this suite would be a test of whatever the
// previous case — or the previous run — happened to leave behind.
process.env.OPENCODE_ZEN_FREE_DISCOVERY_CACHE = "";

// Not caught: a syntax error, a renamed file or a failure while models.mjs (or
// limits.mjs, which it imports) is evaluated has to surface as itself. Swallowed
// into an empty module it reads as "model discovery must be implemented" or
// "parseProtocolDocs is not a function", which is not what broke. The handler
// attached below is not that: it marks the load handled the moment it can fail,
// so a rejected import cannot surface as an unhandled rejection — Bun's test
// runner then aborts the file before any test runs and reports the whole run as
// a crash — while `await subject` in every test still rejects with the original
// error, which is what makes each one fail for the real reason.
const subject = import("./models.mjs");
subject.catch(() => {});
const provider = {
  npm: "@ai-sdk/openai-compatible",
  models: {
    "coder-free": {
      name: "Coder Free",
      cost: { input: 0, output: 0 },
      limit: { context: 200000, input: 160000, output: 32000 },
      reasoning: true,
      tool_call: true,
      modalities: { input: ["text", "image"], output: ["text"] },
      reasoning_options: [{ type: "effort", values: ["low", "high"] }],
    },
    "zero-cost": { cost: { input: 0, output: 0 } },
    paid: { cost: { input: 1, output: 3 } },
    // The one entry where the two free-ness rules disagree: the id ends in
    // `-free` while the catalogue still prices it. The name wins — see the test
    // that pins it below.
    "late-free": { cost: { input: 5, output: 25 } },
    // Deprecated, and still listed — which is offered. "deprecated" is the
    // catalogue expecting a model to go, not a statement that it is gone: on
    // 2026-10-16 `muse-spark-1.2-contributor-free` carried exactly this status
    // while Zen listed it and the free tier answered a request for it, so
    // reading the status as an ending hid a model that was being served. The
    // endings are `lifecycle-free` below and the dated entries further down.
    "old-free": { status: "deprecated", cost: { input: 0, output: 0 } },
    // Retired through `lifecycle`, with a blank `status` written in front of it:
    // a blank status is not a status, so it must not hide the lifecycle.
    "lifecycle-free": { status: "", lifecycle: "retired", cost: { input: 0, output: 0 } },
    // ...and a blank status on its own retires nothing.
    "blank-status-free": { status: "", cost: { input: 0, output: 0 } },
    // Half-described: the catalogue describes it, and the package it gives the
    // model is one this plugin has no SDK for. The id names itself free, so the
    // rule for an id the catalogue cannot speak for is what answers it — before
    // that rule reached this shape, the entry merely being there dropped it.
    "decision-free": { provider: { npm: "@vendor/systemone" } },
    "responses-free": { provider: { npm: "@ai-sdk/openai" } },
    "messages-free": { provider: { npm: "@ai-sdk/anthropic" } },
  },
};
// Every id the catalogue describes is handed to `buildModels`, and which of them
// it lists is the module's answer: an id Zen has stopped listing is retired by
// being absent from the caller's `ids`, which is discovery's business and not
// something this fixture can pin by filtering one out of it.
const ids = Object.keys(provider.models);
const baseURL = "https://opencode.ai/zen/v1";

test("lists only live free models with supported protocols and excludes retired models", async () => {
  const { buildModels } = await subject;
  assert.equal(typeof buildModels, "function", "model discovery must be implemented");
  const models = buildModels(ids, provider, {}, baseURL);
  // `decision-free` is here, and the assertion it used to sit outside of is not
  // a weaker one for it: the catalogue describes this id and gives it a package
  // no SDK answers to, which is the same hole the `-free` rule exists for — an
  // id with no catalogue entry at all was already offered the same way. What
  // keeps a SystemOne id out is the docs naming its endpoint, which the test
  // below pins; a package name alone is not the docs.
  assert.deepEqual(Object.keys(models).sort(), [
    "blank-status-free",
    "coder-free",
    "decision-free",
    "late-free",
    "messages-free",
    "old-free",
    "responses-free",
    "zero-cost",
  ]);
  assert.equal(models["decision-free"].api.npm, "@ai-sdk/openai-compatible");
  assert.equal(models["coder-free"].free, true);
  assert.equal(models["coder-free"].providerID, "opencode-zen-free");
  assert.deepEqual(models["coder-free"].limit, { context: 200000, input: 160000, output: 32000 });
  assert.equal(models["coder-free"].capabilities.input.image, true);
  assert.equal(models["coder-free"].capabilities.toolcall, true);
  assert.deepEqual(Object.keys(models["coder-free"].variants).sort(), ["high", "low"]);
  assert.equal(models["responses-free"].api.npm, "@ai-sdk/openai");
  assert.equal(models["messages-free"].api.npm, "@ai-sdk/anthropic");
});

// Where the two free-ness rules disagree, the name wins. `-free` is the rule for
// an id the catalogue has not caught up with — Zen lists a model the hour it
// turns free — so an id that names itself free is offered even while the
// catalogue still prices it (README 模型, MAINTAINING.md "Waiting for the
// catalogue before offering a model Zen already lists"). The cost reported is
// zero whatever the catalogue says: the one thing this plugin serves is free
// models, so a price is never passed on.
test("an id that names itself free is offered even while the catalogue prices it", async () => {
  const { buildModels } = await subject;
  const models = buildModels(["late-free", "paid"], provider, {}, baseURL);
  assert.deepEqual(Object.keys(models), ["late-free"]);
  assert.equal(models["late-free"].cost.input, 0);
  assert.equal(models["late-free"].cost.output, 0);
});

// A status has to say something to be one: the catalogue writes an empty string
// as well as a null. A blank one must not stand in front of the `lifecycle` that
// retires the model — it did, so a model retired that way stayed on offer — and
// it does not retire one by itself either.
test("a blank status falls through to lifecycle, and retires nothing on its own", async () => {
  const { buildModels, isFree } = await subject;
  assert.equal(isFree("lifecycle-free", provider.models["lifecycle-free"]), false);
  assert.equal(isFree("blank-status-free", provider.models["blank-status-free"]), true);
  const models = buildModels(["blank-status-free", "lifecycle-free"], provider, {}, baseURL);
  assert.deepEqual(Object.keys(models), ["blank-status-free"]);
});

// The statuses that are endings, and the one that is not. `muse-spark-1.2-
// contributor-free` is the measured case: the catalogue calls it deprecated, Zen
// lists it, and the free tier answered a request for it through this plugin on
// 2026-10-16 — so the list, which discovery reads, is what decides whether a
// model is still there, and a deprecated-but-listed model stays offered. The
// statuses that do end a model are read as they always were.
test("a status ends a model only when it says the model is gone", async () => {
  const { isFree } = await subject;
  for (const status of ["retired", "disabled"]) {
    assert.equal(isFree(`ended-${status}-free`, { status, cost: { input: 0, output: 0 } }), false, status);
  }
  for (const status of ["deprecated", "active"]) {
    assert.equal(isFree(`live-${status}-free`, { status, cost: { input: 0, output: 0 } }), true, status);
  }
  // The lifecycle field is the same vocabulary in the same place...
  assert.equal(isFree("ended-free", { lifecycle: "retired", cost: { input: 0, output: 0 } }), false);
  assert.equal(
    isFree("live-free", { lifecycle: "deprecated", cost: { input: 0, output: 0 } }),
    true,
    "deprecated through lifecycle is the same warning as through status",
  );
  // ...and an explicit flag or an effective date still ends one, whatever the
  // status beside it says.
  assert.equal(isFree("flagged-free", { deprecated: true, status: "active" }), false);
  assert.equal(
    isFree("scheduled-free", { status: "deprecated", retirement_date: "2026-11-01" }),
    false,
  );
});

// The date axes are read the same way the status is: the catalogue writes an
// empty string for a date it does not have, and a blank one is not a date, so it
// must not retire a model. A date that does say something still retires it.
test("a blank retirement date retires nothing, a set one does", async () => {
  const { buildModels, isFree } = await subject;
  for (const axis of ["deprecated_at", "retirement_date"]) {
    const blank = { [axis]: "", cost: { input: 0, output: 0 } };
    assert.equal(isFree(`blank-${axis}-free`, blank), true, `a blank ${axis} is not a date`);
    // and the same shape with a date in it is still read as retired
    const dated = { [axis]: "2026-01-01", cost: { input: 0, output: 0 } };
    assert.equal(isFree(`dated-${axis}-free`, dated), false, `a set ${axis} retires the model`);
  }
  const catalogue = {
    npm: "@ai-sdk/openai-compatible",
    models: {
      "blank-date-free": { deprecated_at: "", retirement_date: null, cost: { input: 0, output: 0 } },
      "dated-free": { retirement_date: "2026-01-01", cost: { input: 0, output: 0 } },
    },
  };
  assert.deepEqual(
    Object.keys(buildModels(["blank-date-free", "dated-free"], catalogue, {}, baseURL)),
    ["blank-date-free"],
  );
});

// ...and the third way a field can fail to say anything, which is not about the
// value but about its shape. `isSet` asks whether a field says something, and
// `String` answered for a container as if it had: a list is one non-empty
// string, so `retirement_date: ["2026-01-01"]` — a field that states no date —
// retired the model, and the model left the offered list with nothing in the
// table and nothing in a note to say why. Every other shape rule in this file
// exists to prevent exactly that loss; a status and a date are single values,
// and a container is not one of them.
test("a retirement field written in another shape retires nothing", async () => {
  const { buildModels, isFree } = await subject;
  const free = { cost: { input: 0, output: 0 } };
  // The contrast is the shape and not the value: the string the catalogue really
  // writes retires the model, and a list holding that same string does not.
  assert.equal(isFree("dated-free", { ...free, retirement_date: "2026-01-01" }), false);
  for (const [axis, value] of [
    ["retirement_date", ["2026-01-01"]],
    ["retirement_date", {}],
    ["retirement_date", []],
    ["deprecated_at", [1]],
    ["deprecated_at", () => {}],
  ]) {
    const model = { ...free, [axis]: value };
    const label = `${axis} written as ${JSON.stringify(value) ?? typeof value}`;
    assert.equal(isFree(`shape-${axis}-free`, model), true, `${label} is not a date`);
    // "retires nothing" is about the offered list, so the id is asked for there
    const id = `shape-${axis}-free`;
    const offered = buildModels([id], { npm: "@ai-sdk/openai-compatible", models: { [id]: model } }, {}, baseURL);
    assert.deepEqual(Object.keys(offered), [id], label);
  }
  // The status is the same rule with its own half: a container says nothing, so
  // the `lifecycle` behind it is what is read — the ending the catalogue really
  // wrote. A blank status has always been read that way (the case above); a
  // container was not, and stood in front of the lifecycle as if it were a
  // status the model never had.
  assert.equal(isFree("container-status-free", { ...free, status: {}, lifecycle: "retired" }), false);
  // ...and a container status with nothing behind it retires nothing, whatever
  // it holds: `["retired"]` is a list, not the word
  for (const status of [[], {}, ["retired"]])
    assert.equal(
      isFree("container-only-free", { ...free, status }),
      true,
      `a status written as ${JSON.stringify(status)} is not a status`,
    );
  // A status the catalogue really wrote is still read as itself, which is what
  // keeps the rule above from being "a status never counts": it is set, and
  // being set it stands in front of the lifecycle as it always has.
  assert.equal(isFree("live-status-free", { ...free, status: "active", lifecycle: "retired" }), true);
  assert.equal(isFree("ended-status-free", { ...free, status: "retired", lifecycle: "active" }), false);
});

// The catalogue writes an explicit null for an axis it does not state — this
// file's own comments say so — and the spread that built the model's limit used
// to copy every own key, nulls included, over the 32768/4096 defaults. The host
// was then handed `context: null` as the model's window. Only axes that are
// usable numbers go in, and an axis the catalogue does state still wins.
test("an explicit null limit does not replace the defaults", async () => {
  const { buildModels } = await subject;
  const catalogue = {
    npm: "@ai-sdk/openai-compatible",
    models: {
      "null-limit-free": { cost: { input: 0, output: 0 }, limit: { context: null, output: null } },
      "blank-limit-free": { cost: { input: 0, output: 0 }, limit: { context: "", output: 0 } },
      "partial-limit-free": {
        cost: { input: 0, output: 0 },
        limit: { context: 200000, output: null, input: 160000 },
      },
    },
  };
  const models = buildModels(
    ["null-limit-free", "blank-limit-free", "partial-limit-free"],
    catalogue,
    {},
    baseURL,
  );
  assert.deepEqual(models["null-limit-free"].limit, { context: 32768, output: 4096 });
  assert.deepEqual(models["blank-limit-free"].limit, { context: 32768, output: 4096 });
  assert.deepEqual(models["partial-limit-free"].limit, {
    context: 200000,
    output: 4096,
    input: 160000,
  });
  for (const [id, model] of Object.entries(models))
    for (const [axis, value] of Object.entries(model.limit))
      assert.ok(Number.isSafeInteger(value) && value > 0, `${id}.${axis} is a usable window`);
});

// The names every plain object answers out of Object.prototype — `constructor`,
// `toString`, `hasOwnProperty` — are neither a catalogue entry nor a protocol.
// Read as the docs map's protocol, `protocols["toString"]` is a function the SDK
// does not have, so the model was dropped instead of being asked the way its own
// catalogue entry says; an id the catalogue does describe is offered here even
// though it is named like one of those members.
test("a prototype member name is not read as a protocol", async () => {
  const { buildModels } = await subject;
  const catalogue = {
    npm: "@ai-sdk/openai-compatible",
    models: { toString: { cost: { input: 0, output: 0 }, limit: { context: 4096 } } },
  };
  const models = buildModels(["toString"], catalogue, {}, baseURL);
  assert.deepEqual(Object.keys(models), ["toString"]);
  assert.equal(models["toString"].api.npm, "@ai-sdk/openai-compatible");
  assert.equal(models["toString"].limit.context, 4096);
});

// A model description has to be the catalogue's own, the same rule the
// `__proto__` skip states: what a plain object inherits is not something the
// catalogue says about a model. An id without one is not a described model, and
// is then offered only if it names itself free.
test("a description the catalogue only inherits is not one", async () => {
  const { buildModels } = await subject;
  const chained = Object.create({ legacy: { cost: { input: 0, output: 0 } } });
  const catalogue = { npm: "@ai-sdk/openai-compatible", models: chained };
  assert.deepEqual(Object.keys(buildModels(["legacy"], catalogue, {}, baseURL)), []);
  assert.deepEqual(Object.keys(buildModels(["legacy-free"], catalogue, {}, baseURL)), ["legacy-free"]);
});

// The rest of the names a plain object answers out of Object.prototype, which
// the tests above only reach through `toString` and a chained `legacy`. Read as
// the catalogue's entry or as the docs map's protocol, each of them is a
// function the SDK does not have, so an id that names one has to reach the
// `-free` fallback rather than be dropped for naming a protocol nobody wrote —
// and `__proto__`, whose skip the comment above cites, is never exercised by any
// test unless it is here. The empty catalogue is what makes the names inherited
// rather than own; the second half below is the other side of the same rule.
test("a prototype member name is not read as a catalogue entry or a protocol", async () => {
  const { buildModels } = await subject;
  for (const name of ["__proto__", "constructor", "hasOwnProperty", "toString"]) {
    const models = buildModels([name, `${name}-free`], {}, {}, baseURL);
    assert.deepEqual(
      Object.keys(models),
      [`${name}-free`],
      `${name}: only the id that names itself free is offered`,
    );
    assert.equal(models[`${name}-free`].api.npm, "@ai-sdk/openai-compatible", name);
    assert.equal(
      Object.getPrototypeOf(models),
      Object.prototype,
      `${name} must not reach the result map's prototype`,
    );
    assert.equal(Object.hasOwn(models, "__proto__"), false, name);
  }
});

// The other half: a catalogue that really does carry one of those names as its
// own entry — which takes a null-prototype object, since on a plain one the
// write side of `__proto__` is the prototype itself — is read as what it is, and
// so is the docs map. `__proto__` stays out either way: that skip is stated at
// the point the rule is about, and it cannot be a catalogue entry in any file
// this reads.
test("a catalogue's own entry under a prototype name is still read", async () => {
  const { buildModels } = await subject;
  const catalogue = Object.create(null);
  catalogue.npm = "@ai-sdk/openai-compatible";
  catalogue.models = Object.create(null);
  for (const name of ["constructor", "hasOwnProperty", "toString"]) {
    catalogue.models[name] = { cost: { input: 0, output: 0 }, limit: { context: 4096 } };
  }
  catalogue.models.__proto__ = { cost: { input: 0, output: 0 }, limit: { context: 4096 } };
  const models = buildModels(
    ["__proto__", "constructor", "toString", "missing"],
    catalogue,
    {},
    baseURL,
  );
  assert.deepEqual(Object.keys(models).sort(), ["constructor", "toString"]);
  for (const name of ["constructor", "toString"]) {
    assert.equal(models[name].limit.context, 4096, `${name}: the catalogue's own window`);
  }
  assert.equal(Object.hasOwn(models, "__proto__"), false, "the prototype key is never an entry");
  assert.equal(Object.getPrototypeOf(models), Object.prototype);
  // and the docs map is an own-property lookup for the same reason: `toString`
  // as its own entry resolves the model to `responses`, while a `constructor`
  // the map merely inherits resolves nothing.
  const documented = Object.create(null);
  documented.toString = "responses";
  const free = { npm: "@ai-sdk/openai-compatible", models: { toString: { cost: { input: 0, output: 0 } } } };
  assert.equal(buildModels(["toString"], free, documented, baseURL)["toString"].api.npm, "@ai-sdk/openai");
  assert.equal(
    buildModels(["toString"], free, { constructor: "responses" }, baseURL)["toString"].api.npm,
    "@ai-sdk/openai-compatible",
    "an inherited protocol is not a protocol",
  );
});

test("endpoint documentation overrides inherited SDK and excludes SystemOne", async () => {
  const { buildModels, parseProtocolDocs } = await subject;
  assert.equal(typeof parseProtocolDocs, "function", "protocol parsing must be implemented");
  const protocols = parseProtocolDocs(
    [
      "| Coder | coder-free | `https://opencode.ai/zen/v1/messages` | sdk |",
      "| Decision | decision-free | `https://opencode.ai/zen/v1/systemone` | - |",
    ].join("\n"),
  );
  const models = buildModels(ids, provider, protocols, baseURL);
  assert.equal(models["coder-free"].api.npm, "@ai-sdk/anthropic");
  assert.equal(models["decision-free"], undefined);
});

// The test above leaves the SystemOne exclusion with two possible reasons, and
// this is the one it must be: an id the *docs* name as SystemOne. `decision-free`
// is in that fixture's catalogue too, and its entry describes it with a package
// mapping to no protocol — so before the `-free` rule reached a described id,
// that entry alone dropped it and the docs row was never what did. The id here
// has no catalogue entry at all, so the fallback would hand it `chat`: it can
// only be missing when the docs named its endpoint, and `systemone` is not a
// protocol this plugin asks. The same id, with a catalogue entry that resolves
// to no protocol, is offered — the two halves are pinned together below.
test("a documented SystemOne endpoint keeps an undescribed id out", async () => {
  const { buildModels, parseProtocolDocs } = await subject;
  const protocols = parseProtocolDocs(
    "| Fresh | fresh-free | `https://opencode.ai/zen/v1/systemone` | - |",
  );
  assert.equal(protocols["fresh-free"], "systemone");
  assert.deepEqual(Object.keys(buildModels(["fresh-free"], {}, {}, baseURL)), ["fresh-free"]);
  assert.deepEqual(Object.keys(buildModels(["fresh-free"], {}, protocols, baseURL)), []);
});

// The hole the `-free` rule was written for, on the one shape it could not
// reach: an id the catalogue *does* describe, whose entry names a package no SDK
// answers to. The fallback used to be skipped for it — the entry was there, so
// the id was read as described and then dropped for a protocol nobody resolved —
// while the very same id with no catalogue entry at all was offered. Nothing
// about the two facts differs: neither the catalogue nor the package has said
// what this id speaks.
test("a catalogue entry that resolves to no protocol still leaves a free id to its own name", async () => {
  const { buildModels } = await subject;
  // the catalogue describes it and gives it a package `sdkProtocol` cannot read
  const described = buildModels(
    ["Foo-Free"],
    { npm: "@ai-sdk/openai-compatible", models: { "Foo-Free": { provider: { npm: "@vendor/nothing" }, limit: { context: 4096 } } } },
    {},
    baseURL,
  );
  assert.deepEqual(Object.keys(described), ["Foo-Free"]);
  assert.equal(described["Foo-Free"].api.npm, "@ai-sdk/openai-compatible");
  // the fallback is the provider's own protocol, not a guess at an endpoint: a
  // provider that speaks responses gets that one
  const elsewhere = buildModels(
    ["Foo-Free"],
    { npm: "@ai-sdk/openai", models: { "Foo-Free": { provider: { npm: "@vendor/nothing" } } } },
    {},
    baseURL,
  );
  assert.equal(elsewhere["Foo-Free"].api.npm, "@ai-sdk/openai");
  // ...and the two shapes the rule must not reach are unchanged: systemone named
  // by the docs keeps the id out however it names itself...
  const systemone = { "Foo-Free": "systemone", "Foo-FREE": "systemone" };
  assert.deepEqual(Object.keys(buildModels(["Foo-Free", "Foo-FREE"], {}, systemone, baseURL)), []);
  // ...and so does an id the catalogue describes, when the docs name its
  // endpoint: the docs' own name for it is what `protocols` carries here
  assert.deepEqual(
    Object.keys(
      buildModels(
        ["labeled-free"],
        { npm: "@ai-sdk/openai-compatible", models: { "labeled-free": {} } },
        { "labeled-free": "systemone" },
        baseURL,
      ),
    ),
    [],
  );
  // and the name the docs give is read as itself when it is one this plugin
  // asks, so the rule above is about `systemone` and not about the docs map
  const spoken = buildModels(["chatty-free"], {}, { "chatty-free": "chat" }, baseURL);
  assert.deepEqual(Object.keys(spoken), ["chatty-free"]);
  assert.equal(spoken["chatty-free"].api.npm, "@ai-sdk/openai-compatible");
});

// The package a row names is a string, and the catalogue writes other things
// as well: a number, a boolean, an object. `npm?.` covers the two shapes that
// are not there at all and nothing else, so `npm.includes` on a number was a
// TypeError — and that throw left `sdkProtocol` → `protocolFor` →
// `buildModels` → the discovery that called it, so one dirty row upstream took
// every free model with it. Every other field the catalogue can dirty is
// guarded in this file; this one was the one that was not.
//
// A package that is not a string names no protocol this plugin asks, which is
// the same fact the half-described row above is: the field is skipped, the rest
// of the row is still read, and the id is offered on its own name at the
// provider's own protocol.
test("a package the catalogue wrote in another shape does not take the models beside it with it", async () => {
  const { buildModels } = await subject;
  for (const npm of [5, true, {}, [], null]) {
    const label = `a package written as ${JSON.stringify(npm) ?? typeof npm}`;
    const catalogue = {
      npm: "@ai-sdk/openai-compatible",
      models: {
        "keeper-free": { cost: { input: 0, output: 0 }, limit: { context: 4096 } },
        "dirty-free": { provider: { npm }, cost: { input: 0, output: 0 } },
      },
    };
    const models = buildModels(["keeper-free", "dirty-free"], catalogue, {}, baseURL);
    assert.deepEqual(
      Object.keys(models).sort(),
      ["dirty-free", "keeper-free"],
      `${label}: no row is lost`,
    );
    assert.equal(
      models["keeper-free"].limit.context,
      4096,
      `${label}: the row beside it keeps what the catalogue says`,
    );
    assert.equal(
      models["dirty-free"].api.npm,
      "@ai-sdk/openai-compatible",
      `${label}: a package that names no protocol leaves the id on the provider's own`,
    );
  }
  // The same shape on the provider itself: the top-level package is read on
  // the `-free` fallback, so it was the same throw on the same path.
  const models = buildModels(
    ["keeper-free"],
    { npm: 5, models: { "keeper-free": { cost: { input: 0, output: 0 } } } },
    {},
    baseURL,
  );
  assert.deepEqual(Object.keys(models), ["keeper-free"]);
  assert.equal(models["keeper-free"].api.npm, "@ai-sdk/openai-compatible");
});

// The limit map is the one object a host plans a prompt from. The row it
// comes from is checked for being an object, but its keys were not checked: a
// row with `limit: { context: 1000, output: 500, max_input: 8000 }` handed the
// host an axis no host reads, beside the two it does — a number the host
// cannot interpret, in the map it interprets. Only the axes this file knows
// about are copied.
test("a limit axis nobody named is not handed to the host", async () => {
  const { buildModels } = await subject;
  const catalogue = {
    npm: "@ai-sdk/openai-compatible",
    models: {
      "stray-axis-free": {
        cost: { input: 0, output: 0 },
        limit: { context: 1000, output: 500, max_input: 8000 },
      },
      "known-axes-free": {
        cost: { input: 0, output: 0 },
        limit: { context: 200000, input: 160000, output: 32000 },
      },
    },
  };
  const models = buildModels(["stray-axis-free", "known-axes-free"], catalogue, {}, baseURL);
  assert.deepEqual(models["stray-axis-free"].limit, { context: 1000, output: 500 });
  assert.deepEqual(models["known-axes-free"].limit, {
    context: 200000,
    input: 160000,
    output: 32000,
  });
  for (const [id, model] of Object.entries(models))
    for (const axis of Object.keys(model.limit))
      assert.ok(
        ["context", "input", "output"].includes(axis),
        `${id}.${axis} is an axis a host reads`,
      );
});

// The second source for the same map is the override table, and it is data too:
// a shipped entry or a caller-supplied one that states `null`, `0` or a negative
// for an axis states no window. `limitOverrides` refuses those as well, and the
// rule is stated here so a change on either side of the seam cannot hand a host
// a limit it has no number to plan from.
test("a table axis that is not a usable number is not handed to the host", async () => {
  const { limitFor } = await subject;
  const limit = limitFor("table-free", { context: 1000, input: 500, output: 100 }, undefined, {
    "table-free": {
      context: { value: null, source: "models.dev" },
      input: { value: 0, source: "models.dev" },
      output: { value: -1, source: "models.dev" },
    },
  });
  assert.deepEqual(limit, { context: 1000, input: 500, output: 100 });
  for (const [axis, value] of Object.entries(limit))
    assert.ok(Number.isSafeInteger(value) && value > 0, `${axis} is a usable window`);
});

test("an unknown id is offered on its own free name, never on a guessed endpoint", async () => {
  const { buildModels } = await subject;
  assert.equal(typeof buildModels, "function", "model discovery must be implemented");
  // an id that does not name itself free is not offered at all
  assert.deepEqual(Object.keys(buildModels(["unknown-paid"], {}, {}, baseURL)), []);
  // one that does is asked through the provider's own protocol, not a guess at it
  const free = buildModels(["new-free"], {}, {}, baseURL);
  assert.deepEqual(Object.keys(free), ["new-free"]);
  assert.equal(free["new-free"].api.npm, "@ai-sdk/openai-compatible");
  const models = buildModels(["new-free"], {}, { "new-free": "chat" }, baseURL);
  assert.equal(models["new-free"].api.url, baseURL);
  assert.equal(models["new-free"].cost.input, 0);
});

// The catalogue writes `null` for a row it could not fill in, and one such row
// used to take the whole list with it: this loop read the entry as a
// description, `model.modalities?.input` on `null` threw, and the throw was
// discovery's — so a host that could have been offering every other free model
// offered none of them. An entry that is not an object describes nothing, which
// is a fact this file already knows how to state: the id is then read exactly
// like one the catalogue has no entry for, and is offered when it names itself
// free.
test("a malformed catalogue entry does not take the models that are described with it", async () => {
  const { buildModels } = await subject;
  const catalogue = {
    npm: "@ai-sdk/openai-compatible",
    models: {
      "coder-free": { cost: { input: 0, output: 0 }, limit: { context: 4096 } },
      "empty-free": null,
      "string-free": "not a model",
    },
  };
  const models = buildModels(["coder-free", "empty-free", "string-free"], catalogue, {}, baseURL);
  assert.deepEqual(Object.keys(models), ["coder-free", "empty-free", "string-free"]);
  assert.equal(models["coder-free"].limit.context, 4096, "the described model keeps what the catalogue says");
  // The row the catalogue could not fill in is read as an undescribed free id:
  // the provider's own protocol, and the defaults where the catalogue said
  // nothing. Said as "no title, not a model" rather than as a limit, because a
  // `null` read as a description is a description with `name: null` in it — the
  // model offered under a blank name is the same dirty row arriving one layer
  // further along.
  assert.equal(models["empty-free"].name, "empty-free", "a row that says nothing does not name the model");
  assert.equal(models["empty-free"].api.npm, "@ai-sdk/openai-compatible");
  assert.deepEqual(models["empty-free"].limit, { context: 32768, output: 4096 });
  assert.equal(typeof models["string-free"], "object", "a row that is not an object is not a description");
  assert.equal(models["string-free"].name, "string-free");
  assert.equal(models["string-free"].api.npm, "@ai-sdk/openai-compatible");
  assert.deepEqual(models["string-free"].limit, { context: 32768, output: 4096 });
  // ...and one that does not call itself free is still not offered on the
  // strength of a row that says nothing: the rule is the id's name or the
  // catalogue's word, and a `null` row is not the catalogue's word
  const notFree = buildModels(["empty-paid"], { npm: "@ai-sdk/openai-compatible", models: { "empty-paid": null } }, {}, baseURL);
  assert.deepEqual(Object.keys(notFree), []);
  // The rows the whole loop has to survive, each of which the caller of
  // `buildModels` decides about by the same rule this file does. `provider.mjs`
  // keeps that rule as `describesModel` and asks it of the catalogue's own row
  // while it decides what to preserve, so a row read as a description on one
  // side and not the other is a model whose fate depends on which file looked at
  // it. The empty list is the row that is hardest to catch — `typeof []` is
  // `"object"`, so it passed the object test — and is read by the same rule: see
  // the case below, which is where that row's own shapes are pinned.
  for (const row of [null, [], "not a model", 17, true, undefined]) {
    const dirty = { npm: "@ai-sdk/openai-compatible", models: { "dirty-free": row } };
    const label = JSON.stringify(row) ?? String(row);
    const offered = buildModels(["dirty-free"], dirty, {}, baseURL);
    assert.deepEqual(Object.keys(offered), ["dirty-free"], `${label}: the id is still offered`);
    assert.equal(offered["dirty-free"].name, "dirty-free", `${label}: and under its own name`);
  }
  // The rule stated where it cannot be missed: a row the catalogue cannot be
  // read as a description is one this loop does not carry out of itself. What a
  // member read on the malformed values above cannot show — `(17).name` is
  // `undefined`, not a throw — is the difference between "read as nothing" and
  // "read as a description with holes in it", and that difference is exactly
  // what the guard is for; the rows above are the shapes the catalogue really
  // writes, and each of them being offered on its own name is the observable
  // half of the rule. What is left is stated as the rule it is.
  for (const axis of Object.keys(catalogue.models))
    assert.equal(
      Object.hasOwn(models, axis),
      true,
      `${axis}: a malformed row is still the id's own reason to be offered`,
    );
  // the same row does not become a description the way an inherited one must
  // not, and the result map's own prototype is untouched either way
  assert.equal(Object.getPrototypeOf(models), Object.prototype);
  assert.equal(Object.hasOwn(models, "__proto__"), false);
});

// The row that is a list, which is the same fact as `null` one step harder to
// see: `typeof []` is `"object"`, so it passed the "is it an object" test that
// `null` does not, and was then read as a description — from which nothing can
// be read, because a list has no `name` and no `cost` and no `limit` of its own.
// `provider.mjs` reads a row as a description by its own `describesModel`, which
// says a list is not one, and the two sides deciding differently about one row is
// a model whose fate depends on which file looked at it. This is that answer
// stated where the models it decides about can be counted.
test("an array is a row the catalogue could not fill in, not a description", async () => {
  const { buildModels } = await subject;
  const catalogue = {
    npm: "@ai-sdk/openai-compatible",
    models: {
      "described-free": { cost: { input: 0, output: 0 }, name: "Described", limit: { context: 4096 } },
      "empty-array-free": [],
      "empty-array-paid": [],
    },
  };
  const models = buildModels(["described-free", "empty-array-free", "empty-array-paid"], catalogue, {}, baseURL);
  // the row that is a description is untouched, and the ones beside it are what
  // says the list did not take the call with it
  assert.equal(models["described-free"].limit.context, 4096);
  // An id the row belongs to is offered exactly the way an id the catalogue has
  // no entry for is: on its `-free` name, at the provider's own protocol, with
  // the defaults where the catalogue said nothing.
  assert.deepEqual(Object.keys(models), ["described-free", "empty-array-free"]);
  assert.equal(models["empty-array-free"].api.npm, "@ai-sdk/openai-compatible");
  assert.equal(
    models["empty-array-free"].name,
    "empty-array-free",
    "a row that is not a description does not name the model",
  );
  assert.deepEqual(models["empty-array-free"].limit, { context: 32768, output: 4096 });
  // ...and one that does not call itself free gets nothing from the row at all,
  // rather than a protocol invented for something nobody could read
  assert.equal(Object.hasOwn(models, "empty-array-paid"), false);
  // The rule, stated where it can fail. A bare list reads the same either way:
  // every axis this loop consults is absent from an empty list and from an empty
  // object alike, so the fixture that can tell the two rules apart is a list
  // that *carries* something — a shape only a hand-built catalogue hands over,
  // and the shape the rule is about. Nothing a list carries is the catalogue's
  // word about the model.
  const named = Object.assign([], { name: "Array Row" });
  const namedModels = buildModels(
    ["named-free"],
    { npm: "@ai-sdk/openai-compatible", models: { "named-free": named } },
    {},
    baseURL,
  );
  assert.equal(
    namedModels["named-free"].name,
    "named-free",
    "a name hung on a list is not the catalogue naming the model",
  );
  // The cost is the one that decides who is offered at all: a zero-cost row
  // makes a model free, so a list carrying one would hand a host a model nobody
  // described — the silent arrival the free rules exist to prevent.
  const priced = Object.assign([], { cost: { input: 0, output: 0 }, name: "Array Row" });
  assert.deepEqual(
    Object.keys(
      buildModels(["priced-paid"], { npm: "@ai-sdk/openai-compatible", models: { "priced-paid": priced } }, {}, baseURL),
    ),
    [],
    "a cost hung on a list is not the catalogue calling the model free",
  );
  // ...and the same row through the free gate, where the id's own name is what
  // offers it: the list's numbers are still not the model's numbers
  const limited = Object.assign([], { limit: { context: 4096 }, name: "Array Row" });
  const limitedModels = buildModels(
    ["limited-free"],
    { npm: "@ai-sdk/openai-compatible", models: { "limited-free": limited } },
    {},
    baseURL,
  );
  assert.deepEqual(limitedModels["limited-free"].limit, { context: 32768, output: 4096 });
});

// The other half of the same rule, on the fields read as shapes rather than as
// values. `?? []` and `?? {}` cover a field the catalogue left out and nothing
// else, and these are the shapes it writes when it writes something else — each
// of which used to throw out of `buildModels`, which is discovery's: `.filter`
// is not a function on an object or a string, `option.type` on a `null` element
// is a TypeError, and `Object.entries` reads a list as its indices. One dirty
// field on one row took every free model with it, and the host was waiting on
// the hook that threw.
test("a field the catalogue wrote in another shape does not end the call", async () => {
  const { buildModels } = await subject;
  const catalogue = {
    npm: "@ai-sdk/openai-compatible",
    models: {
      "kept-free": {
        cost: { input: 0, output: 0 },
        name: "Kept",
        reasoning_options: [{ type: "effort", values: ["low"] }],
      },
      "object-options-free": { cost: { input: 0, output: 0 }, reasoning_options: {} },
      "string-options-free": { cost: { input: 0, output: 0 }, reasoning_options: "low" },
      "null-element-free": {
        cost: { input: 0, output: 0 },
        reasoning_options: [null, { type: "effort", values: ["high"] }],
      },
      "string-values-free": { cost: { input: 0, output: 0 }, reasoning_options: [{ type: "effort", values: "low" }] },
    },
  };
  const ids = Object.keys(catalogue.models);
  const models = buildModels(ids, catalogue, {}, baseURL);
  // The ids as a set, both sides sorted: what this asserts is that no row was
  // lost and none was invented, and `buildModels` writes its keys in the order
  // it was handed them, which is not part of that.
  assert.deepEqual(
    Object.keys(models).sort(),
    [...ids].sort(),
    "a wrong shape is not a reason to lose a row, or the rows beside it",
  );
  // a list the catalogue did write is read exactly as it always was
  assert.deepEqual(Object.keys(models["kept-free"].variants), ["low"]);
  // and the ones it did not say nothing about are read as no efforts, which is
  // what a host shows as "this model has no effort settings" rather than as a
  // selection the catalogue never offered
  for (const id of ["object-options-free", "string-options-free", "string-values-free"])
    assert.deepEqual(Object.keys(models[id].variants), [], `${id}: no efforts can be read`);
  // the element that is not a description is skipped and the one beside it is
  // still read: a wrong element is not a wrong list
  assert.deepEqual(Object.keys(models["null-element-free"].variants), ["high"]);
  // The axis map: `Object.entries` reads a list as its indices, and a row whose
  // `limit` was `[111, 222]` handed the host
  // `{0: 111, 1: 222, context: 32768, output: 4096}` — two axes no catalogue
  // named, on the one object a host plans a prompt from.
  const listed = buildModels(
    ["limit-list-free"],
    { npm: "@ai-sdk/openai-compatible", models: { "limit-list-free": { cost: { input: 0, output: 0 }, limit: [111, 222] } } },
    {},
    baseURL,
  );
  assert.deepEqual(listed["limit-list-free"].limit, { context: 32768, output: 4096 });
  // a word is not an axis map either, and said here so the rule is one rule
  const word = buildModels(
    ["limit-word-free"],
    { npm: "@ai-sdk/openai-compatible", models: { "limit-word-free": { cost: { input: 0, output: 0 }, limit: "big" } } },
    {},
    baseURL,
  );
  assert.deepEqual(word["limit-word-free"].limit, { context: 32768, output: 4096 });
  // ...and a map that really is one is still read, on both levels: the
  // catalogue's own axes, and the evidence limits.mjs has for the id
  const real = buildModels(
    ["deepseek-v4.1-flash-free"],
    {
      npm: "@ai-sdk/openai-compatible",
      models: { "deepseek-v4.1-flash-free": { cost: { input: 0, output: 0 }, limit: { context: 200000, output: 32000 } } },
    },
    {},
    baseURL,
  );
  assert.deepEqual(real["deepseek-v4.1-flash-free"].limit, { context: 326000, output: 384000 });
});

// The same rule for the two modality axes, which the case above does not reach:
// `modalities.input` is read by `input.some(...)`, and a word, a number or an
// object there is not a list — `.some` is not a function on any of them, so the
// row threw out of `buildModels` and took every free model with it, which is the
// failure the whole shape rule exists to prevent. The neighbouring
// `reasoning_options` is guarded with `Array.isArray` and read as its own
// default, and these two are read the same way: `??` covers a field the
// catalogue left out and nothing else, so every other shape has to be answered
// for as well. What a field written as a word or a number means is "no list was
// stated", and the default for a field nothing was stated about is text-only —
// the one thing a model here is known to read.
test("a modality axis written in another shape is read as its default", async () => {
  const { buildModels } = await subject;
  const catalogue = {
    npm: "@ai-sdk/openai-compatible",
    models: {
      "word-input-free": { cost: { input: 0, output: 0 }, modalities: { input: "text" } },
      "number-input-free": { cost: { input: 0, output: 0 }, modalities: { input: 7 } },
      "object-output-free": { cost: { input: 0, output: 0 }, modalities: { output: {} } },
      // ...and the whole field in another shape: a word and a list read as
      // nothing stated, which is what the `??` above always did with them, so
      // the guard neither loses nor invents a modality for either.
      "word-modalities-free": { cost: { input: 0, output: 0 }, modalities: "text" },
      "list-modalities-free": { cost: { input: 0, output: 0 }, modalities: ["text", "image"] },
      "described-free": {
        cost: { input: 0, output: 0 },
        modalities: { input: ["text", "image"], output: ["text"] },
      },
    },
  };
  const ids = Object.keys(catalogue.models);
  const models = buildModels(ids, catalogue, {}, baseURL);
  // the rows written plainly are still read as they were, and the malformed
  // axes beside them cost no row: the axes are read one at a time
  assert.deepEqual(models["described-free"].capabilities.input, {
    text: true,
    image: true,
    audio: false,
    video: false,
    pdf: false,
  });
  assert.equal(models["described-free"].capabilities.attachment, true);
  for (const id of [
    "word-input-free",
    "number-input-free",
    "object-output-free",
    "word-modalities-free",
    "list-modalities-free",
  ]) {
    assert.deepEqual(
      models[id].capabilities.input,
      { text: true, image: false, audio: false, video: false, pdf: false },
      `${id}: the input axis is the default`,
    );
    assert.deepEqual(
      models[id].capabilities.output,
      { text: true, image: false, audio: false, video: false, pdf: false },
      `${id}: and so is the output axis, which is read by the same rule`,
    );
    assert.equal(
      models[id].capabilities.attachment,
      false,
      `${id}: and text-only is not an attachment`,
    );
  }
});

// A model Zen lists that neither the catalogue nor the docs describe yet: the id
// says it is free, so it is offered at the protocol the provider itself speaks
// rather than waiting for the catalogue to catch up (yetone/magpie#2385). An id
// that does not call itself free still needs the catalogue's word, and one the
// catalogue does describe keeps the protocol the catalogue gave it.
test("an id that calls itself free is offered before the catalogue describes it", async () => {
  const { buildModels } = await subject;
  const models = buildModels(
    ["brand-new-free", "brand-new", "responses-free"],
    provider,
    {},
    baseURL,
  );
  assert.deepEqual(Object.keys(models).sort(), ["brand-new-free", "responses-free"]);
  assert.equal(models["brand-new-free"].api.npm, "@ai-sdk/openai-compatible");
  assert.equal(models["brand-new-free"].name, "brand-new-free");
  // the fallback used when the catalogue carries no limit for the model
  assert.equal(models["brand-new-free"].limit.context, 32768);
  // the catalogue's own package still decides the protocol for an id it describes
  assert.equal(models["responses-free"].api.npm, "@ai-sdk/openai");
  // "names itself free" is asked case-insensitively, the way the free gate asks
  // it. Asked case-sensitively, an id like this passed the gate and then found
  // no protocol, so it was dropped silently instead of being offered.
  for (const id of ["new-model-FREE", "New-Model-Free"]) {
    const offered = buildModels([id], {}, {}, baseURL);
    assert.deepEqual(Object.keys(offered), [id], `${id} names itself free whatever its case`);
    assert.equal(offered[id].api.npm, "@ai-sdk/openai-compatible", id);
  }
});

// Rows as OpenCode's console docs have them since 2026-10-12
// (services/www/src/docs/content/console/models.mdx), and the pricing table
// beside it that names no endpoint (yetone/magpie#2305): the zen.mdx these
// were read from before was removed that day. Two of the rows below are ones the
// parser has to leave out, and each is parsed on its own further down: the
// whole-object comparison cannot say which row produced what, so it cannot say
// that the pricing row produced nothing — a pricing row carries no endpoint at
// all, and an endpoint path that is not one of the four protocols
// (`/v1/models/…`, Gemini's) is not a protocol this plugin can ask.
const geminiRow =
  "| Gemini 3 Flash                  | gemini-3-flash                  | `https://opencode.ai/inference/v1/models/gemini-3-flash`        | `@ai-sdk/google`            |";
const pricingRow =
  "| Step 5 Preview Free               | Free            | Free            | Free            | -            |";

// The rows of the four free models the fixture below used to leave out — all
// four are Chat, which is what the snapshot says and what the docs table shows.
// Without them the consistency check at the bottom of this file only ever runs
// in one direction: it walks the ids these rows parsed, so a snapshot entry the
// docs do not carry was compared with nothing at all. Those are exactly the
// entries that route a listed model when the docs cannot be read, so a stale one
// is a silent misroute rather than a test failure.
const chatRow = (name, id) =>
  `| ${name.padEnd(31)} | ${id.padEnd(31)} | \`https://opencode.ai/inference/v1/chat/completions\`             | \`@ai-sdk/openai-compatible\` |`;
const consoleDocs = [
  "| Claude Haiku 4.5                | claude-haiku-4-5                | `https://opencode.ai/inference/v1/messages`                     | `@ai-sdk/anthropic`         |",
  geminiRow,
  "| Jev 1.13 Free                   | jev-1.13-free                   | `https://opencode.ai/inference/v1/systemone`                    | -                           |",
  "| Big Pickle                      | big-pickle                      | `https://opencode.ai/inference/v1/chat/completions`             | `@ai-sdk/openai-compatible` |",
  "| Step 5 Preview Free             | step-5-preview-free             | `https://opencode.ai/inference/v1/chat/completions`             | `@ai-sdk/openai-compatible` |",
  "| Muse Spark 1.3 Contributor Free | muse-spark-1.3-contributor-free | `https://opencode.ai/inference/v1/responses`                    | `@ai-sdk/openai`            |",
  chatRow("Space Bunny Free", "space-bunny-free"),
  chatRow("Cat Jam Free", "cat-jam-free"),
  chatRow("LongCat 2.5 Preview Free", "longcat-2.5-preview-free"),
  chatRow("MiMo-V2.6-Flash Free", "mimo-v2.6-flash-free"),
  chatRow("Nemotron 3.5 Lightning Free", "nemotron-3.5-lightning-free"),
  // The free ids the tier was serving on 2026-10-16, whose snapshot entries the
  // consistency check at the bottom holds against these rows. The docs table
  // lists all four (the last one as its paid twin's endpoint, responses).
  chatRow("DeepSeek V4.1 Flash Free", "deepseek-v4.1-flash-free"),
  chatRow("GLM-5.3-Flash Free", "glm-5.3-flash-free"),
  chatRow("LL Alpha Free", "ll-alpha-free"),
  chatRow("Nemotron 3.5 Super VL Free", "nemotron-3.5-super-vl-free"),
  "| Muse Spark 1.2 Contributor Free | muse-spark-1.2-contributor-free | `https://opencode.ai/inference/v1/responses`                    | `@ai-sdk/openai`            |",
  pricingRow,
].join("\n");

// Ids the docs name that are paid, which is why the free snapshot has no entry
// for them. The loop below holds every other parsed row against the snapshot,
// and a routine docs update that adds a paid row with a supported endpoint
// belongs in this set rather than reading as a snapshot that has gone stale.
const paidIds = new Set(["claude-haiku-4-5"]);

test("reads the console docs' endpoint table, and Jev stays out as SystemOne", async () => {
  const { buildModels, parseProtocolDocs, bootstrapProtocols } = await subject;
  assert.ok(
    bootstrapProtocols &&
      typeof bootstrapProtocols === "object" &&
      Object.keys(bootstrapProtocols).length > 0,
    "the console-docs snapshot must be exported as a non-empty object",
  );
  const protocols = parseProtocolDocs(consoleDocs);
  assert.deepEqual(protocols, {
    "claude-haiku-4-5": "anthropic",
    "jev-1.13-free": "systemone",
    "big-pickle": "chat",
    "step-5-preview-free": "chat",
    "muse-spark-1.3-contributor-free": "responses",
    "space-bunny-free": "chat",
    "cat-jam-free": "chat",
    "longcat-2.5-preview-free": "chat",
    "mimo-v2.6-flash-free": "chat",
    "nemotron-3.5-lightning-free": "chat",
    "deepseek-v4.1-flash-free": "chat",
    "glm-5.3-flash-free": "chat",
    "ll-alpha-free": "chat",
    "nemotron-3.5-super-vl-free": "chat",
    "muse-spark-1.2-contributor-free": "responses",
  });
  // the two rows that must not have produced a protocol, each on its own
  assert.deepEqual(parseProtocolDocs(pricingRow), {}, "a pricing row names no endpoint");
  assert.deepEqual(parseProtocolDocs(geminiRow), {}, "an endpoint outside the four protocols");
  // the snapshot kept for when the docs can't be read says the same, for every
  // id it carries: the paid ids are the ones the free snapshot has no entry for,
  // and every other id here has to be in it
  for (const [id, protocol] of Object.entries(protocols)) {
    if (paidIds.has(id)) continue;
    assert.ok(Object.hasOwn(bootstrapProtocols, id), `${id} is missing from the free snapshot`);
    assert.equal(
      bootstrapProtocols[id],
      protocol,
      `${id}: the docs' endpoint and the free snapshot's protocol disagree`,
    );
  }
  // ...and the other direction, which is the one that was never checked: every
  // id the snapshot carries is one the docs describe, at the protocol it says.
  // The snapshot is what routes a listed model when the docs cannot be read, so
  // an entry the docs have since dropped or moved misroutes it silently.
  for (const [id, protocol] of Object.entries(bootstrapProtocols)) {
    assert.ok(Object.hasOwn(protocols, id), `${id} is in the snapshot but no docs row`);
    assert.equal(
      protocol,
      protocols[id],
      `${id}: the free snapshot's protocol and the docs' endpoint disagree`,
    );
  }
  const models = buildModels(["jev-1.13-free", "step-5-preview-free"], {}, protocols, baseURL);
  assert.deepEqual(Object.keys(models), ["step-5-preview-free"]);
});

// The docs table is read by the endpoint a row names and the id beside it, not
// by the position of a column. The parse used to assume the id was the second
// cell of the row and the endpoint the third, so a table that gained a column
// — or lost one, or renamed one — came back empty, and an empty answer is
// what "the docs say nothing" looks like: every model fell back to the
// `-free` guess and a responses-only model was asked at /chat/completions.
test("the protocol docs table is read by the endpoint cell, not by the column's position", async () => {
  const { parseProtocolDocs } = await subject;
  // A column the parse did not expect, in front of the id: the id is the cell
  // right before the endpoint, so the row is still read.
  const protocols = parseProtocolDocs(
    [
      "| Model | Tier | id | endpoint | sdk |",
      "| Coder | free | coder-free | `https://opencode.ai/zen/v1/chat/completions` | `@ai-sdk/openai-compatible` |",
      "| Muse | free | muse-spark-free | `https://opencode.ai/zen/v1/responses` | `@ai-sdk/openai` |",
    ].join("\n"),
  );
  assert.deepEqual(protocols, { "coder-free": "chat", "muse-spark-free": "responses" });
  // An id written as a link is still the id the row names.
  const linked = parseProtocolDocs(
    "| Model | id | endpoint | sdk |\n| Coder | [`coder-free`](https://example.test/coder-free) | `https://opencode.ai/zen/v1/chat/completions` | `@ai-sdk/openai-compatible` |",
  );
  assert.deepEqual(linked, { "coder-free": "chat" });
});

// A parse that finds no endpoint used to be indistinguishable from a document
// that says nothing: the caller could not tell "the table changed shape" from
// "the docs say nothing", so every model fell back to the snapshot's protocol
// and nobody knew. The parse now says so, and the report says what it read —
// the rows it saw, and the rows an endpoint could be read out of.
test("a protocol docs table that cannot be read is reported, not swallowed", async () => {
  const { parseProtocolDocs, parseProtocolDocsReport, modelDiagnostics } = await subject;
  const notes = [];
  const previous = modelDiagnostics((entry) => notes.push(entry));
  try {
    // A table whose shape changed: rows, and no endpoint in any of them.
    const changed =
      "| Model | id | endpoint | sdk |\n| Coder | coder-free | `https://example.test/ask` | `@ai-sdk/openai-compatible` |";
    const report = parseProtocolDocsReport(changed);
    assert.equal(report.rows, 2, "the table's rows are counted");
    assert.equal(report.matched, 0, "and none of them named an endpoint this plugin asks");
    assert.match(report.note, /table has 2 rows and none of them names an endpoint/);
    assert.deepEqual(parseProtocolDocs(changed), {}, "a table that cannot be read answers nothing");
    assert.equal(notes.length, 1, "and it says so");
    assert.match(notes[0], /shape changed/);
    // A document that is not the table at all.
    const other = "<html><body>not the models table</body></html>";
    const otherReport = parseProtocolDocsReport(other);
    assert.equal(otherReport.rows, 0, "a document without a table has no rows");
    assert.match(otherReport.note, /no table row in it/);
    parseProtocolDocs(other);
    assert.equal(notes.length, 2, "and a document that is not the table says so too");
    // A table that reads: nothing to report, and the protocols it names.
    const good =
      "| Model | id | endpoint | sdk |\n| Coder | coder-free | `https://opencode.ai/zen/v1/chat/completions` | `@ai-sdk/openai-compatible` |";
    const goodReport = parseProtocolDocsReport(good);
    assert.equal(goodReport.rows, 2);
    assert.equal(goodReport.matched, 1);
    assert.equal(goodReport.note, undefined, "a table that reads has nothing to report");
    parseProtocolDocs(good);
    assert.equal(notes.length, 2, "and says nothing");
  } finally {
    modelDiagnostics(previous);
  }
});

// ---------------------------------------------------------------------------
// Not a change of subject: everything above this line is about `models.mjs`, and
// the cases below are `provider.mjs`'s discovery-lease invariants, driven from
// here because the lease lifecycle has no entry point of its own. A lease is
// taken by that module's server whenever a caller waits for a discovery, the only
// caller that arrives with a signal of its own is the loader's request path, and
// neither is exported. `index.test.mjs` drives the same server over a socket;
// these drive it over a stubbed `fetch` instead, so the three reads one discovery
// makes can be held open, watched for the signal that ends them, and answered on
// demand.
//
// The three invariants, in the order they are pinned below:
//   - a discovery that answered releases the lease it was waited on with, so a
//     lease taken by a caller that never aborts — the `models()` hook, and
//     `refresh()` — does not outlive it;
//   - a caller that had already given up when its lease was taken releases that
//     lease too, though no listener of its own ever fires;
//   - a flight cancelled to no callers does not end the next discovery: that
//     flight's reads end, and the one after it reads on a signal that is not
//     already aborted.
// The case after those holds the other half of the rule the leases exist for:
// one caller's abandonment must not cancel an answer another is still waiting
// for, which is why a lease released for a caller that left ends nothing. The
// last one closes the other end of it: a flight that was abandoned is not
// joinable either, so a caller arriving while it is still winding down is not
// handed the abort some other caller asked for.
//
// What they were written for is the pair of failures that hid each other: a
// lease that was never released (the set only ever grew, so the "last caller
// waiting has gone" branch was not reachable at all), and a read signal built
// once for the server, which stayed aborted for its life once that branch had
// run, so every later discovery answered with the abort instead of the list.
const providerModule = import("./provider.mjs");
providerModule.catch(() => {});

const zenBase = "https://zen.test/v1";
const zenCatalog = "https://zen.test/catalog";
const zenDocs = "https://zen.test/docs";
const publicAuth = async () => ({ type: "api", key: "public" });
// `modelsDevURL: null` is the third-party read switched off, as in index.test.mjs:
// these cases are about what the catalogue says, and a suite that reached
// models.dev per case would be a network suite. `limitsSnapshotURL: ""` switches
// off the other third-party read for the same reason, and for one more of its
// own: a cold process reads the snapshot once per server, which made a discovery
// four reads where these cases assert three. The count they pin is how a flight
// ends, and it must not depend on whether an earlier file happened to warm a
// cache or on whether the network answered. `modelsSnapshotURL: ""` switches the
// protocol snapshot's own read off for the same two reasons: it is one more
// background fetch a cold server starts, and the floor it installs would change
// which endpoint a discovery answers an id with — the exact answer these cases
// read from the docs stub alone.
const zenURLs = {
  baseURL: zenBase,
  catalogURL: zenCatalog,
  docsURL: zenDocs,
  modelsDevURL: null,
  limitsSnapshotURL: "",
  modelsSnapshotURL: "",
};

// A macrotask boundary. The loader reaches its discovery through microtasks —
// the auth lookup, the request body — so by the time a timer callback runs, a
// discovery that was going to start has started and its reads have been issued.
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// The three reads discovery makes, answered without a socket. A read is handed
// the signal that ends it, and the only way that end is observable from here is
// that signal: aborted is what `fetch` does with one, inside and outside this
// stub, so a read that ended and one that is still waiting are told apart by it.
//
// The listing and the catalogue are what a case hands in: the defaults are the
// fixture every other case here wants, and a case that needs a row written in
// another shape brings its own.
function discoveryUpstream({ listing, catalog } = {}) {
  const reads = [];
  const held = [];
  let holding = false;
  let refusal = null;
  const original = globalThis.fetch;
  const answer = (url) => {
    if (url.endsWith("/models"))
      return Response.json(listing ?? { data: [{ id: "chat-free" }] });
    if (url.endsWith("/catalog"))
      return Response.json(catalog ?? { opencode: { models: { "chat-free": {} } } });
    if (url.endsWith("/docs")) return new Response("| Model | id | endpoint |");
    if (refusal)
      return new Response(refusal.body, {
        status: refusal.status,
        headers: { "content-type": "application/json" },
      });
    throw new Error(`nothing answers ${url} in this case`);
  };
  globalThis.fetch = async (url, init) => {
    const read = { url: String(url), signal: init?.signal ?? null };
    reads.push(read);
    // What a real fetch does with a signal: one that arrives already aborted
    // refuses before anything is sent, and one aborted while the read waits
    // rejects the read. Both are how a read ends here, and the second is why a
    // read held at the gate needs no watchdog to end it.
    const stop = () => {
      throw read.signal?.reason ?? new Error("the read was aborted");
    };
    if (read.signal?.aborted) stop();
    if (holding)
      await new Promise((resolve, reject) => {
        held.push(resolve);
        const signal = read.signal;
        // A turn later, and deliberately: a real fetch rejects a read it is
        // waiting on, and not in the same turn as the abort. That turn is the
        // window the case below is about — how long a flight that has ended its
        // reads stays visible as one still running — so it is modelled here
        // rather than raced against.
        signal?.addEventListener("abort", () => setTimeout(() => reject(signal.reason), 0), {
          once: true,
        });
      });
    if (read.signal?.aborted) stop();
    return answer(read.url);
  };
  return {
    reads,
    // Hold every read issued from now on at the gate, and release them all.
    hold() {
      holding = true;
    },
    free() {
      holding = false;
      for (const resolve of held.splice(0)) resolve();
    },
    // What the inference path answers with, once a request gets that far.
    refuse(status, body) {
      refusal = { status, body };
    },
    restore() {
      globalThis.fetch = original;
    },
  };
}

async function zenPlugin(t) {
  const upstream = discoveryUpstream();
  t.after(() => upstream.restore());
  const { server } = (await providerModule).default;
  const plugin = await server({}, zenURLs);
  return { upstream, plugin };
}

// A request for a model the last list did not have: the one path that takes a
// lease with a caller's own signal, and so the one that can walk away from it.
const askForUnknown = (loader, signal) =>
  loader.fetch(`${zenBase}/chat/completions`, {
    method: "POST",
    body: JSON.stringify({
      model: "nothing-free",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }),
    signal,
  });

// A discovery that answered is over for every caller that waited for it, and the
// lease set has to say so. `models()` waits with no signal at all, so a lease it
// leaves behind has nothing that could ever release it, and every later flight
// counts it as a caller still waiting: the reads of a flight whose last real
// caller walked away are then never ended — the one thing the leases exist to do.
test("a caller a discovery has answered holds no lease on the next flight", async (t) => {
  const { upstream, plugin } = await zenPlugin(t);
  const answered = await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  assert.ok(answered["chat-free"], "the fixture's listing is what that call answers with");
  assert.equal(upstream.reads.length, 3, "a discovery is three reads");
  // The relist budget would answer an unknown model out of `known`; moved past
  // it, so the request below really is a second round, with a caller of its own.
  const realNow = Date.now;
  t.mock.method(Date, "now", () => realNow() + 61_000);
  upstream.hold();
  const loader = await plugin.auth.loader(publicAuth);
  const controller = new AbortController();
  const pending = askForUnknown(loader, controller.signal).catch((error) => error);
  await tick();
  assert.equal(upstream.reads.length, 6, "the request started its own discovery");
  controller.abort();
  const heard = await pending;
  assert.equal(heard.name, "AbortError", "the caller that walked away hears its own signal");
  await tick();
  assert.deepEqual(
    upstream.reads.slice(3).map((read) => read.signal.aborted),
    [true, true, true],
    "the reads end when the last caller waiting for them has gone",
  );
});

// The other end of the same rule: a caller that had already given up when the
// lease was taken. No `abort` listener of its own ever fires — its signal is
// aborted before one is attached — so a lease released only by that listener is
// held for the life of the server, and the flight it was taken on reads on with
// nobody left to read for.
test("a caller that had already given up holds no lease either", async (t) => {
  const { upstream, plugin } = await zenPlugin(t);
  upstream.hold();
  const loader = await plugin.auth.loader(publicAuth);
  const controller = new AbortController();
  const pending = askForUnknown(loader, controller.signal).catch((error) => error);
  // Aborted once the loader is past its own gate: the request body is the await
  // between that gate and the discovery, so the lease is taken by a caller that
  // is already gone. Were the abort earlier, the loader would refuse the request
  // before it read anything, which the read count below would say.
  queueMicrotask(() => controller.abort());
  await tick();
  assert.equal(upstream.reads.length, 3, "the abort landed after the loader's own gate");
  assert.deepEqual(
    upstream.reads.map((read) => read.signal.aborted),
    [true, true, true],
    "nobody is waiting, so the flight has nothing left to read for",
  );
  assert.equal((await pending).name, "AbortError");
});

// ...and the failure those two leaks hide: the signal every read was given was
// built once for the server, so once a flight had ended its reads by aborting
// it, every later discovery started on a signal that was already aborted — the
// listing, the catalogue and the docs all failed before they were sent, and
// `refresh()`, the models hook and a request for a model the list did not have
// all answered with that abort from then on.
test("a flight cancelled to no callers does not end the next discovery", async (t) => {
  const { upstream, plugin } = await zenPlugin(t);
  upstream.hold();
  const loader = await plugin.auth.loader(publicAuth);
  const controller = new AbortController();
  const pending = askForUnknown(loader, controller.signal).catch((error) => error);
  await tick();
  assert.equal(upstream.reads.length, 3);
  controller.abort();
  assert.equal((await pending).name, "AbortError");
  await tick();
  assert.deepEqual(
    upstream.reads.map((read) => read.signal.aborted),
    [true, true, true],
    "the reads end when the last caller waiting for them has gone",
  );
  // The discovery after it reads again, on a signal that is not already aborted.
  upstream.free();
  const refreshed = await plugin.refresh();
  assert.ok(refreshed["chat-free"], "the discovery after a cancelled one still answers");
  assert.equal(upstream.reads.length, 6, "and it read rather than answering from the abort");
  // The request path answers too: an unknown model is refused by name, with the
  // models Zen does serve, which is the answer only a discovery that finished
  // can give.
  const realNow = Date.now;
  t.mock.method(Date, "now", () => realNow() + 61_000);
  const refused = await askForUnknown(loader, undefined);
  assert.equal(refused.status, 404);
  const { error } = await refused.json();
  assert.match(error.message, /nothing-free is not available.*chat-free/);
  assert.equal(upstream.reads.length, 9, "and that request read the listing again");
});

// The other half of the rule the leases exist for, and the reason a release does
// not abort anything of its own accord: a caller that walks away is not the
// flight. Two callers wait on one discovery; the first gives up, and the reads
// it was waiting for go on, because the second is still waiting for them.
test("one caller walking away does not cancel the answer another waits for", async (t) => {
  const { upstream, plugin } = await zenPlugin(t);
  upstream.hold();
  const loader = await plugin.auth.loader(publicAuth);
  const first = new AbortController();
  const second = new AbortController();
  const walkedAway = askForUnknown(loader, first.signal).catch((error) => error);
  const waitingStill = askForUnknown(loader, second.signal).catch((error) => error);
  await tick();
  assert.equal(upstream.reads.length, 3, "two callers, one flight, one round of reads");
  first.abort();
  assert.equal((await walkedAway).name, "AbortError");
  await tick();
  assert.deepEqual(
    upstream.reads.map((read) => read.signal.aborted),
    [false, false, false],
    "the caller that left was not the last one waiting, so the reads go on",
  );
  // The answer reaches the caller that stayed: it is the refusal for the model
  // it named, which only a discovery that finished can write.
  upstream.free();
  const refused = await waitingStill;
  assert.equal(refused.status, 404);
  const { error } = await refused.json();
  assert.match(error.message, /nothing-free is not available.*chat-free/);
  assert.equal(upstream.reads.length, 3, "and no second round was read for it");
});

// ...and the other side of the same rule: a caller that arrives while a
// cancelled flight is still winding down must not inherit its cancellation. The
// window is not a microtask — a flight's reads reject a turn after they are
// aborted, and the three of them settle it after that — so a request arriving
// right after the cancellation finds a flight that is still "running" and
// already dead. Its answer would be the abort some other caller asked for.
test("a caller arriving after a cancellation is not handed its abort", async (t) => {
  const { upstream, plugin } = await zenPlugin(t);
  upstream.hold();
  const loader = await plugin.auth.loader(publicAuth);
  const first = new AbortController();
  const walkedAway = askForUnknown(loader, first.signal).catch((error) => error);
  await tick();
  assert.equal(upstream.reads.length, 3, "the caller that left started a discovery");
  first.abort();
  assert.equal((await walkedAway).name, "AbortError");
  // Arrives with the cancelled flight unsettled: its reads have been aborted,
  // but their rejection is a turn away and the settle comes after that.
  const second = new AbortController();
  const answered = askForUnknown(loader, second.signal).catch((error) => error);
  await tick();
  upstream.free();
  const refused = await answered;
  assert.notEqual(
    refused.name,
    "AbortError",
    "the cancellation was not this caller's to inherit",
  );
  assert.equal(refused.status, 404, "and its own discovery is what answered it");
  const { error } = await refused.json();
  assert.match(error.message, /nothing-free is not available.*chat-free/);
  assert.equal(upstream.reads.length, 6, "a round of its own, not the cancelled one");
});

// Why a refusal's body stopped short is not among the facts this path holds.
// The reader answers "the read stopped short" for a budget it reached, a
// deadline that passed, a read that failed and a caller that aborted, and it
// names none of them; the length read is not a reason either, since a body past
// the budget and one a stalled upstream left half-sent come back as the same
// prefix. So the message states the fact it has — the body was not read to its
// end — and how much of it was read. The request below is the budget case, whose
// number the message can still state, and the wording is not the one that read a
// reason off that number.
test("a refusal read short says so without naming a reason it cannot know", async (t) => {
  const { upstream, plugin } = await zenPlugin(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  const long = `{"error":{"message":"${"x".repeat(5000)}"}}`;
  upstream.refuse(400, long);
  const response = await loader.fetch(`${zenBase}/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "chat-free", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(response.status, 400, "the upstream's status is the answer's status");
  const { error } = await response.json();
  assert.match(error.message, /HTTP 400/);
  assert.match(error.message, /was not read to the end/);
  assert.match(error.message, /\d+ characters read before the read stopped/);
  assert.doesNotMatch(
    error.message,
    /ran past|this plugin reads of a refusal/,
    "the budget is not stated as the reason, which this path cannot know",
  );
  assert.equal(
    error.upstream,
    long.slice(0, 512) + "…",
    "the opening that was read is carried along",
  );
});

// Not a lease invariant, and here for the reason the ones above are: the
// discovery is provider.mjs's, and the row that has to survive it is the
// catalogue's. A catalogue row that writes its package in another shape used
// to throw out of `buildModels`, and the throw was the discovery's — so every
// free model went with it, which is the one outcome the whole shape rule in
// models.mjs exists to prevent. The row here is a number where a package name
// belongs, and the models beside it are still offered.
test("a catalogue row with a package in another shape does not end the discovery", async (t) => {
  const upstream = discoveryUpstream({
    listing: { data: [{ id: "chat-free" }, { id: "dirty-free" }] },
    catalog: {
      opencode: {
        models: {
          "chat-free": {},
          "dirty-free": { provider: { npm: 5 } },
        },
      },
    },
  });
  t.after(() => upstream.restore());
  const { server } = (await providerModule).default;
  const plugin = await server({}, zenURLs);
  const models = await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  assert.ok(models["chat-free"], "the discovery answered");
  assert.ok(models["dirty-free"], "and the row with the dirty package is still offered");
  assert.equal(models["dirty-free"].api.npm, "@ai-sdk/openai-compatible");
});

// The route's listing is a document this plugin reads, and an entry that is not
// a model is a fact about that entry: `item.id` on a `null` entry threw out of
// `reading`, and that throw was the whole discovery's, so one dirty row upstream
// took every free model with it. The entry is skipped and the rest of the
// listing — in the order the route sent it — is still offered.
test("a listing entry that is not a model does not end the discovery", async (t) => {
  const upstream = discoveryUpstream({
    listing: { data: [{ id: "chat-free" }, null, 7, "junk", { id: "late-free" }] },
  });
  t.after(() => upstream.restore());
  const { server } = (await providerModule).default;
  const plugin = await server({}, zenURLs);
  const models = await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  assert.deepEqual(Object.keys(models), ["chat-free", "late-free"]);
});

// The body of a discovery read is part of the read. `readRemote` disposed its
// combined signal in a `finally` that ran as soon as the fetch promise was
// handed back — before `response.json()`/`text()` had read anything — so on a
// runtime without `AbortSignal.any` the caller's abort and the read's own
// timeout were detached from a body still being waited on. Pinned on the
// hand-made combination, which is the one with a listener to let go of.
test("a caller that aborts ends the discovery bodies it is waiting on", async (t) => {
  const any = AbortSignal.any;
  AbortSignal.any = undefined;
  t.after(() => {
    AbortSignal.any = any;
  });
  const reads = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const read = { url: String(url), aborted: false };
    reads.push(read);
    // Headers now, body when the read's signal ends it: what a real fetch does
    // with a body it is holding, and the only thing that ends this one.
    return new Response(
      new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener(
            "abort",
            () => {
              read.aborted = true;
              controller.error(init.signal.reason);
            },
            { once: true },
          );
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const { server } = (await providerModule).default;
  const plugin = await server({}, {
    ...zenURLs,
    discoveryCachePath: "",
    limitsSnapshotURL: "",
  });
  const loader = await plugin.auth.loader(publicAuth);
  const controller = new AbortController();
  const pending = askForUnknown(loader, controller.signal).catch((error) => error);
  // The reads are waited for rather than assumed: how many discovery issues and
  // in which order is not what this case is about, and `await tick()` happened
  // to be enough for exactly three. The wait is bounded, so a discovery that
  // stopped issuing them fails here as a count instead of hanging until the
  // runner's own timeout says nothing.
  const deadline = Date.now() + 5_000;
  while (reads.length < 3) {
    if (Date.now() > deadline)
      throw new Error(`only ${reads.length} of the discovery's three reads started`);
    await tick();
  }
  assert.equal(reads.length, 3, "the discovery's three reads are in flight");
  controller.abort();
  // The abort is what ends the mocked bodies, so a propagation regression is a
  // wait that never settles: raced, it fails with the reason instead of hanging.
  const heard = await Promise.race([
    pending,
    new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error("the abort never reached the discovery's bodies")),
        5_000,
      ).unref?.();
    }),
  ]);
  assert.equal(heard.name, "AbortError", "the caller hears its own signal");
  assert.deepEqual(
    reads.map((read) => read.aborted),
    [true, true, true],
    "the reads' bodies end with the caller that asked for them",
  );
});

// ---- discovery cache -------------------------------------------------------
//
// The cache is an input to discovery, not a source of truth. These cases pin
// the two halves that make that safe: a file this build cannot read answers no
// cache rather than failing discovery, and a file it can read is bounded to the
// records and protocols this build can ask. The path cases use a temporary
// directory only; the operator's own cache is never named here.

const CACHED_AT = "2026-10-21T10:00:00.000Z";
const cachedModel = {
  id: "chat-free",
  providerID: "opencode-zen-free",
  name: "Chat Free",
  api: {
    id: "chat-free",
    url: "https://opencode.ai/inference/v1",
    npm: "@ai-sdk/openai-compatible",
  },
  limit: { context: 200000, output: 32000 },
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: false,
    toolcall: true,
    input: { text: true, image: false, audio: false, video: false, pdf: false },
    output: { text: true, image: false, audio: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  variants: {},
  options: {},
  headers: {},
  status: "active",
  release_date: "",
  free: true,
};

async function discoveryTempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "opencode-zen-freex-discovery-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("the discovery cache path follows explicit, env, and platform rules", async () => {
  const { DISCOVERY_CACHE_ENV, discoveryCachePath } = await subject;
  assert.equal(discoveryCachePath("/tmp/explicit.json", {}), "/tmp/explicit.json");
  assert.equal(discoveryCachePath("", {}), undefined, "an empty explicit path disables");
  assert.equal(
    discoveryCachePath(undefined, { [DISCOVERY_CACHE_ENV]: "/tmp/named.json" }),
    "/tmp/named.json",
  );
  assert.equal(
    discoveryCachePath(undefined, { [DISCOVERY_CACHE_ENV]: "" }),
    undefined,
    "an empty env value disables",
  );
  assert.equal(
    discoveryCachePath(undefined, { LOCALAPPDATA: "/tmp/local", XDG_CACHE_HOME: "/tmp/xdg" }),
    join("/tmp/local", "opencode-zen-freex", "discovery.json"),
    "LOCALAPPDATA wins",
  );
  assert.equal(
    discoveryCachePath(undefined, { XDG_CACHE_HOME: "/tmp/xdg" }),
    join("/tmp/xdg", "opencode-zen-freex", "discovery.json"),
  );
});

test("the discovery cache round-trips the models, protocols, and listed date", async (t) => {
  const { readDiscoveryCache, writeDiscoveryCache } = await subject;
  const dir = await discoveryTempDir(t);
  const file = join(dir, "discovery.json");
  const models = { "chat-free": cachedModel };
  const protocols = { "chat-free": "chat" };
  assert.equal(await writeDiscoveryCache(file, { models, protocols, listedAt: CACHED_AT }), true);
  assert.deepEqual(await readDiscoveryCache(file), { models, protocols, listedAt: CACHED_AT });
  assert.deepEqual(await readdir(dir), ["discovery.json"], "no temporary is left behind");
  if (process.platform !== "win32")
    assert.equal((await stat(file)).mode & 0o777, 0o600, "the cache is private");
});

test("the discovery cache accepts a Date and stores it as ISO text", async (t) => {
  const { readDiscoveryCache, writeDiscoveryCache } = await subject;
  const dir = await discoveryTempDir(t);
  const file = join(dir, "discovery.json");
  assert.equal(
    await writeDiscoveryCache(file, {
      models: { "chat-free": cachedModel },
      protocols: { "chat-free": "chat" },
      listedAt: new Date(CACHED_AT),
    }),
    true,
  );
  const cache = await readDiscoveryCache(file);
  assert.equal(cache.listedAt, CACHED_AT);
});

test("a missing, bad-JSON, or foreign-version cache answers no cache", async (t) => {
  const { readDiscoveryCache } = await subject;
  const dir = await discoveryTempDir(t);
  const file = join(dir, "discovery.json");
  assert.equal(await readDiscoveryCache(join(dir, "missing.json")), undefined);
  await writeFile(file, "{ this is not json", "utf8");
  assert.equal(await readDiscoveryCache(file), undefined);
  // A cache from an older build is the one this build must not read: v1 holds
  // rows written before the record rule got stricter, and v2 holds limits computed
  // by an estimator that read a screenshot's base64 as prompt text. A reader that
  // served either would answer a listing with a model missing, or with a window
  // three times the one the route enforces, instead of fetching it again.
  for (const version of [1, 2]) {
    await writeFile(
      file,
      JSON.stringify({
        version,
        models: { "chat-free": cachedModel },
        protocols: { "chat-free": "chat" },
        listedAt: CACHED_AT,
      }),
      "utf8",
    );
    assert.equal(await readDiscoveryCache(file), undefined, `version ${version} is not this build's`);
  }
});

test("bad model rows are skipped and protocols are filtered", async (t) => {
  const { readDiscoveryCache } = await subject;
  const dir = await discoveryTempDir(t);
  const file = join(dir, "discovery.json");
  await writeFile(
    file,
    JSON.stringify({
      version: 3,
      models: {
        "chat-free": cachedModel,
        "string-row": "not a model",
        "array-row": [],
        "null-row": null,
        "partial-row": { id: "partial-row" },
        "wrong-id-row": { ...cachedModel, id: "some-other-id" },
      },
      protocols: {
        "chat-free": "chat",
        "array-row": "systemone",
        "bad-protocol": "not-a-protocol",
      },
      listedAt: CACHED_AT,
    }),
    "utf8",
  );
  assert.deepEqual(await readDiscoveryCache(file), {
    models: { "chat-free": cachedModel },
    protocols: { "chat-free": "chat" },
    listedAt: CACHED_AT,
  });
});

// `configModels` reads `reasoning`/`toolcall`/`attachment` and the two modality
// maps off `capabilities`, so a row that kept `{ id, api, limit }` and lost
// `capabilities` — a hand-edited or truncated cache — turned into
// `Object.keys(undefined)` on the listing path. A row without the maps is not a
// model this build can hand on, and it is skipped like any other bad row.
test("a cached row without capabilities is skipped, not read as a model", async (t) => {
  const { configModels, readDiscoveryCache } = await subject;
  const dir = await discoveryTempDir(t);
  const file = join(dir, "discovery.json");
  await writeFile(
    file,
    JSON.stringify({
      version: 3,
      models: {
        "chat-free": cachedModel,
        "missing-capabilities-free": {
          ...cachedModel,
          id: "missing-capabilities-free",
          capabilities: undefined,
        },
        "null-capabilities-free": {
          ...cachedModel,
          id: "null-capabilities-free",
          capabilities: null,
        },
        "flat-capabilities-free": {
          ...cachedModel,
          id: "flat-capabilities-free",
          capabilities: { reasoning: true },
        },
      },
      protocols: { "chat-free": "chat" },
      listedAt: CACHED_AT,
    }),
    "utf8",
  );
  const cache = await readDiscoveryCache(file);
  assert.deepEqual(Object.keys(cache.models), ["chat-free"]);
  // The throw the row would otherwise have caused, at the place that reads it.
  assert.doesNotThrow(() => configModels(cache.models));
});

// The cache's ceiling bounds the bytes a request path can be asked to read from
// a file it did not write, and it has to be checked before the file is buffered.
// Three-byte characters are how the two lengths come apart: this document's text
// is under the ceiling while its bytes are over it, and it is otherwise a cache
// this build can read, so only the size guard can refuse it.
test("a cache file over the byte ceiling is not read", async (t) => {
  const { readDiscoveryCache } = await subject;
  const dir = await discoveryTempDir(t);
  const file = join(dir, "discovery.json");
  const body = JSON.stringify({
    version: 3,
    models: {},
    protocols: {},
    listedAt: CACHED_AT,
    pad: "语".repeat(2_800_000),
  });
  assert.ok(body.length < 8 * 1024 * 1024, "the text is under the 8 MiB ceiling");
  await writeFile(file, body, "utf8");
  assert.ok((await stat(file)).size > 8 * 1024 * 1024, "the file is over it");
  assert.equal(await readDiscoveryCache(file), undefined);
  // The same document with the padding taken out is read, so the refusal above
  // is the ceiling and not the field it was padded with: an unknown key is not
  // what makes a cache unreadable.
  await writeFile(file, JSON.stringify({ ...JSON.parse(body), pad: "语" }), "utf8");
  assert.ok((await stat(file)).size < 8 * 1024 * 1024, "the control is under the ceiling");
  assert.deepEqual(await readDiscoveryCache(file), {
    models: {},
    protocols: {},
    listedAt: CACHED_AT,
  });
});

// The read is the other half of the ceiling: `stat` refuses a file already over
// it, but a file can grow between the stat and the read, and a procfs-style file
// reports a size of 0 whatever it holds. `readDiscoveryCache`'s tests cannot show
// that, because its stat refuses those files before the read; the read is called
// directly here, on a file larger than the buffer, which is the shape a file that
// grew takes. A read bounded only by the file would buffer all of it.
test("a bounded read answers the buffer's length, not the file's", async (t) => {
  const { readAtMost } = await subject;
  const dir = await discoveryTempDir(t);
  const file = join(dir, "grown.json");
  await writeFile(file, "0123456789", "utf8");
  const buffer = Buffer.alloc(4);
  assert.equal(await readAtMost(file, buffer), 4, "the answer is the buffer, not the file");
  assert.equal(buffer.toString("utf8"), "0123", "and its bytes are the file's first bytes");
});

// The bound has to let a file smaller than the buffer through whole, and the
// count has to be bytes rather than characters: three-byte characters are how
// the two lengths come apart, and a count taken from the decoded text would cut
// the last character off. It is also the loop's short-answer path: the first
// read answers fewer bytes than the buffer asked for, and the next answers 0,
// which is the branch that ends the read at the file rather than at the buffer.
test("a file smaller than the buffer is read whole and counted in bytes", async (t) => {
  const { readAtMost } = await subject;
  const dir = await discoveryTempDir(t);
  const file = join(dir, "small.json");
  const text = '{"pad":"语"}';
  await writeFile(file, text, "utf8");
  const size = (await stat(file)).size;
  const buffer = Buffer.alloc(size + 16);
  const read = await readAtMost(file, buffer);
  assert.equal(read, size, "the count is the file's bytes, short of the buffer");
  assert.equal(buffer.subarray(0, read).toString("utf8"), text, "and the bytes decode as written");
});

test("listedAt must be an ISO date, and a bad date is not written", async (t) => {
  const { readDiscoveryCache, writeDiscoveryCache } = await subject;
  const dir = await discoveryTempDir(t);
  const file = join(dir, "discovery.json");
  assert.equal(
    await writeDiscoveryCache(file, {
      models: {},
      protocols: {},
      listedAt: "yesterday",
    }),
    false,
  );
  assert.equal(await readDiscoveryCache(file), undefined);
  await writeFile(
    file,
    JSON.stringify({ version: 3, models: {}, protocols: {}, listedAt: 123 }),
    "utf8",
  );
  assert.equal(await readDiscoveryCache(file), undefined);
});

test("empty paths disable reads and writes without touching the disk", async () => {
  const { DISCOVERY_CACHE_ENV, discoveryCachePath, readDiscoveryCache, writeDiscoveryCache } =
    await subject;
  assert.equal(discoveryCachePath("", {}), undefined);
  assert.equal(discoveryCachePath(undefined, { [DISCOVERY_CACHE_ENV]: "" }), undefined);
  assert.equal(await readDiscoveryCache(undefined), undefined);
  assert.equal(await readDiscoveryCache(""), undefined);
  assert.equal(
    await writeDiscoveryCache("", {
      models: {},
      protocols: {},
      listedAt: CACHED_AT,
    }),
    false,
  );
  assert.equal(
    await writeDiscoveryCache(undefined, {
      models: {},
      protocols: {},
      listedAt: CACHED_AT,
    }),
    false,
  );
});

test("a failed atomic write leaves no temporary behind", async (t) => {
  const { writeDiscoveryCache } = await subject;
  const dir = await discoveryTempDir(t);
  // A directory at the target path makes rename fail after the temporary has
  // been written. What must not survive is that temporary.
  const target = join(dir, "discovery.json");
  await mkdir(target);
  assert.equal(
    await writeDiscoveryCache(target, {
      models: {},
      protocols: {},
      listedAt: CACHED_AT,
    }),
    false,
  );
  assert.deepEqual(await readdir(dir), ["discovery.json"]);
});

test("the discovery cache writer ignores inputs that are not object maps", async (t) => {
  const { readDiscoveryCache, writeDiscoveryCache } = await subject;
  const dir = await discoveryTempDir(t);
  const file = join(dir, "discovery.json");
  assert.equal(await writeDiscoveryCache(file, null), false);
  assert.equal(await writeDiscoveryCache(file, {}), false);
  assert.equal(
    await writeDiscoveryCache(file, { models: null, protocols: {}, listedAt: CACHED_AT }),
    false,
  );
  assert.equal(
    await writeDiscoveryCache(file, { models: {}, protocols: [], listedAt: CACHED_AT }),
    false,
  );
  assert.equal(await readDiscoveryCache(file), undefined);
  await writeFile(
    file,
    JSON.stringify({ version: 3, models: {}, protocols: [], listedAt: CACHED_AT }),
    "utf8",
  );
  assert.equal(await readDiscoveryCache(file), undefined);
});
