export async function handleUse({
  broadcastInventory,
  getItemCatalog,
  player,
  pushChat,
  sanitize,
  useInventoryItem,
}, payload) {
  if (!player.saveId) return
  const itemId = sanitize(String(payload.itemId || ''), 48)
  const itemCatalog = await getItemCatalog()
  const item = itemCatalog.find((candidate) => candidate.id === itemId)
  if (!item || !useInventoryItem(player.saveId, item.id)) return

  await broadcastInventory(player)
  pushChat({ name: 'World', text: `${player.name} used ${item.name}.`, system: true })
}
