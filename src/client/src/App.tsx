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

type InventoryItem = WorldItem & {
  quantity: number
  equipped: boolean
}

type WorldObject = {
  id: string
  object: string
  type: 'tree' | 'rock' | 'building' | 'water' | string
  name: string
  color: string | null
  render: {
    shape: string
    color: string | null
    parts: RenderPart[]
  }
  position: {
    x: number
    z: number
  }
  rotation: number
  scale: number
  collision: {
    radius: number
  }
  portal: {
    targetWorld: string
    triggerRadius: number
    target: {
      x: number | null
      z: number | null
    }
  } | null
}

type RenderPart = {
  id: string
  shape: string
  color: string | null
  position: {
    x: number
    y: number
    z: number
  }
  rotation: {
    x: number
    y: number
    z: number
  }
  scale: {
    x: number
    y: number
    z: number
  }
  size: {
    x: number
    y: number
    z: number
    radius: number
    tube: number
    height: number
    topRadius: number
    bottomRadius: number
  }
  material: {
    kind: string
    texture: string | null
    textureRepeat: {
      x: number
      y: number
    }
    textureOffset: {
      x: number
      y: number
    }
    roughness: number
    metalness: number
    opacity: number
    emissive: string | null
    emissiveIntensity: number
    transparent: boolean
  }
  castShadow: boolean
  receiveShadow: boolean
  animate: string
}

type WorldData = {
  id: string
  name: string
  size: number
  bounds: {
    minX: number
    maxX: number
    minZ: number
    maxZ: number
  }
  spawn: {
    x: number
    z: number
  }
  objects: WorldObject[]
}

type ServerEvent =
  | {
      type: 'welcome'
      id: string
      players: Player[]
      chat: ChatMessage[]
      assets?: ServerAsset[]
      items?: WorldItem[]
      inventory?: InventoryItem[]
      world?: WorldData | null
    }
  | { type: 'players'; players: Player[] }
  | { type: 'chat'; message: ChatMessage }
  | { type: 'inventory'; inventory: InventoryItem[] }
  | { type: 'world'; world: WorldData | null; players: Player[]; items?: WorldItem[] }

const fallbackName = `Traveler-${Math.floor(100 + Math.random() * 900)}`
const defaultWorldSocketUrl = getWorldSocketUrl()
const saveId = getSaveId()

type AssetTextures = {
  grass?: THREE.Texture
  playerToken?: THREE.Texture
  assets: Map<string, THREE.Texture>
}

