# GitHub Actions - Automatic Deployment to DigitalOcean

## What This Does

Every time you push to GitHub, it will automatically:
1. Pull the latest code on your DigitalOcean droplet
2. Install dependencies
3. Restart the application
4. Verify deployment

**Time to deploy**: ~30 seconds after push

## Setup Instructions

### 1. Generate SSH Key for GitHub Actions

On your **local machine**:

```bash
# Generate a new SSH key specifically for deployment
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/github_actions_deploy

# This creates two files:
# - ~/.ssh/github_actions_deploy (private key)
# - ~/.ssh/github_actions_deploy.pub (public key)
```

### 2. Add Public Key to DigitalOcean Droplet

```bash
# Copy the public key
cat ~/.ssh/github_actions_deploy.pub

# SSH into your droplet
ssh root@YOUR_DROPLET_IP

# Add the public key to authorized_keys
echo "YOUR_PUBLIC_KEY_HERE" >> ~/.ssh/authorized_keys

# Set correct permissions
chmod 600 ~/.ssh/authorized_keys
```

### 3. Add Secrets to GitHub Repository

Go to your GitHub repository:
1. Click **Settings** → **Secrets and variables** → **Actions**
2. Click **New repository secret**

Add these three secrets:

**Secret 1: DO_HOST**
- Name: `DO_HOST`
- Value: Your droplet IP address (e.g., `142.93.xxx.xxx`)

**Secret 2: DO_USERNAME**
- Name: `DO_USERNAME`
- Value: `root` (or your SSH username)

**Secret 3: DO_SSH_KEY**
- Name: `DO_SSH_KEY`
- Value: Your **private key** (copy the entire content)
  ```bash
  cat ~/.ssh/github_actions_deploy
  ```
  Copy everything including:
  ```
  -----BEGIN OPENSSH PRIVATE KEY-----
  ...
  -----END OPENSSH PRIVATE KEY-----
  ```

### 4. Commit and Push the GitHub Actions Workflow

The workflow file has already been created at `.github/workflows/deploy.yml`.

```bash
cd tradingapp

# Add the workflow file
git add .github/workflows/deploy.yml

# Commit
git commit -m "Add GitHub Actions deployment workflow"

# Push to GitHub
git push origin master
```

### 5. Watch Your First Deployment

1. Go to your GitHub repository
2. Click **Actions** tab
3. You'll see "Deploy to DigitalOcean" workflow running
4. Click on it to see live logs
5. Wait ~30 seconds for completion

## How It Works

```
You push to GitHub
    ↓
GitHub Actions triggered
    ↓
Build React client on the runner (`npm ci && npm run build`)
    ↓
Package build (`client-build.tgz`) and copy it to the droplet
    ↓
SSH into DigitalOcean droplet
    ↓
Pull latest code (`git pull`)
    ↓
Install server deps (`npm install --omit=dev`)
    ↓
Replace `/opt/tradingapp/client/build` with the uploaded artifact
    ↓
Restart server (pm2 startOrRestart)
    ↓
✅ Deployment complete!
```

The workflow now builds the React client inside GitHub Actions, uploads the resulting `client-build.tgz` to `/tmp`, installs the server dependencies on the droplet, extracts the build into `/opt/tradingapp/client`, and restarts PM2 so both API and UI are refreshed after every push.

## Testing Your Setup

### Test 1: Make a Small Change

```bash
# Make a small change
echo "# Updated $(date)" >> README.md

# Commit and push
git add README.md
git commit -m "Test automatic deployment"
git push origin master

# Watch the Actions tab on GitHub
# You should see the workflow run automatically
```

### Test 2: Verify Deployment

```bash
# SSH into your droplet
ssh root@YOUR_DROPLET_IP

# Check PM2 status
pm2 status

# Check logs
pm2 logs tradingapp --lines 50
```

## Advanced Configuration

### Deploy Both Render + DigitalOcean (Parallel)

Render can keep auto-deploying from GitHub at the same time as this DigitalOcean workflow.

- In Render: connect your repo, set the branch to `master`, and ensure **Auto-Deploy = Yes**.
- In GitHub: keep this workflow enabled.

Both deployments will run on each push.

### Deploy Client Too (If You Really Want)

By default, the DigitalOcean workflow deploys **server only** (recommended if your client is on Vercel).

If you want the droplet to also build the React client, extend `.github/workflows/deploy.yml` with:

