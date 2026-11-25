import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scanner = join(root, "scripts/scan-forbidden-capabilities.mjs");

function fixture(t) {
  const target = mkdtempSync(join(tmpdir(), "stark-capability-test-"));
  t.after(() => rmSync(target, { recursive: true }));
  for (const name of ["services/engine/src", "contracts"]) {
    mkdirSync(dirname(join(target, name)), { recursive: true });
    cpSync(join(root, name), join(target, name), {
      recursive: true,
      filter: (source) => !source.includes("__pycache__") && !source.includes("__tests__"),
    });
  }
  return target;
}

function run(target) {
  return spawnSync(process.execPath, [scanner, "--root", target], { encoding: "utf8", timeout: 20_000 });
}

function add(target, relative, content) {
  const path = join(target, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

test("accepts the reviewed production source and closed contracts", () => {
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /capability scan passed/);
});

for (const [label, path] of [
  ["historical Control router", "services/engine/src/stark_trading_os/control/routes/historical.py"],
]) {
  test(`requires review when the approved ${label} changes`, (t) => {
    const target = fixture(t);
    const absolute = join(target, path);
    const comment = path.endsWith(".py") ? "# unreviewed change\n" : "// unreviewed change\n";
    writeFileSync(absolute, `${readFileSync(absolute, "utf8")}\n${comment}`);
    const result = run(target);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /historical closed routing changed; review required/);
    assert.ok(result.stderr.includes(JSON.stringify(path)));
  });
}

for (const [label, mutate] of [
  ["unapproved historical path", (paths) => { paths["/v2/historical/execute"] = { post: {} }; }],
  ["missing historical path", (paths) => { delete paths["/v2/historical/catalogs"]; }],
  ["extra historical method", (paths) => { paths["/v2/historical/catalogs"].post = {}; }],
  ["missing historical method", (paths) => { delete paths["/v2/historical/configuration-drafts/{draft_id}"].put; }],
]) {
  test(`rejects ${label}`, (t) => {
    const target = fixture(t);
    const path = join(target, "contracts/control.openapi.json");
    const contract = JSON.parse(readFileSync(path, "utf8"));
    mutate(contract.paths);
    writeFileSync(path, JSON.stringify(contract));
    const result = run(target);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /contract (?:route|method) inventory changed/);
  });
}

test("rejects a default-named tool added to the reviewed Agent module", (t) => {
  const target = fixture(t);
  const path = join(target, "services/engine/src/stark_trading_os/agent/openai_review.py");
  writeFileSync(path, `${readFileSync(path, "utf8")}\n@function_tool\nasync def unreviewed_default_tool():\n    return "unsafe"\n`);

  const result = run(target);

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /CAPABILITY.*Agent tool inventory changed/);
});

for (const [name, path, content] of [
  ["agent shell tool", "services/engine/src/stark_trading_os/agent/new_tool.py", 'from agents import ShellTool\n'],
  ["unreviewed agent function tool", "services/engine/src/stark_trading_os/agent/new_tool.py", 'from agents import function_tool\n@function_tool\ndef extra(): return "unsafe"\n'],
  ["new Control route file", "services/engine/src/stark_trading_os/control/routes/execute.py", 'from fastapi import APIRouter\nrouter = APIRouter()\n@router.post("/execute")\ndef execute(): return {}\n'],
  ["exchange adapter", "services/engine/src/stark_trading_os/new_venue.py", 'from nautilus_trader.adapters.binance import BinanceLiveExecClient\n'],
]) {
  test(`rejects ${name} in a newly added production file`, (t) => {
    const target = fixture(t);
    add(target, path, content);
    const result = run(target);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /CAPABILITY/);
    assert.match(result.stderr, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
}

test("rejects a new control contract path", (t) => {
  const target = fixture(t);
  const path = join(target, "contracts/control.openapi.json");
  const contract = JSON.parse(readFileSync(path, "utf8"));
  contract.paths["/v1/execute"] = { post: {} };
  writeFileSync(path, JSON.stringify(contract));
  const result = run(target);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /CAPABILITY.*contract/);
});

for (const [label, mutate] of [
  ["missing PUT", (operations) => { delete operations.put; }],
  ["extra PATCH", (operations) => { operations.patch = {}; }],
]) {
  test(`rejects ${label} on the approved multi-verb strategy draft path`, (t) => {
    const target = fixture(t);
    const path = join(target, "contracts/control.openapi.json");
    const contract = JSON.parse(readFileSync(path, "utf8"));
    mutate(contract.paths["/v1/strategy-drafts/{draft_id}"]);
    writeFileSync(path, JSON.stringify(contract));

    const result = run(target);

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /CAPABILITY.*contract method inventory changed/);
  });
}

