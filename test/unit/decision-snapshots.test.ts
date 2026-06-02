import { describe, expect, it } from "vitest";
import { persistSignalSnapshot } from "../../src/db/repositories";
import {
  __agentOrchestratorInternals,
  planNextWork,
  type AgentRunBundle,
} from "../../src/services/agent-orchestrator";
import { CONTRIBUTOR_DECISION_PACK_SIGNAL, type ContributorDecisionPack } from "../../src/services/decision-pack";
import type { AgentActionRecord, AgentContextSnapshotRecord, JsonValue } from "../../src/types";
import { nowIso } from "../../src/utils/json";
import { createTestEnv } from "../helpers/d1";
import worker from "../../src/index";
import privateFixture from "../fixtures/decision-snapshots/private.json";
import publicSafeFixture from "../fixtures/decision-snapshots/public-safe.json";

// ---------------------------------------------------------------------------
// Minimal fixtures
// ---------------------------------------------------------------------------

async function persistDecisionPack(env: Env, pack: ContributorDecisionPack): Promise<void> {
  await persistSignalSnapshot(env, {
    id: crypto.randomUUID(),
    signalType: CONTRIBUTOR_DECISION_PACK_SIGNAL,
    targetKey: pack.login,
    payload: pack as unknown as Record<string, JsonValue>,
    generatedAt: pack.generatedAt,
  });
}

function minimalPack(overrides: Partial<ContributorDecisionPack> = {}): ContributorDecisionPack {
  const generatedAt = nowIso();
  return {
    status: "ready",
    source: "computed",
    login: "snap-tester",
    generatedAt,
    stale: false,
    freshness: "fresh",
    rebuildEnqueued: false,
    scoringModelSnapshotId: "model-snap-1",
    profile: {
      login: "snap-tester",
      source: "github_only",
      topLanguages: ["TypeScript"],
      publicRepos: 5,
      followers: 10,
      officialStats: null,
    },
    outcomeHistory: { login: "snap-tester", source: "unavailable", repoOutcomes: [] },
    roleContexts: [],
    opportunities: [],
    repoDecisions: [
      {
        repoFullName: "owner/alpha",
        recommendation: "pursue",
        priorityScore: 80,
        lane: { lane: "direct", reasons: [] },
        roleContext: { login: "snap-tester", role: "contributor", repoFullName: "owner/alpha", generatedAt, maintainerLane: false, normalContributorEvidenceAllowed: true, source: "contributor_match", reasons: [], guidance: "" },
        queue: { openIssues: 5, openPullRequests: 1, mergedPullRequests: 10, closedUnmergedPullRequests: 0 },
        rewardUpside: { emissionShare: 0.1, directPrShare: 0.3, issueDiscoveryShare: 0.05, maintainerCut: 0.1 },
        languageMatch: { matched: true, languages: ["TypeScript"], reason: "TypeScript match" },
        labelFit: [],
        scoreBlockers: [],
        riskReasons: [],
        whyThisHelps: ["Good lane fit."],
        nextActions: ["Pick a well-scoped issue and run preflight."],
        publicNextActions: ["Use Gittensory preflight before posting."],
        outcome: null,
      },
      {
        repoFullName: "owner/beta",
        recommendation: "cleanup_first",
        priorityScore: 40,
        lane: { lane: "direct", reasons: [] },
        roleContext: { login: "snap-tester", role: "contributor", repoFullName: "owner/beta", generatedAt, maintainerLane: false, normalContributorEvidenceAllowed: true, source: "contributor_match", reasons: [], guidance: "" },
        queue: { openIssues: 2, openPullRequests: 4, mergedPullRequests: 3, closedUnmergedPullRequests: 1 },
        rewardUpside: { emissionShare: 0.05, directPrShare: 0.2, issueDiscoveryShare: 0.02, maintainerCut: 0.1 },
        languageMatch: { matched: true, languages: ["TypeScript"], reason: "TypeScript match" },
        labelFit: [],
        scoreBlockers: [{ code: "open_pr_pressure", repoFullName: "owner/beta", severity: "critical", detail: "4 open PRs." }],
        riskReasons: ["4 open PRs create queue pressure."],
        whyThisHelps: [],
        nextActions: ["Close open PRs before adding new work."],
        publicNextActions: ["Resolve open PR pressure first."],
        outcome: null,
      },
    ],
    topActions: [
      {
        actionKind: "open_new_direct_pr",
        repoFullName: "owner/alpha",
        priorityScore: 80,
        recommendation: "pursue",
        whyThisHelps: ["Good lane fit."],
        nextActions: ["Pick a well-scoped issue and run preflight."],
        publicNextActions: ["Use Gittensory preflight before posting."],
      },
    ],
    cleanupFirst: [],
    pursueRepos: [],
    avoidRepos: [],
    maintainerLaneRepos: [],
    scoreBlockers: [],
    dataQuality: {
      signalFidelity: {
        status: "complete",
        partialRepos: [],
        cappedRepos: [],
        staleRepos: [],
        rateLimitedRepos: [],
      },
    },
    summary: "1 action recommended.",
    nextActions: ["Pick a well-scoped issue and run preflight."],
    ...overrides,
  } as ContributorDecisionPack;
}

