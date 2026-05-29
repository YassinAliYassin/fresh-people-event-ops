module.exports = {
  apps: [{
    name: 'fresh-people-ops',
    cwd: '/home/yassin/fresh-people-event-ops/web-dashboard',
    script: 'server-v4.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production',
      PORT: 3004
    },
    error_file: '/tmp/fresh-people-ops-err.log',
    out_file: '/tmp/fresh-people-ops-out.log',
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss'
  }]
};