function makeChatId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function App() {
  const mountRef = useRef<HTMLDivElement | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const playerMeshes = useRef(new Map<string, THREE.Group>())
  const itemMeshes = useRef(new Map<string, THREE.Group>())
  const objectMeshes = useRef(new Map<string, THREE.Group>())
  const assetTextures = useRef<AssetTextures>({ assets: new Map() })
  const localPlayerId = useRef<string | null>(null)
  const handMesh = useRef<THREE.Group | null>(null)
  const nearbyItemId = useRef<string | null>(null)
  const worldColliders = useRef<WorldObject[]>([])
  const worldBounds = useRef({ minX: -32, maxX: 32, minZ: -32, maxZ: 32 })
  const desiredMove = useRef({ x: 0, z: 0 })
  const isRunning = useRef(false)
  const jumpState = useRef({ height: 0, velocity: 0, grounded: true })
  const lookAngles = useRef({ yaw: Math.PI, pitch: 0 })
  const localPosition = useRef({ x: 0, z: 0 })
  const [name, setName] = useState(() => localStorage.getItem('isekai-name') ?? fallbackName)
  const [endpoint, setEndpoint] = useState(() => localStorage.getItem('isekai-endpoint') ?? defaultWorldSocketUrl)
  const [status, setStatus] = useState<'offline' | 'connecting' | 'online'>('offline')
  const [players, setPlayers] = useState<Player[]>([])
  const [serverAssets, setServerAssets] = useState<ServerAsset[]>([])
  const [items, setItems] = useState<WorldItem[]>([])
  const [inventory, setInventory] = useState<InventoryItem[]>([])
  const [world, setWorld] = useState<WorldData | null>(null)
  const [currentPosition, setCurrentPosition] = useState({ x: 0, z: 0 })
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
  const latestMessages = useMemo(() => messages.slice(-6), [messages])
  const visibleItems = useMemo(() => {
    const ownedItemIds = new Set(inventory.map((item) => item.id))
    return items.filter((item) => !ownedItemIds.has(item.id))
  }, [inventory, items])
  const equippedItem = useMemo(() => inventory.find((item) => item.equipped) ?? inventory[0] ?? null, [inventory])
  const itemSlots = useMemo(() => {
    const slots: Array<InventoryItem | null> = [...inventory.slice(0, 6)]
    while (slots.length < 6) slots.push(null)
    return slots
  }, [inventory])
  const nearbyItem = useMemo(() => {
    return visibleItems
      .map((item) => ({
        item,
        distance: Math.hypot(item.position.x - currentPosition.x, item.position.z - currentPosition.z),
      }))
      .filter(({ distance }) => distance <= 4)
      .sort((left, right) => left.distance - right.distance)[0]?.item ?? null
  }, [currentPosition, visibleItems])

  useEffect(() => {
    nearbyItemId.current = nearbyItem?.id ?? null
  }, [nearbyItem])

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
    const worldObjects = objectMeshes.current
    const textures = assetTextures.current
    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#bfe6ff')
    scene.fog = new THREE.Fog('#bfe6ff', 28, 72)

    const camera = new THREE.PerspectiveCamera(72, 1, 0.08, 140)
    camera.position.set(0, 2.1, 0)
    camera.lookAt(0, 0, 0)
    scene.add(camera)

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

    const marker = new THREE.Mesh(
      new THREE.RingGeometry(1.05, 1.22, 32),
      new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.85 }),
    )
    marker.rotation.x = -Math.PI / 2
    marker.position.y = 0.08
    marker.visible = false
    scene.add(marker)

    const hands = createHandMesh()
    handMesh.current = hands
    camera.add(hands)

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
    const lookDirection = new THREE.Vector3(0, 0, -1)
    const cameraTarget = new THREE.Vector3(0, 0, 0)
    const eyePosition = new THREE.Vector3()
    const render = () => {
      frame = requestAnimationFrame(render)
      const localMesh = localPlayerId.current ? playerMeshes.current.get(localPlayerId.current) : null
      if (localMesh) {
        localMesh.visible = false
        marker.position.x = localMesh.position.x
        marker.position.y = terrainHeight(localMesh.position.x, localMesh.position.z) + 0.08
        marker.position.z = localMesh.position.z
        eyePosition.set(localMesh.position.x, localMesh.position.y + 1.45 + jumpState.current.height, localMesh.position.z)
        camera.position.lerp(eyePosition, 0.35)
        if (handMesh.current) {
          handMesh.current.position.y = -0.46 - jumpState.current.height * 0.08
        }
        lookDirection.set(
          Math.sin(lookAngles.current.yaw) * Math.cos(lookAngles.current.pitch),
          Math.sin(lookAngles.current.pitch),
          Math.cos(lookAngles.current.yaw) * Math.cos(lookAngles.current.pitch),
        )
        cameraTarget.copy(camera.position).addScaledVector(lookDirection, 10)
        camera.lookAt(cameraTarget)
      }
      animateWorldObjects(objectMeshes.current)
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
      textures.assets.forEach((texture) => texture.dispose())
      textures.assets.clear()
      meshes.clear()
      worldItems.clear()
      worldObjects.clear()
      handMesh.current = null
    }
  }, [])

  useEffect(() => {
    if (!handMesh.current) return
    paintHandItem(handMesh.current, equippedItem)
  }, [equippedItem])

  useEffect(() => {
    worldColliders.current = world?.objects.filter((object) => object.collision.radius > 0) ?? []
    worldBounds.current = world?.bounds ?? { minX: -32, maxX: 32, minZ: -32, maxZ: 32 }
  }, [world])

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const requestLookControl = () => {
      mount.requestPointerLock?.()
    }

    const updateLook = (event: MouseEvent) => {
      if (document.pointerLockElement !== mount) return
      lookAngles.current.yaw -= event.movementX * 0.0024
      lookAngles.current.pitch = THREE.MathUtils.clamp(
        lookAngles.current.pitch - event.movementY * 0.002,
        -1.05,
        0.85,
      )
    }

    mount.addEventListener('click', requestLookControl)
    window.addEventListener('mousemove', updateLook)

    return () => {
      mount.removeEventListener('click', requestLookControl)
      window.removeEventListener('mousemove', updateLook)
      if (document.pointerLockElement === mount) document.exitPointerLock()
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
    serverAssets.forEach((asset) => {
      loader.load(asset.url, (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace
        assetTextures.current.assets.get(asset.name)?.dispose()
        assetTextures.current.assets.set(asset.name, texture)
        applyObjectTextures(objectMeshes.current, assetTextures.current.assets)
      })
    })

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

    if (!world) {
      for (const mesh of objectMeshes.current.values()) {
        scene.remove(mesh)
        disposeObject3D(mesh)
      }
      objectMeshes.current.clear()
      return
    }

    const knownIds = new Set(world.objects.map((object) => object.id))
    for (const [id, mesh] of objectMeshes.current) {
      if (!knownIds.has(id)) {
        scene.remove(mesh)
        disposeObject3D(mesh)
        objectMeshes.current.delete(id)
      }
    }

    world.objects.forEach((object, index) => {
      let mesh = objectMeshes.current.get(object.id)
      if (!mesh || mesh.userData.type !== object.type) {
        if (mesh) {
          scene.remove(mesh)
          disposeObject3D(mesh)
        }
        mesh = createWorldObjectMesh(object, index, assetTextures.current.assets)
        objectMeshes.current.set(object.id, mesh)
        scene.add(mesh)
      }

      mesh.position.set(object.position.x, terrainHeight(object.position.x, object.position.z), object.position.z)
      mesh.rotation.y = object.rotation
      mesh.scale.setScalar(object.scale)
    })
  }, [world])

  useEffect(() => {
    const mount = mountRef.current as (HTMLDivElement & { sceneState?: { scene: THREE.Scene } }) | null
    const scene = mount?.sceneState?.scene
    if (!scene) return

    const knownIds = new Set(visibleItems.map((item) => item.id))
    for (const [id, mesh] of itemMeshes.current) {
      if (!knownIds.has(id)) {
        scene.remove(mesh)
        itemMeshes.current.delete(id)
      }
    }

    visibleItems.forEach((item) => {
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
  }, [visibleItems])

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
      const key = event.key.toLowerCase()
      if (key === ' ' || key === 'shift') event.preventDefault()
      if (key === 'e') {
        const itemId = nearbyItemId.current
        if (itemId) send({ type: 'pickup', itemId })
      }
      if (key === 'shift') {
        isRunning.current = true
      } else if (key === ' ' && jumpState.current.grounded) {
        jumpState.current.velocity = 0.42
        jumpState.current.grounded = false
      } else {
        keys.add(key)
      }
      updateMove()
    }
    const up = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()
      if (key === 'shift') {
        isRunning.current = false
      } else {
        keys.delete(key)
      }
      updateMove()
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)

    const timer = window.setInterval(() => {
      const jump = jumpState.current
      if (!jump.grounded || jump.height > 0) {
        jump.height = Math.max(0, jump.height + jump.velocity)
        jump.velocity -= 0.055
        if (jump.height === 0 && jump.velocity <= 0) {
          jump.velocity = 0
          jump.grounded = true
        }
      }

      const move = desiredMove.current
      if (!move.x && !move.z) return
      const length = Math.hypot(move.x, move.z) || 1
      const yaw = lookAngles.current.yaw
      const forward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw))
      const right = new THREE.Vector3(-Math.cos(yaw), 0, Math.sin(yaw))
      const direction = forward.multiplyScalar(-move.z / length).add(right.multiplyScalar(move.x / length)).normalize()
      const bounds = worldBounds.current
      const speed = isRunning.current ? 0.92 : 0.55
      const nextX = THREE.MathUtils.clamp(localPosition.current.x + direction.x * speed, bounds.minX, bounds.maxX)
      const nextZ = THREE.MathUtils.clamp(localPosition.current.z + direction.z * speed, bounds.minZ, bounds.maxZ)

      if (canMoveTo(nextX, nextZ, worldColliders.current)) {
        localPosition.current.x = nextX
        localPosition.current.z = nextZ
      } else {
        if (canMoveTo(nextX, localPosition.current.z, worldColliders.current)) localPosition.current.x = nextX
        if (canMoveTo(localPosition.current.x, nextZ, worldColliders.current)) localPosition.current.z = nextZ
      }
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
      mesh.visible = player.id !== localPlayerId.current
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
        if (local) {
          localPosition.current = { x: local.x, z: local.z }
          setCurrentPosition(localPosition.current)
        }
        setPlayers(payload.players)
        setMessages(payload.chat)
        setServerAssets(resolveServerAssets(endpoint, payload.assets ?? []))
        setItems(payload.items ?? [])
        setInventory(payload.inventory ?? [])
        setWorld(payload.world ?? null)
      }
      if (payload.type === 'players') {
        const local = payload.players.find((player) => player.id === localPlayerId.current)
        if (local) {
          localPosition.current = { x: local.x, z: local.z }
          setCurrentPosition(localPosition.current)
        }
        setPlayers(payload.players)
      }
      if (payload.type === 'chat') {
        setMessages((current) => [...current.slice(-49), payload.message])
      }
      if (payload.type === 'inventory') {
        setInventory(payload.inventory)
      }
      if (payload.type === 'world') {
        setWorld(payload.world ?? null)
        setPlayers(payload.players)
        setItems(payload.items ?? [])
        const local = payload.players.find((player) => player.id === localPlayerId.current)
        if (local) {
          localPosition.current = { x: local.x, z: local.z }
          setCurrentPosition(localPosition.current)
        }
      }
    })

    socket.addEventListener('close', () => {
      setStatus('offline')
      socketRef.current = null
      localPlayerId.current = null
      setPlayers([])
      setItems([])
      setInventory([])
      setWorld(null)
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

  function equipItem(itemId: string) {
    send({ type: 'equip', itemId })
  }

  return (
    <main className="shell">
      <section className="world-panel" aria-label="First person world">
        <div ref={mountRef} className="world-canvas" />
        <div className="world-hud">
          <div>
            <span className={`status-dot ${status}`} />
            <strong>{status === 'online' ? 'Shard online' : status === 'connecting' ? 'Connecting' : 'Offline'}</strong>
            <span>{connectedCount} online</span>
          </div>
          <div className="key-strip" aria-label="Movement keys">
            <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd><kbd>Shift</kbd><kbd>Space</kbd>
          </div>
        </div>
        <div className="world-roster" aria-label="Connected players">
          {players.length === 0 ? (
            <span>No players</span>
          ) : (
            players.slice(0, 5).map((player) => (
              <span key={player.id} className="world-player">
                <i style={{ background: player.color }} />
                {player.name}
              </span>
            ))
          )}
        </div>
        <div className="crosshair" aria-hidden="true" />
        <div className="pickup-prompt" aria-live="polite">
          {nearbyItem ? (
            <>
              <span className="prompt-key">E</span>
              <span>Take {nearbyItem.name}</span>
            </>
          ) : (
            <span>Look around for items</span>
          )}
        </div>
        <section className="ingame-inventory" aria-label="In-game item list">
          <div className="hand-readout">
            <span>Hand</span>
            <strong>{equippedItem ? equippedItem.name : 'Empty'}</strong>
          </div>
          <div className="ingame-slots">
            {itemSlots.map((item, index) => (
              <button
                key={item?.id ?? `hud-empty-${index}`}
                type="button"
                className={`hud-slot ${item ? 'filled' : ''} ${item?.equipped ? 'equipped' : ''}`}
                disabled={!item || status !== 'online'}
                title={item ? `${item.name} (${item.kind})` : 'Empty slot'}
                onClick={() => item && equipItem(item.id)}
              >
                <span>{index + 1}</span>
                {item ? <i style={{ background: item.color }} /> : <i />}
                <strong>{item ? item.name : 'Empty'}</strong>
                {item ? <small>x{item.quantity}</small> : null}
              </button>
            ))}
          </div>
        </section>

        <section className="world-log" aria-label="Chat and event log">
          {latestMessages.map((message) => (
            <article key={message.id} className={message.system ? 'system-message' : ''}>
              <strong>{message.name}</strong>
              <p>{message.text}</p>
            </article>
          ))}
        </section>

        <form className="chat-overlay" onSubmit={submitChat}>
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

        {status !== 'online' ? (
          <form className="login-overlay" onSubmit={(event) => {
            event.preventDefault()
            connect()
          }}>
            <header>
              <p className="eyebrow">Isekai World</p>
              <h1>Enter the Shard</h1>
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

            <button type="submit" disabled={status !== 'offline'}>
              {status === 'connecting' ? 'Connecting' : 'Connect'}
            </button>
          </form>
        ) : (
          <button type="button" className="disconnect-overlay" onClick={disconnect}>
            Disconnect
          </button>
        )}
      </section>
    </main>
  )
}

function createHandMesh() {
  const group = new THREE.Group()
  group.position.set(0.42, -0.46, -0.72)
  group.rotation.set(-0.18, -0.18, 0.12)

  const skinMaterial = new THREE.MeshStandardMaterial({ color: '#f0b58d', roughness: 0.64 })
  const sleeveMaterial = new THREE.MeshStandardMaterial({ color: '#244a3d', roughness: 0.75 })
  const itemMaterial = new THREE.MeshStandardMaterial({ color: '#94a3b8', roughness: 0.4, metalness: 0.08 })

  const forearm = new THREE.Mesh(new THREE.CapsuleGeometry(0.12, 0.48, 6, 12), sleeveMaterial)
  forearm.position.set(0.08, -0.1, 0.08)
  forearm.rotation.set(0.72, 0.1, -0.28)

  const hand = new THREE.Mesh(new THREE.SphereGeometry(0.16, 18, 14), skinMaterial)
  hand.position.set(-0.03, 0.16, -0.08)
  hand.scale.set(1.15, 0.72, 0.92)

  const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(0.035, 0.16, 4, 8), skinMaterial)
  thumb.position.set(-0.17, 0.16, -0.13)
  thumb.rotation.set(0.18, 0.18, 0.72)

  const held = new THREE.Mesh(new THREE.OctahedronGeometry(0.11, 0), itemMaterial)
  held.position.set(-0.02, 0.3, -0.21)
  held.rotation.set(0.4, 0.1, 0.32)
  held.visible = false
  group.userData.heldMesh = held

  const label = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthTest: false }))
  label.position.set(-0.02, 0.5, -0.24)
  label.scale.set(0.58, 0.16, 1)
  label.visible = false
  group.userData.heldLabel = label

  group.add(forearm, hand, thumb, held, label)
  return group
}

