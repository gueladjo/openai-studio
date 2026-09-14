import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const generatedDirectories = [
  'dist',
  'dist-ssr',
  'logs',
  'node_modules',
  'release',
];
// Tool-generated Git refs that live outside the working tree. Their deeply
// nested names break Windows MAX_PATH when the repository is copied out of WSL.
const generatedNestedDirectories = ['.git/refs/codex'];
const generatedFilePatterns = [
  /\.log(?:\..*)?$/,
  /^(?:npm|yarn|pnpm|lerna)-debug\.log.*$/,
  /^yarn-error\.log.*$/,
];

const exists = async (relativePath) => {
  try {
    await stat(join(projectRoot, relativePath));
    return true;
  } catch {
    return false;
  }
};

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const unsupportedArgs = args.filter((arg) => arg !== '--dry-run');

if (unsupportedArgs.length > 0) {
  console.error(`Unsupported argument: ${unsupportedArgs.join(', ')}`);
  process.exitCode = 1;
} else {
  const rootEntries = await readdir(projectRoot, { withFileTypes: true });
  const rootEntryNames = new Set(rootEntries.map((entry) => entry.name));
  const generatedFiles = rootEntries
    .filter(
      (entry) =>
        entry.isFile() &&
        generatedFilePatterns.some((pattern) => pattern.test(entry.name)),
    )
    .map((entry) => entry.name);
  const presentNestedDirectories = [];
  for (const nestedDirectory of generatedNestedDirectories) {
    if (await exists(nestedDirectory)) {
      presentNestedDirectories.push(nestedDirectory);
    }
  }
  const targets = [
    ...generatedDirectories.filter((name) => rootEntryNames.has(name)),
    ...presentNestedDirectories,
    ...generatedFiles,
  ].sort();

  if (targets.length === 0) {
    console.log('Nothing to clean.');
  } else {
    for (const target of targets) {
      if (!dryRun) {
        await rm(join(projectRoot, target), { force: true, recursive: true });
      }
      console.log(`${dryRun ? 'Would remove' : 'Removed'} ${target}`);
    }
  }
}
