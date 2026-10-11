const os = require('os');
const path = require('path');
const mime = require('mime-types');

/**
 * Get all available IPv4 LAN addresses and localhost
 */
function getNetworkInterfacesList() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Skip internal (i.e. 127.0.0.1) and non-IPv4 addresses
      if (iface.family === 'IPv4') {
        addresses.push({
          interface: name,
          address: iface.address,
          isInternal: iface.internal,
          label: iface.internal ? 'Localhost' : `${name} (${iface.address})`
        });
      }
    }
  }

  // Ensure 127.0.0.1 is included if not present
  if (!addresses.some(a => a.address === '127.0.0.1')) {
    addresses.push({
      interface: 'Loopback',
      address: '127.0.0.1',
      isInternal: true,
      label: 'Localhost (127.0.0.1)'
    });
  }

  return addresses;
}

/**
 * Get primary LAN IP (prioritizing Wi-Fi / Ethernet non-internal)
 */
function getPrimaryLanIP() {
  const all = getNetworkInterfacesList();
  const lan = all.find(a => !a.isInternal && !a.address.startsWith('169.254'));
  return lan ? lan.address : '127.0.0.1';
}

/**
 * Generate a random 6-digit numeric key (e.g. "849201")
 */
function generate6DigitPin(existingPins = new Set()) {
  let pin = '';
  let attempts = 0;
  do {
    // 6-digit numeric string
    pin = Math.floor(100000 + Math.random() * 900000).toString();
    attempts++;
  } while (existingPins.has(pin) && attempts < 100);
  return pin;
}

/**
 * Format bytes to human readable string
 */
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

/**
 * Categorize a file by extension / mime type
 */
function categorizeFile(filename, mimeType) {
  const ext = path.extname(filename).toLowerCase().replace('.', '');
  const type = (mimeType || mime.lookup(filename) || '').toLowerCase();

  if (type.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'avif'].includes(ext)) {
    return 'image';
  }
  if (type.startsWith('video/') || ['mp4', 'mkv', 'avi', 'mov', 'webm', 'wmv', 'flv', 'm4v'].includes(ext)) {
    return 'video';
  }
  if (type.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma'].includes(ext)) {
    return 'audio';
  }
  if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'csv', 'epub'].includes(ext) || type.includes('pdf') || type.includes('document')) {
    return 'document';
  }
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso'].includes(ext) || type.includes('zip') || type.includes('archive')) {
    return 'archive';
  }
  if (['js', 'ts', 'jsx', 'tsx', 'html', 'css', 'json', 'py', 'java', 'c', 'cpp', 'cs', 'go', 'rs', 'php', 'rb', 'sh', 'sql', 'yaml', 'yml', 'xml', 'md'].includes(ext)) {
    return 'code';
  }
  return 'file';
}

/**
 * Clean and sanitize filename
 */
function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._\- ()\u00C0-\u024F\u1E00-\u1EFF\u0600-\u06FF\u4E00-\u9FFF]/g, '_');
}

/**
 * Get friendly device name from User-Agent and IP
 */
function getDeviceNameFromUA(userAgent = '', ip = '') {
  let osName = 'Unknown Device';
  if (/windows nt 10/i.test(userAgent)) osName = 'Windows 10/11 PC';
  else if (/windows/i.test(userAgent)) osName = 'Windows PC';
  else if (/macintosh|mac os x/i.test(userAgent)) osName = 'MacBook / Mac';
  else if (/iphone/i.test(userAgent)) osName = 'iPhone';
  else if (/ipad/i.test(userAgent)) osName = 'iPad';
  else if (/android/i.test(userAgent)) osName = 'Android Device';
  else if (/linux/i.test(userAgent)) osName = 'Linux PC';

  let browser = '';
  if (/edg/i.test(userAgent)) browser = 'Edge';
  else if (/chrome|crios/i.test(userAgent)) browser = 'Chrome';
  else if (/safari/i.test(userAgent) && !/chrome/i.test(userAgent)) browser = 'Safari';
  else if (/firefox|fxios/i.test(userAgent)) browser = 'Firefox';

  const cleanIP = ip.replace(/^.*:/, '') || 'LAN';
  return `${osName} (${browser || 'Browser'} • ${cleanIP})`;
}

module.exports = {
  getNetworkInterfacesList,
  getPrimaryLanIP,
  generate6DigitPin,
  formatBytes,
  categorizeFile,
  sanitizeFilename,
  getDeviceNameFromUA
};
