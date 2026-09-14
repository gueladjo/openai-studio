import { describe, expect, it } from 'vitest';
import {
  excludeWebManifestFromPrecache,
  getAppBase,
  getInjectedProcessEnvironment,
  getPwaManifest
} from './vite.config';

describe('build configuration policy', () => {
  it('never injects an API key into a production web bundle', () => {
    const environment = getInjectedProcessEnvironment('web', {
      NODE_ENV: 'production',
      OPENAI_API_KEY: 'must-not-be-bundled'
    });

    expect(environment).toEqual({ NODE_ENV: 'production' });
    expect(JSON.stringify(environment)).not.toContain('must-not-be-bundled');
  });

  it('allows local and Electron modes to use an explicitly supplied key', () => {
    expect(getInjectedProcessEnvironment('electron', {
      OPENAI_API_KEY: 'electron-key'
    })).toEqual({
      NODE_ENV: 'electron',
      OPENAI_API_KEY: 'electron-key'
    });
    expect(getInjectedProcessEnvironment('development', {
      OPENAI_API_KEY: 'development-key'
    })).toEqual({
      NODE_ENV: 'development',
      OPENAI_API_KEY: 'development-key'
    });
  });

  it('keeps Electron assets relative and PWA navigation within the web base', () => {
    expect(getAppBase('electron')).toBe('./');

    const webBase = getAppBase('web');
    expect(webBase).toBe('/openai-studio/');
    expect(getPwaManifest(webBase)).toMatchObject({
      theme_color: '#ffffff',
      background_color: '#121211',
      scope: webBase,
      start_url: webBase,
      icons: [
        { src: '/openai-studio/icons/icon-192.png' },
        { src: '/openai-studio/icons/icon-512.png' }
      ]
    });
  });

  it('refreshes the web manifest outside the revisioned shell precache', () => {
    expect(excludeWebManifestFromPrecache([
      { url: 'index.html', revision: 'index-1' },
      { url: 'manifest.webmanifest', revision: 'manifest-1' }
    ])).toEqual([
      { url: 'index.html', revision: 'index-1' }
    ]);
  });
});
