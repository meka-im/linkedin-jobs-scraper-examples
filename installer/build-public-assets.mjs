import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

const ROOT_FILES = Object.freeze([
  'index.html',
  'styles.css',
]);

const LIB_FILES = Object.freeze([
  'app-controller.js',
  'credentials.js',
  'errors.js',
  'http-transport.js',
  'install-recovery.js',
  'install.js',
  'mcp-client.js',
  'node-options.js',
  'oauth-session.js',
  'oauth.js',
  'pkce.js',
  'settings-proof.js',
  'verify-install.js',
  'workflow-code.js',
  'workspace.js',
]);

async function copy(relativePath, outputDirectory) {
  const source = path.join(here, relativePath);
  const destination = path.join(outputDirectory, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

async function assertOnlyPublicExtensions(outputDirectory) {
  const entries = await readdir(outputDirectory, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!['.html', '.css', '.js', '.svg'].includes(path.extname(entry.name))) {
      throw new Error(`Unexpected public asset type: ${entry.name}`);
    }
  }
}

export async function buildPublicAssets(outputDirectory = path.join(here, 'dist')) {
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });

  for (const file of ROOT_FILES) await copy(file, outputDirectory);
  await copy('app.js', outputDirectory);
  for (const file of LIB_FILES) await copy(path.join('lib', file), outputDirectory);
  await copy(path.join('generated', 'workflow-template.js'), outputDirectory);
  await copy(path.join('generated', 'workflow-manifest.js'), outputDirectory);
  const bannerDestination = path.join(outputDirectory, 'assets', 'banner.svg');
  await mkdir(path.dirname(bannerDestination), { recursive: true });
  await copyFile(path.join(here, '..', 'assets', 'banner.svg'), bannerDestination);

  for (const forbidden of [
    'server.mjs',
    'worker/index.mjs',
    'lib/relay-policy.js',
    'lib/security-headers.js',
    'package-lock.json',
    'wrangler.toml',
  ]) {
    try {
      await stat(path.join(outputDirectory, forbidden));
      throw new Error(`Forbidden Node-only file entered public assets: ${forbidden}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  await assertOnlyPublicExtensions(outputDirectory);
  return outputDirectory;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputDirectory = await buildPublicAssets();
  process.stdout.write(`Built public installer assets in ${outputDirectory}\n`);
}
