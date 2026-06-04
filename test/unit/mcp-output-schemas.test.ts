import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const bin = join(process.cwd(), "packages/gittensory-mcp/bin/gittensory-mcp.js");

let client: Client;
let transport: StdioClientTransport;
let configDir: string;

async function connect() {
  configDir = mkdtempSync(join(tmpdir(), "gittensory-schemas-"));
  transport = new StdioClientTransport({
    command: "node",
    args: [bin, "--stdio"],
    env: {
      ...process.env,
      GITTENSORY_CONFIG_DIR: configDir,
      GITTENSORY_API_TIMEOUT_MS: "1000",
    },
  });
  client = new Client({ name: "schema-test", version: "0.0.1" });
  await client.connect(transport);
}

async function disconnect() {
  await client.close().catch(() => undefined);
  if (configDir) rmSync(configDir, { recursive: true, force: true });
}

describe("MCP structured output schemas", () => {
  beforeEach(connect);
  afterEach(disconnect);

  it("gittensory_local_status_structured tool is discoverable", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "gittensory_local_status_structured");
    expect(tool).toBeDefined();
    expect(tool?.description).toMatch(/local.*status|status.*structured/i);
  });

  it("gittensory_local_status_structured tool has an output schema", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "gittensory_local_status_structured");
    expect(tool?.outputSchema).toBeDefined();
    const schema = tool?.outputSchema as Record<string, unknown>;
    expect(schema.type).toBe("object");
    const properties = schema.properties as Record<string, unknown>;
    expect(properties).toHaveProperty("apiUrl");
    expect(properties).toHaveProperty("hasToken");
    expect(properties).toHaveProperty("package");
    expect(properties).toHaveProperty("sourceUploadDefault");
    expect(properties).toHaveProperty("sourceUploadSupported");
  });

  it("all existing tools remain discoverable and are not broken by schema additions", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("gittensory_get_repo_context");
    expect(names).toContain("gittensory_preflight_pr");
    expect(names).toContain("gittensory_get_decision_pack");
    expect(names).toContain("gittensory_local_status");
    expect(names).toContain("gittensory_preflight_current_branch");
    expect(names).toContain("gittensory_agent_plan_next_work");
    expect(names).toContain("gittensory_agent_prepare_pr_packet");
  });

  it("tools do not expose private or forbidden fields in their descriptions", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const text = tool.description ?? "";
      expect(text).not.toMatch(/wallet address|hotkey|coldkey|raw trust score|private scoreability ranking/i);
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { GittensoryMcp } from "../../src/mcp/server";
import { createTestEnv } from "../helpers/d1";

// Tools that ship an MCP-native output schema so modern clients can validate/render responses.
const TOOLS_WITH_OUTPUT_SCHEMA = [
  "gittensory_get_repo_context",
  "gittensory_get_burden_forecast",
  "gittensory_get_repo_outcome_patterns",
  "gittensory_get_contributor_profile",
  "gittensory_get_decision_pack",
  "gittensory_monitor_open_prs",
  "gittensory_explain_repo_decision",
  "gittensory_get_issue_quality",
  "gittensory_get_registry_changes",
  "gittensory_get_upstream_drift",
  "gittensory_local_status",
];

async function connectTestClient() {
  const mcpServer = new GittensoryMcp(createTestEnv()).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);
  const client = new Client({ name: "gittensory-output-schema-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return { client, mcpServer };
}

// ── Output schema discovery ────────────────────────────────────────────────────

describe("MCP output schema discovery", () => {
  it("exposes an outputSchema for every covered tool in tools/list", async () => {
    const { client } = await connectTestClient();
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    for (const name of TOOLS_WITH_OUTPUT_SCHEMA) {
      const tool = byName.get(name);
      expect(tool, `expected tool "${name}" to be registered`).toBeDefined();
      expect(tool?.outputSchema, `expected tool "${name}" to expose an outputSchema`).toBeDefined();
      expect(tool?.outputSchema?.type).toBe("object");
    }
  });

  it("output schemas declare documented top-level properties", async () => {
    const { client } = await connectTestClient();
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    const repoContext = byName.get("gittensory_get_repo_context");
    const repoContextProps = Object.keys((repoContext?.outputSchema?.properties ?? {}) as Record<string, unknown>);
    expect(repoContextProps).toEqual(expect.arrayContaining(["repoFullName", "lane", "queueHealth", "configQuality"]));

    const upstream = byName.get("gittensory_get_upstream_drift");
    const upstreamProps = Object.keys((upstream?.outputSchema?.properties ?? {}) as Record<string, unknown>);
    expect(upstreamProps).toEqual(expect.arrayContaining(["status", "highestSeverity"]));

    const localStatus = byName.get("gittensory_local_status");
    const localStatusProps = Object.keys((localStatus?.outputSchema?.properties ?? {}) as Record<string, unknown>);
    expect(localStatusProps).toEqual(expect.arrayContaining(["apiAvailable", "supportedEndpoint"]));
  });

  it("preserves the full tool inventory while adding output schemas", async () => {
    const { client } = await connectTestClient();
    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));

    // A representative slice of tools without output schemas remains intact.
    expect(names.has("gittensory_preflight_pr")).toBe(true);
    expect(names.has("gittensory_agent_plan_next_work")).toBe(true);
    expect(names.has("gittensory_compare_pr_variants")).toBe(true);
  });
});

