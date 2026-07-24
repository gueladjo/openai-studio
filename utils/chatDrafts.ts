export interface ChatDraft {
  content: string;
  attachments: File[];
  attachmentError: string | null;
}

export type ChatDraftsState = Record<string, ChatDraft>;

export type ChatDraftsAction =
  | {
      type: 'set-content';
      sessionId: string;
      content: string;
    }
  | {
      type: 'set-attachments';
      sessionId: string;
      attachments: File[];
      attachmentError: string | null;
    }
  | {
      type: 'remove-attachment';
      sessionId: string;
      attachmentIndex: number;
    }
  | {
      type: 'set-attachment-error';
      sessionId: string;
      attachmentError: string | null;
    }
  | {
      type: 'clear';
      sessionId: string;
    }
  | {
      type: 'restore-submission';
      sessionId: string;
      content: string;
      attachments: File[];
    }
  | {
      type: 'prune';
      sessionIds: string[];
    }
  | {
      type: 'reset';
    };

const EMPTY_DRAFT: ChatDraft = {
  content: '',
  attachments: [],
  attachmentError: null
};

export const getChatDraft = (
  drafts: ChatDraftsState,
  sessionId: string | null | undefined
): ChatDraft => (
  sessionId ? drafts[sessionId] || EMPTY_DRAFT : EMPTY_DRAFT
);

const setDraft = (
  drafts: ChatDraftsState,
  sessionId: string,
  draft: ChatDraft
): ChatDraftsState => {
  if (
    !draft.content &&
    draft.attachments.length === 0 &&
    !draft.attachmentError
  ) {
    if (!(sessionId in drafts)) return drafts;
    const nextDrafts = { ...drafts };
    delete nextDrafts[sessionId];
    return nextDrafts;
  }

  return {
    ...drafts,
    [sessionId]: draft
  };
};

export const chatDraftsReducer = (
  drafts: ChatDraftsState,
  action: ChatDraftsAction
): ChatDraftsState => {
  if (action.type === 'reset') return {};

  if (action.type === 'prune') {
    const allowedSessionIds = new Set(action.sessionIds);
    const draftEntries = Object.entries(drafts);
    if (draftEntries.every(([sessionId]) => allowedSessionIds.has(sessionId))) {
      return drafts;
    }
    return Object.fromEntries(
      draftEntries.filter(([sessionId]) => allowedSessionIds.has(sessionId))
    );
  }

  const currentDraft = getChatDraft(drafts, action.sessionId);

  if (action.type === 'set-content') {
    return setDraft(drafts, action.sessionId, {
      ...currentDraft,
      content: action.content
    });
  }

  if (action.type === 'set-attachments') {
    return setDraft(drafts, action.sessionId, {
      ...currentDraft,
      attachments: action.attachments,
      attachmentError: action.attachmentError
    });
  }

  if (action.type === 'remove-attachment') {
    return setDraft(drafts, action.sessionId, {
      ...currentDraft,
      attachments: currentDraft.attachments.filter(
        (_, index) => index !== action.attachmentIndex
      ),
      attachmentError: null
    });
  }

  if (action.type === 'set-attachment-error') {
    return setDraft(drafts, action.sessionId, {
      ...currentDraft,
      attachmentError: action.attachmentError
    });
  }

  if (action.type === 'clear') {
    return setDraft(drafts, action.sessionId, EMPTY_DRAFT);
  }

  const restoredContent = action.content
    ? currentDraft.content
      ? `${action.content}\n${currentDraft.content}`
      : action.content
    : currentDraft.content;

  return setDraft(drafts, action.sessionId, {
    ...currentDraft,
    content: restoredContent,
    attachments: [...action.attachments, ...currentDraft.attachments]
  });
};
