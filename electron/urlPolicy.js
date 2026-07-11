export const isSafeExternalUrl = (value) => {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
};

export const isSameAppDocument = (value, appUrl) => {
  try {
    const target = new URL(value);
    const appDocument = new URL(appUrl);
    target.hash = '';
    appDocument.hash = '';
    return target.href === appDocument.href;
  } catch {
    return false;
  }
};
