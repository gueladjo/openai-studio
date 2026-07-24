export const CHAT_DELETION_CONFIRMATION_MESSAGE =
  'Delete this chat? This action cannot be undone.';

export const confirmChatDeletion = (
  confirmDeletion: (message: string) => boolean = (message) => window.confirm(message)
): boolean => confirmDeletion(CHAT_DELETION_CONFIRMATION_MESSAGE);
