import {
  AssistantOutputMessage,
  AssistantPhase,
  Message
} from '../types';

export interface ResponseStreamSnapshot {
  content: string;
  outputMessages: AssistantOutputMessage[];
  thinking: string;
}

export interface ResponseStreamCheckpoint {
  snapshot: ResponseStreamSnapshot;
  textChanged: boolean;
  thinkingChanged: boolean;
}

interface PendingOutputDelta {
  delta: string;
  outputIndex: number;
  phase?: AssistantPhase;
}

const appendOutputDelta = (
  outputs: Map<number, AssistantOutputMessage>,
  { delta, outputIndex, phase }: PendingOutputDelta
): void => {
  const current = outputs.get(outputIndex);
  outputs.set(outputIndex, {
    content: `${current?.content || ''}${delta}`,
    ...(phase || current?.phase ? { phase: phase || current?.phase } : {})
  });
};

const orderedOutputs = (
  outputs: ReadonlyMap<number, AssistantOutputMessage>
): AssistantOutputMessage[] => (
  [...outputs.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, output]) => ({ ...output }))
);

export class ResponseStreamState {
  private content = '';
  private readonly outputMessages = new Map<number, AssistantOutputMessage>();
  private thinking = '';
  private pendingContent = '';
  private readonly pendingOutputDeltas: PendingOutputDelta[] = [];
  private pendingThinking = '';

  appendText(
    delta: string,
    outputIndex: number,
    phase?: AssistantPhase
  ): void {
    this.pendingContent += delta;
    this.pendingOutputDeltas.push({ delta, outputIndex, phase });
  }

  appendThinking(delta: string): void {
    this.pendingThinking += delta;
  }

  preview(): ResponseStreamSnapshot {
    const outputs = new Map(this.outputMessages);
    this.pendingOutputDeltas.forEach(delta => appendOutputDelta(outputs, delta));
    return {
      content: this.content + this.pendingContent,
      outputMessages: orderedOutputs(outputs),
      thinking: this.thinking + this.pendingThinking
    };
  }

  checkpoint(): ResponseStreamCheckpoint {
    const textChanged = this.pendingContent.length > 0 ||
      this.pendingOutputDeltas.length > 0;
    const thinkingChanged = this.pendingThinking.length > 0;

    this.content += this.pendingContent;
    this.pendingOutputDeltas.forEach(delta => (
      appendOutputDelta(this.outputMessages, delta)
    ));
    this.thinking += this.pendingThinking;
    this.clearPending();

    return {
      snapshot: {
        content: this.content,
        outputMessages: orderedOutputs(this.outputMessages),
        thinking: this.thinking
      },
      textChanged,
      thinkingChanged
    };
  }

  discardPending(): void {
    this.clearPending();
  }

  private clearPending(): void {
    this.pendingContent = '';
    this.pendingOutputDeltas.length = 0;
    this.pendingThinking = '';
  }
}

export const hasResponseStreamOutput = (
  snapshot: ResponseStreamSnapshot
): boolean => Boolean(
  snapshot.content || snapshot.thinking || snapshot.outputMessages.length
);

const outputMessagesEqual = (
  left?: AssistantOutputMessage[],
  right?: AssistantOutputMessage[]
): boolean => (
  left === right || (
    left?.length === right?.length &&
    Boolean(left?.every((output, index) => (
      output.content === right?.[index].content &&
      output.phase === right[index].phase
    )))
  )
);

export const applyResponseStreamSnapshot = (
  message: Message,
  snapshot: ResponseStreamSnapshot,
  status: 'streaming' | 'stopped',
  timestamp = message.timestamp
): Message => ({
  ...message,
  content: snapshot.content || message.content || (status === 'stopped' ? 'Stopped.' : ''),
  outputMessages: snapshot.outputMessages.length
    ? snapshot.outputMessages
    : message.outputMessages,
  thinking: snapshot.thinking || message.thinking,
  status,
  timestamp
});

export const responseStreamSnapshotMatchesMessage = (
  message: Message,
  snapshot: ResponseStreamSnapshot
): boolean => {
  const applied = applyResponseStreamSnapshot(message, snapshot, 'streaming');
  return message.content === applied.content &&
    outputMessagesEqual(message.outputMessages, applied.outputMessages) &&
    (message.thinking || '') === (applied.thinking || '');
};
