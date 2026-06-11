import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { extname, join, normalize, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket, { WebSocketServer } from 'ws'
import { getSaveStats, listRecentChat, loadPlayerSave, saveChatMessage, savePlayer } from './db.mjs'
import { handleWorldEvent } from './events/index.mjs'

const host = process.env.WORLD_HOST ?? '127.0.0.1'
const port = Number(process.env.WORLD_PORT ?? 8787)
const serverId = process.env.WORLD_SERVER_ID ?? `${host}:${port}`
const peerUrls = (process.env.WORLD_PEERS ?? '').split(',').map((url) => url.trim()).filter(Boolean)
const colors = ['#2dd4bf', '#f59e0b', '#ef4444', '#8b5cf6', '#22c55e', '#38bdf8']
const serverRoot = fileURLToPath(new URL('.', import.meta.url))
const assetsRoot = join(serverRoot, 'assets')
const itemsRoot = join(serverRoot, 'items')

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `${host}:${port}`}`)

  if (url.pathname === '/health') {
    writeJson(response, {
      ok: true,
      serverId,
      players: sockets.size,
      peers: peers.size,
      assets: await listAssets(),
      items: await listItems(),
      saves: getSaveStats(),
    })
    return
  }

  if (url.pathname === '/assets') {
    writeJson(response, { assets: await listAssets() })
    return
  }

  if (url.pathname === '/items') {
    writeJson(response, { items: await listItems() })
    return
  }

  if (url.pathname.startsWith('/assets/')) {
    await serveAsset(url.pathname, response)
    return
  }

  response.writeHead(404, {
    'access-control-allow-origin': '*',
    'content-type': 'text/plain',
  })
  response.end('Not found')
})

function writeJson(response, payload) {
  response.writeHead(200, {
    'access-control-allow-origin': '*',
    'content-type': 'application/json',
  })
  response.end(JSON.stringify(payload))
}

async function listItems() {
  try {
    const entries = await readdir(itemsRoot, { withFileTypes: true })
    const itemFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    const items = await Promise.all(itemFiles.map((entry) => readItem(entry.name)))
    return items.filter(Boolean)
  } catch {
    return []
  }
}

async function readItem(filename) {
  try {
    const itemPath = normalize(join(itemsRoot, filename))
    const insideItems = relative(itemsRoot, itemPath)
    if (insideItems.startsWith('..') || insideItems === '' || insideItems.includes(':')) return null

    const item = JSON.parse(await readFile(itemPath, 'utf8'))
    return normalizeItem(item, filename)
  } catch {
    return null
  }
}

function normalizeItem(item, filename) {
  const id = sanitize(String(item.id || filename.replace(/\.json$/u, '')), 48)
  const name = sanitize(String(item.name || id), 64)
  const kind = sanitize(String(item.kind || 'loot'), 32)
  const color = /^#[0-9a-f]{6}$/iu.test(String(item.color)) ? String(item.color) : '#f59e0b'
  const position = item.position && typeof item.position === 'object' ? item.position : {}
  const scale = clamp(Number(item.scale ?? 1), 0.35, 3)

  return {
    id,
    name,
    kind,
    color,
    description: sanitize(String(item.description || ''), 140),
    asset: item.asset ? sanitize(String(item.asset), 80) : null,
    position: {
      x: clamp(Number(position.x ?? 0), -32, 32),
      z: clamp(Number(position.z ?? 0), -32, 32),
    },
    scale,
  }
}

async function serveAsset(pathname, response) {
  const assetName = decodeURIComponent(pathname.replace('/assets/', ''))
  const assetPath = normalize(join(assetsRoot, assetName))
  const insideAssets = relative(assetsRoot, assetPath)

  if (insideAssets.startsWith('..') || insideAssets === '' || insideAssets.includes(':')) {
    response.writeHead(403, { 'access-control-allow-origin': '*', 'content-type': 'text/plain' })
    response.end('Forbidden')
    return
  }

  try {
    const assetStat = await stat(assetPath)
    if (!assetStat.isFile()) throw new Error('Asset is not a file')
    response.writeHead(200, {
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=3600',
      'content-type': getContentType(assetPath),
    })
    createReadStream(assetPath).pipe(response)
  } catch {
    response.writeHead(404, { 'access-control-allow-origin': '*', 'content-type': 'text/plain' })
    response.end('Asset not found')
  }
}

async function listAssets() {
  try {
    const entries = await readdir(assetsRoot, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => ({
        name: entry.name,
        url: `/assets/${entry.name}`,
        type: getContentType(entry.name),
      }))
  } catch {
    return []
  }
}

function getContentType(filename) {
  const types = {
    '.avif': 'image/avif',
    '.gif': 'image/gif',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
  }

  return types[extname(filename).toLowerCase()] ?? 'application/octet-stream'
}

const wss = new WebSocketServer({ noServer: true })
const peerWss = new WebSocketServer({ noServer: true })
const sockets = new Map()
const peers = new Map()
const seenPeerEvents = new Set()
const chat = listRecentChat(50)
if (chat.length === 0) chat.push(
  { id: 'server-start', name: 'World', text: 'A fresh shard is waiting.', at: Date.now(), system: true },
)

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `${host}:${port}`}`)

  if (url.pathname === '/world') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request)
    })
    return
  }

  if (url.pathname === '/peer') {
    peerWss.handleUpgrade(request, socket, head, (ws) => {
      peerWss.emit('connection', ws, request)
    })
    return
  }

    socket.destroy()
})