function createWorldObjectMesh(object: WorldObject, index: number, textures: Map<string, THREE.Texture>) {
  if (object.render.parts.length > 0) return createComposedObjectMesh(object, textures)
  const shape = object.render.shape || object.type
  if (shape === 'tree') return createTreeMesh(object, index)
  if (shape === 'rock') return createRockMesh(object, index)
  if (shape === 'building') return createBuildingMesh(object)
  if (shape === 'water') return createWaterMesh(object)
  if (shape === 'portal') return createPortalMesh(object)
  return createFallbackObjectMesh(object)
}

function createComposedObjectMesh(object: WorldObject, textures: Map<string, THREE.Texture>) {
  const group = new THREE.Group()
  object.render.parts.forEach((part) => {
    const mesh = createRenderPartMesh(part, object, textures)
    mesh.userData.animate = part.animate
    mesh.userData.baseScale = { ...part.scale }
    mesh.userData.texture = part.material.texture
    mesh.userData.renderPart = part
    mesh.position.set(part.position.x, part.position.y, part.position.z)
    mesh.rotation.set(part.rotation.x, part.rotation.y, part.rotation.z)
    mesh.scale.set(part.scale.x, part.scale.y, part.scale.z)
    mesh.castShadow = part.castShadow
    mesh.receiveShadow = part.receiveShadow
    group.add(mesh)
  })
  group.userData.type = object.type
  return group
}

