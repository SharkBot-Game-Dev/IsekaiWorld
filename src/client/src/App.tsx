import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import * as THREE from 'three'
import './App.css'

type Player = {
  id: string
  name: string
  x: number
  z: number
  color: string
}

type ChatMessage = {
  id: string
  name: string
  text: string
  at: number
  system?: boolean
  serverId?: string
}

type ServerAsset = {
  name: string
  url: string
  type: string
}

type WorldItem = {
  id: string
  name: string
  kind: string
  color: string
  description: string
  asset: string | null
  position: {
    x: number
    z: number
  }
  scale: number
}

type ServerEvent =
  | {
      type: 'welcome'
      id: string
      players: Player[]
      chat: ChatMessage[]
      assets?: ServerAsset[]
      items?: WorldItem[]
    }
  | { type: 'players'; players: Player[] }
  | { type: 'chat'; message: ChatMessage }

const fallbackName = `Traveler-${Math.floor(100 + Math.random() * 900)}`
const defaultWorldSocketUrl = getWorldSocketUrl()
const saveId = getSaveId()

type AssetTextures = {
  grass?: THREE.Texture
  playerToken?: THREE.Texture
}

function makeChatId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function App() {
  const mountRef = useRef<HTMLDivElement | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const playerMeshes = useRef(new Map<string, THREE.Group>())
  const itemMeshes = useRef(new Map<string, THREE.Group>())
  const assetTextures = useRef<AssetTextures>({})
  const localPlayerId = useRef<string | null>(null)
  const desiredMove = useRef({ x: 0, z: 0 })
  const localPosition = useRef({ x: 0, z: 0 })
  const [name, setName] = useState(() => localStorage.getItem('isekai-name') ?? fallbackName)
  const [endpoint, setEndpoint] = useState(() => localStorage.getItem('isekai-endpoint') ?? defaultWorldSocketUrl)
  const [status, setStatus] = useState<'offline' | 'connecting' | 'online'>('offline')
  const [players, setPlayers] = useState<Player[]>([])
  const [serverAssets, setServerAssets] = useState<ServerAsset[]>([])
  const [items, setItems] = useState<WorldItem[]>([])
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'local-hello',
      name: 'World',
      text: 'Connect to the shard, move with WASD, and say hello.',
      at: Date.now(),
      system: true,
    },
  ])
  const [chatText, setChatText] = useState('')

  const connectedCount = useMemo(() => players.length, [players])

  useEffect(() => {
    localStorage.setItem('isekai-name', name)
  }, [name])

  useEffect(() => {
    localStorage.setItem('isekai-endpoint', endpoint)
  }, [endpoint])

  useEffect(() => {
    if (!mountRef.current) return

    const mount = mountRef.current
    const meshes = playerMeshes.current
    const worldItems = itemMeshes.current
    const textures = assetTextures.current
    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#bfe6ff')
    scene.fog = new THREE.Fog('#bfe6ff', 28, 72)

    const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 140)
    camera.position.set(18, 26, 18)
    camera.lookAt(0, 0, 0)

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    mount.appendChild(renderer.domElement)

    const hemi = new THREE.HemisphereLight('#f8fbff', '#5f7d56', 2.1)
    scene.add(hemi)

    const sun = new THREE.DirectionalLight('#fff2d5', 3.2)
    sun.position.set(-14, 28, 12)
    sun.castShadow = true
    sun.shadow.camera.left = -32
    sun.shadow.camera.right = 32
    sun.shadow.camera.top = 32
    sun.shadow.camera.bottom = -32
    scene.add(sun)

    const groundGeometry = new THREE.PlaneGeometry(84, 84, 96, 96)
    const groundPositions = groundGeometry.getAttribute('position')
    for (let index = 0; index < groundPositions.count; index += 1) {
      groundPositions.setZ(index, terrainHeight(groundPositions.getX(index), groundPositions.getY(index)))
    }
    groundGeometry.computeVertexNormals()

    const groundMaterial = new THREE.MeshStandardMaterial({ color: '#65a55b', roughness: 0.9 })
    const ground = new THREE.Mesh(
      groundGeometry,
      groundMaterial,
    )
    ground.rotation.x = -Math.PI / 2
    ground.receiveShadow = true
    scene.add(ground)

    const grid = new THREE.GridHelper(72, 24, '#2f6f4d', '#7fc179')
    grid.position.y = 0.06
    scene.add(grid)

    const water = new THREE.Mesh(
      new THREE.CircleGeometry(7.5, 48),
      new THREE.MeshStandardMaterial({ color: '#44b8d8', roughness: 0.25, metalness: 0.05 }),
    )
    water.rotation.x = -Math.PI / 2
    water.position.set(-18, -0.34, -16)
    scene.add(water)

    const trunkMaterial = new THREE.MeshStandardMaterial({ color: '#7c4a2d', roughness: 0.8 })
    const leafMaterials = [
      new THREE.MeshStandardMaterial({ color: '#1f8f4f', roughness: 0.7 }),
      new THREE.MeshStandardMaterial({ color: '#2d7f5d', roughness: 0.7 }),
    ]
    const treePositions = [
      [-27, -23], [-23, 18], [-16, 24], [-8, -27], [9, 25], [19, -24], [26, 14],
      [30, -8], [-30, 4], [13, -16], [-12, 13], [22, 27],
    ]

    treePositions.forEach(([x, z], index) => {
      const tree = new THREE.Group()
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.48, 2.4, 8), trunkMaterial)
      trunk.position.y = 1.2
      trunk.castShadow = true
      const leaves = new THREE.Mesh(new THREE.ConeGeometry(1.8, 3.4, 9), leafMaterials[index % 2])
      leaves.position.y = 3.2
      leaves.castShadow = true
      tree.add(trunk, leaves)
      tree.position.set(x, terrainHeight(x, z), z)
      scene.add(tree)
    })

    const rockMaterial = new THREE.MeshStandardMaterial({ color: '#64748b', roughness: 0.88 })
    const rockPositions = [[-21, -5], [-5, -18], [5, 15], [17, 6], [28, -18], [-29, 14]]
    rockPositions.forEach(([x, z], index) => {
      const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(1.1 + (index % 3) * 0.24, 0), rockMaterial)
      rock.position.set(x, terrainHeight(x, z) + 0.55, z)
      rock.rotation.set(index * 0.4, index * 0.7, index * 0.18)
      rock.scale.y = 0.62 + (index % 2) * 0.28
      rock.castShadow = true
      rock.receiveShadow = true
      scene.add(rock)
    })

    const building = new THREE.Group()
    const wall = new THREE.Mesh(
      new THREE.BoxGeometry(5.4, 2.8, 4.2),
      new THREE.MeshStandardMaterial({ color: '#d6b48a', roughness: 0.72 }),
    )
    wall.position.y = 1.4
    wall.castShadow = true
    wall.receiveShadow = true
    const roof = new THREE.Mesh(
      new THREE.ConeGeometry(4.2, 1.8, 4),
      new THREE.MeshStandardMaterial({ color: '#8b3a2e', roughness: 0.7 }),
    )
    roof.position.y = 3.25
    roof.rotation.y = Math.PI / 4
    roof.castShadow = true
    building.add(wall, roof)
    building.position.set(2, terrainHeight(2, -24), -24)
    scene.add(building)

    const marker = new THREE.Mesh(
      new THREE.RingGeometry(1.05, 1.22, 32),
      new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.85 }),
    )
    marker.rotation.x = -Math.PI / 2
    marker.position.y = 0.08
    scene.add(marker)

    const resize = () => {
      const rect = mount.getBoundingClientRect()
      renderer.setSize(rect.width, rect.height)
      camera.aspect = rect.width / rect.height
      camera.updateProjectionMatrix()
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(mount)

    let frame = 0
    const cameraOffset = new THREE.Vector3(18, 26, 18)
    const cameraTarget = new THREE.Vector3(0, 0, 0)
    const nextCameraPosition = new THREE.Vector3()
    const render = () => {
      frame = requestAnimationFrame(render)
      const localMesh = localPlayerId.current ? playerMeshes.current.get(localPlayerId.current) : null
      if (localMesh) {
        marker.position.x = localMesh.position.x
        marker.position.y = terrainHeight(localMesh.position.x, localMesh.position.z) + 0.08
        marker.position.z = localMesh.position.z
        cameraTarget.set(localMesh.position.x, localMesh.position.y + 0.8, localMesh.position.z)
        nextCameraPosition.copy(cameraTarget).add(cameraOffset)
        camera.position.lerp(nextCameraPosition, 0.08)
        camera.lookAt(cameraTarget)
      }
      water.material.color.offsetHSL(0, 0, Math.sin(performance.now() / 900) * 0.0008)
      renderer.render(scene, camera)
    }
    render()

    const sceneState = { scene, groundMaterial }
    ;(mount as HTMLDivElement & { sceneState?: typeof sceneState }).sceneState = sceneState

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      mount.removeChild(renderer.domElement)
      renderer.dispose()
      textures.grass?.dispose()
      textures.playerToken?.dispose()
      meshes.clear()
      worldItems.clear()
    }
  }, [])

  useEffect(() => {
    if (serverAssets.length === 0) return

    const mount = mountRef.current as (
      HTMLDivElement & { sceneState?: { scene: THREE.Scene; groundMaterial: THREE.MeshStandardMaterial } }
    ) | null
    const sceneState = mount?.sceneState
    if (!sceneState) return

    const loader = new THREE.TextureLoader()
    const grassAsset = serverAssets.find((asset) => asset.name === 'grass-tile.svg')
    const tokenAsset = serverAssets.find((asset) => asset.name === 'player-token.svg')

    if (grassAsset) {
      loader.load(grassAsset.url, (texture) => {
        texture.wrapS = THREE.RepeatWrapping
        texture.wrapT = THREE.RepeatWrapping
        texture.repeat.set(18, 18)
        assetTextures.current.grass?.dispose()
        assetTextures.current.grass = texture
        sceneState.groundMaterial.map = texture
        sceneState.groundMaterial.color.set('#ffffff')
        sceneState.groundMaterial.needsUpdate = true
      })
    }

    if (tokenAsset) {
      loader.load(tokenAsset.url, (texture) => {
        assetTextures.current.playerToken?.dispose()
        assetTextures.current.playerToken = texture
        for (const mesh of playerMeshes.current.values()) applyPlayerAssetTexture(mesh, texture)
        for (const mesh of itemMeshes.current.values()) applyItemTexture(mesh, texture)
      })
    }
  }, [serverAssets])

  useEffect(() => {
    const mount = mountRef.current as (HTMLDivElement & { sceneState?: { scene: THREE.Scene } }) | null
    const scene = mount?.sceneState?.scene
    if (!scene) return

    const knownIds = new Set(items.map((item) => item.id))
    for (const [id, mesh] of itemMeshes.current) {
      if (!knownIds.has(id)) {
        scene.remove(mesh)
        itemMeshes.current.delete(id)
      }
    }

    items.forEach((item) => {
      let mesh = itemMeshes.current.get(item.id)
      if (!mesh) {
        mesh = createItemMesh(item, assetTextures.current)
        itemMeshes.current.set(item.id, mesh)
        scene.add(mesh)
      }

      mesh.position.set(item.position.x, terrainHeight(item.position.x, item.position.z), item.position.z)
      mesh.scale.setScalar(item.scale)
      if (mesh.userData.name !== item.name) paintItemLabel(mesh, item.name)
    })
  }, [items])

  useEffect(() => {
    const keys = new Set<string>()
    const updateMove = () => {
      desiredMove.current = {
        x: (keys.has('d') ? 1 : 0) - (keys.has('a') ? 1 : 0),
        z: (keys.has('s') ? 1 : 0) - (keys.has('w') ? 1 : 0),
      }
    }
    const down = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) return
      keys.add(event.key.toLowerCase())
      updateMove()
    }
    const up = (event: KeyboardEvent) => {
      keys.delete(event.key.toLowerCase())
      updateMove()
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)

    const timer = window.setInterval(() => {
      const move = desiredMove.current
      if (!move.x && !move.z) return
      const length = Math.hypot(move.x, move.z) || 1
      localPosition.current.x = THREE.MathUtils.clamp(localPosition.current.x + (move.x / length) * 0.55, -32, 32)
      localPosition.current.z = THREE.MathUtils.clamp(localPosition.current.z + (move.z / length) * 0.55, -32, 32)
      send({ type: 'move', ...localPosition.current })
    }, 45)

    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    const mount = mountRef.current as (HTMLDivElement & { sceneState?: { scene: THREE.Scene } }) | null
    const scene = mount?.sceneState?.scene
    if (!scene) return

    const knownIds = new Set(players.map((player) => player.id))
    for (const [id, mesh] of playerMeshes.current) {
      if (!knownIds.has(id)) {
        scene.remove(mesh)
        playerMeshes.current.delete(id)
      }
    }

    players.forEach((player) => {
      let mesh = playerMeshes.current.get(player.id)
      if (!mesh) {
        mesh = createPlayerMesh(player, assetTextures.current)
        playerMeshes.current.set(player.id, mesh)
        scene.add(mesh)
      }
      mesh.position.lerp(new THREE.Vector3(player.x, terrainHeight(player.x, player.z), player.z), 0.42)
      if (mesh.userData.name !== player.name) paintPlayerLabel(mesh, player.name)
    })
  }, [players])

  function connect() {
    if (status !== 'offline') return
    setStatus('connecting')
    const socket = new WebSocket(endpoint)
    socketRef.current = socket

    socket.addEventListener('open', () => {
      setStatus('online')
      send({ type: 'join', name, saveId })
    })

    socket.addEventListener('message', (event) => {
      const payload = JSON.parse(event.data) as ServerEvent
      if (payload.type === 'welcome') {
        localPlayerId.current = payload.id
        const local = payload.players.find((player) => player.id === payload.id)
        if (local) localPosition.current = { x: local.x, z: local.z }
        setPlayers(payload.players)
        setMessages(payload.chat)
        setServerAssets(resolveServerAssets(endpoint, payload.assets ?? []))
        setItems(payload.items ?? [])
      }
      if (payload.type === 'players') setPlayers(payload.players)
      if (payload.type === 'chat') {
        setMessages((current) => [...current.slice(-49), payload.message])
      }
    })

    socket.addEventListener('close', () => {
      setStatus('offline')
      socketRef.current = null
      localPlayerId.current = null
      setPlayers([])
      setItems([])
      setServerAssets([])
      setMessages((current) => [
        ...current.slice(-49),
        { id: makeChatId(), name: 'World', text: 'Disconnected from the shard.', at: Date.now(), system: true },
      ])
    })

    socket.addEventListener('error', () => {
      socket.close()
    })
  }

  function disconnect() {
    socketRef.current?.close()
  }

  function send(payload: Record<string, unknown>) {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(payload))
    }
  }

  function submitChat(event: FormEvent) {
    event.preventDefault()
    const text = chatText.trim()
    if (!text) return
    send({ type: 'chat', text })
    setChatText('')
  }

  return (
    <main className="shell">
      <section className="world-panel" aria-label="Top down world">
        <div ref={mountRef} className="world-canvas" />
        <div className="world-hud">
          <div>
            <span className={`status-dot ${status}`} />
            <strong>{status === 'online' ? 'Shard online' : status === 'connecting' ? 'Connecting' : 'Offline'}</strong>
            <span>{connectedCount} online</span>
          </div>
          <div className="key-strip" aria-label="Movement keys">
            <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>
          </div>
        </div>
      </section>

      <aside className="side-panel" aria-label="Connection and chat">
        <header>
          <p className="eyebrow">Isekai World</p>
          <h1>Top-Down Shard</h1>
        </header>

        <label className="field">
          <span>Name</span>
          <input value={name} maxLength={24} onChange={(event) => setName(event.target.value)} />
        </label>

        <label className="field">
          <span>World Server</span>
          <input
            value={endpoint}
            disabled={status !== 'offline'}
            onChange={(event) => setEndpoint(event.target.value)}
          />
        </label>

        <div className="button-row">
          <button type="button" onClick={connect} disabled={status !== 'offline'}>
            Connect
          </button>
          <button type="button" className="secondary" onClick={disconnect} disabled={status === 'offline'}>
            Disconnect
          </button>
        </div>

        <p className="endpoint">Assets {serverAssets.length || 'waiting'} / Items {items.length || 'waiting'}</p>

        <section className="roster" aria-label="Connected players">
          {players.length === 0 ? (
            <p>No one is connected.</p>
          ) : (
            players.map((player) => (
              <div key={player.id} className="player-row">
                <span style={{ background: player.color }} />
                <strong>{player.name}</strong>
              </div>
            ))
          )}
        </section>

        <section className="chat-log" aria-label="Chat log">
          {messages.map((message) => (
            <article key={message.id} className={message.system ? 'system-message' : ''}>
              <strong>{message.name}</strong>
              <p>{message.text}</p>
            </article>
          ))}
        </section>

        <form className="chat-form" onSubmit={submitChat}>
          <input
            value={chatText}
            placeholder={status === 'online' ? 'Message the shard' : 'Connect to chat'}
            disabled={status !== 'online'}
            maxLength={180}
            onChange={(event) => setChatText(event.target.value)}
          />
          <button type="submit" disabled={status !== 'online' || !chatText.trim()}>
            Send
          </button>
        </form>
      </aside>
    </main>
  )
}

