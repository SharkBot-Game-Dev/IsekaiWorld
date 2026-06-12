import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { extname, join, normalize, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket, { WebSocketServer } from 'ws'
import {
  addInventoryItem,
  equipInventoryItem,
  getSaveStats,
  listInventory,
  listRecentChat,
  loadPlayerSave,
  saveChatMessage,
  savePlayer,
  useInventoryItem,
} from './db.mjs'
import { handleWorldEvent } from './events/index.mjs'

const host = process.env.WORLD_HOST ?? '127.0.0.1'
const port = Number(process.env.WORLD_PORT ?? 8787)
const serverId = process.env.WORLD_SERVER_ID ?? `${host}:${port}`
const peerUrls = (process.env.WORLD_PEERS ?? '').split(',').map((url) => url.trim()).filter(Boolean)
const colors = ['#2dd4bf', '#f59e0b', '#ef4444', '#8b5cf6', '#22c55e', '#38bdf8']
const serverRoot = fileURLToPath(new URL('.', import.meta.url))
const assetsRoot = join(serverRoot, 'assets')
const itemsRoot = join(serverRoot, 'items')
const worldsRoot = join(serverRoot, 'worlds')
const objectsRoot = join(serverRoot, 'objects')
const activeWorldId = process.env.WORLD_ID ?? 'default'

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
      objects: await listObjectDefinitions(),
      world: await readWorld(`${activeWorldId}.json`),
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

  if (url.pathname === '/objects') {
    writeJson(response, { objects: await listObjectDefinitions() })
    return
  }

  if (url.pathname.startsWith('/objects/')) {
    const objectName = decodeURIComponent(url.pathname.replace('/objects/', ''))
    const object = await readObjectDefinition(objectName.endsWith('.json') ? objectName : `${objectName}.json`)
    if (object) {
      writeJson(response, { object })
    } else {
      response.writeHead(404, { 'access-control-allow-origin': '*', 'content-type': 'text/plain' })
      response.end('Object not found')
    }
    return
  }

  if (url.pathname === '/worlds') {
    writeJson(response, { worlds: await listWorlds(), active: activeWorldId })
    return
  }

  if (url.pathname.startsWith('/worlds/')) {
    const worldName = decodeURIComponent(url.pathname.replace('/worlds/', ''))
    const world = await readWorld(worldName.endsWith('.json') ? worldName : `${worldName}.json`)
    if (world) {
      writeJson(response, { world })
    } else {
      response.writeHead(404, { 'access-control-allow-origin': '*', 'content-type': 'text/plain' })
      response.end('World not found')
    }
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

async function listWorlds() {
  try {
    const entries = await readdir(worldsRoot, { withFileTypes: true })
    const worldFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    const worlds = await Promise.all(worldFiles.map((entry) => readWorld(entry.name)))
    return worlds.filter(Boolean)
  } catch {
    return []
  }
}

async function listObjectDefinitions() {
  try {
    const entries = await readdir(objectsRoot, { withFileTypes: true })
    const objectFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    const objects = await Promise.all(objectFiles.map((entry) => readObjectDefinition(entry.name)))
    return objects.filter(Boolean)
  } catch {
    return []
  }
}

async function readObjectDefinition(filename) {
  try {
    const objectPath = normalize(join(objectsRoot, filename))
    const insideObjects = relative(objectsRoot, objectPath)
    if (insideObjects.startsWith('..') || insideObjects === '' || insideObjects.includes(':')) return null

    const object = JSON.parse(await readFile(objectPath, 'utf8'))
    return normalizeObjectDefinition(object, filename)
  } catch {
    return null
  }
}

async function getWorld(worldId = activeWorldId) {
  return await readWorld(`${worldId}.json`)
}

async function readWorld(filename) {
  try {
    const worldPath = normalize(join(worldsRoot, filename))
    const insideWorlds = relative(worldsRoot, worldPath)
    if (insideWorlds.startsWith('..') || insideWorlds === '' || insideWorlds.includes(':')) return null

    const world = JSON.parse(await readFile(worldPath, 'utf8'))
    return await normalizeWorld(world, filename)
  } catch {
    return null
  }
}

function normalizeObjectDefinition(object, filename) {
  const id = sanitize(String(object.id || filename.replace(/\.json$/u, '')), 48)
  const render = object.render && typeof object.render === 'object' ? object.render : {}
  const collision = object.collision && typeof object.collision === 'object' ? object.collision : {}
  const portal = object.portal && typeof object.portal === 'object' ? object.portal : null

  return {
    id,
    type: sanitize(String(object.type || id), 32),
    name: sanitize(String(object.name || id), 64),
    color: /^#[0-9a-f]{6}$/iu.test(String(object.color)) ? String(object.color) : null,
    render: {
      shape: sanitize(String(render.shape || object.type || id), 32),
      color: /^#[0-9a-f]{6}$/iu.test(String(render.color)) ? String(render.color) : null,
      parts: normalizeRenderParts(render.parts),
    },
    collision: {
      radius: clamp(Number(collision.radius ?? 0), 0, 12),
    },
    portal: portal ? normalizePortal(portal) : null,
  }
}

async function normalizeWorld(world, filename) {
  const id = sanitize(String(world.id || filename.replace(/\.json$/u, '')), 48)
  const name = sanitize(String(world.name || id), 64)
  const size = clamp(Number(world.size ?? 84), 24, 256)
  const bounds = world.bounds && typeof world.bounds === 'object' ? world.bounds : {}
  const spawn = world.spawn && typeof world.spawn === 'object' ? world.spawn : {}
  const objects = Array.isArray(world.objects) ? world.objects : []
  const normalizedObjects = await Promise.all(objects.map(normalizeWorldObject))

  return {
    id,
    name,
    size,
    bounds: {
      minX: clamp(Number(bounds.minX ?? -32), -128, 0),
      maxX: clamp(Number(bounds.maxX ?? 32), 0, 128),
      minZ: clamp(Number(bounds.minZ ?? -32), -128, 0),
      maxZ: clamp(Number(bounds.maxZ ?? 32), 0, 128),
    },
    spawn: {
      x: clamp(Number(spawn.x ?? 0), -32, 32),
      z: clamp(Number(spawn.z ?? 0), -32, 32),
    },
    objects: normalizedObjects.filter(Boolean),
  }
}

async function normalizeWorldObject(object, index) {
  if (!object || typeof object !== 'object') return null
  const objectRef = sanitize(String(object.object || object.type || ''), 48)
  const definition = objectRef ? await readObjectDefinition(`${objectRef}.json`) : null
  const position = object.position && typeof object.position === 'object' ? object.position : {}
  const collision = object.collision && typeof object.collision === 'object' ? object.collision : {}
  const render = object.render && typeof object.render === 'object' ? object.render : {}
  const portal = object.portal && typeof object.portal === 'object' ? object.portal : null
  const id = sanitize(String(object.id || `object-${index}`), 48)
  const type = sanitize(String(object.type || definition?.type || objectRef || 'rock'), 32)
  const color = /^#[0-9a-f]{6}$/iu.test(String(object.color))
    ? String(object.color)
    : definition?.color ?? null
  const renderShape = sanitize(String(render.shape || definition?.render?.shape || type), 32)
  const renderColor = /^#[0-9a-f]{6}$/iu.test(String(render.color))
    ? String(render.color)
    : definition?.render?.color ?? null
  const renderParts = Array.isArray(render.parts) ? normalizeRenderParts(render.parts) : definition?.render?.parts ?? []
  const normalizedPortal = portal ? normalizePortal(portal) : definition?.portal ?? null

  return {
    id,
    object: definition?.id ?? objectRef,
    type,
    name: sanitize(String(object.name || id), 64),
    color,
    render: {
      shape: renderShape,
      color: renderColor,
      parts: renderParts,
    },
    position: {
      x: clamp(Number(position.x ?? 0), -128, 128),
      z: clamp(Number(position.z ?? 0), -128, 128),
    },
    rotation: clamp(Number(object.rotation ?? 0), -Math.PI * 2, Math.PI * 2),
    scale: clamp(Number(object.scale ?? 1), 0.2, 8),
    collision: {
      radius: clamp(Number(collision.radius ?? definition?.collision?.radius ?? 0), 0, 12),
    },
    portal: normalizedPortal,
  }
}

function normalizeRenderParts(parts) {
  if (!Array.isArray(parts)) return []
  return parts.map(normalizeRenderPart).filter(Boolean)
}

function normalizeRenderPart(part, index) {
  if (!part || typeof part !== 'object') return null
  const position = part.position && typeof part.position === 'object' ? part.position : {}
  const rotation = part.rotation && typeof part.rotation === 'object' ? part.rotation : {}
  const scale = part.scale && typeof part.scale === 'object' ? part.scale : {}
  const size = part.size && typeof part.size === 'object' ? part.size : {}
  const material = part.material && typeof part.material === 'object' ? part.material : {}

  return {
    id: sanitize(String(part.id || `part-${index}`), 48),
    shape: sanitize(String(part.shape || 'box'), 32),
    color: /^#[0-9a-f]{6}$/iu.test(String(part.color)) ? String(part.color) : null,
    position: {
      x: clamp(Number(position.x ?? 0), -32, 32),
      y: clamp(Number(position.y ?? 0), -32, 32),
      z: clamp(Number(position.z ?? 0), -32, 32),
    },
    rotation: {
      x: clamp(Number(rotation.x ?? 0), -Math.PI * 2, Math.PI * 2),
      y: clamp(Number(rotation.y ?? 0), -Math.PI * 2, Math.PI * 2),
      z: clamp(Number(rotation.z ?? 0), -Math.PI * 2, Math.PI * 2),
    },
    scale: {
      x: clamp(Number(scale.x ?? 1), 0.05, 32),
      y: clamp(Number(scale.y ?? 1), 0.05, 32),
      z: clamp(Number(scale.z ?? 1), 0.05, 32),
    },
    size: {
      x: clamp(Number(size.x ?? 1), 0.05, 32),
      y: clamp(Number(size.y ?? 1), 0.05, 32),
      z: clamp(Number(size.z ?? 1), 0.05, 32),
      radius: clamp(Number(size.radius ?? 0.5), 0.05, 32),
      tube: clamp(Number(size.tube ?? 0.08), 0.01, 8),
      height: clamp(Number(size.height ?? 1), 0.05, 32),
      topRadius: clamp(Number(size.topRadius ?? size.radius ?? 0.5), 0, 32),
      bottomRadius: clamp(Number(size.bottomRadius ?? size.radius ?? 0.5), 0, 32),
    },
    material: {
      kind: sanitize(String(material.kind || 'standard'), 32),
      texture: material.texture ? sanitize(String(material.texture), 80) : null,
      textureRepeat: {
        x: clamp(Number(material.textureRepeat?.x ?? 1), 0.05, 64),
        y: clamp(Number(material.textureRepeat?.y ?? 1), 0.05, 64),
      },
      textureOffset: {
        x: clamp(Number(material.textureOffset?.x ?? 0), -64, 64),
        y: clamp(Number(material.textureOffset?.y ?? 0), -64, 64),
      },
      roughness: clamp(Number(material.roughness ?? 0.7), 0, 1),
      metalness: clamp(Number(material.metalness ?? 0), 0, 1),
      opacity: clamp(Number(material.opacity ?? 1), 0, 1),
      emissive: /^#[0-9a-f]{6}$/iu.test(String(material.emissive)) ? String(material.emissive) : null,
      emissiveIntensity: clamp(Number(material.emissiveIntensity ?? 0), 0, 4),
      transparent: Boolean(material.transparent || Number(material.opacity) < 1),
    },
    castShadow: part.castShadow !== false,
    receiveShadow: part.receiveShadow !== false,
    animate: sanitize(String(part.animate || ''), 32),
  }
}

function normalizePortal(portal) {
  const target = portal.target && typeof portal.target === 'object' ? portal.target : {}
  return {
    targetWorld: sanitize(String(portal.targetWorld || ''), 48),
    triggerRadius: clamp(Number(portal.triggerRadius ?? 2.2), 0.4, 12),
    target: {
      x: Number.isFinite(Number(target.x)) ? Number(target.x) : null,
      z: Number.isFinite(Number(target.z)) ? Number(target.z) : null,
    },
  }
}

function canMoveTo(world, x, z, playerRadius = 0.55) {
  if (!world) return true
  if (x < world.bounds.minX || x > world.bounds.maxX || z < world.bounds.minZ || z > world.bounds.maxZ) return false

  return !world.objects.some((object) => {
    const radius = Number(object.collision?.radius ?? 0)
    if (radius <= 0) return false
    const distance = Math.hypot(x - object.position.x, z - object.position.z)
    return distance < radius + playerRadius
  })
}

function findPortalAt(world, x, z) {
  if (!world) return null
  return world.objects.find((object) => {
    if (!object.portal?.targetWorld) return false
    const triggerRadius = Number(object.portal.triggerRadius ?? object.collision?.radius ?? 2.2)
    return Math.hypot(x - object.position.x, z - object.position.z) <= triggerRadius
  }) ?? null
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
const playersToSockets = new Map()
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
  const activeWorld = await getWorld(activeWorldId)
  const player = {
    id,
    saveId: null,
    worldId: activeWorld?.id ?? activeWorldId,
    name: `Traveler-${id.slice(0, 4)}`,
    x: randomSpawn(activeWorld?.spawn.x ?? 0),
    z: randomSpawn(activeWorld?.spawn.z ?? 0),
    color: colors[sockets.size % colors.length],
  }
  sockets.set(ws, player)
  playersToSockets.set(player, ws)

  ws.on('message', async (raw) => {
    const payload = readJson(raw.toString())
    if (!payload) return

    await handleWorldEvent({
      addInventoryItem,
      broadcastInventory,
      player,
      pushChat,
      broadcastPlayers,
      clamp,
      equipInventoryItem,
      getItemCatalog: listItems,
      getWorld,
      canMoveTo,
      findPortalAt,
      sendWorldState,
      loadPlayerSave,
      savePlayer,
      sanitize,
      useInventoryItem,
    }, payload)
  })

  ws.on('close', () => {
    const leaving = sockets.get(ws)
    sockets.delete(ws)
    if (leaving) playersToSockets.delete(leaving)
    if (leaving) {
      savePlayer(leaving)
      pushChat({ name: 'World', text: `${leaving.name} disconnected.`, system: true })
    }
    broadcastPlayers()
  })

  ws.send(JSON.stringify({
    type: 'welcome',
    id,
    players: listPlayers(player.worldId),
    chat,
    assets: await listAssets(),
    items: await listItems(),
    world: activeWorld,
    inventory: listInventory(player.saveId, await listItems()),
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
  for (const [ws, player] of sockets.entries()) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'players', players: listPlayers(player.worldId) }))
    }
  }
}

function listPlayers(worldId = activeWorldId) {
  return [...sockets.values()]
    .filter((player) => player.worldId === worldId)
    .map(({ id, name, x, z, color }) => ({ id, name, x, z, color }))
}

async function broadcastInventory(player) {
  const ws = playersToSockets.get(player)
  if (!ws || ws.readyState !== ws.OPEN) return
  ws.send(JSON.stringify({
    type: 'inventory',
    inventory: listInventory(player.saveId, await listItems()),
  }))
}

async function sendWorldState(player) {
  const ws = playersToSockets.get(player)
  if (!ws || ws.readyState !== ws.OPEN) return
  const world = await getWorld(player.worldId)
  ws.send(JSON.stringify({
    type: 'world',
    world,
    players: listPlayers(player.worldId),
    items: await listItems(),
  }))
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

function randomSpawn(center = 0) {
  return Math.round((center + Math.random() * 6 - 3) * 10) / 10
}
