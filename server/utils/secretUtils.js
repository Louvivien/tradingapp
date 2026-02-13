const CryptoJS = require('crypto-js');

const normalizeEnvValue = (value) => String(value || '').trim();

const getEncryptionKey = () =>
  normalizeEnvValue(process.env.ENCRYPTION_KEY || process.env.CryptoJS_secret_key) || null;

const looksLikeCryptoJSCiphertext = (value) => normalizeEnvValue(value).startsWith('U2Fsd');

const decryptIfEncrypted = (value) => {
  const raw = normalizeEnvValue(value);
  if (!raw) {
    return '';
  }
  if (!looksLikeCryptoJSCiphertext(raw)) {
    return raw;
  }
  const key = getEncryptionKey();
  if (!key) {
    throw new Error('ENCRYPTION_KEY/CryptoJS_secret_key is not configured.');
  }
  const bytes = CryptoJS.AES.decrypt(raw, key);
  const decrypted = bytes.toString(CryptoJS.enc.Utf8);
  return normalizeEnvValue(decrypted);
};

const encryptIfPlaintext = (value) => {
  const raw = normalizeEnvValue(value);
  if (!raw) {
    return '';
  }
  if (looksLikeCryptoJSCiphertext(raw)) {
    return raw;
  }
  const key = getEncryptionKey();
  if (!key) {
    throw new Error('ENCRYPTION_KEY/CryptoJS_secret_key is not configured.');
  }
  return CryptoJS.AES.encrypt(raw, key).toString();
};

const maskKey = (value) => {
  const raw = normalizeEnvValue(value);
  if (!raw) return null;
  if (raw.length <= 8) {
    return `${raw.slice(0, 2)}…${raw.slice(-2)}`;
  }
  return `${raw.slice(0, 2)}…${raw.slice(-4)}`;
};

module.exports = {
  looksLikeCryptoJSCiphertext,
  decryptIfEncrypted,
  encryptIfPlaintext,
  maskKey,
};

