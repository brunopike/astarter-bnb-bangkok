import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";


const CONTROL_PATHS = {
  "/v1/system/health": ["get"],
  "/v1/system/capabilities": ["get"],
  "/v1/catalogs/fixtures/{fixture_id}/publish": ["post"],
  "/v1/catalogs/{catalog_revision}/instruments": ["get"],
  "/v1/backtests/preflight": ["post"],
  "/v1/backtests": ["post"],
  "/v1/backtests/{run_id}": ["get"],
  "/v1/backtests/{run_id}/cancel": ["post"],
  "/v1/backtests/{run_id}/configuration": ["get"],
  "/v1/backtests/{run_id}/events": ["get"],
  "/v1/backtests/{run_id}/artifacts": ["get"],
  "/v1/backtests/{run_id}/artifacts/{artifact_name}": ["get"],
  "/v1/stream": ["get"],
  "/v1/agent/run-review": ["post"],
  "/v1/strategies": ["get"],
  "/v1/strategy-drafts": ["get", "post"],
  "/v1/strategy-drafts/{draft_id}": ["get", "put"],
  "/v1/strategy-drafts/{draft_id}/publish": ["post"],
  "/v1/strategy-drafts/{draft_id}/versions": ["get"],
  "/v1/strategy-configurations/{configuration_id}": ["get"],
  "/v1/strategy-configurations/{configuration_id}/preflight": ["post"],
  "/v2/historical/capabilities": ["get"],
  "/v2/historical/catalogs": ["get"],
  "/v2/historical/catalogs/{catalog_revision}": ["get"],
  "/v2/historical/configuration-drafts": ["get", "post"],
  "/v2/historical/configuration-drafts/{draft_id}": ["get", "put"],
  "/v2/historical/configuration-drafts/{draft_id}/publish": ["post"],
  "/v2/historical/configurations": ["get"],
  "/v2/historical/configurations/{configuration_id}": ["get"],
  "/v2/historical/preflights": ["post"],
  "/v2/historical/preflights/{preflight_id}": ["get"],
  "/v2/historical/runs": ["post"],
  "/v2/historical/runs/{run_id}": ["get"],
  "/v2/historical/runs/{run_id}/artifacts": ["get"],
  "/v2/historical/runs/{run_id}/artifacts/{artifact_name}": ["get"],
  "/v2/historical/runs/{run_id}/cancel": ["post"],
  "/v2/historical/runs/{run_id}/events": ["get"],
  "/v2/historical/runs/{run_id}/report-summary": ["get"],
  "/v2/historical/strategies": ["get"],
};
// The sole approved catch-all delegates to a reviewed, closed method/path table.
// Pin that exception, its BFF and Control router; future edits need explicit review.
// These are public source digests, not credentials or a runtime authorization system.
const HISTORICAL_REVIEWED_SOURCES = {
  "services/engine/src/stark_trading_os/control/routes/historical.py": "a5f02faf39614046545dd0f8005ac4783989d3bb18505661dedeb4a887b0f78f",
};
// Reviewed optional source/mount/admission boundaries; not default routes or execution grants.
const OPT_IN_REVIEWED_SOURCES = {
  "services/engine/src/stark_trading_os/control/routes/assistant_tools.py": "4b4b2fbb36790a9f01cbfb25a82f167bbbee215dc9e628a34092cd6de847a900",
  "services/engine/src/stark_trading_os/control/routes/public_data.py": "e09732afc22330d5197378e4c9c1ec9d60ab11d35191289dafc985711f1839b1",
  "services/engine/src/stark_trading_os/control/routes/recommendations.py": "31a0d42c9a72f560deb2deb5e64b25cd05f2d21637c0058829e9f99d36678185",
  "services/engine/src/stark_trading_os/control/routes/strategy_references.py": "bc767466a35b0791fc8fdbd6ca60384db74f434f2c5aafcd71034b7ca0973c39",
  "services/engine/src/stark_trading_os/control/app.py": "31e8df64fbf01e0bfd582f03c6c2199f9df3a5454a61d9501b6c74c9ac87b0f5",
  "services/engine/src/stark_trading_os/control/security.py": "7668f7c300362aaaacebae27017f4e584b5f862dbbc26eaef481a26e1745a021",
  "services/engine/src/stark_trading_os/control/postgres/caller.py": "af0dadc380733a5035841afaf252c55655a50a4b2601f535fe1a509808005587",
  "services/engine/src/stark_trading_os/control/postgres/identity.py": "80239f958ce067b97bb99c6171b3a866c0bf851717f5c1cd1cf66a49e3e5d239",
};
const SDK_IMPORTS = {
  agents: ["Agent", "RunConfig", "Runner", "ToolExecutionConfig", "function_tool"],
  "agents.exceptions": ["MaxTurnsExceeded", "ModelBehaviorError", "ModelRefusalError", "ModelTimeoutError"],
  "agents.tool": ["FunctionTool"],
  "agents.tool_context": ["ToolContext"],
};
const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?|py)$/;
const CONTROL_ROUTE_FILES = new Set(["__init__.py", "agent.py", "artifacts.py", "backtests.py", "catalogs.py", "historical.py", "strategies.py", "stream.py", "system.py", "assistant_tools.py", "public_data.py", "recommendations.py", "strategy_references.py"]);

