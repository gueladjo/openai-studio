import { describe, expect, it } from 'vitest';
import { Message } from '../types';
import {
  applyResponseStreamSnapshot,
  hasResponseStreamOutput,
  ResponseStreamState,
  responseStreamSnapshotMatchesMessage
} from './responseStreamState';

const placeholder = (): Message => ({
  id: 'assistant-1',
  role: 'assistant',
  content: '',
  status: 'streaming',
  timestamp: 1,
  modelName: 'GPT-5.6 Sol'
});

describe('ResponseStreamState', () => {
  it('previews pending deltas in output-index order without committing them', () => {
    const state = new ResponseStreamState();
    state.appendText('answer', 2, 'final_answer');
    state.appendText('note', 0, 'commentary');
    state.appendThinking('reasoning');

    expect(state.preview()).toEqual({
      content: 'answernote',
      outputMessages: [{
        content: 'note',
        phase: 'commentary'
      }, {
        content: 'answer',
        phase: 'final_answer'
      }],
      thinking: 'reasoning'
    });
    expect(state.preview()).toEqual(state.preview());
  });

  it('checkpoints text, phase, and thinking atomically', () => {
    const state = new ResponseStreamState();
    state.appendText('Part ', 1, 'commentary');
    state.appendText('one.', 1);
    state.appendThinking('Thought.');

    expect(state.checkpoint()).toEqual({
      snapshot: {
        content: 'Part one.',
        outputMessages: [{
          content: 'Part one.',
          phase: 'commentary'
        }],
        thinking: 'Thought.'
      },
      textChanged: true,
      thinkingChanged: true
    });
    expect(state.checkpoint()).toMatchObject({
      textChanged: false,
      thinkingChanged: false
    });
  });

  it('discards an uncommitted terminal tail together', () => {
    const state = new ResponseStreamState();
    state.appendText('kept', 0, 'final_answer');
    state.checkpoint();
    state.appendText('dropped', 0);
    state.appendThinking('also dropped');

    state.discardPending();

    expect(state.preview()).toEqual({
      content: 'kept',
      outputMessages: [{ content: 'kept', phase: 'final_answer' }],
      thinking: ''
    });
  });

  it('applies useful partial state and supplies the stopped fallback', () => {
    const message = placeholder();
    const empty = new ResponseStreamState().preview();
    expect(hasResponseStreamOutput(empty)).toBe(false);
    expect(applyResponseStreamSnapshot(message, empty, 'stopped', 2))
      .toMatchObject({ content: 'Stopped.', status: 'stopped', timestamp: 2 });

    const state = new ResponseStreamState();
    state.appendText('Partial.', 0, 'final_answer');
    const snapshot = state.preview();
    expect(hasResponseStreamOutput(snapshot)).toBe(true);
    expect(responseStreamSnapshotMatchesMessage(message, snapshot)).toBe(false);
    const applied = applyResponseStreamSnapshot(message, snapshot, 'streaming');
    expect(responseStreamSnapshotMatchesMessage(applied, snapshot)).toBe(true);
  });
});
