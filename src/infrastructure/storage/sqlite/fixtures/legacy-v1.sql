CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
  conversation_id TEXT NOT NULL DEFAULT '',
  last_response_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
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

INSERT INTO conversations(
  id,
  title,
  session_id,
  conversation_id,
  last_response_id,
  created_at,
  updated_at
) VALUES
  (
    'conv_fixture_older',
    '旧对话一',
    'sess_fixture_older',
    'conv_fixture_older',
    'resp_fixture_older',
    1770000000000,
    1770000001000
  ),
  (
    'conv_fixture_newer',
    '旧对话二',
    'sess_fixture_newer',
    'conv_fixture_newer',
    'resp_fixture_newer',
    1770000002000,
    1770000003000
  );
