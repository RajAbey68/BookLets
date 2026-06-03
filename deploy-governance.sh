#!/bin/bash
set -e

echo "🚀 DEPLOYING GOVERNANCE GATES TO GITHUB"
echo "=========================================="

# Configure git
git config user.email "rajabey68@gmail.com"
git config user.name "Rajiv Abey"

# BookLets deployment
echo ""
echo "📦 BookLets: Pulling latest..."
git pull origin main --allow-unrelated-histories 2>/dev/null || git pull origin main --rebase 2>/dev/null || true

echo "📦 BookLets: Pushing commit..."
git push origin main

echo "✅ BookLets pushed successfully"

# SymbiOS deployment
echo ""
echo "📦 SymbiOS: Switching repos..."
cd ~/GitHub/SymbiOS

echo "📦 SymbiOS: Configuring git..."
git config user.email "rajabey68@gmail.com"
git config user.name "Rajiv Abey"

echo "📦 SymbiOS: Adding files..."
git add .

echo "📦 SymbiOS: Committing..."
git commit -m "feat: P0+P1 governance gates - 4-Eyes, SoD, drift logging" || true

echo "📦 SymbiOS: Pulling latest..."
git pull origin main --allow-unrelated-histories 2>/dev/null || git pull origin main --rebase 2>/dev/null || true

echo "📦 SymbiOS: Pushing..."
git push origin main

echo ""
echo "✅ ✅ ✅ COMPLETE ✅ ✅ ✅"
echo ""
echo "Both repositories deployed to GitHub."
echo "Workflows are running now. Check:"
echo "  • https://github.com/RajAbey68/BookLets/actions"
echo "  • https://github.com/RajAbey68/SymbiOS/actions"
echo ""
echo "Expected: Both P0 + P1 workflows GREEN in 2-5 minutes"