// ---------------------------------------------------------------------------
// #281 — persist recommendation snapshot IDs
// ---------------------------------------------------------------------------

describe("#281 — decision snapshot IDs link actions to context", () => {
  it("every completed action carries a decisionSnapshotId matching the context snapshot", async () => {
    const env = createTestEnv();
    await persistDecisionPack(env, minimalPack());

    const bundle: AgentRunBundle = await planNextWork(env, { login: "snap-tester" });

    expect(bundle.contextSnapshots).toHaveLength(1);
    const snapshotId = bundle.contextSnapshots[0]!.id;
    expect(snapshotId).toBeTruthy();

    for (const action of bundle.actions) {
      expect(action.decisionSnapshotId).toBe(snapshotId);
    }
  });
});

// ---------------------------------------------------------------------------
// #282 — provenance fields on context snapshots
// ---------------------------------------------------------------------------

describe("#282 — decision snapshot provenance fields", () => {
  it("context snapshot carries actorLogin, decisionPackGeneratedAt, confidenceLevel, and freshnessAtDecision", async () => {
    const env = createTestEnv();
    const pack = minimalPack();
    await persistDecisionPack(env, pack);

    const bundle: AgentRunBundle = await planNextWork(env, { login: "snap-tester" });

    const ctx: AgentContextSnapshotRecord = bundle.contextSnapshots[0]!;
    expect(ctx.actorLogin).toBe("snap-tester");
    expect(ctx.decisionPackGeneratedAt).toBeTruthy();
    expect(["high", "medium", "low"]).toContain(ctx.confidenceLevel);
    expect(ctx.freshnessAtDecision).toBe("fresh");
  });

  it("context snapshot freshnessAtDecision reflects the served pack freshness", async () => {
    const env = createTestEnv();
    await persistDecisionPack(env, minimalPack());

    const bundle: AgentRunBundle = await planNextWork(env, { login: "snap-tester" });

    const ctx: AgentContextSnapshotRecord = bundle.contextSnapshots[0]!;
    // freshness is computed by the serving layer from snapshot age, not the stored flag
    expect(["fresh", "stale", "rebuilding", "missing"]).toContain(ctx.freshnessAtDecision);
  });
});

// ---------------------------------------------------------------------------
// #283 — public/private snapshot serialization fixtures
// ---------------------------------------------------------------------------

