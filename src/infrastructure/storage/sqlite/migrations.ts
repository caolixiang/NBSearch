export interface SqlMigration {
  version: number
  name: string
  statements: string[]
}

export const SQLITE_MIGRATIONS: SqlMigration[] = [
  {
    version: 1,
    name: "init_chat_schema",
    statements: [
      `CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        session_id TEXT NOT NULL DEFAULT '',
        conversation_id TEXT NOT NULL DEFAULT '',
        last_response_id TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content_json TEXT NOT NULL,
        response_id TEXT NOT NULL DEFAULT '',
        previous_response_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'completed',
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
       ON messages(conversation_id, created_at)`,
      `CREATE TABLE IF NOT EXISTS voice_sessions (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        livekit_room TEXT NOT NULL DEFAULT '',
        request_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      )`,
      `CREATE INDEX IF NOT EXISTS idx_voice_sessions_conversation
       ON voice_sessions(conversation_id, started_at)`,
    ],
  },
  {
    version: 2,
    name: "add_conversation_has_deep_search_flag",
    statements: [
      `ALTER TABLE conversations
       ADD COLUMN has_deep_search INTEGER NOT NULL DEFAULT 0`,
    ],
  },
]
