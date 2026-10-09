import { fileURLToPath } from 'node:url';

process.loadEnvFile(fileURLToPath(new URL('.env', import.meta.url)));

export function getProxyString({ country = process.env.PROXY_COUNTRY } = {}) {
    const { PROXY_HOST, PROXY_PORT, PROXY_USER, PROXY_PASS } = process.env;
    const pass = country ? `${PROXY_PASS}_country-${country}` : PROXY_PASS;
    return `http://${PROXY_USER}:${pass}@${PROXY_HOST}:${PROXY_PORT}`;
}