describe("#283 — public/private snapshot serialization boundaries", () => {
  it("private fixture actions contain decisionSnapshotId, alternativesConsidered, and counterfactualReasons", () => {
    const action = privateFixture.actions[0]!;
    expect(action.decisionSnapshotId).toBe(privateFixture.context.id);
    expect(Array.isArray(action.alternativesConsidered)).toBe(true);
    expect(Array.isArray(action.counterfactualReasons)).toBe(true);
  });

  it("private fixture actions contain private payload fields that must not reach public output", () => {
    const action = privateFixture.actions[0]!;
    expect(action.payload).toBeDefined();
    expect((action as { payload?: unknown }).payload).toHaveProperty("recommendationEvidence");
  });

  it("public-safe fixture omits all forbidden private fields", () => {
    const publicAction = publicSafeFixture.actions[0]!;
    const forbidden = publicSafeFixture.forbiddenInPublicOutput;
    for (const key of forbidden) {
      expect(publicAction).not.toHaveProperty(key);
    }
  });

  it("publicSafeSummary in private fixture does not contain forbidden reward language", () => {
    const action = privateFixture.actions[0]!;
    expect(action.publicSafeSummary).not.toMatch(/reward|wallet|hotkey|raw trust score|estimated score|farming/i);
  });

  it("live actions produced by the orchestrator also have clean publicSafeSummary", async () => {
    const env = createTestEnv();
    await persistDecisionPack(env, minimalPack());
    const bundle: AgentRunBundle = await planNextWork(env, { login: "snap-tester" });
    for (const action of bundle.actions) {
      expect(action.publicSafeSummary).not.toMatch(/reward|wallet|hotkey|raw trust score|estimated score|farming/i);
    }
  });
});

// ---------------------------------------------------------------------------
// #284 — counterfactual reasons
// ---------------------------------------------------------------------------

