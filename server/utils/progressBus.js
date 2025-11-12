const { EventEmitter } = require('events');

const emitter = new EventEmitter();
const subscribers = new Map();

const ensureJob = (jobId) => {
  if (!subscribers.has(jobId)) {
    subscribers.set(jobId, new Set());
  }
  return subscribers.get(jobId);
};

const addSubscriber = (jobId, res) => {
  const set = ensureJob(jobId);
  set.add(res);
};

const removeSubscriber = (jobId, res) => {
  const set = subscribers.get(jobId);
  if (!set) {
    return;
  }
  set.delete(res);
  if (!set.size) {
    subscribers.delete(jobId);
  }
};

const serializeEvent = (payload) => {
  const enriched = {
    timestamp: new Date().toISOString(),
    ...payload,
  };
  return `data: ${JSON.stringify(enriched)}\n\n`;
};

const publishProgress = (jobId, event) => {
  if (!jobId) {
    return;
  }
  const set = subscribers.get(jobId);
  if (!set || !set.size) {
    return;
  }
  const message = serializeEvent({ jobId, ...event });
  set.forEach((res) => {
    res.write(message);
  });
};

const completeProgress = (jobId, event) => {
  publishProgress(jobId, event);
  const set = subscribers.get(jobId);
  if (set && set.size) {
    set.forEach((res) => {
      try {
        res.end();
      } catch (error) {
        // ignore
      }
    });
  }
  subscribers.delete(jobId);
};

module.exports = {
  addSubscriber,
  removeSubscriber,
  publishProgress,
  completeProgress,
};
