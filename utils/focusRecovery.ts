export const restoreFocusAfterFileDialog = (): void => {
  void window.electronAPI?.restoreFocusAfterDialog().catch(error => {
    console.warn('Electron window focus could not be restored after a file dialog.', error);
  });
};

const registeredFileInputs = new WeakSet<HTMLInputElement>();

export const registerFileDialogFocusRecovery = (
  input: HTMLInputElement | null
): void => {
  if (!input || registeredFileInputs.has(input)) return;
  registeredFileInputs.add(input);
  input.addEventListener('cancel', restoreFocusAfterFileDialog);
};
