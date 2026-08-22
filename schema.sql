-- Reference schema for agent-control-plane (D1 / SQLite).
-- Two tables: one spend window, one approval queue.

-- ── Spend window ────────────────────────────────────────────────────────────
-- One row per window. `date_string` is the window key; swap the format for a
-- monthly window ('%Y-%m') if your provider's ceiling is monthly.
--
-- TRAP: do NOT give hard_cap_usd a column DEFAULT and then rely on your code
-- constant as the source of truth. New rows will silently inherit the column
-- default, so lowering the constant changes nothing. Write it explicitly on
-- insert (see examples/worker.ts). The column is NOT NULL with no default here
-- deliberately — an omitted cap should be a loud error, not a quiet ceiling.
CREATE TABLE IF NOT EXISTS agent_spend_windows (
  date_string     TEXT PRIMARY KEY,
  total_spend_usd REAL    NOT NULL DEFAULT 0,
  hard_cap_usd    REAL    NOT NULL,
  call_count      INTEGER NOT NULL DEFAULT 0,
  kill_switch_hit INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ── Approval queue ──────────────────────────────────────────────────────────
-- Machine-generated items stage here as 'pending'. Publication reads
-- released_by; retraction flips status back without a redeploy.
CREATE TABLE IF NOT EXISTS agent_approval_queue (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  slug           TEXT    NOT NULL,
  payload        TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','released','rejected','retracted')),
  released_by    TEXT,
  released_at    TEXT,
  has_ad_disclosure          INTEGER NOT NULL DEFAULT 0,
  has_ai_disclosure          INTEGER NOT NULL DEFAULT 0,
  content_hash   TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_approval_queue_status
  ON agent_approval_queue (status, created_at DESC);

-- Prevents the same generated item being staged twice by a retried agent run.
-- Learn from my omission: without this, a duplicate-draft bug is invisible
-- until it is on the public site.
CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_queue_content_hash
  ON agent_approval_queue (content_hash)
  WHERE content_hash IS NOT NULL;
