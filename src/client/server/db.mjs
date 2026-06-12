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

  CREATE TABLE IF NOT EXISTS inventory_items (
    save_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 0,
    equipped INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (save_id, item_id)
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

const listInventoryStatement = db.prepare(`
  SELECT item_id AS itemId, quantity, equipped
  FROM inventory_items
  WHERE save_id = ? AND quantity > 0
  ORDER BY equipped DESC, updated_at ASC
`)

const getInventoryItemStatement = db.prepare(`
  SELECT item_id AS itemId, quantity, equipped
  FROM inventory_items
  WHERE save_id = ? AND item_id = ?
`)

const addInventoryItemStatement = db.prepare(`
  INSERT INTO inventory_items (save_id, item_id, quantity, equipped, updated_at)
  VALUES (?, ?, ?, 0, ?)
  ON CONFLICT(save_id, item_id) DO UPDATE SET
    quantity = inventory_items.quantity + excluded.quantity,
    updated_at = excluded.updated_at
`)

const decrementInventoryItemStatement = db.prepare(`
  UPDATE inventory_items
  SET quantity = quantity - 1,
      equipped = CASE WHEN quantity - 1 <= 0 THEN 0 ELSE equipped END,
      updated_at = ?
  WHERE save_id = ? AND item_id = ? AND quantity > 0
`)

const clearEquippedStatement = db.prepare(`
  UPDATE inventory_items
  SET equipped = 0,
      updated_at = ?
  WHERE save_id = ?
`)

const equipInventoryItemStatement = db.prepare(`
  UPDATE inventory_items
  SET equipped = 1,
      updated_at = ?
  WHERE save_id = ? AND item_id = ? AND quantity > 0
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

export function listInventory(saveId, itemCatalog = []) {
  if (!saveId) return []
  const catalog = new Map(itemCatalog.map((item) => [item.id, item]))
  return listInventoryStatement.all(saveId).map((row) => ({
    ...catalog.get(row.itemId),
    id: row.itemId,
    quantity: Number(row.quantity),
    equipped: Boolean(row.equipped),
  }))
}

export function addInventoryItem(saveId, itemId, quantity = 1) {
  if (!saveId || !itemId) return
  addInventoryItemStatement.run(saveId, itemId, quantity, Date.now())
}

export function useInventoryItem(saveId, itemId) {
  if (!saveId || !itemId) return false
  const current = getInventoryItemStatement.get(saveId, itemId)
  if (!current || current.quantity <= 0) return false
  decrementInventoryItemStatement.run(Date.now(), saveId, itemId)
  return true
}

export function equipInventoryItem(saveId, itemId) {
  if (!saveId || !itemId) return false
  const current = getInventoryItemStatement.get(saveId, itemId)
  if (!current || current.quantity <= 0) return false
  const now = Date.now()
  clearEquippedStatement.run(now, saveId)
  equipInventoryItemStatement.run(now, saveId, itemId)
  return true
}

export function getSaveStats() {
  const players = db.prepare('SELECT COUNT(*) AS count FROM player_saves').get().count
  const messages = db.prepare('SELECT COUNT(*) AS count FROM chat_messages').get().count
  const inventory = db.prepare('SELECT COUNT(*) AS count FROM inventory_items WHERE quantity > 0').get().count
  return { dbPath, players, messages, inventory }
}
