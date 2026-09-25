import { projectUpdateProjection } from '@/app/collab/publish/projectUpdateProjection';
import type { CollabProjectUpdateInspection, CollabProjectUpdateOperation, CollabPublicationReview } from '@/core/collab';

const review: CollabPublicationReview = {
  kind: 'publication', intent: 'update', projectId: 'project-a', operationId: 'update-a',
  baseMainOid: 'a'.repeat(40), currentMainOid: 'b'.repeat(40), contributionHeadOid: 'c'.repeat(40),
  candidateOid: 'd'.repeat(40), comparisonBaseOid: 'b'.repeat(40), comparisonTargetOid: 'd'.repeat(40),
  files: [], canConfirm: true,
};
const publish: CollabProjectUpdateOperation = {
  kind: 'publish', requestId: 'request-a', workingReview: {
    kind: 'working-tree', projectId: 'project-a', baseOid: 'a'.repeat(40), headOid: 'c'.repeat(40),
    snapshotId: 'snapshot-a', files: [],
  },
};
type Facts = Omit<CollabProjectUpdateInspection, 'action'>;

// Expected actions express the user workflow: finish an existing operation before starting another.
const cases: { name: string; facts: Facts; action: CollabProjectUpdateInspection['action'] }[] = [
  { name: 'already included content', facts: { freshness: 'fresh', incoming: 'included', operation: { kind: 'none' } }, action: { kind: 'none', enabled: false } },
  { name: 'current content', facts: { freshness: 'fresh', incoming: 'current', operation: { kind: 'none' } }, action: { kind: 'none', enabled: false } },
  { name: 'unknown incoming content', facts: { freshness: 'not-fetched', incoming: 'unknown', operation: { kind: 'none' } }, action: { kind: 'none', enabled: false } },
  { name: 'available update', facts: { freshness: 'fresh', incoming: 'available', operation: { kind: 'none' } }, action: { kind: 'update', enabled: true } },
  { name: 'cached update offline', facts: { freshness: 'offline', incoming: 'available', operation: { kind: 'none' } }, action: { kind: 'update', enabled: false } },
  { name: 'unrefreshed update', facts: { freshness: 'not-fetched', incoming: 'available', operation: { kind: 'none' } }, action: { kind: 'update', enabled: false } },
  { name: 'pending publication before incoming update', facts: { freshness: 'fresh', incoming: 'available', operation: publish }, action: { kind: 'complete-publish', enabled: true } },
  { name: 'publication entry offline', facts: { freshness: 'offline', incoming: 'unknown', operation: publish }, action: { kind: 'complete-publish', enabled: true } },
  { name: 'conflict continuation', facts: { freshness: 'fresh', incoming: 'available', operation: { kind: 'update-conflict', conflictOperationId: 'update-a' } }, action: { kind: 'continue-update', enabled: true } },
  { name: 'offline conflict', facts: { freshness: 'offline', incoming: 'unknown', operation: { kind: 'update-conflict', conflictOperationId: 'update-a' } }, action: { kind: 'continue-update', enabled: false } },
  { name: 'interrupted update', facts: { freshness: 'fresh', incoming: 'included', operation: { kind: 'update-recovery' } }, action: { kind: 'continue-update', enabled: true } },
  { name: 'unrefreshed recovery', facts: { freshness: 'not-fetched', incoming: 'unknown', operation: { kind: 'update-recovery' } }, action: { kind: 'continue-update', enabled: false } },
];

describe('projectUpdateProjection', () => {
  it.each(cases)('offers the action for $name', ({ facts, action }) => {
    expect(projectUpdateProjection(facts)).toEqual({ ...facts, action });
  });

  it.each([
    ['fresh', true], ['offline', false], ['not-fetched', false],
  ] as const)('keeps review readable with %s authority and appropriate confirmation', (freshness, canConfirm) => {
    const facts: Facts = { freshness, incoming: 'unknown', operation: { kind: 'update-review', review } };
    expect(projectUpdateProjection(facts)).toEqual({
      ...facts, operation: { kind: 'update-review', review: { ...review, canConfirm } },
      action: { kind: 'review-update', enabled: true },
    });
    expect(review.canConfirm).toBe(true);
  });

  it('does not enable an unconfirmable review merely because authority is fresh', () => {
    const result = projectUpdateProjection({ freshness: 'fresh', incoming: 'available',
      operation: { kind: 'update-review', review: { ...review, canConfirm: false } } });
    expect(result.operation).toEqual({ kind: 'update-review', review: { ...review, canConfirm: false } });
  });
});
