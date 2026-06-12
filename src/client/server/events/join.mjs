export async function handleJoin({
  broadcastInventory,
  broadcastPlayers,
  loadPlayerSave,
  player,
  pushChat,
  savePlayer,
  sanitize,
}, payload) {
  const saveId = sanitize(String(payload.saveId || ''), 80)
  const save = loadPlayerSave(saveId)

  if (save) {
    player.saveId = save.save_id
    player.name = sanitize(String(payload.name || save.name), 24)
    player.x = Number(save.x)
    player.z = Number(save.z)
    player.color = save.color
  } else {
    player.saveId = saveId
    player.name = sanitize(String(payload.name || player.name), 24)
  }

  savePlayer(player)
  await broadcastInventory(player)
  pushChat({ name: 'World', text: `${player.name} connected.`, system: true })
  broadcastPlayers()
}
