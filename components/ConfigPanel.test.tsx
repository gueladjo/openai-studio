// @vitest-environment happy-dom

import React, { act, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CONFIG,
  ModelId,
  type ChatConfig,
  type SystemInstruction
} from '../types';
import { changeValue, useReactView } from '../test/reactView';
import { ConfigPanel } from './ConfigPanel';

interface HarnessProps {
  initialConfig?: ChatConfig;
  onConfigChange: (config: ChatConfig) => void;
  systemInstructions?: SystemInstruction[];
  onUpdateSystemInstruction?: (instruction: SystemInstruction) => void;
  onCreateSystemInstruction?: () => void;
  onDeleteSystemInstruction?: (id: string) => void;
  readOnly?: boolean;
  hideSystemInstructions?: boolean;
}

const ConfigPanelHarness: React.FC<HarnessProps> = ({
  initialConfig = DEFAULT_CONFIG,
  onConfigChange,
  systemInstructions = [],
  onUpdateSystemInstruction = () => undefined,
  onCreateSystemInstruction = () => undefined,
  onDeleteSystemInstruction = () => undefined,
  readOnly = false,
  hideSystemInstructions = false
}) => {
  const [config, setConfig] = useState(initialConfig);

  return (
    <ConfigPanel
      config={config}
      onChange={nextConfig => {
        onConfigChange(nextConfig);
        setConfig(nextConfig);
      }}
      systemInstructions={systemInstructions}
      onUpdateSystemInstruction={onUpdateSystemInstruction}
      onCreateSystemInstruction={onCreateSystemInstruction}
      onDeleteSystemInstruction={onDeleteSystemInstruction}
      readOnly={readOnly}
      hideSystemInstructions={hideSystemInstructions}
    />
  );
};

