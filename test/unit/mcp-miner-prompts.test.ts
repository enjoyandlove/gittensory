import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const bin = join(process.cwd(), "packages/gittensory-mcp/bin/gittensory-mcp.js");

const FORBIDDEN_PATTERN = /wallet\s*[:=]\s*\S+|hotkey\s*[:=]\s*\S+|coldkey\s*[:=]\s*\S+|raw trust score is|your trust score|reward estimate is|estimated reward/i;

let client: Client;
let transport: StdioClientTransport;
let configDir: string;

async function connect() {
  configDir = mkdtempSync(join(tmpdir(), "gittensory-miner-prompts-"));
  transport = new StdioClientTransport({
    command: "node",
    args: [bin, "--stdio"],
    env: {
      ...process.env,
      GITTENSORY_CONFIG_DIR: configDir,
      GITTENSORY_API_TIMEOUT_MS: "1000",
    },
  });
  client = new Client({ name: "miner-prompt-test", version: "0.0.1" });
  await client.connect(transport);
}

async function disconnect() {
  await client.close().catch(() => undefined);
  if (configDir) rmSync(configDir, { recursive: true, force: true });
}

function extractText(messages: Array<{ content: unknown }>): string {
  return messages
    .map((m) => (typeof m.content === "object" && m.content !== null && "text" in m.content ? (m.content as { text: string }).text : ""))
    .join("\n");
}

describe("gittensory_miner_select_issue prompt", () => {
  beforeEach(connect);
  afterEach(disconnect);

  it("returns a user message with issue selection guidance", async () => {
    const result = await client.getPrompt({ name: "gittensory_miner_select_issue", arguments: { repoFullName: "owner/repo", login: "dev" } });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.role).toBe("user");
    const text = extractText(result.messages);
    expect(text).toContain("owner/repo");
    expect(text).toContain("dev");
    expect(text).toMatch(/select.*issue|issue.*select/i);
  });

  it("enforces the no-write human-approval boundary", async () => {
    const result = await client.getPrompt({ name: "gittensory_miner_select_issue", arguments: { repoFullName: "owner/repo", login: "dev" } });
    const text = extractText(result.messages);
    expect(text).toMatch(/do not open|do not.*comment|do not.*label|do not.*close|do not.*merge/i);
  });

  it("prohibits credential and scoring requests", async () => {
    const result = await client.getPrompt({ name: "gittensory_miner_select_issue", arguments: { repoFullName: "owner/repo", login: "dev" } });
    const text = extractText(result.messages);
    expect(text).toMatch(/do not request wallet|do not request.*hotkey|do not request.*coldkey/i);
    expect(text).toMatch(/do not predict reward|do not predict.*scoring/i);
    expect(text).not.toMatch(FORBIDDEN_PATTERN);
  });
});

describe("gittensory_miner_draft_pr_packet prompt", () => {
  beforeEach(connect);
  afterEach(disconnect);

  it("returns a user message with PR packet drafting guidance", async () => {
    const result = await client.getPrompt({ name: "gittensory_miner_draft_pr_packet", arguments: { repoFullName: "owner/repo", login: "dev" } });
    const text = extractText(result.messages);
    expect(text).toMatch(/draft|pr packet|pull request/i);
    expect(text).toContain("owner/repo");
  });

  it("enforces no-write and public-safe boundaries", async () => {
    const result = await client.getPrompt({ name: "gittensory_miner_draft_pr_packet", arguments: { repoFullName: "owner/repo", login: "dev" } });
    const text = extractText(result.messages);
    expect(text).toMatch(/do not open|do not.*merge/i);
    expect(text).toMatch(/public.?safe|no private/i);
    expect(text).not.toMatch(FORBIDDEN_PATTERN);
  });
});

describe("gittensory_miner_branch_preflight prompt", () => {
  beforeEach(connect);
  afterEach(disconnect);

  it("returns a user message with preflight guidance", async () => {
    const result = await client.getPrompt({ name: "gittensory_miner_branch_preflight", arguments: { repoFullName: "owner/repo", login: "dev" } });
    const text = extractText(result.messages);
    expect(text).toMatch(/blocker|preflight|remediation/i);
  });

  it("does not expose private scoreability in prompt text", async () => {
    const result = await client.getPrompt({ name: "gittensory_miner_branch_preflight", arguments: { repoFullName: "owner/repo", login: "dev" } });
    const text = extractText(result.messages);
    expect(text).not.toMatch(FORBIDDEN_PATTERN);
  });
});

