/**
 * Pluggable push-notification transports. Two implementations ship: ntfy
 * (POST to {baseUrl}/{topic}) and Telegram (POST to the Bot API). Both accept
 * an injectable fetch so tests never hit the network.
 *
 * SECURITY: error messages thrown here must never contain config values
 * (bot tokens, chat ids, topics, full URLs). Upstream descriptions are passed
 * through only because Telegram's own error descriptions are token-free.
 */

export type NotificationPriority = 'low' | 'default' | 'high' | 'urgent';

export interface Notifier {
  send(title: string, body: string, priority: NotificationPriority): Promise<void>;
}

export interface NtfyConfig {
  baseUrl: string;
  topic: string;
}

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

type FetchImpl = typeof fetch;

function statusError(prefix: string, status: number): Error {
  return new Error(`${prefix}: upstream returned status ${status}`);
}

export function createNtfyNotifier(
  config: NtfyConfig,
  fetchImpl: FetchImpl = fetch,
): Notifier {
  const url = `${config.baseUrl.replace(/\/+$/, '')}/${config.topic}`;
  return {
    async send(title, body, priority) {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            Title: title,
            Priority: priority,
          },
          body,
        });
      } catch (error) {
        // Network-level failure — message contains no config values.
        throw new Error(
          `ntfy send failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!response.ok) {
        throw statusError('ntfy send failed', response.status);
      }
    },
  };
}

export function createTelegramNotifier(
  config: TelegramConfig,
  fetchImpl: FetchImpl = fetch,
): Notifier {
  const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
  return {
    async send(title, body) {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: config.chatId,
            text: `${title}\n\n${body}`,
          }),
        });
      } catch (error) {
        throw new Error(
          `telegram send failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!response.ok) {
        // Telegram error bodies carry a human `description` that never
        // includes the token; surface it, fall back to the bare status.
        let description: string | null = null;
        try {
          const data = (await response.json()) as { description?: string };
          if (typeof data.description === 'string') description = data.description;
        } catch {
          // Unparseable body — the status-only message below still applies.
        }
        throw new Error(description ?? `telegram send failed: upstream returned status ${response.status}`);
      }
    },
  };
}
