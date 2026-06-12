export async function handlePickup({
  addInventoryItem,
  broadcastInventory,
  getItemCatalog,
  player,
  pushChat,
  sanitize,
}, payload) {
  if (!player.saveId) return
  const itemId = sanitize(String(payload.itemId || ''), 48)
  const itemCatalog = await getItemCatalog()
  const item = itemCatalog.find((candidate) => candidate.id === itemId)
  if (!item) return

  const distance = Math.hypot(player.x - item.position.x, player.z - item.position.z)
  if (distance > 4) {
    pushChat({ name: 'World', text: `${player.name} is too far from ${item.name}.`, system: true })
    return
  }

  addInventoryItem(player.saveId, item.id, 1)
  await broadcastInventory(player)
  pushChat({ name: 'World', text: `${player.name} picked up ${item.name}.`, system: true })
}
