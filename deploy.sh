#!/bin/bash

# Configuration
REMOTE_HOST="myserver"
REMOTE_DIR="/root/sendbycloud/sbc-backend"

echo "🚀 Starting deployment to $REMOTE_HOST..."

# Sync files
echo "📦 Syncing files..."
rsync -avz --exclude 'node_modules' --exclude '.git' --exclude 'logs' ./ $REMOTE_HOST:$REMOTE_DIR

# Run remote commands
echo "🔧 Installing dependencies and restarting service on remote..."
ssh $REMOTE_HOST "cd $REMOTE_DIR && npm install && pm2 restart sbc-backend"

echo "✅ Deployment complete!"