// ── Structured content validates against the declared schema ─────────────────────

describe("MCP tool calls return schema-valid structured content", () => {
  it("gittensory_local_status returns validated structured content", async () => {
    const { client } = await connectTestClient();
    const result = await client.callTool({ name: "gittensory_local_status", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toBeDefined();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.apiAvailable).toBe(true);
    expect(data.supportedEndpoint).toBe("/v1/local/branch-analysis");
  });

  it("gittensory_get_upstream_drift returns validated structured content", async () => {
    const { client } = await connectTestClient();
    const result = await client.callTool({ name: "gittensory_get_upstream_drift", arguments: {} });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(["current", "drift_detected", "stale", "unavailable"]).toContain(data.status);
  });

  it("gittensory_get_registry_changes returns validated structured content", async () => {
    const { client } = await connectTestClient();
    const result = await client.callTool({ name: "gittensory_get_registry_changes", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toBeDefined();
  });

  it("gittensory_get_repo_context returns validated structured content", async () => {
    const { client } = await connectTestClient();
    const result = await client.callTool({ name: "gittensory_get_repo_context", arguments: { owner: "octo", repo: "demo" } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.repoFullName).toBe("octo/demo");
  });
});

// ── Public/private safety ─────────────────────────────────────────────────────

describe("MCP output schemas do not declare private financial fields", () => {
  it("no output schema exposes wallet/hotkey/coldkey/financial property names", async () => {
    const { client } = await connectTestClient();
    const { tools } = await client.listTools();

    for (const tool of tools) {
      if (!tool.outputSchema) continue;
      const serialized = JSON.stringify(tool.outputSchema);
      expect(serialized, `tool "${tool.name}" output schema must not declare private fields`).not.toMatch(
        /hotkey|coldkey|wallet|mnemonic|alphaPerDay|taoPerDay|usdPerDay|rawTrust|privateReviewability/i,
      );
    }
  });

  it("structured content from public-safe tools never includes redacted financial keys", async () => {
    const { client } = await connectTestClient();

    for (const name of ["gittensory_local_status", "gittensory_get_upstream_drift", "gittensory_get_registry_changes"]) {
      const result = await client.callTool({ name, arguments: {} });
      const serialized = JSON.stringify(result.structuredContent ?? {});
      expect(serialized, `tool "${name}" structured content must not leak financial fields`).not.toMatch(
        /hotkey|coldkey|wallet|mnemonic|alphaPerDay|taoPerDay|usdPerDay/i,
      );
    }
  });
});
