export class PollFailureTracker {
  constructor({ threshold, windowMs, now = Date.now }) {
    this.threshold = threshold;
    this.windowMs = windowMs;
    this.now = now;
    this.failures = [];
  }

  recordFailure() {
    const currentTime = this.now();
    const cutoff = currentTime - this.windowMs;
    this.failures = this.failures.filter((timestamp) => timestamp > cutoff);
    this.failures.push(currentTime);

    return {
      count: this.failures.length,
      shouldRestart: this.failures.length >= this.threshold,
    };
  }
}

export function formatError(error) {
  const message = error?.message || String(error);
  const cause = error?.cause;
  if (!cause) {
    return message;
  }

  const causeMessage = cause.message || String(cause);
  const causeCode = cause.code ? ` [${cause.code}]` : "";
  if (causeMessage === message) {
    return `${message}${causeCode}`;
  }

  return `${message}; cause: ${causeMessage}${causeCode}`;
}
