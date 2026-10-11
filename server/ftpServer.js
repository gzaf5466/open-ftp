const FtpSrv = require('ftp-srv');
const config = require('./config');
const { getPrimaryLanIP } = require('./utils');

class FtpServerManager {
  constructor() {
    this.ftpServer = null;
    this.isRunning = false;
    this.error = null;
  }

  start() {
    try {
      const primaryIP = getPrimaryLanIP();
      const pasvUrl = config.FTP_PASV_URL === '127.0.0.1' ? primaryIP : config.FTP_PASV_URL;

      this.ftpServer = new FtpSrv({
        url: `ftp://0.0.0.0:${config.FTP_PORT}`,
        pasv_url: pasvUrl,
        anonymous: config.FTP_ANONYMOUS,
        greeting: ['Welcome to SendAnywhere LAN FTP Server', 'Shared storage directory is ready.'],
        timeout: 30000
      });

      this.ftpServer.on('login', ({ connection, username, password }, resolve, reject) => {
        // Support anonymous or credentials
        if (config.FTP_ANONYMOUS && (username === 'anonymous' || !username)) {
          return resolve({ root: config.VAULT_DIR });
        }

        if (username === config.FTP_USER && password === config.FTP_PASS) {
          return resolve({ root: config.VAULT_DIR });
        }

        // Allow any user if anonymous is enabled
        if (config.FTP_ANONYMOUS) {
          return resolve({ root: config.VAULT_DIR });
        }

        return reject(new Error('Invalid FTP username or password'));
      });

      this.ftpServer.on('client-error', ({ connection, context, error }) => {
        console.warn('FTP Client warning:', error ? error.message : context);
      });

      this.ftpServer.listen()
        .then(() => {
          this.isRunning = true;
          this.error = null;
          console.log(`[FTP] Server listening on ftp://0.0.0.0:${config.FTP_PORT} (PASV: ${pasvUrl})`);
        })
        .catch(err => {
          this.isRunning = false;
          this.error = err.message;
          console.error('[FTP] Failed to start FTP server:', err.message);
        });

    } catch (err) {
      this.isRunning = false;
      this.error = err.message;
      console.error('[FTP] Initialization error:', err.message);
    }
  }

  stop() {
    if (this.ftpServer && this.isRunning) {
      return this.ftpServer.close().then(() => {
        this.isRunning = false;
      });
    }
    return Promise.resolve();
  }

  getStatus() {
    return {
      running: this.isRunning,
      port: config.FTP_PORT,
      anonymous: config.FTP_ANONYMOUS,
      user: config.FTP_USER,
      pass: config.FTP_PASS,
      vaultDir: config.VAULT_DIR,
      error: this.error
    };
  }
}

module.exports = new FtpServerManager();