function createPlayerMesh(player: Player, textures: AssetTextures) {
  const group = new THREE.Group()
  const material = new THREE.MeshStandardMaterial({ color: player.color, roughness: 0.55 })
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.48, 1.05, 5, 12), material)
  body.position.y = 1
  body.castShadow = true

  const face = new THREE.Mesh(
    new THREE.SphereGeometry(0.2, 16, 16),
    new THREE.MeshStandardMaterial({ color: '#111827', roughness: 0.4 }),
  )
  face.position.set(0, 1.32, -0.42)

  const label = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthTest: false }))
  label.position.y = 2.25
  label.scale.set(3.6, 0.9, 1)
  group.userData.nameSprite = label
  paintPlayerLabel(group, player.name)

  const token = new THREE.Sprite(new THREE.SpriteMaterial({ color: player.color, transparent: true, opacity: 0.95 }))
  token.position.set(0, 1.15, 0)
  token.scale.set(1.5, 1.5, 1)
  group.userData.tokenSprite = token
  if (textures.playerToken) applyPlayerAssetTexture(group, textures.playerToken)

  group.add(body, face, token, label)
  group.position.set(player.x, terrainHeight(player.x, player.z), player.z)
  return group
}

function applyPlayerAssetTexture(group: THREE.Group, texture: THREE.Texture) {
  const token = group.userData.tokenSprite as THREE.Sprite | undefined
  if (!token) return
  const material = token.material as THREE.SpriteMaterial
  material.map = texture
  material.color.set('#ffffff')
  material.needsUpdate = true
}

