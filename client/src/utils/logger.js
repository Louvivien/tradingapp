/* eslint-disable no-console */

const isDev = process.env.NODE_ENV !== "production";

export const logDebug = (...args) => {
  if (isDev) {
    console.debug(...args);
  }
};

export const logInfo = (...args) => {
  if (isDev) {
    console.info(...args);
  }
};

export const logWarn = (...args) => {
  if (isDev) {
    console.warn(...args);
  }
};

export const logError = (...args) => {
  if (isDev) {
    console.error(...args);
  }
};

export default {
  logDebug,
  logInfo,
  logWarn,
  logError,
};