describe("#284 — counterfactual reasons on actions", () => {
  it("actions include alternativesConsidered listing other repos from the decision pack", async () => {
    const env = createTestEnv();
    await persistDecisionPack(env, minimalPack());
    const bundle: AgentRunBundle = await planNextWork(env, { login: "snap-tester" });

    const alphaAction = bundle.actions.find((a) => a.targetRepoFullName === "owner/alpha");
    expect(alphaAction).toBeDefined();
    expect((alphaAction!.alternativesConsidered ?? []).some((alt) => alt.includes("owner/beta"))).toBe(true);
  });

  it("actions with open_pr_pressure blocker include a counterfactualReason about resolving queue pressure", async () => {
    const env = createTestEnv();
    const pack = minimalPack({ topActions: [], repoDecisions: [minimalPack().repoDecisions[1]!] });
    await persistDecisionPack(env, pack);
    const bundle: AgentRunBundle = await planNextWork(env, { login: "snap-tester", repoFullName: "owner/beta" });

    const action = bundle.actions.find((a) => a.targetRepoFullName === "owner/beta");
    expect(action).toBeDefined();
    expect((action!.counterfactualReasons ?? []).some((r) => /open_pr_pressure|queue/i.test(r))).toBe(true);
  });

  it("buildCounterfactualReasons helper generates flip reasons from blockers", () => {
    const decision = minimalPack().repoDecisions[1]!;
    const reasons = __agentOrchestratorInternals.buildCounterfactualReasons(decision);
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.some((r) => /open_pr_pressure/i.test(r))).toBe(true);
  });

  it("buildAlternativesConsidered helper returns other repos from the pack", () => {
    const pack = minimalPack();
    const alternatives = __agentOrchestratorInternals.buildAlternativesConsidered(pack.repoDecisions[0]!, pack);
    expect(alternatives.some((a) => a.includes("owner/beta"))).toBe(true);
  });

  it("buildAlternativesConsidered returns empty array when no pack provided", () => {
    const decision = minimalPack().repoDecisions[0]!;
    expect(__agentOrchestratorInternals.buildAlternativesConsidered(decision, undefined)).toEqual([]);
  });

  it("buildCounterfactualReasons includes avoid_for_now risk factor flip when riskReasons present", () => {
    const decision = {
      ...minimalPack().repoDecisions[0]!,
      recommendation: "avoid_for_now" as const,
      riskReasons: ["Closed PR rate is high."],
      scoreBlockers: [],
    };
    const reasons = __agentOrchestratorInternals.buildCounterfactualReasons(decision);
    expect(reasons.some((r) => /risk factors resolve/i.test(r))).toBe(true);
  });

  it("buildCounterfactualReasons is empty for pursue with no blockers", () => {
    const decision = {
      ...minimalPack().repoDecisions[0]!,
      recommendation: "pursue" as const,
      scoreBlockers: [],
      riskReasons: [],
    };
    expect(__agentOrchestratorInternals.buildCounterfactualReasons(decision)).toEqual([]);
  });

  it("buildCounterfactualReasons skips risk line for avoid_for_now with empty riskReasons", () => {
    const decision = {
      ...minimalPack().repoDecisions[0]!,
      recommendation: "avoid_for_now" as const,
      scoreBlockers: [],
      riskReasons: [],
    };
    const reasons = __agentOrchestratorInternals.buildCounterfactualReasons(decision);
    expect(reasons.every((r) => !/risk factors resolve/i.test(r))).toBe(true);
  });

  it("contextSnapshotFromPack with empty decisions defaults confidence to medium", () => {
    const pack = minimalPack();
    const snapshot = __agentOrchestratorInternals.contextSnapshotFromPack("run-empty", "snap-tester", pack, []);
    expect(snapshot.confidenceLevel).toBe("medium");
    expect(snapshot.actorLogin).toBe("snap-tester");
    expect((snapshot.payload.selectedRepos as string[])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// #285 — GET /v1/agent/snapshots/:snapshotId replay endpoint
// ---------------------------------------------------------------------------

describe("#285 — decision snapshot replay endpoint", () => {
  it("returns 404 for an unknown snapshotId", async () => {
    const env = createTestEnv();
    const res = await worker.fetch(
      new Request("https://gittensory.test/v1/agent/snapshots/nonexistent-snap-id", {
        headers: { authorization: `Bearer ${env.GITTENSORY_API_TOKEN}` },
      }),
      env,
    );
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("decision_snapshot_not_found");
  });

  it("returns 200 with replay payload for a known snapshot", async () => {
    const env = createTestEnv();
    await persistDecisionPack(env, minimalPack());
    const bundle: AgentRunBundle = await planNextWork(env, { login: "snap-tester" });
    const snapshotId = bundle.contextSnapshots[0]!.id;

    const res = await worker.fetch(
      new Request(`https://gittensory.test/v1/agent/snapshots/${snapshotId}`, {
        headers: { authorization: `Bearer ${env.GITTENSORY_API_TOKEN}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const replay = await res.json() as { snapshotId: string; context: { id: string }; actions: { decisionSnapshotId: string }[]; run: { id: string } };
    expect(replay.snapshotId).toBe(snapshotId);
    expect(replay.context.id).toBe(snapshotId);
    expect(replay.run.id).toBe(bundle.run.id);
    expect(replay.actions.every((a) => a.decisionSnapshotId === snapshotId)).toBe(true);
  });
});

describe("actionRecord optional fields", () => {
  it("actionRecord omitting optional snapshot fields produces empty arrays", () => {
    const run = __agentOrchestratorInternals.buildRunRecord({
      objective: "test",
      actorLogin: "snap-tester",
      surface: "api",
      status: "running",
      payload: {},
    });
    const action = __agentOrchestratorInternals.actionRecord({
      run,
      actionType: "choose_next_work",
      index: 0,
      status: "recommended",
      recommendation: "Pick work.",
      why: [],
      blockedBy: [],
      publicSafeSummary: "Use preflight.",
      payload: {},
    });
    expect(action.alternativesConsidered).toEqual([]);
    expect(action.counterfactualReasons).toEqual([]);
    expect(action.decisionSnapshotId).toBeUndefined();
  });
});
