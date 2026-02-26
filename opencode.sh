#!/bin/bash

set -e

COMMAND=${1:-"start"}

echo "🔥 OPENCODE MAX STARTING... ($COMMAND)"
PROJECT_DIR=$(pwd)
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
VERSION_TAG="auto-$TIMESTAMP"

case "$COMMAND" in
  "upgrade-lotoai")
    echo "🧠 UPGRADING LOTOAI MODULE..."
    
    mkdir -p modules

    cat > modules/lotoai-ultra.js <<EOF
export function lotoaiUltraInit(){
    console.log("🔥 LotoAI Ultra Loaded")

    window.lotoaiUltra = {
        analyze(numbers){
            const stats={}
            numbers.forEach(n=>{
                const d=n.slice(-2)
                stats[d]=(stats[d]||0)+1
            })
            return Object.entries(stats)
                .sort((a,b)=>b[1]-a[1])
                .slice(0,5)
        }
    }
}
EOF

    if [ -f "index.html" ]; then
      if ! grep -q "lotoai-ultra.js" index.html; then
        echo "📝 Patching index.html..."
        sed -i '' 's#</body>#<script type="module" src="./modules/lotoai-ultra.js"></script></body>#' index.html
      fi
    fi

    echo "📝 Committing..."
    git add .
    git commit -m "🧠 LotoAI Upgrade $TIMESTAMP" || echo "⚠️ Nothing to commit"
    git push origin main || echo "⚠️ Push skipped"

    echo "✅ LOTOAI UPGRADE COMPLETE."
    ;;

  "start"|*)
    echo "📦 Creating backup..."
    mkdir -p .backup
    rsync -a --exclude='.backup' ./ .backup/backup_$TIMESTAMP/

    echo "📥 Pulling latest..."
    git pull origin main || echo "⚠️ No remote or already updated"

    echo "📦 Installing npm dependencies..."
    npm install

    echo "🔧 Checking Electron..."
    if ! grep -q "electron" package.json; then
      echo "Installing electron..."
      npm install electron --save-dev
    fi

    echo "🧠 Injecting LotoAI Ultra..."
    mkdir -p modules

    cat > modules/lotoai-ultra.js <<EOF
export function lotoaiUltraInit(){
    console.log("🔥 LotoAI Ultra Loaded")

    window.lotoaiUltra = {
        analyze(numbers){
            const stats={}
            numbers.forEach(n=>{
                const d=n.slice(-2)
                stats[d]=(stats[d]||0)+1
            })
            return Object.entries(stats)
                .sort((a,b)=>b[1]-a[1])
                .slice(0,5)
        }
    }
}
EOF

    if [ -f "index.html" ]; then
      if ! grep -q "lotoai-ultra.js" index.html; then
        echo "📝 Patching index.html..."
        sed -i '' 's#</body>#<script type="module" src="./modules/lotoai-ultra.js"></script></body>#' index.html
      fi
    fi

    echo "🏗 Building..."
    npm run build || echo "⚠️ No build script found"

    echo "📝 Committing..."
    git add .
    git commit -m "🔥 OPENCODE MAX AUTO UPGRADE $TIMESTAMP" || echo "⚠️ Nothing to commit"
    git push origin main || echo "⚠️ Push skipped"

    echo "🏷 Creating tag..."
    git tag $VERSION_TAG || true
    git push origin $VERSION_TAG || true

    echo "🚀 Starting Electron..."
    npm start

    echo "✅ OPENCODE MAX COMPLETE."
    ;;
esac