function createRenderPartMesh(part: RenderPart, object: WorldObject, textures: Map<string, THREE.Texture>) {
  const material = createRenderPartMaterial(part, object, textures)
  const shape = part.shape
  if (shape === 'sphere') return new THREE.Mesh(new THREE.SphereGeometry(part.size.radius, 24, 18), material)
  if (shape === 'capsule') return new THREE.Mesh(new THREE.CapsuleGeometry(part.size.radius, part.size.height, 6, 14), material)
  if (shape === 'cylinder') {
    return new THREE.Mesh(
      new THREE.CylinderGeometry(part.size.topRadius, part.size.bottomRadius, part.size.height, 24),
      material,
    )
  }
  if (shape === 'cone') return new THREE.Mesh(new THREE.ConeGeometry(part.size.radius, part.size.height, 24), material)
  if (shape === 'torus') return new THREE.Mesh(new THREE.TorusGeometry(part.size.radius, part.size.tube, 14, 48), material)
  if (shape === 'circle') return new THREE.Mesh(new THREE.CircleGeometry(part.size.radius, 48), material)
  if (shape === 'ring') return new THREE.Mesh(new THREE.RingGeometry(part.size.radius, part.size.radius + part.size.tube, 48), material)
  if (shape === 'octahedron') return new THREE.Mesh(new THREE.OctahedronGeometry(part.size.radius, 0), material)
  if (shape === 'dodecahedron') return new THREE.Mesh(new THREE.DodecahedronGeometry(part.size.radius, 0), material)
  return new THREE.Mesh(new THREE.BoxGeometry(part.size.x, part.size.y, part.size.z), material)
}

