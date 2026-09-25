import { collabWorkingCopySlugBase } from '@/app/collab/project/CollabWorkingCopySlug';

describe('collabWorkingCopySlugBase', () => {
  it.each([
    ['Collab Demo', 'collab-demo'],
    ['Café Notes', 'cafe-notes'],
    ['项目', 'project'],
    ['_Cloud Notes', 'cloud-notes'],
  ])('derives the portable directory base for %s', (name, expected) => {
    expect(collabWorkingCopySlugBase(name)).toBe(expected);
  });
});
