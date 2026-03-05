import { Source } from '../types';

const CLICKABLE_PROTOCOLS = new Set(['http:', 'https:']);

const normalizeSourceUrl = (url?: string | null): string | null => {
  const trimmedUrl = url?.trim();
  return trimmedUrl ? trimmedUrl : null;
};

export const parseSourceUrl = (url?: string | null): URL | null => {
  const normalizedUrl = normalizeSourceUrl(url);
  if (!normalizedUrl) return null;

  try {
    const parsedUrl = new URL(normalizedUrl);
    return CLICKABLE_PROTOCOLS.has(parsedUrl.protocol) ? parsedUrl : null;
  } catch {
    return null;
  }
};

export const createSourceRecord = (
  title: string | undefined,
  url: string | undefined | null,
  context?: string
): Source | null => {
  const normalizedUrl = normalizeSourceUrl(url);
  if (!normalizedUrl) return null;

  const parsedUrl = parseSourceUrl(normalizedUrl);
  if (!parsedUrl && context) {
    console.warn(`${context}: invalid source URL`, normalizedUrl);
  }

  const normalizedTitle = title?.trim();

  return {
    title: normalizedTitle || parsedUrl?.hostname || normalizedUrl,
    url: normalizedUrl
  };
};

export const getSourcePresentation = (source: Source): {
  href: string | null;
  hostname: string | null;
  label: string;
  rawUrl: string;
} => {
  const rawUrl = source.url.trim();
  const parsedUrl = parseSourceUrl(rawUrl);
  const normalizedTitle = source.title?.trim();

  return {
    href: parsedUrl?.toString() ?? null,
    hostname: parsedUrl?.hostname ?? null,
    label: normalizedTitle || parsedUrl?.hostname || rawUrl || source.url,
    rawUrl: rawUrl || source.url
  };
};
