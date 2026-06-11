import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const serverRoot = fileURLToPath(new URL('.', import.meta.url))
const dbPath = join(serverRoot, 'data', 'world.sqlite')

mkdirSync(dirname(dbPath), { recursive: true })

const db = new DatabaseSync(dbPath)
db.exec(`
  CREATE TABLE IF NOT EXISTS player_saves (
    save_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    x REAL NOT NULL,
    z REAL NOT NULL,
    color TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    text TEXT NOT NULL,
    server_id TEXT,
    system INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
`)

const loadPlayerStatement = db.prepare(`
  SELECT save_id, name, x, z, color, updated_at
  FROM player_saves
  WHERE save_id = ?
`)

const savePlayerStatement = db.prepare(`
  INSERT INTO player_saves (save_id, name, x, z, color, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(save_id) DO UPDATE SET
    name = excluded.name,
    x = excluded.x,
    z = excluded.z,
    color = excluded.color,
    updated_at = excluded.updated_at
`)

const saveChatStatement = db.prepare(`
  INSERT OR IGNORE INTO chat_messages (id, name, text, server_id, system, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
`)

const listRecentChatStatement = db.prepare(`
  SELECT id, name, text, server_id AS serverId, system, created_at AS at
  FROM chat_messages
  ORDER BY created_at DESC
  LIMIT ?
`)

export function loadPlayerSave(saveId) {
  if (!saveId) return null
  return loadPlayerStatement.get(saveId) ?? null
}

export function savePlayer(player) {
  if (!player.saveId) return
  savePlayerStatement.run(player.saveId, player.name, player.x, player.z, player.color, Date.now())
}

export function saveChatMessage(message) {
  saveChatStatement.run(
    message.id,
    message.name,
    message.text,
    message.serverId ?? null,
    message.system ? 1 : 0,
    message.at,
  )
}

export function listRecentChat(limit = 50) {
  return listRecentChatStatement
    .all(limit)
    .reverse()
    .map((message) => ({ ...message, system: Boolean(message.system) }))
}

export function getSaveStats() {
  const players = db.prepare('SELECT COUNT(*) AS count FROM player_saves').get().count
  const messages = db.prepare('SELECT COUNT(*) AS count FROM chat_messages').get().count
  return { dbPath, players, messages }
}
