module.exports = {
  apps: [
    {
      name: "fresh-people-ops",
      script: "web-dashboard/server-v4.js",
      cwd: "/home/yassin/fresh-people-event-ops",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "500M",
      env: {
        NODE_ENV: "production",
        PORT: 3004
      },
      error_file: "/home/yassin/.pm2/logs/fresh-people-ops-error.log",
      out_file: "/home/yassin/.pm2/logs/fresh-people-ops-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss"
    },
    {
      name: "fresh-people-api",
      script: "server.js",
      cwd: "/home/yassin/fresh-people-event-ops",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "300M",
      env: {
        NODE_ENV: "production",
        PORT: 3000
      },
      error_file: "/home/yassin/.pm2/logs/fresh-people-api-error.log",
      out_file: "/home/yassin/.pm2/logs/fresh-people-api-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss"
    },
    {
      name: "fresh-people-whatsapp",
      script: "whatsapp-api-bot.js",
      cwd: "/home/yassin/fresh-people-event-ops",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "300M",
      env: {
        NODE_ENV: "production",
        PORT: 3003
      },
      error_file: "/home/yassin/.pm2/logs/fresh-people-whatsapp-error.log",
      out_file: "/home/yassin/.pm2/logs/fresh-people-whatsapp-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss"
    }
  ]
};