function createItemMesh(item: WorldItem, textures: AssetTextures) {
  const group = new THREE.Group()
  const color = new THREE.Color(item.color)
  const baseMaterial = new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.08 })
  const core =
    item.kind === 'currency'
      ? new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.18, 32), baseMaterial)
      : new THREE.Mesh(new THREE.OctahedronGeometry(0.72, 0), baseMaterial)
  core.position.y = 0.85
  core.castShadow = true
  if (item.kind === 'currency') core.rotation.x = Math.PI / 2

  const halo = new THREE.Mesh(
    new THREE.RingGeometry(0.82, 1, 32),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5 }),
  )
  halo.rotation.x = -Math.PI / 2
  halo.position.y = 0.07

  const icon = new THREE.Sprite(new THREE.SpriteMaterial({ color, transparent: true, opacity: 0.9 }))
  icon.position.y = 1.65
  icon.scale.set(1, 1, 1)
  group.userData.itemSprite = icon
  if (item.asset && textures.playerToken) applyItemTexture(group, textures.playerToken)

  const label = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthTest: false }))
  label.position.y = 2.15
  label.scale.set(3.2, 0.75, 1)
  group.userData.nameSprite = label
  paintItemLabel(group, item.name)

  group.add(halo, core, icon, label)
  group.position.set(item.position.x, terrainHeight(item.position.x, item.position.z), item.position.z)
  group.scale.setScalar(item.scale)
  return group
}

