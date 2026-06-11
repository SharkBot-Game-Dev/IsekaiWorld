export function handleChat({ player, pushChat, sanitize }, payload) {
  const text = sanitize(String(payload.text || ''), 180)
  if (text) pushChat({ name: player.name, text })
}
