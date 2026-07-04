// PM2 config to run Github Track 24/7 (crawler + UI), with auto-restart on crash
// and on machine reboot. Windows setup:
//   npm install -g pm2 pm2-windows-startup
//   pm2-startup install          (registers PM2 to resurrect on login)
//   npm run build
//   pm2 start ecosystem.config.cjs
//   pm2 save                     (remember the running apps for next boot)
module.exports = {
  apps: [
    {
      name: 'gh-track-crawler',
      script: 'dist/index.js', // scheduler: crawls on start, then on CRON_SCHEDULE
      cwd: __dirname, // resolve ./data and .env against the project root
      autorestart: true,
      max_restarts: 20,
      restart_delay: 10000, // wait 10s before restarting after a crash
      out_file: 'logs/crawler.out.log',
      error_file: 'logs/crawler.err.log',
      time: true, // timestamp each log line
    },
    {
      name: 'gh-track-ui',
      script: 'dist/server.js', // browsing UI at http://localhost:UI_PORT
      cwd: __dirname,
      autorestart: true,
      out_file: 'logs/ui.out.log',
      error_file: 'logs/ui.err.log',
      time: true,
    },
  ],
};
