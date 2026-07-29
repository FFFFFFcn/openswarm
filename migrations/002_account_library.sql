-- Account library: allow multiple Xiaohongshu accounts per user and add
-- profile fields captured from home-page screenshots.
-- The migration runner disables foreign_keys while executing migrations so
-- this rebuild does not cascade-delete strategies/topics/drafts.

CREATE TABLE account_profiles_new (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    account_name TEXT NOT NULL,
    niche TEXT NOT NULL,
    target_audience TEXT NOT NULL DEFAULT '',
    primary_goal TEXT NOT NULL DEFAULT '',
    voice TEXT NOT NULL DEFAULT '',
    differentiators TEXT NOT NULL DEFAULT '[]',
    forbidden_topics TEXT NOT NULL DEFAULT '[]',
    red_id TEXT NOT NULL DEFAULT '',
    follower_count INTEGER,
    notes_count INTEGER,
    intro TEXT NOT NULL DEFAULT '',
    profile_url TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'screenshot')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

INSERT INTO account_profiles_new
    (id, user_id, account_name, niche, target_audience, primary_goal,
     voice, differentiators, forbidden_topics, created_at, updated_at)
SELECT id, user_id, account_name, niche, target_audience, primary_goal,
       voice, differentiators, forbidden_topics, created_at, updated_at
FROM account_profiles;

DROP TABLE account_profiles;
ALTER TABLE account_profiles_new RENAME TO account_profiles;

CREATE INDEX IF NOT EXISTS idx_accounts_user_created
ON account_profiles(user_id, created_at DESC);
