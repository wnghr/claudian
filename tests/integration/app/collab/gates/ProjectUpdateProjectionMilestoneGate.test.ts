import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CollabFixtureSnapshot } from '@test/helpers/collab/CollabFixtureSnapshot';
import {
  accept,
  availablePort,
  projectUpdateMilestoneFixture,
  publishFully,
  unwrap,
  waitFor,
} from '@test/helpers/collab/ProjectUpdateMilestoneFixture';
import { TEST_INSTALLATION_A, TEST_INSTALLATION_B } from '@test/helpers/installations';

import { InvitationCodec } from '@/app/collab/lan/InvitationCodec';

jest.setTimeout(90_000);

describe('Project Update projection milestone gate', () => {
  const { closeParticipants, createRoot, createFoundation, createFeature } = projectUpdateMilestoneFixture();

  let prepared: Awaited<ReturnType<typeof prepare>>;
  let snapshot: CollabFixtureSnapshot;

  beforeAll(async () => {
    try {
      prepared = await prepare();
    } finally {
      await closeParticipants();
    }
    snapshot = await CollabFixtureSnapshot.capture(prepared.root);
  });

  beforeEach(async () => { await snapshot.restore(); });
  afterAll(async () => { await snapshot?.dispose(); });

  async function prepare() {
    const root = await createRoot('claudian-update-projection-');
    const hostRoot = path.join(root, 'host');
    const memberRoot = path.join(root, 'member');
    await Promise.all([mkdir(hostRoot), mkdir(memberRoot)]);
    const codec = new InvitationCodec({ isAddressAllowed: address => address === '127.0.0.1' });
    const hostPort = await availablePort();
    const host = createFoundation(hostRoot, codec, hostPort);
    const member = createFoundation(memberRoot, codec);
    const hostFeature = createFeature(host, hostRoot, TEST_INSTALLATION_A);
    const memberFeature = createFeature(member, memberRoot, TEST_INSTALLATION_B);
    unwrap(await hostFeature.initialize());
    unwrap(await memberFeature.initialize());
    const project = unwrap(await hostFeature.createProject({ memberDisplayName: 'Manager', name: 'Update projection' }));
    const projectId = project.id;
    const hostPath = path.join(hostRoot, project.workspacePath);
    await writeFile(path.join(hostPath, 'shared.md'), 'base\n');
    await accept(hostFeature, projectId, (await publishFully(hostFeature, projectId)).request!.id);
    const invitation = unwrap(await hostFeature.createInvitation(projectId));
    const joined = unwrap(await memberFeature.joinProject({ encodedInvitation: invitation.encodedInvitation, memberDisplayName: 'Member' }));
    const memberPath = path.join(memberRoot, joined.workspacePath);
    return { root, hostRoot, memberRoot, hostPath, memberPath, codec, hostPort, projectId };
  }

  it.each(['matching-working-content', 'offline-update', 'offline-review'] as const)('projects the actionable Update state for %s', async scenario => {
    const { hostRoot, memberRoot, hostPath, memberPath, codec, hostPort, projectId } = prepared;
    const host = createFoundation(hostRoot, codec, hostPort);
    const member = createFoundation(memberRoot, codec);
    const hostFeature = createFeature(host, hostRoot, TEST_INSTALLATION_A);
    const memberFeature = createFeature(member, memberRoot, TEST_INSTALLATION_B);
    unwrap(await hostFeature.initialize());
    unwrap(await hostFeature.startHost(projectId));
    unwrap(await memberFeature.initialize());
    await writeFile(path.join(memberPath, 'draft.md'), 'private staged work\n');
    const git = await member.requireGitFoundation();
    await git.repositories.stageAll(memberPath);
    await writeFile(path.join(memberPath, 'draft.md'), 'private staged work\nand unstaged work\n');
    await writeFile(path.join(memberPath, 'shared.md'), scenario === 'offline-update' ? 'conflicting local edit\n' : 'team content\n');
    const headBefore = await git.repositories.resolveRef(memberPath, 'HEAD');
    const indexBefore = await readFile(path.join(memberPath, '.git', 'index'));
    await writeFile(path.join(hostPath, 'shared.md'), 'team content\n');
    if (scenario === 'offline-review') await writeFile(path.join(hostPath, 'team.md'), 'incoming review file\n');
    await accept(hostFeature, projectId, (await publishFully(hostFeature, projectId)).request!.id);
    const acceptedMain = unwrap(await hostFeature.inspectProject(projectId)).coordination!.snapshot.project.mainOid;
    await waitFor(async () => {
      const current = unwrap(await memberFeature.inspectProject(projectId));
      return current.coordination?.snapshot.project.mainOid === acceptedMain && current.gitStatus?.acceptedMainOid === acceptedMain;
    });
    let preparation: string | undefined;
    if (scenario === 'offline-update' || scenario === 'offline-review') {
      const updated = await memberFeature.updateProject(projectId);
      preparation = updated.status === 'success' ? updated.value.state : updated.status;
      unwrap(await hostFeature.stopHost(projectId));
    }
    const inspected = unwrap(await memberFeature.inspectProject(projectId));
    expect(preparation).toBe(scenario === 'offline-review' ? 'review-required' : scenario === 'offline-update' ? 'conflict' : undefined);
    expect(inspected.projectUpdate).toMatchObject(scenario === 'matching-working-content'
      ? { freshness: 'fresh', incoming: 'included', operation: { kind: 'none' }, action: { kind: 'none', enabled: false } }
      : scenario === 'offline-update'
        ? { freshness: 'offline', incoming: 'unknown', operation: { kind: 'update-conflict' }, action: { kind: 'continue-update', enabled: false } }
        : { freshness: 'offline', incoming: 'unknown', operation: { kind: 'update-review', review: { canConfirm: false } }, action: { kind: 'review-update', enabled: true } });
    if (scenario === 'matching-working-content') {
      const afterHead = await git.repositories.resolveRef(memberPath, 'HEAD');
      const afterIndex = await readFile(path.join(memberPath, '.git', 'index'));
      if (afterHead !== headBefore || !afterIndex.equals(indexBefore)) throw new Error('Inspection changed the real HEAD or index');
    }
    expect(await readFile(path.join(memberPath, 'draft.md'), 'utf8')).toBe('private staged work\nand unstaged work\n');
  });
});