test("rejects an expanded run environment in the domain source", (t) => {
  const target = fixture(t);
  const path = join(target, "services/engine/src/stark_trading_os/domain/models.py");
  writeFileSync(path, readFileSync(path, "utf8").replace('Literal["BACKTEST"]', 'Literal["BACKTEST", "LIVE"]'));
  assert.equal(run(target).status, 1);
});

test("fails closed for incomplete or malformed source roots", (t) => {
  const target = fixture(t);
  writeFileSync(join(target, "contracts/control.openapi.json"), "not JSON");
  assert.equal(run(target).status, 1);
});


const optInSources = [
  "routes/assistant_tools.py", "routes/public_data.py", "routes/recommendations.py",
  "routes/strategy_references.py", "app.py", "security.py", "postgres/caller.py", "postgres/identity.py",
].map((path) => `services/engine/src/stark_trading_os/control/${path}`);

test("accepts reviewed opt-in sources while preserving default route inventories", () => {
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /39 Control paths, 8 reviewed opt-in sources/);
});

for (const path of optInSources) {
  test(`requires review when opt-in boundary ${path} changes`, (t) => {
    const target = fixture(t);
    add(target, path, `${readFileSync(join(target, path), "utf8")}\n# changed reviewed boundary\n`);
    const result = run(target);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /opt-in source changed; review required/);
    assert.ok(result.stderr.includes(JSON.stringify(path)));
  });
}

for (const [label, path, before, after] of [
  ["default mount", "app.py", "public_data_enabled: bool = False", "public_data_enabled: bool = True"],
  ["exclusive assembly", "app.py", "if recommendation_only:", "if False:"],
  ["Origin middleware", "app.py", "application.add_middleware(LocalOriginMiddleware", "application.add_middleware(object"],
  ["reference writer", "postgres/caller.py", "if write and", "if False and"],
  ["identity admission", "postgres/identity.py", "if compare_digest(digest, grant.token_digest):", "if True:"],
]) {
  test(`rejects opt-in ${label} bypass`, (t) => {
    const target = fixture(t);
    const relative = `services/engine/src/stark_trading_os/control/${path}`;
    const original = readFileSync(join(target, relative), "utf8");
    assert.ok(original.includes(before), "mutation must reach the real boundary");
    add(target, relative, original.replace(before, after));
    const result = run(target);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /opt-in source changed; review required/);
    assert.ok(result.stderr.includes(JSON.stringify(relative)));
  });
}

for (const [path, source] of [
  ["public_data.py", '@router.post("/execute")\ndef unreviewed_execute(): return {}\n'],
  ["strategy_references.py", '@router.post("/recovery/unlock")\ndef unreviewed_unlock(): return {}\n'],
]) {
  test(`rejects same-file opt-in expansion in ${path}`, (t) => {
    const target = fixture(t);
    const relative = `services/engine/src/stark_trading_os/control/routes/${path}`;
    add(target, relative, `${readFileSync(join(target, relative), "utf8")}\n${source}`);
    const result = run(target);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /opt-in source changed; review required/);
  });
}

test("rejects a nested route using a reviewed basename", (t) => {
  const target = fixture(t);
  const path = "services/engine/src/stark_trading_os/control/routes/nested/public_data.py";
  add(target, path, "# unreviewed nested source\n");
  const result = run(target);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(JSON.stringify(path)));
  assert.match(result.stderr, /unapproved Control route source/);
});

for (const damage of ["missing", "symlink"]) {
  test(`rejects ${damage} opt-in identity source`, (t) => {
    const target = fixture(t);
    const path = join(target, optInSources.at(-1));
    rmSync(path);
    if (damage === "symlink") symlinkSync(join(target, optInSources[0]), path);
    assert.equal(run(target).status, 1);
  });
}

test("does not add an optional path to the frozen Control contract", (t) => {
  const target = fixture(t);
  const path = join(target, "contracts/control.openapi.json");
  const contract = JSON.parse(readFileSync(path, "utf8"));
  contract.paths["/v1/data/markets"] = { get: {} };
  writeFileSync(path, JSON.stringify(contract));
  const result = run(target);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /contract route inventory changed/);
});
