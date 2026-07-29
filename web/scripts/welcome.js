#!/usr/bin/env node

/**
 * Welcome script - Shows getting started message and opens README
 * Runs automatically after first npm install, or manually with: npm run welcome
 */

const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const { setupEnvironment } = require('./setup-env');

const README_PATH = path.join(__dirname, '..', '..', 'README.md');
const MARKER_FILE = path.join(__dirname, '..', '.welcome-shown');

// Check if welcome has already been shown
if (fs.existsSync(MARKER_FILE)) {
  if (process.env.npm_lifecycle_event !== 'welcome') {
    // Silent exit during postinstall if already shown
    process.exit(0);
  }
  console.log('\n♻️  Re-running welcome (marker file will be updated)\n');
}

console.log('\n🎉 Welcome to the AI-Driven Development Template!\n');

// Setup environment variables
setupEnvironment();

console.log(
  '\n💡 Need help? Check the .template-docs\\Getting-Started.md file for development guidelines\n',
);

console.log('\nOpening README.md with getting started instructions...\n');

// Open README in default editor (VSCode if available)
const command =
  process.platform === 'win32'
    ? `code "${README_PATH}"`
    : `code "${README_PATH}" || open "${README_PATH}"`;

exec(command, (error) => {
  if (error) {
    console.log(
      '⚠️  Could not auto-open README (VSCode CLI may not be available)',
    );
    console.log('📖 Please open README.md manually to get started');
    if (process.platform === 'win32') {
      console.log('💡 Tip: Make sure VSCode is installed and in your PATH');
    }
  } else {
    console.log('✅ README.md opened in VSCode');
  }
});

// Create marker file to prevent showing again
fs.writeFileSync(MARKER_FILE, new Date().toISOString());
