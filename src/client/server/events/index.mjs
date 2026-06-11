import { handleChat } from './chat.mjs'
import { handleJoin } from './join.mjs'
import { handleMove } from './move.mjs'

const handlers = {
  chat: handleChat,
  join: handleJoin,
  move: handleMove,
}

export function handleWorldEvent(context, payload) {
  const handler = handlers[payload.type]
  if (!handler) return
  handler(context, payload)
}
