import { readFileSync } from 'node:fs';

/**
 * Load user agents from the CSV (first quoted column per row; numeric columns
 * are unquoted and ignored). Deduped, header skipped.
 *
 * @param {string} file path to user_agents.csv
 * @returns {string[]}
 */
export function loadUserAgents(file) {
  const lines = readFileSync(file, 'utf8').trim().split(/\r?\n/).slice(1);
  const uas = [];
  for (const line of lines) {
    const m = line.match(/^"((?:[^"]|"")*)"/);
    if (m) uas.push(m[1].replace(/""/g, '"'));
  }
  return [...new Set(uas)];
}
