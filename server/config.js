const path = require('path');
const os = require('os');
const fs = require('fs');

// Storage Directories
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const TEMP_UPLOAD_DIR = path.join(DATA_DIR, 'temp_transfers');
const VAULT_DIR = path.join(DATA_DIR, 'vault');

// Ensure directories exist
[DATA_DIR, TEMP_UPLOAD_DIR, VAULT_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

const config = {
  // HTTP / Web Server
  HTTP_PORT: process.env.PORT || 3300,
  
  // FTP Server
  FTP_PORT: process.env.FTP_PORT || 2121,
  FTP_PASV_URL: process.env.FTP_PASV_URL || '127.0.0.1',
  FTP_PASV_MIN: 10000,
  FTP_PASV_MAX: 10100,
  FTP_ANONYMOUS: true,
  FTP_USER: process.env.FTP_USER || 'admin',
  FTP_PASS: process.env.FTP_PASS || 'admin123',

  // Directories
  ROOT_DIR,
  DATA_DIR,
  TEMP_UPLOAD_DIR,
  VAULT_DIR,

  // Transfer defaults
  DEFAULT_EXPIRY_SECONDS: 600, // 10 minutes
  MAX_FILE_SIZE_BYTES: 10 * 1024 * 1024 * 1024, // 10 GB
  CLEANUP_INTERVAL_MS: 15 * 1000, // 15 seconds

  // Host Info
  HOST_NAME: os.hostname() || 'SendAnywhere LAN Node'
};

module.exports = config;
