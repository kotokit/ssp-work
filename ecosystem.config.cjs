/**
 * pm2 process definition for the deployed SSP load tester.
 *
 * WHY run.sh IS THE SCRIPT AND NOT src/ssp-server.mjs
 *
 * The proxy only works when HTTP_PROXY/HTTPS_PROXY are present in the
 * environment at the moment node STARTS, and node must be given
 * --use-env-proxy. pm2 runs `node <script> <args>`, so a `--use-env-proxy`
 * entry in `args` would be handed to the application instead of to node,
 * and the proxy would be silently bypassed while looking configured.
 * run.sh sets both correctly (it evals `pr.mjs --export` and then execs
 * `node --use-env-proxy`), so we launch the script through it.
 *
 *   pm2 start /opt/ssp-work/ecosystem.config.cjs
 *   pm2 logs ssp-work
 *
 * autorestart is FALSE on purpose: this is a targeted load run that exits
 * when `load.stopAfter` is reached, not a daemon. With the pm2 default the
 * run would silently start over every time it finished.
 */
module.exports = {
  apps: [
    {
      name: 'ssp-work',
      script: './run.sh',
      interpreter: 'bash',
      cwd: '/opt/ssp-work',

      // A finished run is a finished run; restart is an explicit operator action.
      autorestart: false,

      /*
       * run.sh execs node, so pm2's PID becomes the server itself. It drains
       * in-flight requests on SIGINT/SIGTERM; the 1.6s pm2 default is too
       * short for that and would SIGKILL mid-drain.
       */
      kill_timeout: 15000,
      kill_signal: 'SIGINT',

      // One process: the proxy exit IP is sticky per process, and the auction
      // and its impression pixel must share an IP. Cluster mode would break that.
      instances: 1,
      exec_mode: 'fork',

      max_memory_restart: '400M',

      time: true,
      merge_logs: true,
      out_file: '/var/log/ssp-work/out.log',
      error_file: '/var/log/ssp-work/error.log',
    },
  ],
};
