export async function handleMove({
  player,
  broadcastPlayers,
  canMoveTo,
  clamp,
  findPortalAt,
  getWorld,
  pushChat,
  savePlayer,
  sendWorldState,
}, payload) {
  const world = await getWorld(player.worldId)
  const bounds = world?.bounds ?? { minX: -32, maxX: 32, minZ: -32, maxZ: 32 }
  const requestedX = clamp(Number(payload.x), bounds.minX, bounds.maxX)
  const requestedZ = clamp(Number(payload.z), bounds.minZ, bounds.maxZ)
  const deltaX = requestedX - player.x
  const deltaZ = requestedZ - player.z
  const distance = Math.hypot(deltaX, deltaZ)
  const maxStep = 1.05
  const scale = distance > maxStep ? maxStep / distance : 1
  const nextX = clamp(player.x + deltaX * scale, bounds.minX, bounds.maxX)
  const nextZ = clamp(player.z + deltaZ * scale, bounds.minZ, bounds.maxZ)

  if (canMoveTo(world, nextX, nextZ)) {
    player.x = nextX
    player.z = nextZ
  } else {
    if (canMoveTo(world, nextX, player.z)) player.x = nextX
    if (canMoveTo(world, player.x, nextZ)) player.z = nextZ
  }

  const portal = findPortalAt(world, player.x, player.z)
  if (portal) {
    const nextWorld = await getWorld(portal.portal.targetWorld)
    if (nextWorld) {
      const previousWorldId = player.worldId
      player.worldId = nextWorld.id
      player.x = Number.isFinite(Number(portal.portal.target.x)) ? Number(portal.portal.target.x) : nextWorld.spawn.x
      player.z = Number.isFinite(Number(portal.portal.target.z)) ? Number(portal.portal.target.z) : nextWorld.spawn.z
      pushChat({ name: 'World', text: `${player.name} entered ${nextWorld.name}.`, system: true })
      await sendWorldState(player)
      broadcastPlayers(previousWorldId)
    }
  }

  savePlayer(player)
  broadcastPlayers()
}