function createRenderPartMaterial(part: RenderPart, object: WorldObject, textures: Map<string, THREE.Texture>) {
  const color = part.color ?? object.color ?? object.render.color ?? '#94a3b8'
  const texture = getRenderPartTexture(part, textures)
  const common = {
    map: texture,
    color,
    opacity: part.material.opacity,
    transparent: part.material.transparent || Boolean(texture && part.material.opacity < 1),
    side: THREE.DoubleSide,
  }
  if (part.material.kind === 'basic') {
    return new THREE.MeshBasicMaterial({
      ...common,
    })
  }

  return new THREE.MeshStandardMaterial({
    ...common,
    roughness: part.material.roughness,
    metalness: part.material.metalness,
    emissive: part.material.emissive ?? '#000000',
    emissiveIntensity: part.material.emissiveIntensity,
  })
}

function getRenderPartTexture(part: RenderPart, textures: Map<string, THREE.Texture>) {
  if (!part.material.texture) return null
  const source = textures.get(part.material.texture)
  if (!source) return null

  const texture = source.clone()
  texture.needsUpdate = true
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.repeat.set(part.material.textureRepeat.x, part.material.textureRepeat.y)
  texture.offset.set(part.material.textureOffset.x, part.material.textureOffset.y)
  return texture
}