describe("gittensory_miner_cleanup_first prompt", () => {
  beforeEach(connect);
  afterEach(disconnect);

  it("returns stale PR cleanup guidance", async () => {
    const result = await client.getPrompt({ name: "gittensory_miner_cleanup_first", arguments: { login: "dev" } });
    const text = extractText(result.messages);
    expect(text).toMatch(/stale|cleanup|close|supersede/i);
    expect(text).toContain("dev");
  });

  it("enforces no-autonomous-write boundary", async () => {
    const result = await client.getPrompt({ name: "gittensory_miner_cleanup_first", arguments: { login: "dev" } });
    const text = extractText(result.messages);
    expect(text).toMatch(/do not close.*autonomously|do not.*merge.*autonomously|do not.*comment.*autonomously/i);
    expect(text).not.toMatch(FORBIDDEN_PATTERN);
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { GittensoryMcp } from "../../src/mcp/server";
import { createTestEnv } from "../helpers/d1";

// Forbidden terms that must never appear in miner planning prompt descriptions or content.
const FORBIDDEN_PROMPT_TERMS =
  /wallet|hotkey|coldkey|mnemonic|seed phrase|payout|raw trust|trust score|reward estimate|farming|private reviewability|scoreability|private ranking/i;

// Explicit secret-request patterns that prompts must never contain.
const FORBIDDEN_REQUEST_PATTERNS = /enter your (wallet|hotkey|token|seed|key|mnemonic|password)|provide your (wallet|hotkey|token|seed|key)|paste your (hotkey|wallet|key)/i;

const MINER_PROMPT_NAMES = [
  "gittensory_select_contribution_issue",
  "gittensory_draft_contribution_pr_packet",
  "gittensory_preflight_contribution_branch",
  "gittensory_plan_cleanup_first",
];

async function connectTestClient() {
  const mcpServer = new GittensoryMcp(createTestEnv()).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);
  const client = new Client({ name: "gittensory-miner-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return { client, mcpServer };
}

// ── Discovery fixtures ────────────────────────────────────────────────────────

describe("MCP miner planning prompt discovery", () => {
  it("lists all miner planning prompts via client discovery", async () => {
    const { client } = await connectTestClient();
    const { prompts } = await client.listPrompts();
    const names = prompts.map((p) => p.name);

    for (const expected of MINER_PROMPT_NAMES) {
      expect(names, `expected miner prompt "${expected}" to be discoverable`).toContain(expected);
    }
  });

  it("all miner prompt names are prefixed with gittensory_", async () => {
    const { client } = await connectTestClient();
    const { prompts } = await client.listPrompts();
    for (const prompt of prompts) {
      expect(prompt.name).toMatch(/^gittensory_/);
    }
  });

  it("miner prompt descriptions do not expose forbidden terms", async () => {
    const { client } = await connectTestClient();
    const { prompts } = await client.listPrompts();
    const minerPrompts = prompts.filter((p) => MINER_PROMPT_NAMES.includes(p.name));

    expect(minerPrompts.length).toBe(MINER_PROMPT_NAMES.length);
    for (const prompt of minerPrompts) {
      expect(prompt.description ?? "", `prompt "${prompt.name}" description must not contain forbidden terms`).not.toMatch(FORBIDDEN_PROMPT_TERMS);
    }
  });

  it("miner prompt inventory is stable — fails if any prompt is removed", async () => {
    const { mcpServer } = await connectTestClient();
    const registered = (mcpServer as unknown as { _registeredPrompts: Record<string, unknown> })._registeredPrompts;

    for (const name of MINER_PROMPT_NAMES) {
      expect(Object.keys(registered), `miner prompt "${name}" must remain registered`).toContain(name);
    }
  });

  it("getting a non-existent miner prompt fails safely", async () => {
    const { client } = await connectTestClient();
    await expect(client.getPrompt({ name: "gittensory_nonexistent_miner_prompt" })).rejects.toThrow();
  });
});

// ── Prompt content safety ─────────────────────────────────────────────────────

describe("MCP miner planning prompt content safety", () => {
  it("gittensory_select_contribution_issue message is free of forbidden terms", async () => {
    const { client } = await connectTestClient();
    const result = await client.getPrompt({
      name: "gittensory_select_contribution_issue",
      arguments: { owner: "test-owner", repo: "test-repo", login: "contributor" },
    });
    for (const message of result.messages) {
      const text = typeof message.content === "object" && "text" in message.content ? (message.content.text as string) : "";
      expect(text).not.toMatch(FORBIDDEN_PROMPT_TERMS);
      expect(text).not.toMatch(FORBIDDEN_REQUEST_PATTERNS);
    }
  });

  it("gittensory_draft_contribution_pr_packet message is free of forbidden terms", async () => {
    const { client } = await connectTestClient();
    const result = await client.getPrompt({
      name: "gittensory_draft_contribution_pr_packet",
      arguments: { owner: "test-owner", repo: "test-repo", login: "contributor" },
    });
    for (const message of result.messages) {
      const text = typeof message.content === "object" && "text" in message.content ? (message.content.text as string) : "";
      expect(text).not.toMatch(FORBIDDEN_PROMPT_TERMS);
      expect(text).not.toMatch(FORBIDDEN_REQUEST_PATTERNS);
    }
  });

  it("gittensory_preflight_contribution_branch message is free of forbidden terms", async () => {
    const { client } = await connectTestClient();
    const result = await client.getPrompt({
      name: "gittensory_preflight_contribution_branch",
      arguments: { owner: "test-owner", repo: "test-repo", login: "contributor" },
    });
    for (const message of result.messages) {
      const text = typeof message.content === "object" && "text" in message.content ? (message.content.text as string) : "";
      expect(text).not.toMatch(FORBIDDEN_PROMPT_TERMS);
      expect(text).not.toMatch(FORBIDDEN_REQUEST_PATTERNS);
    }
  });

  it("gittensory_plan_cleanup_first message is free of forbidden terms", async () => {
    const { client } = await connectTestClient();
    const result = await client.getPrompt({
      name: "gittensory_plan_cleanup_first",
      arguments: { login: "contributor" },
    });
    for (const message of result.messages) {
      const text = typeof message.content === "object" && "text" in message.content ? (message.content.text as string) : "";
      expect(text).not.toMatch(FORBIDDEN_PROMPT_TERMS);
      expect(text).not.toMatch(FORBIDDEN_REQUEST_PATTERNS);
    }
  });

  it("all miner prompts confirm advisory-only intent — no autonomous GitHub writes", async () => {
    const { client } = await connectTestClient();
    const promptArgs: Record<string, Record<string, string>> = {
      gittensory_select_contribution_issue: { owner: "o", repo: "r", login: "dev" },
      gittensory_draft_contribution_pr_packet: { owner: "o", repo: "r", login: "dev" },
      gittensory_preflight_contribution_branch: { owner: "o", repo: "r", login: "dev" },
      gittensory_plan_cleanup_first: { login: "dev" },
    };

    for (const name of MINER_PROMPT_NAMES) {
      const result = await client.getPrompt({ name, arguments: promptArgs[name] });
      const allText = result.messages
        .map((m) => (typeof m.content === "object" && "text" in m.content ? (m.content.text as string) : ""))
        .join(" ");

      expect(allText, `prompt "${name}" must not claim to create issues or PRs`).not.toMatch(
        /\bcreate\s+(?:an?\s+)?(?:issue|pr|pull request|comment|label)\b/i,
      );
      expect(allText, `prompt "${name}" must not claim to merge or close`).not.toMatch(/\b(?:merge|close|push|commit)\b.*\bautomatically\b/i);
      expect(allText, `prompt "${name}" must clarify advisory-only intent`).toMatch(
        /do not|requires.*approval|human.*approval|manually|not.*autonomous|not.*post|not.*open.*pr|not.*create|not.*take.*action/i,
      );
    }
  });

  it("miner prompts do not request secrets, tokens, wallets, or hotkeys from the user", async () => {
    const { client } = await connectTestClient();
    const promptArgs: Record<string, Record<string, string>> = {
      gittensory_select_contribution_issue: { owner: "o", repo: "r", login: "dev" },
      gittensory_draft_contribution_pr_packet: { owner: "o", repo: "r", login: "dev" },
      gittensory_preflight_contribution_branch: { owner: "o", repo: "r", login: "dev" },
      gittensory_plan_cleanup_first: { login: "dev" },
    };

    for (const name of MINER_PROMPT_NAMES) {
      const result = await client.getPrompt({ name, arguments: promptArgs[name] });
      const allText = result.messages
        .map((m) => (typeof m.content === "object" && "text" in m.content ? (m.content.text as string) : ""))
        .join(" ");

      expect(allText, `prompt "${name}" must not request secrets or private credentials`).not.toMatch(
        /\b(?:wallet|hotkey|coldkey|mnemonic|seed phrase|private key|token|api key|password)\b/i,
      );
    }
  });
});
