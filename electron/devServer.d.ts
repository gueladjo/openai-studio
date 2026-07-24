export const DEV_SERVER_HOST: string;
export const DEV_SERVER_PORT: number;
export const DEV_SERVER_ORIGIN: string;
export const DEV_SERVER_HEALTH_PATH: string;
export const DEV_SERVER_HEALTH_URL: string;
export const DEV_SERVER_HEALTH_HEADER: string;
export const DEV_SERVER_HEALTH_HEADER_VALUE: string;
export const DEV_SERVER_HEALTH_BODY: string;

export function isVerifiedDevServerResponse(response: Response): Promise<boolean>;

export function waitForVerifiedDevServer(options?: {
  fetchImpl?: typeof fetch;
  retryDelayMs?: number;
  timeoutMs?: number;
}): Promise<void>;
