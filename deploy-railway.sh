#!/bin/bash

echo "🚀 Quick Deploy to Railway"
echo "========================="

# Kiểm tra git status
if [[ `git status --porcelain` ]]; then
  echo "📝 Có thay đổi chưa commit, đang commit..."
  git add .
  git commit -m "Deploy: $(date +'%Y-%m-%d %H:%M:%S')"
fi

# Push to main branch
echo "📤 Pushing to main branch..."
git push origin main

echo "✅ Code đã được push!"
echo "🔗 Truy cập Railway dashboard để theo dõi deployment:"
echo "   https://railway.app/dashboard"
echo ""
echo "📊 Sau khi deploy xong, kiểm tra:"
echo "   - WebSocket connection status"
echo "   - MQTT connection"
echo "   - Robot data reception"
