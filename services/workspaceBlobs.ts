import type { LocalBlobReference, Project, Session } from '../types';

export function* iterateWorkspaceBlobReferences(
  sessions: readonly Session[],
  projects: readonly Project[] = []
): IterableIterator<LocalBlobReference> {
  for (const session of sessions) {
    for (const message of session.messages) {
      for (const attachment of message.attachments || []) {
        if (attachment.localBlob) yield attachment.localBlob;
      }
      for (const file of message.generatedFiles || []) {
        if (file.localBlob) yield file.localBlob;
      }
    }
  }
  for (const project of projects) {
    for (const source of project.sources) yield source.localBlob;
  }
}
