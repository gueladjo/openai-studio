import { describe, expect, it, vi } from 'vitest';
import {
  DEV_SERVER_HEALTH_BODY,
  DEV_SERVER_HEALTH_HEADER,
  DEV_SERVER_HEALTH_HEADER_VALUE,
  DEV_SERVER_HEALTH_URL,
  isVerifiedDevServerResponse,
  waitForVerifiedDevServer
} from './devServer.js';

const verifiedResponse = () => new Response(DEV_SERVER_HEALTH_BODY, {
  status: 200,
  headers: {
    [DEV_SERVER_HEALTH_HEADER]: DEV_SERVER_HEALTH_HEADER_VALUE
  }
});

describe('Electron development server verification', () => {
  it('accepts only the app-specific health response', async () => {
    await expect(isVerifiedDevServerResponse(verifiedResponse())).resolves.toBe(true);
    await expect(isVerifiedDevServerResponse(
      new Response(DEV_SERVER_HEALTH_BODY, { status: 200 })
    )).resolves.toBe(false);
    await expect(isVerifiedDevServerResponse(
      new Response('unrelated service', {
        status: 200,
        headers: {
          [DEV_SERVER_HEALTH_HEADER]: DEV_SERVER_HEALTH_HEADER_VALUE
        }
      })
    )).resolves.toBe(false);
  });

  it('waits until the verified app server is ready', async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error('not ready'))
      .mockResolvedValueOnce(verifiedResponse());

    await waitForVerifiedDevServer({
      fetchImpl,
      retryDelayMs: 0,
      timeoutMs: 100
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledWith(
      DEV_SERVER_HEALTH_URL,
      expect.objectContaining({ cache: 'no-store' })
    );
  });

  it('terminates verification when the response belongs to another service', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('unrelated service', { status: 200 })
    );

    await expect(waitForVerifiedDevServer({
      fetchImpl,
      retryDelayMs: 0,
      timeoutMs: 0
    })).rejects.toThrow('unexpected health response');
  });
});