function applyItemTexture(group: THREE.Group, texture: THREE.Texture) {
  const icon = group.userData.itemSprite as THREE.Sprite | undefined
  if (!icon) return
  const material = icon.material as THREE.SpriteMaterial
  material.map = texture
  material.color.set('#ffffff')
  material.needsUpdate = true
}

function paintItemLabel(group: THREE.Group, name: string) {
  const sprite = group.userData.nameSprite as THREE.Sprite
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 128
  const context = canvas.getContext('2d')
  if (!context) return

  context.fillStyle = 'rgba(31, 41, 55, 0.82)'
  roundRect(context, 38, 30, 436, 64, 18)
  context.fill()
  context.font = '700 32px system-ui, Segoe UI, sans-serif'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillStyle = '#fef3c7'
  context.fillText(name, 256, 62, 380)

  const material = sprite.material as THREE.SpriteMaterial
  material.map?.dispose()
  material.map = new THREE.CanvasTexture(canvas)
  material.needsUpdate = true
  group.userData.name = name
}

function paintPlayerLabel(group: THREE.Group, name: string) {
  const sprite = group.userData.nameSprite as THREE.Sprite
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 128
  const context = canvas.getContext('2d')
  if (!context) return

  context.fillStyle = 'rgba(15, 23, 42, 0.82)'
  roundRect(context, 24, 24, 464, 72, 24)
  context.fill()
  context.font = '600 38px system-ui, Segoe UI, sans-serif'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillStyle = '#ffffff'
  context.fillText(name, 256, 61, 410)

  const material = sprite.material as THREE.SpriteMaterial
  material.map?.dispose()
  material.map = new THREE.CanvasTexture(canvas)
  material.needsUpdate = true
  group.userData.name = name
}

function roundRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  context.beginPath()
  context.moveTo(x + radius, y)
  context.arcTo(x + width, y, x + width, y + height, radius)
  context.arcTo(x + width, y + height, x, y + height, radius)
  context.arcTo(x, y + height, x, y, radius)
  context.arcTo(x, y, x + width, y, radius)
  context.closePath()
}

function getWorldSocketUrl() {
  const configuredUrl = import.meta.env.VITE_WORLD_WS_URL as string | undefined
  if (configuredUrl) return configuredUrl

  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const hostname = window.location.hostname || '127.0.0.1'
  return `${protocol}://${hostname}:8787/world`
}

function getSaveId() {
  const existingId = localStorage.getItem('isekai-save-id')
  if (existingId) return existingId

  const nextId = crypto.randomUUID()
  localStorage.setItem('isekai-save-id', nextId)
  return nextId
}

function terrainHeight(x: number, z: number) {
  const broad = Math.sin(x * 0.11) * 0.7 + Math.cos(z * 0.1) * 0.55
  const ridges = Math.sin((x + z) * 0.18) * 0.32
  const lakeBasin = Math.max(0, 1 - Math.hypot(x + 18, z + 16) / 12) * -1.15
  return broad + ridges + lakeBasin
}

function resolveServerAssets(endpoint: string, assets: ServerAsset[]) {
  const base = new URL(endpoint)
  base.protocol = base.protocol === 'wss:' ? 'https:' : 'http:'
  base.pathname = '/'
  base.search = ''
  base.hash = ''

  return assets.map((asset) => ({
    ...asset,
    url: new URL(asset.url, base).toString(),
  }))
}

export default App