function applyObjectTextures(objects: Map<string, THREE.Group>, textures: Map<string, THREE.Texture>) {
  for (const object of objects.values()) {
    object.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return
      const textureName = child.userData.texture as string | undefined
      if (!textureName) return
      const partTexture = getRenderPartTexture(child.userData.renderPart as RenderPart, textures)
      if (!partTexture) return
      const materials = Array.isArray(child.material) ? child.material : [child.material]
      materials.forEach((material) => {
        const nextTexture = partTexture.clone()
        nextTexture.needsUpdate = true
        const mappedMaterial = material as THREE.Material & { map?: THREE.Texture | null }
        mappedMaterial.map?.dispose()
        mappedMaterial.map = nextTexture
        material.needsUpdate = true
      })
    })
  }
}

function createTreeMesh(object: WorldObject, index: number) {
  const group = new THREE.Group()
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.34, 0.48, 2.4, 8),
    new THREE.MeshStandardMaterial({ color: '#7c4a2d', roughness: 0.8 }),
  )
  trunk.position.y = 1.2
  trunk.castShadow = true

  const leaves = new THREE.Mesh(
    new THREE.ConeGeometry(1.8, 3.4, 9),
    new THREE.MeshStandardMaterial({
      color: object.color ?? object.render.color ?? (index % 2 ? '#2d7f5d' : '#1f8f4f'),
      roughness: 0.7,
    }),
  )
  leaves.position.y = 3.2
  leaves.castShadow = true
  group.add(trunk, leaves)
  group.userData.type = object.type
  return group
}

