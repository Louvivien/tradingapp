# DigitalOcean Deployment Guide (Ubuntu + PM2 + Nginx)

This guide deploys the **backend** (`tradingapp/server`) on a DigitalOcean droplet.

Notes:
- Only deploy/run Polymarket features if you’re legally allowed to use them and Polymarket’s terms apply to you.
- Keep **all secrets out of Git**. Use `server/config/.env` on the droplet (not committed).

## 1) Create the Droplet

- Image: **Ubuntu 22.04 LTS**
- Size: Basic is fine to start (1GB/1vCPU)
- Auth: **SSH key** (recommended)

## 2) SSH In

```bash
ssh root@YOUR_DROPLET_IP
```

## 3) Create a Deploy User (recommended)

```bash
adduser deploy
usermod -aG sudo deploy

mkdir -p /home/deploy/.ssh
nano /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys
```

From now on you can use:
```bash
ssh deploy@YOUR_DROPLET_IP
```

## 4) Install System Dependencies

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl build-essential
```

## 5) Install Node.js (server requires Node >= 20.10)

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v
npm -v
```

## 6) MongoDB

Use **one** of these:

### Option A (simplest): MongoDB Atlas / managed MongoDB
- Put your connection string in `MONGO_URI` and the password in `MONGO_PASSWORD`.

### Option B: Local MongoDB on the droplet
You can install MongoDB and point `MONGO_URI` to localhost.

Important: the server expects `MONGO_PASSWORD` to be set (even if your URI doesn’t use it).

## 7) Clone the Repo

```bash
sudo mkdir -p /opt/tradingapp
sudo chown -R deploy:deploy /opt/tradingapp

sudo -u deploy git clone https://github.com/Louvivien/tradingapp.git /opt/tradingapp
cd /opt/tradingapp
sudo -u deploy git checkout master
```

## 8) Create the Server `.env` on the Droplet

Create: `/opt/tradingapp/server/config/.env`

```bash
sudo -u deploy mkdir -p /opt/tradingapp/server/config
sudo -u deploy nano /opt/tradingapp/server/config/.env
```

Template (fill with your real values):

```bash
# Required
PORT=3000
JWT_SECRET=<long-random>
ENCRYPTION_KEY=<long-random>

# Mongo
# If your URI contains <password>, it will be replaced with MONGO_PASSWORD.
MONGO_URI=mongodb+srv://<user>:<password>@<cluster>/<db>?retryWrites=true&w=majority
MONGO_PASSWORD=<mongo-password>

# Optional (Alpaca)
ALPACA_API_KEY_ID=<alpaca-key>
ALPACA_API_SECRET_KEY=<alpaca-secret>

# Optional (Polymarket)
POLYMARKET_TRADES_SOURCE=auto
POLYMARKET_EXECUTION_MODE=paper
POLYMARKET_API_KEY=<polymarket-api-key>
POLYMARKET_SECRET=<polymarket-secret>
POLYMARKET_PASSPHRASE=<polymarket-passphrase>
POLYMARKET_AUTH_ADDRESS=0x...

# If you use a private key file, store it on the droplet and reference it:
POLYMARKET_PRIVATE_KEY_FILE=/opt/tradingapp/server/config/polymarket_private_key.txt

# If you’re not using a proxy, leave these unset:
# POLYMARKET_CLOB_PROXY=
# POLYMARKET_PROXY_LIST_ENABLED=false
```

If you use `POLYMARKET_PRIVATE_KEY_FILE`:

```bash
sudo -u deploy bash -lc 'umask 077 && printf "%s\n" "<your-private-key>" > /opt/tradingapp/server/config/polymarket_private_key.txt'
```

## 9) Install Server Dependencies

```bash
cd /opt/tradingapp/server
sudo -u deploy npm install --omit=dev
```

## 10) Run with PM2

```bash
sudo npm install -g pm2

cd /opt/tradingapp/server
sudo -u deploy pm2 startOrRestart ecosystem.config.js --only tradingapp
sudo -u deploy pm2 save

# Make PM2 restart on boot (follow the printed command)
sudo -u deploy pm2 startup systemd -u deploy --hp /home/deploy
```

Useful commands:
```bash
sudo -u deploy pm2 status
sudo -u deploy pm2 logs tradingapp --lines 100
sudo -u deploy pm2 restart tradingapp
```

## 11) Nginx Reverse Proxy

```bash
sudo apt install -y nginx
```

Create `/etc/nginx/sites-available/tradingapp`:

```nginx
server {
  listen 80;
  server_name YOUR_DOMAIN_OR_IP;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_cache_bypass $http_upgrade;
  }
}
```

Enable it:
```bash
sudo ln -sf /etc/nginx/sites-available/tradingapp /etc/nginx/sites-enabled/tradingapp
sudo nginx -t
sudo systemctl restart nginx
```

## 12) Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

## 13) Health Check

```bash
curl -sS http://YOUR_DOMAIN_OR_IP/api/health | head
```

## 14) Auto-deploy on `git push`

Use GitHub Actions + SSH (already in this repo):
- Workflow: `tradingapp/.github/workflows/deploy.yml`
- Setup steps: `tradingapp/GITHUB_ACTIONS_SETUP.md`

### Key change for option 1 (build on GitHub)
The workflow now builds the React client inside GitHub Actions (node 22), packages it as `client-build.tgz`, and copies that tarball to `/tmp` on the droplet before the SSH step runs. The script on the droplet simply extracts the build into `/opt/tradingapp/client` and restarts PM2—no need to run `npm install` or `npm run build` there. This avoids the 1 GB RAM limit of the droplet while still making the latest UI available immediately after every push.
