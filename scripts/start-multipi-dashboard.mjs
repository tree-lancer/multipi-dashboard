#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dashboardHome = process.env.OPENGRAM_HOME || path.join(homedir(), '.pi', 'bus', 'dashboard');
const port = Number(process.env.MULTIPI_DASHBOARD_PORT || 43872);
const configPath = path.join(dashboardHome, 'opengram.config.json');

mkdirSync(dashboardHome, { recursive: true });
const existing = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
const config = {
  ...existing,
  appName: 'multipi bus',
  agents: [{ id: 'multipi-bus', name: 'multipi bus', description: 'Read-only multipi bus dashboard bridge.', defaultModelId: 'multipi-bus' }],
  models: [{ id: 'multipi-bus', name: 'multipi bus', description: 'Bus event stream model.' }],
  defaultModelIdForNewChats: 'multipi-bus',
  push: { enabled: false, vapidPublicKey: '', vapidPrivateKey: '', subject: '' },
  security: { instanceSecretEnabled: false, instanceSecret: '', readEndpointsRequireInstanceSecret: false },
  server: {
    ...(existing.server || {}),
    publicBaseUrl: `http://127.0.0.1:${port}`,
    port,
  },
};
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

const env = {
  ...process.env,
  OPENGRAM_HOME: dashboardHome,
  OPENGRAM_CONFIG_PATH: configPath,
  MULTIPI_DASHBOARD_URL: `http://127.0.0.1:${port}`,
};
const opengram = spawn(process.execPath, [path.join(sourceRoot, 'apps/web/dist/cli/cli.js'), 'start', '--port', String(port)], {
  cwd: sourceRoot,
  env,
  stdio: 'inherit',
});
const bridge = spawn(process.execPath, [path.join(sourceRoot, 'scripts/multipi-bridge.mjs')], {
  cwd: sourceRoot,
  env,
  stdio: 'inherit',
});

const stop = () => {
  bridge.kill('SIGTERM');
  opengram.kill('SIGTERM');
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
opengram.on('exit', (code) => { bridge.kill('SIGTERM'); process.exit(code ?? 0); });
bridge.on('exit', (code) => { if (code && !opengram.killed) console.error(`multipi bridge exited with ${code}`); });