```yaml
script: |
  cd /opt/tradingapp
  git pull origin master
  cd server
  npm install --omit=dev

  cd ../client
  npm install
  npm run build

  cd ../server
  pm2 startOrRestart ecosystem.config.js --only tradingapp
```

### Deploy on Pull Request Merge

Change the trigger in `deploy.yml`:

```yaml
on:
  pull_request:
    types: [closed]
    branches:
      - master

jobs:
  deploy:
    if: github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    # ... rest of the config
```

### Run Tests Before Deploy

Add a test step:

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest

    steps:
    - name: Checkout code
      uses: actions/checkout@v3

    - name: Setup Node.js
      uses: actions/setup-node@v3
      with:
        node-version: '20'

    - name: Run tests
      run: |
        cd server
        npm install
        npm test

    - name: Deploy to DigitalOcean
      # ... deployment steps
```

### Deploy to Staging First

Create two workflows:
- `deploy-staging.yml` - Deploys to staging droplet
- `deploy-production.yml` - Deploys to production droplet

Use different branches:
```yaml
on:
  push:
    branches:
      - develop  # staging
      - master     # production
```

### Slack/Discord Notifications

Add notification steps:

```yaml
- name: Notify Slack
  if: always()
  uses: 8398a7/action-slack@v3
  with:
    status: ${{ job.status }}
    webhook_url: ${{ secrets.SLACK_WEBHOOK }}
```

## Environment Variables

If you need to update environment variables during deployment:

```yaml
script: |
  cd /opt/tradingapp/server

  # Update specific env var
  sed -i 's/OLD_VALUE/NEW_VALUE/' config/.env

  # Or use environment secrets
  echo "NEW_VAR=${{ secrets.NEW_VAR }}" >> config/.env

  pm2 startOrRestart ecosystem.config.js --only tradingapp
```

## Rollback Strategy

### Manual Rollback

```bash
# SSH into droplet
ssh root@YOUR_DROPLET_IP

# Navigate to app
cd /opt/tradingapp

# Check git history
git log --oneline -10

# Rollback to previous commit
git checkout COMMIT_HASH

# Reinstall and restart
cd server
npm install
pm2 startOrRestart ecosystem.config.js --only tradingapp
```

### Automatic Rollback on Failure

Add health check:

```yaml
- name: Health Check
  run: |
    sleep 10
    response=$(curl -s -o /dev/null -w "%{http_code}" http://${{ secrets.DO_HOST }}/api/health)
    if [ $response != "200" ]; then
      echo "Health check failed, rolling back..."
      # Rollback commands here
      exit 1
    fi
```

## Troubleshooting

### Deployment Fails with "Permission denied"

**Solution**: Check SSH key is correctly added
```bash
# On droplet
cat ~/.ssh/authorized_keys
# Should contain your public key
```

### Git Pull Fails

**Solution**: Set up deploy key or use HTTPS
```bash
# On droplet
cd /opt/tradingapp
git remote set-url origin https://github.com/YOUR_USERNAME/tradingapp.git
```

### PM2 Not Found

**Solution**: Ensure PM2 is installed globally
```bash
npm install -g pm2
pm2 startup
```

### Build Fails

**Solution**: Check Node version
```bash
node --version  # Should be v20.10+ (server) or v22.x (client build)
```

## Security Best Practices

1. ✅ **Use separate SSH key** for deployments (not your personal key)
2. ✅ **Limit SSH key permissions** to specific commands (advanced)
3. ✅ **Use repository secrets** for sensitive data
4. ✅ **Enable branch protection** - require PR reviews before merge
5. ✅ **Rotate SSH keys** periodically (every 6-12 months)

## Cost

**GitHub Actions pricing**:
- Public repos: ✅ **FREE** (unlimited)
- Private repos: ✅ **2000 minutes/month FREE**
- Each deployment: ~1 minute
- = **2000 deployments/month free**

More than enough for your needs!

## Monitoring Deployments

### View Deployment History

Go to **GitHub → Actions** tab:
- ✅ Green checkmark = Successful deployment
- ❌ Red X = Failed deployment
- 🟡 Yellow dot = In progress

### Set Up Email Notifications

GitHub automatically emails you on deployment failures.

Configure in: **Settings → Notifications → Actions**

## Next Steps

1. ✅ Generate SSH key
2. ✅ Add public key to droplet
3. ✅ Add secrets to GitHub
4. ✅ Push workflow file
5. ✅ Test deployment
6. ✅ Celebrate! 🎉

---

**Estimated setup time**: 15 minutes
**Difficulty**: Easy

Once set up, you'll never think about deployment again - just push to GitHub!
