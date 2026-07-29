PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_profiles (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE,
    account_name TEXT NOT NULL,
    niche TEXT NOT NULL,
    target_audience TEXT NOT NULL,
    primary_goal TEXT NOT NULL,
    voice TEXT NOT NULL,
    differentiators TEXT NOT NULL DEFAULT '[]',
    forbidden_topics TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS strategies (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    account_id TEXT NOT NULL REFERENCES account_profiles(id) ON DELETE CASCADE,
    positioning TEXT NOT NULL,
    persona TEXT NOT NULL,
    content_pillars TEXT NOT NULL,
    posting_rhythm TEXT NOT NULL,
    growth_plan TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'archived')),
    created_by_agent TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_strategies_user_created
ON strategies(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS topics (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    account_id TEXT NOT NULL REFERENCES account_profiles(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    angle TEXT NOT NULL,
    pillar TEXT NOT NULL,
    audience_need TEXT NOT NULL,
    hook TEXT NOT NULL,
    note_format TEXT NOT NULL CHECK (note_format IN ('image_text', 'video')),
    score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
    rationale TEXT NOT NULL,
    hashtags TEXT NOT NULL DEFAULT '[]',
    source_notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('idea', 'approved', 'rejected', 'drafting', 'ready')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_topics_user_status_created
ON topics(user_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS drafts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    account_id TEXT NOT NULL REFERENCES account_profiles(id) ON DELETE CASCADE,
    topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE RESTRICT,
    title TEXT NOT NULL,
    cover_text TEXT NOT NULL,
    body TEXT NOT NULL,
    hashtags TEXT NOT NULL DEFAULT '[]',
    image_prompts TEXT NOT NULL DEFAULT '[]',
    compliance_notes TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL CHECK (status IN ('draft', 'review', 'approved', 'published')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_drafts_user_status_created
ON drafts(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_drafts_topic ON drafts(topic_id);

CREATE TABLE IF NOT EXISTS activity_log (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    action TEXT NOT NULL,
    actor TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_user_created
ON activity_log(user_id, created_at DESC);

