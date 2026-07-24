import { describe, expect, it } from 'vitest';
import {
  chatDraftsReducer,
  ChatDraftsState,
  getChatDraft
} from './chatDrafts';

const secretFile = (name: string): File => ({ name } as File);

describe('chatDraftsReducer', () => {
  it('keeps text, files, and validation errors isolated by session', () => {
    const firstFile = secretFile('first-secret.pdf');
    const secondFile = secretFile('second-secret.pdf');
    let drafts: ChatDraftsState = {};

    drafts = chatDraftsReducer(drafts, {
      type: 'set-content',
      sessionId: 'session-a',
      content: 'Draft A'
    });
    drafts = chatDraftsReducer(drafts, {
      type: 'set-attachments',
      sessionId: 'session-a',
      attachments: [firstFile],
      attachmentError: 'A-only error'
    });
    drafts = chatDraftsReducer(drafts, {
      type: 'set-content',
      sessionId: 'session-b',
      content: 'Draft B'
    });
    drafts = chatDraftsReducer(drafts, {
      type: 'set-attachments',
      sessionId: 'session-b',
      attachments: [secondFile],
      attachmentError: null
    });

    expect(getChatDraft(drafts, 'session-a')).toEqual({
      content: 'Draft A',
      attachments: [firstFile],
      attachmentError: 'A-only error'
    });
    expect(getChatDraft(drafts, 'session-b')).toEqual({
      content: 'Draft B',
      attachments: [secondFile],
      attachmentError: null
    });
  });

  it('restores a failed submission only into its captured target session', () => {
    const submittedFile = secretFile('submitted-secret.pdf');
    const laterFile = secretFile('later-secret.pdf');
    let drafts: ChatDraftsState = {
      'session-b': {
        content: 'Unrelated B draft',
        attachments: [],
        attachmentError: null
      }
    };

    drafts = chatDraftsReducer(drafts, {
      type: 'clear',
      sessionId: 'session-a'
    });
    drafts = chatDraftsReducer(drafts, {
      type: 'set-content',
      sessionId: 'session-a',
      content: 'Typed after submitting'
    });
    drafts = chatDraftsReducer(drafts, {
      type: 'set-attachments',
      sessionId: 'session-a',
      attachments: [laterFile],
      attachmentError: null
    });
    drafts = chatDraftsReducer(drafts, {
      type: 'restore-submission',
      sessionId: 'session-a',
      content: 'Original submission',
      attachments: [submittedFile]
    });

    expect(getChatDraft(drafts, 'session-a')).toEqual({
      content: 'Original submission\nTyped after submitting',
      attachments: [submittedFile, laterFile],
      attachmentError: null
    });
    expect(getChatDraft(drafts, 'session-b').content).toBe('Unrelated B draft');
  });

  it('prunes deleted sessions and resets drafts when the workspace changes', () => {
    const drafts: ChatDraftsState = {
      'session-a': {
        content: 'Keep me',
        attachments: [],
        attachmentError: null
      },
      'session-deleted': {
        content: 'Confidential',
        attachments: [secretFile('deleted-secret.pdf')],
        attachmentError: null
      }
    };

    const pruned = chatDraftsReducer(drafts, {
      type: 'prune',
      sessionIds: ['session-a']
    });
    expect(Object.keys(pruned)).toEqual(['session-a']);
    expect(chatDraftsReducer(pruned, { type: 'reset' })).toEqual({});
  });
});
