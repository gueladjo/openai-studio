// @vitest-environment happy-dom

import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, type ChatConfig } from '../types';
import { ConfigPanel } from './ConfigPanel';

interface HarnessProps {
  initialConfig?: ChatConfig;
  onConfigChange: (config: ChatConfig) => void;
  readOnly?: boolean;
}

const ConfigPanelHarness: React.FC<HarnessProps> = ({
  initialConfig = DEFAULT_CONFIG,
  onConfigChange,
  readOnly = false
}) => {
  const [config, setConfig] = useState(initialConfig);

  return (
    <ConfigPanel
      config={config}
      onChange={nextConfig => {
        onConfigChange(nextConfig);
        setConfig(nextConfig);
      }}
      systemInstructions={[]}
      onUpdateSystemInstruction={() => undefined}
      onCreateSystemInstruction={() => undefined}
      onDeleteSystemInstruction={() => undefined}
      readOnly={readOnly}
    />
  );
};

describe('ConfigPanel Web Search options', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      value: true
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT;
  });

  const renderPanel = async (
    onConfigChange = vi.fn(),
    readOnly = false
  ) => {
    await act(async () => {
      root.render(
        <ConfigPanelHarness
          onConfigChange={onConfigChange}
          readOnly={readOnly}
        />
      );
    });
    return onConfigChange;
  };

  const getDisclosure = (): HTMLButtonElement => (
    container.querySelector<HTMLButtonElement>('button[aria-controls]')!
  );

  const getSwitch = (): HTMLButtonElement => (
    container.querySelector<HTMLButtonElement>('[role="switch"]')!
  );

  const getButton = (label: string): HTMLButtonElement => (
    Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => (
        button.textContent?.trim().toLowerCase() === label.toLowerCase()
      ))!
  );

  const getContextButton = (label: string): HTMLButtonElement => (
    Array.from(container.querySelectorAll<HTMLButtonElement>(
      'button[aria-pressed]'
    )).find(button => (
      button.textContent?.trim().toLowerCase() === label.toLowerCase()
    ))!
  );

  const getInput = (label: string): HTMLInputElement => (
    Array.from(container.querySelectorAll<HTMLLabelElement>('label'))
      .find(element => element.textContent?.includes(label))!
      .querySelector('input')!
  );

  const changeInput = async (input: HTMLInputElement, value: string) => {
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    )?.set;
    await act(async () => {
      valueSetter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  it('starts collapsed and keeps disclosure independent from enablement', async () => {
    const onConfigChange = await renderPanel();
    const disclosure = getDisclosure();
    const webSearchSwitch = getSwitch();

    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    expect(webSearchSwitch.getAttribute('aria-checked')).toBe('true');
    expect(webSearchSwitch.nextElementSibling).toBe(disclosure);
    expect(webSearchSwitch.firstElementChild?.classList).toContain('left-0.5');
    expect(webSearchSwitch.firstElementChild?.classList).toContain('translate-x-4');
    expect(container.textContent).not.toContain('Search context size');

    await act(async () => {
      webSearchSwitch.click();
    });

    expect(webSearchSwitch.getAttribute('aria-checked')).toBe('false');
    expect(webSearchSwitch.firstElementChild?.classList).toContain('translate-x-0');
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    expect(onConfigChange).toHaveBeenLastCalledWith(expect.objectContaining({
      tools: expect.objectContaining({ webSearch: false })
    }));

    await act(async () => {
      disclosure.click();
    });

    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('Search context size');
    expect(getInput('City').value).toBe('New York');
  });

  it('edits context and bounded location options while Web Search is disabled', async () => {
    const onConfigChange = await renderPanel();
    await act(async () => {
      getSwitch().click();
      getDisclosure().click();
    });
    await act(async () => {
      getContextButton('High').click();
    });

    await changeInput(getInput('City'), 'London');
    await changeInput(getInput('Region'), 'England');
    await changeInput(getInput('Country'), 'g-b');

    expect(getContextButton('High').getAttribute('aria-pressed')).toBe('true');
    expect(getInput('Country').value).toBe('GB');
    expect(onConfigChange).toHaveBeenLastCalledWith(expect.objectContaining({
      tools: expect.objectContaining({
        webSearch: false,
        webSearchOptions: {
          searchContextSize: 'high',
          userLocation: {
            type: 'approximate',
            city: 'London',
            region: 'England',
            country: 'GB'
          }
        }
      })
    }));
  });

  it('clears location and lets a new approximate location be entered', async () => {
    const onConfigChange = await renderPanel();
    await act(async () => {
      getDisclosure().click();
    });
    await act(async () => {
      getButton('Clear location').click();
    });

    expect(getInput('City').value).toBe('');
    expect(getInput('Region').value).toBe('');
    expect(getInput('Country').value).toBe('');
    expect(onConfigChange).toHaveBeenLastCalledWith(expect.objectContaining({
      tools: expect.objectContaining({
        webSearchOptions: expect.objectContaining({ userLocation: null })
      })
    }));

    await changeInput(getInput('City'), 'Paris');
    expect(onConfigChange).toHaveBeenLastCalledWith(expect.objectContaining({
      tools: expect.objectContaining({
        webSearchOptions: expect.objectContaining({
          userLocation: { type: 'approximate', city: 'Paris' }
        })
      })
    }));
  });

  it('disables disclosure, switch, and inputs in read-only mode', async () => {
    const onConfigChange = await renderPanel(undefined, true);

    expect(getDisclosure().matches(':disabled')).toBe(true);
    expect(getSwitch().matches(':disabled')).toBe(true);
    await act(async () => {
      getDisclosure().click();
      getSwitch().click();
    });

    expect(getDisclosure().getAttribute('aria-expanded')).toBe('false');
    expect(getSwitch().getAttribute('aria-checked')).toBe('true');
    expect(onConfigChange).not.toHaveBeenCalled();
  });
});
