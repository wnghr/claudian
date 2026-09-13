/**
 * Guardrails for the tool-first capability layer.
 *
 * These assertions keep one rule enforceable: a capability is implemented once,
 * as a plugin tool, and prompts may name tools but never shell commands.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';

const repositoryRoot = process.cwd();
const sourceRoot = path.join(repositoryRoot, 'src');
const providersRoot = path.join(sourceRoot, 'providers');
const catalogProbePath = path.join(repositoryRoot, 'scripts', 'plugin-tool-catalog.probe.ts');
const tsxEntryPath = path.join(repositoryRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function listTypeScriptFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...listTypeScriptFiles(entryPath));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(entryPath);
  }
  return files;
}

function normalizeRepositoryPath(filePath) {
  return filePath.replaceAll('\\', '/');
}

function findSourceFilesMatching(pattern, roots = [sourceRoot]) {
  const matches = [];
  for (const root of roots) {
    for (const file of listTypeScriptFiles(root)) {
      if (pattern.test(fs.readFileSync(file, 'utf8'))) {
        matches.push(normalizeRepositoryPath(path.relative(repositoryRoot, file)));
      }
    }
  }
  return matches.sort();
}

let cachedCatalog = null;

/** Loads the real tool catalog so the assertions cannot pass on a broken regex. */
function readToolCatalog() {
  if (cachedCatalog) return cachedCatalog;

  const result = spawnSync(process.execPath, [tsxEntryPath, catalogProbePath], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `plugin tool catalog probe failed:\n${result.stderr}`);

  const start = result.stdout.indexOf('{');
  const end = result.stdout.lastIndexOf('}');
  assert.notEqual(start, -1, `plugin tool catalog probe printed no JSON:\n${result.stdout}`);

  cachedCatalog = JSON.parse(result.stdout.slice(start, end + 1));
  return cachedCatalog;
}

test('the plugin tool catalog keeps exactly one owner per capability', () => {
  const catalog = readToolCatalog();

  assert.equal(catalog.catalogGuard, 'ok');
  assert.deepEqual(catalog.violations, []);
  assert.notEqual(catalog.toolNames.length, 0);
  assert.equal(new Set(catalog.toolNames).size, catalog.toolNames.length);
  assert.equal(new Set(catalog.capabilities).size, catalog.capabilities.length);
  assert.ok(catalog.registeredNames.includes('mcp__claudian__read_pdf'));
});

test('provider adapters derive every tool definition from the shared specification', () => {
  // The model-facing contract is written once, in the owning specification module.
  assert.deepEqual(
    findSourceFilesMatching(/Read a focused excerpt from the currently linked vault PDF/u),
    ['src/core/paper/PaperReadTool.ts'],
  );

  // A provider adapter that consumes a tool specification must not restate the
  // argument schema or the human-facing wording; it derives both.
  const specConsumers = findSourceFilesMatching(/_TOOL_SPEC\b|PLUGIN_TOOL_SPECS\b/u, [providersRoot]);
  assert.notEqual(specConsumers.length, 0, 'no provider adapter consumes a tool specification');
  assert.deepEqual(
    specConsumers.filter(file => (
      /additionalProperties|properties\s*:/u.test(
        fs.readFileSync(path.join(repositoryRoot, file), 'utf8'),
      )
    )),
    [],
  );
});

test('tool prompts name registered tools and never the retired shell chain', () => {
  const catalog = readToolCatalog();

  assert.deepEqual(catalog.retiredNameMentions, []);
  assert.deepEqual(catalog.shellCommandMentions, []);
  assert.deepEqual(catalog.toolsMissingToolMention, []);
});

/**
 * The retired engine (kb.py CLI + research_kb/obsidian MCP + the five routing
 * skills) was removed from the vault's prompt layer, not just from the code.
 * These patterns must never reappear in a surface the model actually reads:
 * rule files, skills, or the plugin systemPrompt. Bare `python` is allowed —
 * `.agents/import-paper.py` is the one sanctioned CLI the model may still run.
 */
const VAULT_PROMPT_PATTERNS = [
  '.agents/kb',
  'kb.py',
  'kb_search_server',
  'research_kb',
  'kb-paper',
  'kb-ask',
  'kb-save',
  'research-kb',
  'classify-new-papers',
  'read_paper',
  'read_note',
  'read_pdf_pages',
  'search_paper',
  'paper_parse_status',
  'pdftotext',
  'mineru-open-api',
  'uvx',
  'npx',
];

function vaultRoot() {
  return process.env.CLAUDIAN_VAULT_ROOT ?? path.join(repositoryRoot, '..', 'research');
}

function listVaultPromptFiles(root) {
  const files = [];
  const skillRoots = [
    path.join(root, '.agents', 'skills'),
    path.join(root, '.claude', 'skills'),
  ];
  for (const skillRoot of skillRoots) {
    if (!fs.existsSync(skillRoot)) continue;
    for (const entry of fs.readdirSync(skillRoot, { withFileTypes: true })) {
      const skillFile = path.join(skillRoot, entry.name, 'SKILL.md');
      if (entry.isDirectory() && fs.existsSync(skillFile)) files.push(skillFile);
    }
  }
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    const ruleFile = path.join(root, name);
    if (fs.existsSync(ruleFile)) files.push(ruleFile);
  }
  const settingsFile = path.join(root, '.claudian', 'claudian-settings.json');
  if (fs.existsSync(settingsFile)) files.push(settingsFile);
  return files;
}

test('vault prompt surfaces never mention the retired engine', (t) => {
  const root = vaultRoot();
  if (!fs.existsSync(root)) {
    t.skip(`vault root not found: ${root} (set CLAUDIAN_VAULT_ROOT to override)`);
    return;
  }

  const files = listVaultPromptFiles(root);
  assert.notEqual(files.length, 0, 'no vault prompt surfaces found');

  const violations = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of VAULT_PROMPT_PATTERNS) {
      if (text.includes(pattern)) {
        violations.push(`${path.relative(root, file)}: ${pattern}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('the .claude/skills mirror stays identical to .agents/skills', (t) => {
  const root = vaultRoot();
  const canonical = path.join(root, '.agents', 'skills');
  const mirror = path.join(root, '.claude', 'skills');
  if (!fs.existsSync(canonical) || !fs.existsSync(mirror)) {
    t.skip(`skill directories not found under ${root}`);
    return;
  }

  const digest = (dir) => {
    const entries = {};
    for (const skill of fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory())) {
      entries[skill.name] = fs.readFileSync(path.join(dir, skill.name, 'SKILL.md'), 'utf8');
    }
    return entries;
  };
  assert.deepEqual(digest(mirror), digest(canonical));
});

