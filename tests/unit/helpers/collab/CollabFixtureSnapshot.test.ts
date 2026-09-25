import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CollabFixtureSnapshot } from '@test/helpers/collab/CollabFixtureSnapshot';

it('restores the prepared files after independent mutation and deletion scenarios', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claudian-fixture-isolation-'));
  const directory = path.join(root, 'participant');
  await mkdir(directory);
  await writeFile(path.join(directory, 'state.json'), '{"phase":"ready"}');
  const snapshot = await CollabFixtureSnapshot.capture(directory);
  try {
    await writeFile(path.join(directory, 'state.json'), '{"phase":"interrupted"}');
    await writeFile(path.join(directory, 'pending-operation'), 'unfinished');
    await snapshot.restore();
    expect(await readdir(directory)).toEqual(['state.json']);
    expect(await readFile(path.join(directory, 'state.json'), 'utf8')).toBe('{"phase":"ready"}');

    await rm(directory, { recursive: true });
    await snapshot.restore();
    expect(await readFile(path.join(directory, 'state.json'), 'utf8')).toBe('{"phase":"ready"}');
  } finally {
    await snapshot.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
