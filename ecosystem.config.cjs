// PM2 ecosystem config para a mar.IA
// Uso no VPS:  pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'maria-bot',
      script: './src/index.js',
      cwd: '/root/maria-bot',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
      },
      out_file: '/root/maria-bot/logs/out.log',
      error_file: '/root/maria-bot/logs/err.log',
      time: true,
    },
  ],
};