peerWss.on('connection', (ws) => {
  registerPeer(ws, 'incoming-peer')
})

wss.on('connection', async (ws) => {
  const id = crypto.randomUUID()
  const player = {
    id,
    saveId: null,
    name: `Traveler-${id.slice(0, 4)}`,
    x: randomSpawn(),
    z: randomSpawn(),
    color: colors[sockets.size % colors.length],
  }
  sockets.set(ws, player)

  ws.on('message', (raw) => {
    const payload = readJson(raw.toString())
    if (!payload) return

    handleWorldEvent({
      player,
      pushChat,
      broadcastPlayers,
      clamp,
      loadPlayerSave,
      savePlayer,
      sanitize,
    }, payload)
  })

  ws.on('close', () => {
    const leaving = sockets.get(ws)
    sockets.delete(ws)
    if (leaving) {
      savePlayer(leaving)
      pushChat({ name: 'World', text: `${leaving.name} disconnected.`, system: true })
    }
    broadcastPlayers()
  })

  ws.send(JSON.stringify({
    type: 'welcome',
    id,
    players: listPlayers(),
    chat,
    assets: await listAssets(),
    items: await listItems(),
  }))
  broadcastPlayers()
})

server.listen(port, host, () => {
  console.log(`World WebSocket server listening on ws://${host}:${port}/world`)
  if (peerUrls.length > 0) {
    console.log(`Peer federation enabled for ${peerUrls.length} peer(s)`)
    connectToConfiguredPeers()
  }
})

function broadcastPlayers() {
  broadcast({ type: 'players', players: listPlayers() })
}

function listPlayers() {
  return [...sockets.values()].map(({ id, name, x, z, color }) => ({ id, name, x, z, color }))
}

function pushChat(message) {
  const next = { ...message, id: crypto.randomUUID(), at: Date.now(), serverId }
  chat.push(next)
  chat.splice(0, Math.max(0, chat.length - 50))
  saveChatMessage(next)
  broadcast({ type: 'chat', message: next })
  broadcastPeerChat(next)
}

function broadcast(payload) {
  const encoded = JSON.stringify(payload)
  for (const ws of sockets.keys()) {
    if (ws.readyState === ws.OPEN) ws.send(encoded)
  }
}

function connectToConfiguredPeers() {
  for (const peerUrl of peerUrls) connectToPeer(peerUrl)
}

function connectToPeer(peerUrl) {
  const ws = new WebSocket(peerUrl)
  ws.on('open', () => registerPeer(ws, peerUrl))
  ws.on('close', () => {
    peers.delete(ws)
    setTimeout(() => connectToPeer(peerUrl), 3000)
  })
  ws.on('error', () => {
    ws.close()
  })
}

function registerPeer(ws, label) {
  peers.set(ws, { id: label })
  sendPeer(ws, { type: 'peer-hello', serverId })

  ws.on('message', (raw) => {
    const payload = readJson(raw.toString())
    if (!payload) return
    handlePeerEvent(ws, payload)
  })

  ws.on('close', () => {
    peers.delete(ws)
  })
}

function handlePeerEvent(source, payload) {
  if (payload.type === 'peer-hello') {
    peers.set(source, { id: sanitize(String(payload.serverId || 'peer'), 64) })
    return
  }

  if (payload.type !== 'peer-chat' || !payload.message || !payload.eventId) return
  if (seenPeerEvents.has(payload.eventId)) return
  rememberPeerEvent(payload.eventId)

  const message = {
    ...payload.message,
    id: payload.message.id ?? crypto.randomUUID(),
    name: sanitize(String(payload.message.name || 'Peer'), 64),
    text: sanitize(String(payload.message.text || ''), 180),
    at: Number(payload.message.at) || Date.now(),
    serverId: sanitize(String(payload.message.serverId || payload.origin || 'peer'), 64),
  }

  if (!message.text) return
  chat.push(message)
  chat.splice(0, Math.max(0, chat.length - 50))
  saveChatMessage(message)
  broadcast({ type: 'chat', message })
  broadcastPeerChat(message, source, payload.eventId)
}

function broadcastPeerChat(message, exceptPeer, existingEventId) {
  const eventId = existingEventId ?? `${serverId}:${message.id}`
  rememberPeerEvent(eventId)
  const payload = { type: 'peer-chat', origin: serverId, eventId, message }
  for (const ws of peers.keys()) {
    if (ws !== exceptPeer) sendPeer(ws, payload)
  }
}

function sendPeer(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload))
}

function rememberPeerEvent(eventId) {
  seenPeerEvents.add(eventId)
  if (seenPeerEvents.size > 1000) {
    const [oldest] = seenPeerEvents
    seenPeerEvents.delete(oldest)
  }
}

function readJson(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function sanitize(value, maxLength) {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return 0
  return Math.min(max, Math.max(min, value))
}

function randomSpawn() {
  return Math.round((Math.random() * 20 - 10) * 10) / 10
}