describe('ConfigPanel', () => {
  const view = useReactView();
  let container: HTMLDivElement;

  const renderPanel = async (
    onConfigChange = vi.fn(),
    readOnly = false
  ) => {
    container = await view.render(
      <ConfigPanelHarness
        onConfigChange={onConfigChange}
        readOnly={readOnly}
      />
    );
    return onConfigChange;
  };

  const getWebSearchDisclosure = (): HTMLButtonElement => (
    container.querySelector<HTMLButtonElement>(
      'button[aria-label*="Web Search options"]'
    )!
  );

  const getSystemInstructionsDisclosure = (): HTMLButtonElement => (
    container.querySelector<HTMLButtonElement>(
      'button[aria-label*="System instructions options"]'
    )!
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

  it('starts collapsed and keeps disclosure independent from enablement', async () => {
    const onConfigChange = await renderPanel();
    const disclosure = getWebSearchDisclosure();
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
      getWebSearchDisclosure().click();
    });
    await act(async () => {
      getContextButton('High').click();
    });

    await changeValue(getInput('City'), 'London');
    await changeValue(getInput('Region'), 'England');
    await changeValue(getInput('Country'), 'g-b');

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
      getWebSearchDisclosure().click();
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

    await changeValue(getInput('City'), 'Paris');
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

    expect(getWebSearchDisclosure().matches(':disabled')).toBe(true);
    expect(getSwitch().matches(':disabled')).toBe(true);
    await act(async () => {
      getWebSearchDisclosure().click();
      getSwitch().click();
    });

    expect(getWebSearchDisclosure().getAttribute('aria-expanded')).toBe('false');
    expect(getSwitch().getAttribute('aria-checked')).toBe('true');
    expect(onConfigChange).not.toHaveBeenCalled();
  });

  it('selects Astra with its model-specific reasoning options', async () => {
    const onConfigChange = vi.fn();
    container = await view.render(
      <ConfigPanelHarness
        initialConfig={{
          ...DEFAULT_CONFIG,
          model: ModelId.GPT_5_6_SOL,
          reasoningEffort: 'none'
        }}
        onConfigChange={onConfigChange}
      />
    );
    const modelPicker = Array.from(container.querySelectorAll('select')).find(
      select => select.querySelector(`option[value="${ModelId.GPT_6_ASTRA}"]`)
    )!;

    expect(modelPicker.querySelector(
      `option[value="${ModelId.GPT_6_ASTRA}"]`
    )?.textContent).toBe('GPT-6 Astra');

    await changeValue(modelPicker, ModelId.GPT_6_ASTRA, 'change');

    expect(onConfigChange).toHaveBeenLastCalledWith(expect.objectContaining({
      model: ModelId.GPT_6_ASTRA,
      reasoningEffort: 'max'
    }));
    expect(getButton('none')).toBeUndefined();
    expect(getButton('max')).toBeDefined();
  });

  it('keeps the System instructions picker visible while its editor starts collapsed', async () => {
    const instructions: SystemInstruction[] = [{
      id: 'instruction-1',
      title: 'Concise',
      content: 'Keep answers brief.'
    }];
    container = await view.render(
      <ConfigPanelHarness
        initialConfig={{
          ...DEFAULT_CONFIG,
          systemInstructionId: instructions[0].id
        }}
        onConfigChange={() => undefined}
        systemInstructions={instructions}
      />
    );

    const pickerLabel = Array.from(container.querySelectorAll('label')).find(
      label => label.textContent?.trim() === 'System instructions'
    )!;
    const picker = container.querySelector<HTMLSelectElement>(
      `#${pickerLabel.htmlFor}`
    )!;
    const disclosure = getSystemInstructionsDisclosure();

    expect(picker.value).toBe('instruction-1');
    expect(container.querySelector('option[value="new"]')).toBeNull();
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('New instruction');
    expect(container.querySelector('textarea')).toBeNull();

    await act(async () => {
      disclosure.click();
    });

    const optionsId = disclosure.getAttribute('aria-controls')!;
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector(`#${optionsId}`)).not.toBeNull();
    expect(container.textContent).toContain('New instruction');
    expect(container.querySelector('textarea')?.value).toBe('Keep answers brief.');
  });

  it('selects, creates, edits, and deletes instructions through inline controls', async () => {
    const instructions: SystemInstruction[] = [{
      id: 'instruction-1',
      title: 'Concise',
      content: 'Keep answers brief.'
    }, {
      id: 'instruction-2',
      title: 'Detailed',
      content: 'Explain the reasoning.'
    }];
    const onConfigChange = vi.fn();
    const onUpdateSystemInstruction = vi.fn();
    const onCreateSystemInstruction = vi.fn();
    const onDeleteSystemInstruction = vi.fn();
    container = await view.render(
      <ConfigPanelHarness
        initialConfig={{
          ...DEFAULT_CONFIG,
          systemInstructionId: instructions[0].id
        }}
        onConfigChange={onConfigChange}
        systemInstructions={instructions}
        onUpdateSystemInstruction={onUpdateSystemInstruction}
        onCreateSystemInstruction={onCreateSystemInstruction}
        onDeleteSystemInstruction={onDeleteSystemInstruction}
      />
    );

    const picker = Array.from(container.querySelectorAll('select')).find(
      select => select.value === 'instruction-1'
    )!;
    await changeValue(picker, 'instruction-2', 'change');
    expect(onConfigChange).toHaveBeenLastCalledWith(expect.objectContaining({
      systemInstructionId: 'instruction-2'
    }));

    await act(async () => {
      getSystemInstructionsDisclosure().click();
    });
    const nameInput = Array.from(container.querySelectorAll('label')).find(
      label => label.textContent?.trim() === 'Name'
    )!.querySelector<HTMLInputElement>('input')!;
    const instructionsInput = container.querySelector<HTMLTextAreaElement>('textarea')!;
    await changeValue(nameInput, 'Detailed guidance');
    expect(onUpdateSystemInstruction).toHaveBeenLastCalledWith({
      ...instructions[1],
      title: 'Detailed guidance'
    });

    await changeValue(instructionsInput, 'Show the important steps.');
    expect(onUpdateSystemInstruction).toHaveBeenLastCalledWith({
      ...instructions[1],
      content: 'Show the important steps.'
    });

    await act(async () => {
      getButton('New instruction').click();
      getButton('Delete instruction').click();
    });
    expect(onCreateSystemInstruction).toHaveBeenCalledTimes(1);
    expect(onDeleteSystemInstruction).toHaveBeenCalledWith('instruction-2');
  });

  it('shows an empty instruction state and preserves hidden and read-only behavior', async () => {
    const onCreateSystemInstruction = vi.fn();
    container = await view.render(
      <ConfigPanelHarness
        onConfigChange={() => undefined}
        onCreateSystemInstruction={onCreateSystemInstruction}
        readOnly
      />
    );

    const pickerLabel = Array.from(container.querySelectorAll('label')).find(
      label => label.textContent?.trim() === 'System instructions'
    )!;
    const picker = container.querySelector<HTMLSelectElement>(
      `#${pickerLabel.htmlFor}`
    )!;
    const disclosure = getSystemInstructionsDisclosure();
    expect(picker.disabled).toBe(true);
    expect(disclosure.disabled).toBe(true);
    await act(async () => {
      disclosure.click();
    });
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    expect(onCreateSystemInstruction).not.toHaveBeenCalled();

    container = await view.render(
      <ConfigPanelHarness
        onConfigChange={() => undefined}
        onCreateSystemInstruction={onCreateSystemInstruction}
      />
    );
    await act(async () => {
      getSystemInstructionsDisclosure().click();
    });
    expect(container.textContent).toContain(
      'Select an instruction to edit it, or create a new one.'
    );
    expect(getButton('Delete instruction')).toBeUndefined();

    container = await view.render(
      <ConfigPanelHarness
        onConfigChange={() => undefined}
        hideSystemInstructions
      />
    );
    expect(container.textContent).not.toContain('System instructions');
    expect(getSystemInstructionsDisclosure()).toBeNull();
  });
});
