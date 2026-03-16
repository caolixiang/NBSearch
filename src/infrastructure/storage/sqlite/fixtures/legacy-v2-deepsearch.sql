CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
  conversation_id TEXT NOT NULL DEFAULT '',
  last_response_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  has_deep_search INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content_json TEXT NOT NULL,
  response_id TEXT NOT NULL DEFAULT '',
  previous_response_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'completed',
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_messages_conversation_created
ON messages(conversation_id, created_at);

CREATE TABLE voice_sessions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  livekit_room TEXT NOT NULL DEFAULT '',
  request_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE INDEX idx_voice_sessions_conversation
ON voice_sessions(conversation_id, started_at);

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

INSERT INTO schema_migrations(version, name, applied_at)
VALUES (1, 'init_chat_schema', 1770000000000);

INSERT INTO schema_migrations(version, name, applied_at)
VALUES (2, 'add_conversation_has_deep_search_flag', 1771000000000);

INSERT INTO conversations(
  id,
  title,
  session_id,
  conversation_id,
  last_response_id,
  created_at,
  updated_at,
  has_deep_search
) VALUES
  (
    'conv_fixture_upgrade',
    '旧版本升级对话',
    'sess_fixture_upgrade',
    'conv_fixture_upgrade',
    'resp_fixture_upgrade',
    1770000002000,
    1770000003000,
    1
  );
