import { handleChat } from './chat.mjs'
import { handleEquip } from './equip.mjs'
import { handleJoin } from './join.mjs'
import { handleMove } from './move.mjs'
import { handlePickup } from './pickup.mjs'
import { handleUse } from './use.mjs'

const handlers = {
  chat: handleChat,
  equip: handleEquip,
  join: handleJoin,
  move: handleMove,
  pickup: handlePickup,
  use: handleUse,
}

export async function handleWorldEvent(context, payload) {
  const handler = handlers[payload.type]
  if (!handler) return
  await handler(context, payload)
}
