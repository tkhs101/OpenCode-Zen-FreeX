// The Node claim, checked by a Node that is actually Node.
//
// `package.json` says `engines.node >= 18.17.0` and MAINTAINING.md explains why
// that floor is what it is, but the suite runs on Bun and the workflow only ever
// installed Bun: nothing executed the shipped modules on the runtime the package
// promises. A Bun-only API, or a syntax or built-in a host on the floor does not
// have, could enter `index.mjs` or anything it imports while every `bun test`
// stayed green. This file is the missing execution: `ci.yml`'s `node-host` job
// runs it on the floor and on a current release, and it imports every shipped
// module by its own path rather than relying on `index.mjs` to pull the rest in,
// so a module that stops resolving on Node is a failure here even if the plugin
// entry point still happens to work.
//
// It is repo-only on purpose: `package.json` `files` does not ship it, because a
// consumer installs the plugin and not its checks. It needs no dependencies and
// no network — the request it builds is never sent.
//
// The assertions stay about shapes the package already documents: the factory
// `index.mjs` forwards, the generation a tool list names, the free-id rule, the
// request `tools-smoke.mjs` builds. They are a smoke test, not a second suite:
// `bun test` is where behaviour is pinned, and everything here runs on Node
// 18.17 with plain ESM and no top-level await. `tools-smoke.mjs` is imported for
// `chatRequest` only; its gate asks Zen from an entry-point check, and an import
// is not a run, so importing it here must not and does not reach the network.
import assert from "node:assert/strict";

import plugin, { ZenFreePlugin, id, server } from "./index.mjs";
import provider from "./provider.mjs";
import * as coreTools from "./core-tools.mjs";
import * as models from "./models.mjs";
import * as catalog from "./catalog.mjs";
import * as limits from "./limits.mjs";
import * as stream from "./stream.mjs";
import * as toolResponse from "./tool-response.mjs";
import { chatRequest } from "./tools-smoke.mjs";

const failures = [];
function check(name, fn) {
  try {
    fn();
  } catch (error) {
    failures.push(`${name}: ${error?.message ?? error}`);
  }
}

// The factory a host reads off the default export, and the id it keys the plugin
// by: `index.mjs` refuses to load without both, so the smoke test is holding the
// entry point to the contract a host relies on rather than a duplicate of it.
// The named exports are checked beside the forwarded object because a host can
// resolve the plugin either way, and both ways are supposed to carry the same
// two facts.
check("index.mjs default plugin", () => {
  assert.equal(typeof plugin, "object");
  assert.equal(typeof plugin.server, "function");
  assert.equal(typeof plugin.id, "string");
  assert.ok(plugin.id.trim() !== "");
  assert.equal(server, plugin.server);
  assert.equal(ZenFreePlugin, plugin.server);
  assert.equal(id, plugin.id);
});

// provider.mjs is where the plugin the host starts comes from. The id is the
// provider's own constant, and the factory is the same function index.mjs
// forwards; importing it separately proves the module resolves on Node even if a
// future index.mjs stopped importing it.
check("provider.mjs", () => {
  assert.equal(typeof provider, "object");
  assert.equal(provider.id, "opencode-zen-free");
  assert.equal(typeof provider.server, "function");
  assert.equal(provider.server, plugin.server);
});

// A request belongs to a generation by the tool names it carries, and `bash` is
// the 1.x name (`shell` is 2.x). This is the rule the provider uses to pick the
// request shape, so it is the one worth exercising without a network.
check("core-tools.mjs generationOf", () => {
  assert.equal(coreTools.generationOf([{ type: "function", function: { name: "bash" } }]), "1.x");
  assert.equal(coreTools.generationOf([{ type: "function", function: { name: "shell" } }]), "2.x");
  assert.equal(coreTools.generationOf([]), undefined);
});