function createRockMesh(object: WorldObject, index: number) {
  const group = new THREE.Group()
  const rock = new THREE.Mesh(
    new THREE.DodecahedronGeometry(1.1, 0),
    new THREE.MeshStandardMaterial({ color: object.color ?? object.render.color ?? '#64748b', roughness: 0.88 }),
  )
  rock.position.y = 0.55
  rock.rotation.set(index * 0.4, index * 0.7, index * 0.18)
  rock.scale.y = 0.62 + (index % 2) * 0.28
  rock.castShadow = true
  rock.receiveShadow = true
  group.add(rock)
  group.userData.type = object.type
  return group
}

function createBuildingMesh(object: WorldObject) {
  const group = new THREE.Group()
  const wall = new THREE.Mesh(
    new THREE.BoxGeometry(5.4, 2.8, 4.2),
    new THREE.MeshStandardMaterial({ color: object.color ?? object.render.color ?? '#d6b48a', roughness: 0.72 }),
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
  group.add(wall, roof)
  group.userData.type = object.type
  return group
}

function createWaterMesh(object: WorldObject) {
  const group = new THREE.Group()
  const water = new THREE.Mesh(
    new THREE.CircleGeometry(object.collision.radius || 7.5, 48),
    new THREE.MeshStandardMaterial({ color: object.color ?? object.render.color ?? '#44b8d8', roughness: 0.25, metalness: 0.05 }),
  )
  water.rotation.x = -Math.PI / 2
  water.position.y = -0.34
  group.userData.type = object.type
  group.userData.waterMesh = water
  group.add(water)
  return group
}

function createPortalMesh(object: WorldObject) {
  const group = new THREE.Group()
  const color = object.color ?? object.render.color ?? '#8b5cf6'
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(1.15, 0.1, 14, 48),
    new THREE.MeshStandardMaterial({ color, roughness: 0.24, metalness: 0.2, emissive: color, emissiveIntensity: 0.28 }),
  )
  ring.position.y = 1.45
  ring.rotation.y = Math.PI / 2
  ring.castShadow = true

  const core = new THREE.Mesh(
    new THREE.CircleGeometry(0.95, 48),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.28, side: THREE.DoubleSide }),
  )
  core.position.y = 1.45
  core.rotation.y = Math.PI / 2

  const base = new THREE.Mesh(
    new THREE.RingGeometry(0.8, 1.35, 48),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.34 }),
  )
  base.rotation.x = -Math.PI / 2
  base.position.y = 0.08

  group.userData.type = object.type
  group.userData.portalRing = ring
  group.userData.portalCore = core
  group.add(base, ring, core)
  return group
}

