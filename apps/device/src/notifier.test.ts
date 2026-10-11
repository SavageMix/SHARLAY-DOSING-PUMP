import { describe, expect, it, vi } from 'vitest';
import { createNtfyNotifier, createTelegramNotifier } from '../src/notifier.js';

function mockFetch(ok = true, status = 200, json?: unknown) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => json ?? {},
  }) as unknown as typeof fetch;
}

describe('createNtfyNotifier', () => {
  it('POSTs to {baseUrl}/{topic} with Title/Priority headers and a plain-text body', async () => {
    const fetchImpl = mockFetch();
    const notifier = createNtfyNotifier(
      { baseUrl: 'https://ntfy.sh', topic: 'reef-alerts' },
      fetchImpl,
    );

    await notifier.send('Hello', 'Body text', 'high');

    expect(fetchImpl).toHaveBeenCalledWith('https://ntfy.sh/reef-alerts', {
      method: 'POST',
      headers: { Title: 'Hello', Priority: 'high' },
      body: 'Body text',
    });
  });

  it('strips a trailing slash from the base URL', async () => {
    const fetchImpl = mockFetch();
    const notifier = createNtfyNotifier(
      { baseUrl: 'http://192.168.0.5:8080/', topic: 'reef' },
      fetchImpl,
    );

    await notifier.send('t', 'b', 'low');

    expect(fetchImpl).toHaveBeenCalledWith('http://192.168.0.5:8080/reef', {
      method: 'POST',
      headers: { Title: 't', Priority: 'low' },
      body: 'b',
    });
  });

  it('throws on a non-2xx response without mentioning topic or URL', async () => {
    const fetchImpl = mockFetch(false, 404);
    const notifier = createNtfyNotifier(
      { baseUrl: 'https://ntfy.sh', topic: 'secret-topic-name' },
      fetchImpl,
    );

    await expect(notifier.send('t', 'b', 'default')).rejects.toThrow(
      /status 404/,
    );
    await expect(notifier.send('t', 'b', 'default')).rejects.not.toThrow(
      /secret-topic-name/,
    );
  });

  it('throws on a network failure without mentioning the config', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('socket hangup'));
    const notifier = createNtfyNotifier(
      { baseUrl: 'https://ntfy.sh', topic: 'secret-topic-name' },
      fetchImpl,
    );

    await expect(notifier.send('t', 'b', 'default')).rejects.toThrow(
      /socket hangup/,
    );
  });
});

describe('createTelegramNotifier', () => {
  const TOKEN = '123456:ABC-DEF_secretbotoken';
  const CHAT_ID = '424242';

  it('POSTs to the bot API with chat_id and "<title>\n\n<body>" text', async () => {
    const fetchImpl = mockFetch();
    const notifier = createTelegramNotifier(
      { botToken: TOKEN, chatId: CHAT_ID },
      fetchImpl,
    );

    await notifier.send('DOSE FAILED', 'Alkalinity 09:00 slot (2 mL)', 'high');

    expect(fetchImpl).toHaveBeenCalledWith(
      `https://api.telegram.org/bot${TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: 'DOSE FAILED\n\nAlkalinity 09:00 slot (2 mL)',
        }),
      },
    );
  });

  it('throws with the upstream description on non-2xx', async () => {
    const fetchImpl = mockFetch(false, 400, {
      description: 'Bad Request: chat not found',
    });
    const notifier = createTelegramNotifier(
      { botToken: TOKEN, chatId: CHAT_ID },
      fetchImpl,
    );

    await expect(notifier.send('t', 'b', 'default')).rejects.toThrow(
      'Bad Request: chat not found',
    );
  });

  it('never puts the token or chat id into a thrown message', async () => {
    const fetchImpl = mockFetch(false, 401, {
      description: 'Unauthorized',
    });
    const notifier = createTelegramNotifier(
      { botToken: TOKEN, chatId: CHAT_ID },
      fetchImpl,
    );

    try {
      await notifier.send('t', 'b', 'default');
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain(TOKEN);
      expect(message).not.toContain(CHAT_ID);
    }

    // Same guard for an unparseable error body.
    const brokenFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('not json');
      },
    }) as unknown as typeof fetch;
    const broken = createTelegramNotifier(
      { botToken: TOKEN, chatId: CHAT_ID },
      brokenFetch,
    );
    await expect(broken.send('t', 'b', 'default')).rejects.toThrow(
      /status 500/,
    );
  });
});
