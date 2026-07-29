#!/usr/bin/env node

/**
 * Pre-install script to check Node.js version
 * Provides a friendly error message if Node version is too old
 *
 * Required: Node.js 22 LTS or higher
 */

const REQUIRED_NODE_VERSION = 22;

const currentVersion = process.versions.node;
const majorVersion = parseInt(currentVersion.split('.')[0], 10);

if (majorVersion < REQUIRED_NODE_VERSION) {
  console.error(`
╔════════════════════════════════════════════════════════════════╗
║                                                                ║
║   ❌  Node.js version ${REQUIRED_NODE_VERSION}+ is required                          ║
║                                                                ║
║   Your version: ${currentVersion.padEnd(44)}║
║   Required:     ${REQUIRED_NODE_VERSION}.0.0 or higher${' '.repeat(32)}║
║                                                                ║
║   How to fix:                                                  ║
║   1. Download Node.js LTS from https://nodejs.org/             ║
║   2. Or use nvm: nvm install ${REQUIRED_NODE_VERSION} && nvm use ${REQUIRED_NODE_VERSION}                    ║
║                                                                ║
╚════════════════════════════════════════════════════════════════╝
`);
  process.exit(1);
}

// Success - no output needed, let install continue
