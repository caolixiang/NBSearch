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
    name: "add_conversation_starred",
    statements: [
      `ALTER TABLE conversations
       ADD COLUMN starred INTEGER NOT NULL DEFAULT 0`,
    ],
  },
  {
    version: 4,
    name: "add_feed_subscription_tables",
    statements: [
      `CREATE TABLE IF NOT EXISTS feed_subscriptions (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL DEFAULT 0,
        poll_interval_minutes INTEGER NOT NULL DEFAULT 10,
        last_polled_at INTEGER,
        last_success_at INTEGER,
        last_error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS feed_items (
        id TEXT PRIMARY KEY,
        subscription_id TEXT NOT NULL,
        source TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        title TEXT NOT NULL,
        content_markdown TEXT NOT NULL,
        media_json TEXT NOT NULL DEFAULT '[]',
        canonical_url TEXT NOT NULL DEFAULT '',
        published_at INTEGER,
        discovered_at INTEGER NOT NULL,
        fetched_at INTEGER NOT NULL,
        UNIQUE(subscription_id, content_hash)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_feed_items_source_discovered
       ON feed_items(source, discovered_at DESC, id DESC)`,
    ],
  },
  {
    version: 5,
    name: "add_feed_item_translation_fields",
    statements: [
      `ALTER TABLE feed_items
       ADD COLUMN title_zh TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE feed_items
       ADD COLUMN content_markdown_zh TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE feed_items
       ADD COLUMN translation_status TEXT NOT NULL DEFAULT 'skipped'`,
      `ALTER TABLE feed_items
       ADD COLUMN translation_model TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE feed_items
       ADD COLUMN translated_at INTEGER`,
    ],
  },
  {
    version: 6,
    name: "reset_legacy_feed_items_for_gateway_schema",
    statements: [
      `DELETE FROM feed_items`,
      `UPDATE feed_subscriptions
       SET poll_interval_minutes = 30,
           last_polled_at = NULL,
           last_success_at = NULL,
           last_error = ''`,
    ],
  },
]
