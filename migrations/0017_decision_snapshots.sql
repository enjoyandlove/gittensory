-- #281: link each agent action back to the context snapshot that drove it
ALTER TABLE agent_actions ADD COLUMN decision_snapshot_id TEXT;

-- #282: provenance fields on context snapshots so decisions are replayable
ALTER TABLE agent_context_snapshots ADD COLUMN actor_login TEXT;
ALTER TABLE agent_context_snapshots ADD COLUMN decision_pack_generated_at TEXT;
ALTER TABLE agent_context_snapshots ADD COLUMN confidence_level TEXT;
ALTER TABLE agent_context_snapshots ADD COLUMN freshness_at_decision TEXT;
ALTER TABLE agent_context_snapshots ADD COLUMN upstream_ruleset_id TEXT;

-- #284: counterfactual reasoning attached to each action
ALTER TABLE agent_actions ADD COLUMN alternatives_considered_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE agent_actions ADD COLUMN counterfactual_reasons_json TEXT NOT NULL DEFAULT '[]';

-- Indexes for snapshot replay lookup (#285)
CREATE INDEX agent_actions_snapshot_idx ON agent_actions (decision_snapshot_id, created_at);
CREATE INDEX agent_context_snapshots_actor_idx ON agent_context_snapshots (actor_login, created_at);
