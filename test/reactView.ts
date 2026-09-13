import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach } from 'vitest';

export interface ReactView {
  /** Renders into the per-test container inside `act` and returns the container. */
  render: (element: ReactNode) => Promise<HTMLDivElement>;
  /** Unmounts the current root; the next `render` mounts a fresh one. */
  unmount: () => Promise<void>;
}

/**
 * Registers a per-test container for the enclosing suite and unmounts whatever
 * was rendered into it afterwards. Requires the happy-dom environment pragma.
 */
export const useReactView = (): ReactView => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  const unmount = async (): Promise<void> => {
    const current = root;
    root = null;
    if (current) await act(async () => current.unmount());
  };

  beforeEach(() => {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      value: true
    });
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(async () => {
    await unmount();
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT;
  });

  return {
    render: async element => {
      const current = root ?? createRoot(container);
      root = current;
      await act(async () => {
        current.render(element);
      });
      return container;
    },
    unmount
  };
};

export const findButton = (
  container: ParentNode,
  text: string
): HTMLButtonElement | undefined => (
  Array.from(container.querySelectorAll('button'))
    .find(button => button.textContent?.includes(text))
);

/** Sets a controlled form value through the native setter so React sees it. */
export const changeValue = async (
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
  eventName: 'input' | 'change' = 'input'
): Promise<void> => {
  const prototype = element instanceof HTMLSelectElement
    ? HTMLSelectElement.prototype
    : element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  await act(async () => {
    valueSetter?.call(element, value);
    element.dispatchEvent(new Event(eventName, { bubbles: true }));
  });
};
