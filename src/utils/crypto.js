const crypto = require('crypto');

function getKey() {
  const hex = process.env.APP_ENCRYPTION_KEY || '';
  if (!/^[a-fA-F0-9]{64}$/.test(hex)) {
    throw new Error('APP_ENCRYPTION_KEY deve ter exatamente 64 caracteres hexadecimais (32 bytes).');
  }
  return Buffer.from(hex, 'hex');
}

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decrypt(payload) {
  const data = Buffer.from(payload, 'base64');
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const encrypted = data.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
