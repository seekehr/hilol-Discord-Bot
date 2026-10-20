import type { BotConfig } from '../config/schema.js';

export function channelAllowed(
  config: BotConfig,
  channelId: string,
  parentId: string | null,
  direct: boolean,
): boolean {
  const excluded = config.triggers.excludedChannelIds;
  if (excluded.includes(channelId) || (parentId !== null && excluded.includes(parentId)))
    return false;
  if (!direct) return config.autoReply.enabled && config.autoReply.channelId === channelId;
  const allowed = config.triggers.directChannelIds;
  return (
    allowed.length === 0 ||
    allowed.includes(channelId) ||
    (parentId !== null && allowed.includes(parentId))
  );
}
