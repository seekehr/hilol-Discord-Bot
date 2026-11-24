import type { Logger } from 'pino';
import type { BotConfig } from '../config/schema.js';
import { errorDetails } from '../core/errors.js';
import type { Completion, CompletionRequest, Completer } from './groq.js';
import { OpenRouterProvider } from './openrouter.js';

/**
 * Sends each request to Groq and, if Groq fails for any reason (budget, outage, bad
 * reply), retries it once on OpenRouter with the same prompt.
 *
 * A request that wants web search only falls back when OpenRouter search is enabled:
 * otherwise the backup model would answer a "search first" prompt from memory. The
 * caller decides what to do instead (checks and mentions retry without search).
 */
export class FallbackCompleter implements Completer {
  constructor(
    private readonly primary: Completer,
    private readonly backup: Completer,
    private readonly logger: Logger,
  ) {}

  async complete(
    request: CompletionRequest,
    config: BotConfig,
    signal?: AbortSignal,
  ): Promise<Completion> {
    try {
      return await this.primary.complete(request, config, signal);
    } catch (error) {
      if (
        signal?.aborted ||
        !config.ai.openRouter.enabled ||
        (request.webSearch && !OpenRouterProvider.searches(config))
      )
        throw error;
      this.logger.info(
        { pool: request.pool, ...errorDetails(error) },
        'Groq failed; trying OpenRouter',
      );
      try {
        return await this.backup.complete(request, config, signal);
      } catch (backupError) {
        this.logger.info(errorDetails(backupError), 'OpenRouter fallback failed');
        // Groq's error says how long to wait for the main budget, so report that one.
        throw error;
      }
    }
  }
}
