import type { BotConfig } from '../config/schema.js';
import type { ChatMessage } from '../core/conversation.js';

export interface ChatProvider {
  complete(messages: ChatMessage[], config: BotConfig, signal?: AbortSignal): Promise<string>;
}
