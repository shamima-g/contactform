#!/usr/bin/env node

/**
 * Environment setup script
 * - Creates .env.local from .env.example if it doesn't exist
 *
 * Run manually with: npm run setup:env
 * Also called automatically by the welcome script during postinstall
 */

const path = require('path');
const fs = require('fs');

const ENV_LOCAL_PATH = path.join(__dirname, '..', '.env.local');
const ENV_EXAMPLE_PATH = path.join(__dirname, '..', '.env.example');

// Allow silent mode for programmatic use
const silent = process.argv.includes('--silent');

function log(message) {
  if (!silent) {
    console.log(message);
  }
}

function setupEnvironment() {
  let envCreated = false;

  // Check if .env.local exists
  if (!fs.existsSync(ENV_LOCAL_PATH)) {
    if (fs.existsSync(ENV_EXAMPLE_PATH)) {
      fs.copyFileSync(ENV_EXAMPLE_PATH, ENV_LOCAL_PATH);
      envCreated = true;
      log('✅ Created .env.local from .env.example');
    } else {
      const basicEnv = `NEXT_PUBLIC_API_BASE_URL=http://localhost:8042\n`;
      fs.writeFileSync(ENV_LOCAL_PATH, basicEnv);
      envCreated = true;
      log('✅ Created .env.local');
    }
  }

  return { envCreated };
}

// Run if called directly
if (require.main === module) {
  setupEnvironment();
}

module.exports = { setupEnvironment };
