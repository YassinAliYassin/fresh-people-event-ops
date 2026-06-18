module.exports = {
  apps: [
    {
      name: 'fresh-people-dashboard',
      script: 'server-v4.js',
      cwd: '/home/yassin/fresh-people-event-ops/web-dashboard',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        PORT: 3004,
        DASHBOARD_USER: 'admin',
        DASHBOARD_PASS: 'freshpeople2026'
      },
      error_file: '/home/yassin/.hermes/logs/fresh-people-dashboard-error.log',
      out_file: '/home/yassin/.hermes/logs/fresh-people-dashboard-out.log',
      time: true
    },
    {
      name: 'fresh-people-api',
      script: 'server.js',
      cwd: '/home/yassin/fresh-people-event-ops',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      },
      error_file: '/home/yassin/.hermes/logs/fresh-people-api-error.log',
      out_file: '/home/yassin/.hermes/logs/fresh-people-api-out.log',
      time: true
    },
    {
      name: 'fresh-people-whatsapp',
      script: 'whatsapp-api-bot.js',
      cwd: '/home/yassin/fresh-people-event-ops',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        PORT: 3003
      },
      error_file: '/home/yassin/.hermes/logs/fresh-people-whatsapp-error.log',
      out_file: '/home/yassin/.hermes/logs/fresh-people-whatsapp-out.log',
      time: true
    }
  ]
};
