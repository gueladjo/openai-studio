import { sha256 } from '@noble/hashes/sha2.js';

const encoder = new TextEncoder();

export const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export const bytesToHex = (bytes: Uint8Array): string => (
  Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
);

export const sha256Bytes = (bytes: Uint8Array): string => bytesToHex(sha256(bytes));

export const encodeUtf8 = (text: string): Uint8Array => encoder.encode(text);

export const sha256Text = (text: string): string => sha256Bytes(encodeUtf8(text));

export const sha256Blob = async (blob: Blob): Promise<string> => {
  const hash = sha256.create();
  const reader = blob.stream().getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
    }
  } finally {
    reader.releaseLock();
  }

  return bytesToHex(hash.digest());
};
