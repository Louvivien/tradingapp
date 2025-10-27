class RateLimiter {
  constructor(requestsPerMinute) {
    this.requestsPerMinute = requestsPerMinute;
    this.requests = [];
  }

  async waitForSlot() {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;

    // Remove old requests
    this.requests = this.requests.filter(time => time > oneMinuteAgo);

    // If we've hit the limit, wait
    if (this.requests.length >= this.requestsPerMinute) {
      const oldestRequest = this.requests[0];
      const waitTime = 60000 - (now - oldestRequest);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      return this.waitForSlot();
    }

    // Add new request
    this.requests.push(now);
    return true;
  }
}

// Create instances for different API endpoints
const tradingLimiter = new RateLimiter(200); // 200 requests per minute for trading API
const dataLimiter = new RateLimiter(200); // 200 requests per minute for data API

module.exports = {
  tradingLimiter,
  dataLimiter
}; 