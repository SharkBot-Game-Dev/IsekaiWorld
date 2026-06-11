export function handleMove({ player, broadcastPlayers, clamp, savePlayer }, payload) {
  player.x = clamp(Number(payload.x), -32, 32)
  player.z = clamp(Number(payload.z), -32, 32)
  savePlayer(player)
  broadcastPlayers()
}
