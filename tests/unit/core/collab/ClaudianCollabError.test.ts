import { decodeCollabProtocolEnvelope } from '@claudian-collab/protocol';

import {
  CollabError,
  collabErrorGroup,
} from '@/core/collab/ClaudianCollabError';

describe('ClaudianCollabError', () => {
  it('groups application-only errors for recovery', () => {
    expect(collabErrorGroup('invitation-expired')).toBe('connectivity');
  });

  it('recognizes canonical package errors at the application boundary', () => {
    const decoded = decodeCollabProtocolEnvelope({});
    expect(decoded.status).toBe('invalid');
    if (decoded.status !== 'invalid') throw new Error('Expected an invalid envelope');
    expect(decoded.error).toBeInstanceOf(CollabError);
  });

  it('serializes application-only errors with shared redaction', () => {
    const error = new CollabError({
      code: 'invitation-expired',
      recoveryActions: ['refresh-invitation'],
      safeContext: {
        invitationSecret: 'never-serialize',
        projectId: 'project_1',
      },
    });

    expect(error.toJSON()).toMatchObject({
      code: 'invitation-expired',
      group: 'connectivity',
      recoveryActions: ['refresh-invitation'],
      safeContext: { projectId: 'project_1' },
    });
  });
});