function createFallbackObjectMesh(object: WorldObject) {
  const group = new THREE.Group()
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(1.6, 1.6, 1.6),
    new THREE.MeshStandardMaterial({ color: object.color ?? object.render.color ?? '#94a3b8', roughness: 0.7 }),
  )
  box.position.y = 0.8
  box.castShadow = true
  box.receiveShadow = true
  group.add(box)
  group.userData.type = object.type
  return group
}

function animateWorldObjects(objects: Map<string, THREE.Group>) {
  const pulse = Math.sin(performance.now() / 900) * 0.0008
  const time = performance.now() / 1000
  for (const object of objects.values()) {
    const water = object.userData.waterMesh as THREE.Mesh | undefined
    const material = water?.material as THREE.MeshStandardMaterial | undefined
    material?.color.offsetHSL(0, 0, pulse)
    const portalRing = object.userData.portalRing as THREE.Mesh | undefined
    const portalCore = object.userData.portalCore as THREE.Mesh | undefined
    if (portalRing) portalRing.rotation.z = time * 0.8
    if (portalCore) {
      portalCore.rotation.z = -time * 0.5
      const coreMaterial = portalCore.material as THREE.MeshBasicMaterial
      coreMaterial.opacity = 0.22 + Math.sin(time * 3) * 0.07
    }
    object.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return
      if (child.userData.animate === 'spin') child.rotation.y += 0.02
      if (child.userData.animate === 'pulse') {
        const baseScale = child.userData.baseScale as { x: number; y: number; z: number } | undefined
        const scale = 1 + Math.sin(time * 3) * 0.08
        child.scale.set(
          (baseScale?.x ?? 1) * scale,
          (baseScale?.y ?? 1) * scale,
          (baseScale?.z ?? 1) * scale,
        )
      }
    })
  }
}

function canMoveTo(x: number, z: number, colliders: WorldObject[], playerRadius = 0.55) {
  return !colliders.some((object) => {
    const radius = object.collision.radius
    if (radius <= 0) return false
    return Math.hypot(x - object.position.x, z - object.position.z) < radius + playerRadius
  })
}

function disposeObject3D(object: THREE.Object3D) {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh) && !(child instanceof THREE.Sprite)) return
    if (child instanceof THREE.Mesh) child.geometry.dispose()
    const materials = Array.isArray(child.material) ? child.material : [child.material]
    materials.forEach((material) => {
      const mappedMaterial = material as THREE.Material & { map?: THREE.Texture | null }
      mappedMaterial.map?.dispose()
      material.dispose()
    })
  })
}

function paintHandItem(group: THREE.Group, item: InventoryItem | null) {
  const held = group.userData.heldMesh as THREE.Mesh | undefined
  const label = group.userData.heldLabel as THREE.Sprite | undefined
  if (!held || !label) return

  held.visible = Boolean(item)
  label.visible = Boolean(item)
  if (!item) return

  const material = held.material as THREE.MeshStandardMaterial
  material.color.set(item.color)
  material.needsUpdate = true

  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 128
  const context = canvas.getContext('2d')
  if (!context) return

  context.fillStyle = 'rgba(15, 23, 42, 0.78)'
  roundRect(context, 34, 30, 444, 64, 18)
  context.fill()
  context.font = '700 30px system-ui, Segoe UI, sans-serif'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillStyle = '#ffffff'
  context.fillText(item.name, 256, 62, 380)

  const spriteMaterial = label.material as THREE.SpriteMaterial
  spriteMaterial.map?.dispose()
  spriteMaterial.map = new THREE.CanvasTexture(canvas)
  spriteMaterial.needsUpdate = true
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
