export const DEV_SERVER_HOST = '127.0.0.1';
export const DEV_SERVER_PORT = 5173;
export const DEV_SERVER_ORIGIN = `http://${DEV_SERVER_HOST}:${DEV_SERVER_PORT}/`;
export const DEV_SERVER_HEALTH_PATH = '/__openai-studio/electron-dev-health';
export const DEV_SERVER_HEALTH_URL = new URL(
  DEV_SERVER_HEALTH_PATH,
  DEV_SERVER_ORIGIN
).href;
export const DEV_SERVER_HEALTH_HEADER = 'X-OpenAI-Studio-Dev-Server';
export const DEV_SERVER_HEALTH_HEADER_VALUE = '1';
export const DEV_SERVER_HEALTH_BODY = JSON.stringify({
  app: 'openai-studio',
  mode: 'electron-development',
  version: 1
});

export const isVerifiedDevServerResponse = async (response) => (
  response.status === 200
  && response.headers.get(DEV_SERVER_HEALTH_HEADER) === DEV_SERVER_HEALTH_HEADER_VALUE
  && await response.text() === DEV_SERVER_HEALTH_BODY
);

const delay = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

const formatFailure = (error) => (
  error instanceof Error ? error.message : String(error)
);

export const waitForVerifiedDevServer = async ({
  fetchImpl = globalThis.fetch,
  retryDelayMs = 100,
  timeoutMs = 15_000
} = {}) => {
  const deadline = Date.now() + timeoutMs;
  let lastFailure = 'unexpected health response';

  do {
    try {
      const remainingMs = Math.max(1, deadline - Date.now());
      const response = await fetchImpl(DEV_SERVER_HEALTH_URL, {
        cache: 'no-store',
        signal: AbortSignal.timeout(Math.min(1_000, remainingMs))
      });

      if (await isVerifiedDevServerResponse(response)) return;
      lastFailure = 'unexpected health response';
    } catch (error) {
      lastFailure = formatFailure(error);
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await delay(Math.min(retryDelayMs, remainingMs));
  } while (true);

  throw new Error(
    `OpenAI Studio Electron development server verification failed at `
    + `${DEV_SERVER_HEALTH_URL}: ${lastFailure}`
  );
};