function filesUnder(directory) {
  if (!lstatSync(directory).isDirectory()) throw new Error("source directory is unavailable");
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (["__tests__", "__pycache__"].includes(entry.name) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) return [];
    if (entry.isSymbolicLink()) throw new Error("source symlinks are not accepted");
    return entry.isDirectory() ? filesUnder(path) : entry.isFile() && SOURCE_EXTENSION.test(entry.name) ? [path] : [];
  });
}

function agentToolInventory(source) {
  const decoratorCount = [...source.matchAll(/^[ \t]*@function_tool\b/gm)].length;
  const tools = [];
  const decorators = /^[ \t]*@function_tool(?:[ \t]*\(([\s\S]*?)^[ \t]*\))?[ \t]*\r?\n[ \t]*(?:async[ \t]+)?def[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*\(/gm;
  for (const match of source.matchAll(decorators)) {
    const overrides = [...(match[1] ?? "").matchAll(/\bname_override\s*=\s*["']([^"']+)["']/g)];
    if (overrides.length > 1) return null;
    tools.push(overrides[0]?.[1] ?? match[2]);
  }
  return tools.length === decoratorCount ? tools.sort() : null;
}

function scan(root) {
  const findings = [];
  const reject = (path, reason) => findings.push(`CAPABILITY ${JSON.stringify(path)}: ${reason}`);
  const read = (path) => {
    if (!lstatSync(join(root, path)).isFile()) throw new Error("required source file is unavailable");
    return readFileSync(join(root, path), "utf8");
  };
  const engineFiles = filesUnder(join(root, "services/engine/src"));
  for (const [path, expected] of Object.entries(HISTORICAL_REVIEWED_SOURCES)) {
    const digest = createHash("sha256").update(read(path)).digest("hex");
    if (digest !== expected) reject(path, "historical closed routing changed; review required");
  }

  for (const [path, expected] of Object.entries(OPT_IN_REVIEWED_SOURCES)) {
    const digest = createHash("sha256").update(read(path)).digest("hex");
    if (digest !== expected) reject(path, "opt-in source changed; review required");
  }

  const contractPath = "contracts/control.openapi.json";
  const contract = JSON.parse(read(contractPath));
  const paths = contract.paths;
  if (!paths || typeof paths !== "object" || Array.isArray(paths)) throw new Error("contract paths unavailable");
  if (JSON.stringify(Object.keys(paths).sort()) !== JSON.stringify(Object.keys(CONTROL_PATHS).sort())) reject(contractPath, "contract route inventory changed");
  for (const [path, expectedMethods] of Object.entries(CONTROL_PATHS)) {
    const methods = Object.keys(paths[path] ?? {})
      .filter((key) => /^(get|post|put|patch|delete|head|options|trace)$/.test(key))
      .sort();
    if (JSON.stringify(methods) !== JSON.stringify([...expectedMethods].sort())) reject(contractPath, "contract method inventory changed");
  }
  const schemas = contract.components?.schemas;
  if (!schemas || typeof schemas !== "object" || Array.isArray(schemas)) throw new Error("contract schemas unavailable");
  if (Object.keys(schemas).some((name) => /Order|Execute|Wallet|Sign|Transaction|Credential|Live|ChainObserver/.test(name))) reject(contractPath, "unapproved contract capability schema");
  if (schemas.Environment?.const !== "BACKTEST" || schemas.Environment?.type !== "string") reject(contractPath, "expanded environment definition");
  for (const schema of Object.values(schemas)) {
    const environment = schema.properties?.environment;
    if (environment && environment.const !== "BACKTEST" && environment.$ref !== "#/components/schemas/Environment") reject(contractPath, "expanded run environment schema");
  }
  const domainPath = "services/engine/src/stark_trading_os/domain/models.py";
  if (!/^type Environment = Literal\["BACKTEST"\]$/m.test(read(domainPath))) reject(domainPath, "run environment must remain BACKTEST only");

  for (const absolute of engineFiles) {
    const path = relative(root, absolute).split(sep).join("/");
    const source = readFileSync(absolute, "utf8");
    const controlRoutePrefix = "services/engine/src/stark_trading_os/control/routes/";
    if (path.startsWith(controlRoutePrefix) && !CONTROL_ROUTE_FILES.has(path.slice(controlRoutePrefix.length))) reject(path, "unapproved Control route source");
    if (/\b(?:nautilus_trader\.(?:adapters|live)|TradingNode|LiveExecutionClient|LiveDataClient|ccxt)\b/.test(source)) reject(path, "venue/live execution capability");
    if (!path.includes("/stark_trading_os/agent/")) continue;
    if (!path.endsWith("/agent/openai_review.py") && /\bfunction_tool\b/.test(source)) reject(path, "unreviewed Agent function tool");
    if (/\b(?:ShellTool|LocalShellTool|ComputerTool|WebSearchTool|FileSearchTool|CodeInterpreterTool|HostedMCPTool|MCPServer\w*|subprocess|socket|httpx|requests)\b|\bos\.(?:system|popen)\s*\(/.test(source)) reject(path, "agent external execution/network tool");
    for (const match of source.matchAll(/from\s+(agents(?:\.\w+)*)\s+import\s+(\([^)]*\)|[^\n]+)/g)) {
      const names = match[2].replace(/[()]/g, "").split(",").map((name) => name.trim()).filter(Boolean);
      if (names.some((name) => !SDK_IMPORTS[match[1]]?.includes(name))) reject(path, "unapproved Agent SDK import");
    }
    if (/^\s*import\s+agents\b/m.test(source)) reject(path, "Agent SDK namespace import");
  }
  const agentPath = "services/engine/src/stark_trading_os/agent/openai_review.py";
  const toolNames = agentToolInventory(read(agentPath));
  if (JSON.stringify(toolNames) !== JSON.stringify(["deterministic_ratio", "read_artifact", "read_event"])) reject(agentPath, "Agent tool inventory changed");
  if (findings.length) {
    console.error(findings.join("\n"));
    return 1;
  }
  console.log(`capability scan passed: ${engineFiles.length} backend production sources, ${Object.keys(CONTROL_PATHS).length} Control paths, ${Object.keys(OPT_IN_REVIEWED_SOURCES).length} reviewed opt-in sources`);
  return 0;
}

try {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--root" || !args[1])) throw new Error("invalid scanner arguments");
  process.exitCode = scan(resolve(args[1] ?? join(dirname(fileURLToPath(import.meta.url)), "..")));
} catch {
  console.error("CAPABILITY scanner failed: source or contract could not be validated");
  process.exitCode = 1;
}
