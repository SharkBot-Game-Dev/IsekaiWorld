export async function handleEquip({
  broadcastInventory,
  equipInventoryItem,
  getItemCatalog,
  player,
  pushChat,
  sanitize,
}, payload) {
  if (!player.saveId) return
  const itemId = sanitize(String(payload.itemId || ''), 48)
  const itemCatalog = await getItemCatalog()
  const item = itemCatalog.find((candidate) => candidate.id === itemId)
  if (!item || !equipInventoryItem(player.saveId, item.id)) return

  await broadcastInventory(player)
  pushChat({ name: 'World', text: `${player.name} equipped ${item.name}.`, system: true })
}
