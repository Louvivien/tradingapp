module.exports = {
  apps: [
    {
      name: 'tradingapp',
      cwd: __dirname,
      script: './server.js',
      instances: 1,
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
