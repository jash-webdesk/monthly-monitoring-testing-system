/**
 * Consistent structured logging for the monitoring system.
 * All runners must use this — never console.log directly.
 * Set DEBUG=1 environment variable to enable debug output.
 */

const PAD = {
  info:    '  INFO',
  warn:    '  WARN',
  error:   ' ERROR',
  debug:   ' DEBUG',
  success: '    OK'
};

/**
 * Formats a log line with timestamp and level prefix.
 * @param {string} level
 * @param {string} message
 * @returns {string}
 */
function fmt(level, message) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  return `[${ts}] ${PAD[level] ?? level.padStart(5)} ${message}`;
}

export const logger = {
  /** @param {string} msg */
  info:    (msg) => console.log(fmt('info', msg)),

  /** @param {string} msg */
  warn:    (msg) => console.warn(fmt('warn', msg)),

  /** @param {string} msg */
  error:   (msg) => console.error(fmt('error', msg)),

  /** @param {string} msg - Only shown when DEBUG=1 */
  debug:   (msg) => { if (process.env.DEBUG) console.log(fmt('debug', msg)); },

  /** @param {string} msg */
  success: (msg) => console.log(fmt('success', msg)),

  /**
   * Logs that a runner has started.
   * @param {string} runner
   */
  runnerStart: (runner) => {
    console.log(fmt('info', `▶  Starting runner: ${runner}`));
  },

  /**
   * Logs that a runner has completed successfully.
   * @param {string} runner
   * @param {number} findingCount
   */
  runnerDone: (runner, findingCount) => {
    console.log(fmt('success', `✓  Runner done: ${runner} — ${findingCount} finding(s)`));
  },

  /**
   * Logs that a runner has failed.
   * @param {string} runner
   * @param {string} error
   */
  runnerError: (runner, error) => {
    console.error(fmt('error', `✗  Runner failed: ${runner} — ${error}`));
  },

  /**
   * Prints a section divider.
   * @param {string} title
   */
  section: (title) => {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  ${title}`);
    console.log('─'.repeat(60));
  }
};
