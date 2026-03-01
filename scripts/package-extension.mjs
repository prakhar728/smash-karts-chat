#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--server-url') out.serverUrl = argv[++i];
    else if (arg === '--oauth-client-id') out.oauthClientId = argv[++i];
    else if (arg === '--zip-path') out.zipPath = argv[++i];
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/package-extension.mjs --server-url <https://chat.example.com> --oauth-client-id <client_id> [--zip-path <output.zip>]',
    '',
    'Examples:',
    '  node scripts/package-extension.mjs --server-url https://smash-karts-chat.up.railway.app --oauth-client-id 123.apps.googleusercontent.com',
  ].join('\n');
}

function normalizeServerUrl(input) {
  const url = new URL(input);
  const secure = url.protocol === 'https:' || url.protocol === 'wss:';
  const wsProtocol = secure ? 'wss:' : 'ws:';
  const httpProtocol = secure ? 'https:' : 'http:';

  let basePath = url.pathname.replace(/\/+$/, '');
  if (basePath.endsWith('/ws')) basePath = basePath.slice(0, -3);
  if (basePath.endsWith('/log')) basePath = basePath.slice(0, -4);

  const pathPrefix = basePath ? `${basePath}` : '';
  const wsBase = `${wsProtocol}//${url.host}${pathPrefix}/ws`;
  const logUrl = `${httpProtocol}//${url.host}${pathPrefix}/log`;

  return {
    wsBase,
    logUrl,
    httpPermission: `${httpProtocol}//${url.host}/*`,
    wsPermission: `${wsProtocol}//${url.host}/*`,
  };
}

function patchBackground(backgroundPath, wsBase, logUrl) {
  let text = readFileSync(backgroundPath, 'utf8');
  const wsPattern = /^const WS_BASE = '.*';$/m;
  const logPattern = /^const LOG_URL = '.*';$/m;

  if (!wsPattern.test(text)) {
    throw new Error('Could not find WS_BASE in background.js');
  }
  if (!logPattern.test(text)) {
    throw new Error('Could not find LOG_URL in background.js');
  }

  text = text.replace(wsPattern, `const WS_BASE = '${wsBase}';`);
  text = text.replace(logPattern, `const LOG_URL = '${logUrl}';`);
  writeFileSync(backgroundPath, text, 'utf8');
}

function patchManifest(manifestPath, oauthClientId, httpPermission, wsPermission) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.oauth2 = manifest.oauth2 || {};
  manifest.oauth2.client_id = oauthClientId;
  manifest.host_permissions = [
    'https://www.googleapis.com/*',
    httpPermission,
    wsPermission,
    'https://smashkarts.io/*',
  ];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }

  if (!args.serverUrl || !args.oauthClientId) {
    console.error(usage());
    process.exit(1);
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, '..');
  const extensionDir = path.join(repoRoot, 'extension');
  const distRoot = path.join(repoRoot, 'dist');
  const stagingDir = path.join(distRoot, 'extension-release');
  const zipPath = path.resolve(args.zipPath || path.join(distRoot, 'smash-karts-chat-extension.zip'));

  const { wsBase, logUrl, httpPermission, wsPermission } = normalizeServerUrl(args.serverUrl);

  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(distRoot, { recursive: true });

  cpSync(extensionDir, stagingDir, {
    recursive: true,
    filter: (src) => !src.endsWith('.DS_Store'),
  });

  patchBackground(path.join(stagingDir, 'background.js'), wsBase, logUrl);
  patchManifest(path.join(stagingDir, 'manifest.json'), args.oauthClientId, httpPermission, wsPermission);

  if (existsSync(zipPath)) {
    unlinkSync(zipPath);
  }

  const zipResult = spawnSync('zip', ['-r', zipPath, '.', '-x', '*.DS_Store'], {
    cwd: stagingDir,
    stdio: 'inherit',
  });

  if (zipResult.status !== 0) {
    throw new Error('zip command failed while creating extension artifact');
  }

  console.log('Created extension artifact:');
  console.log(`  ${zipPath}`);
  console.log('Release values applied:');
  console.log(`  WS_BASE=${wsBase}`);
  console.log(`  LOG_URL=${logUrl}`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
