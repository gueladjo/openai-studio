import {
  DEFAULT_CONFIG,
  type ChatConfig,
  type Project,
  type Session
} from '../types';

export const createDeferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

/** A detached copy of the default chat configuration. */
export const chatConfig = (overrides: Partial<ChatConfig> = {}): ChatConfig => {
  const { userLocation } = DEFAULT_CONFIG.tools.webSearchOptions;
  return {
    ...DEFAULT_CONFIG,
    tools: {
      ...DEFAULT_CONFIG.tools,
      webSearchOptions: {
        ...DEFAULT_CONFIG.tools.webSearchOptions,
        userLocation: userLocation ? { ...userLocation } : null
      }
    },
    ...overrides
  };
};

export const projectFixture = (overrides: Partial<Project> = {}): Project => ({
  id: 'project-1',
  name: 'Research',
  icon: 'research',
  instructions: '',
  sources: [],
  createdAt: 1,
  updatedAt: 1,
  ...overrides
});

export const sessionFixture = (overrides: Partial<Session> = {}): Session => ({
  id: 'session-1',
  title: 'Session',
  messages: [],
  config: chatConfig(),
  lastModified: 1,
  ...overrides
});