// "Free" is the id's own word when the id ends in `-free`, case-insensitively;
// that is the fallback that offers a new Zen model before the catalogue catches
// up. A paid id with no catalogue entry is not free.
check("models.mjs isFree", () => {
  assert.equal(models.isFree("some-model-free"), true);
  assert.equal(models.isFree("some-model-FREE"), true);
  assert.equal(models.isFree("some-model"), false);
});

// catalog.mjs must load with its snapshot beside it and answer the floor a
// discovery reads from: the file is an input at run time, and a module that
// loads but cannot parse the file it ships with is not one a Node host can use.
check("catalog.mjs", () => {
  assert.equal(typeof catalog.parseModelsSnapshotDocument, "function");
  const floor = catalog.bundledModelsSnapshot();
  assert.equal(typeof floor, "object");
  assert.ok(Object.keys(floor).length > 0, "the bundled models-observed.json parsed to a non-empty floor");
  const parsed = catalog.parseModelsSnapshotDocument(JSON.stringify({ version: 1, protocols: floor }));
  assert.ok(parsed, "the bundled copy is one this build reads whole");
});

// limits.mjs must load with its snapshot/table intact: the table is the input
// every host plans from, and a module that imports but cannot answer its own
// docket of exports is not a module a Node host can use.
check("limits.mjs", () => {
  assert.equal(typeof limits.LIMITS, "object");
  assert.ok(Object.keys(limits.LIMITS).length > 0);
  assert.ok(limits.estimateTokens("the free tier") > 0);
  // The size a request is measured at is the same walk the provider uses; a
  // body with one string answers one token-ish count, not NaN.
  const size = limits.requestSize({ messages: [{ role: "user", content: "hi" }] });
  assert.ok(Number.isSafeInteger(size.tokens) && size.tokens > 0);
  assert.ok(Number.isSafeInteger(limits.ESTIMATE_SCALE));
});

// stream.mjs and tool-response.mjs are the transport half of the package: both
// are reached from provider.mjs on the first response, so a module that loads
// but exports nothing usable is the failure this catches.
check("stream.mjs", () => {
  assert.ok(Number.isSafeInteger(stream.MAX_BYTES) && stream.MAX_BYTES > 0);
  assert.equal(typeof stream.collapseResponse, "function");
});
check("tool-response.mjs", () => {
  assert.equal(typeof toolResponse.guardToolResponse, "function");
});

// The request `tools-smoke.mjs` builds is the request the plugin is observed to
// send, and building one is the other half of the smoke test: it makes the
// capture, the header set and the tool profile run on Node. It is built from
// the real 1.x profile in `fingerprint.json`, with the tools that profile
// requires, so a capture that no longer resolves on the floor is a failure here
// too — and the body is checked, not sent.
check("tools-smoke.mjs chatRequest", () => {
  const profile = coreTools.PROFILES["1.x"];
  assert.equal(typeof profile, "object");
  const request = chatRequest({
    model: "smoke-test-free",
    generation: "1.x",
    profile,
    names: [...profile.required],
    maxTokens: 8,
  });
  assert.equal(request.body.model, "smoke-test-free");
  assert.equal(request.body.stream, true);
  assert.equal(request.body.max_tokens, 8);
  assert.equal(request.body.tools.length, profile.required.length);
  // The first message is the generation's own system prompt: measured
  // 2026-10-28, the tier refuses a promptless request with the same
  // `FreeUsageLimitError` a spent quota earns, so the gate's probe carries
  // the prompt and its first message reads `system`.
  assert.equal(request.body.messages[0].role, "system");
  assert.equal(request.body.messages[1].role, "user");
  assert.equal(request.headers.get("authorization"), "Bearer public");
  assert.match(request.headers.get("user-agent"), /^opencode\//);
});

if (failures.length) {
  console.error(`node-smoke: ${failures.length} check(s) failed on ${process.version}`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`node-smoke: shipped modules load and the request builds on ${process.version}`);
}
