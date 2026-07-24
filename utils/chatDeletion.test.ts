import { describe, expect, it, vi } from 'vitest';
import {
  CHAT_DELETION_CONFIRMATION_MESSAGE,
  confirmChatDeletion
} from './chatDeletion';

describe('confirmChatDeletion', () => {
  it('allows deletion when the user confirms', () => {
    const confirmDeletion = vi.fn(() => true);

    expect(confirmChatDeletion(confirmDeletion)).toBe(true);
    expect(confirmDeletion).toHaveBeenCalledOnce();
    expect(confirmDeletion).toHaveBeenCalledWith(CHAT_DELETION_CONFIRMATION_MESSAGE);
  });

  it('cancels deletion when the user declines', () => {
    const confirmDeletion = vi.fn(() => false);

    expect(confirmChatDeletion(confirmDeletion)).toBe(false);
    expect(confirmDeletion).toHaveBeenCalledOnce();
    expect(confirmDeletion).toHaveBeenCalledWith(CHAT_DELETION_CONFIRMATION_MESSAGE);
  });
});
