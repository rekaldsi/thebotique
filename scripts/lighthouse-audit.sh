#!/bin/bash
# Lighthouse Audit Script for TheBotique

URL="${1:-https://www.thebotique.ai}"
OUTPUT_DIR="./lighthouse-reports"

mkdir -p "$OUTPUT_DIR"

echo "🔍 Running Lighthouse audit on $URL..."

# Run Lighthouse with performance, accessibility, best-practices, SEO
lighthouse "$URL" \
  --output=html,json \
  --output-path="$OUTPUT_DIR/report" \
  --chrome-flags="--headless --no-sandbox" \
  --only-categories=performance,accessibility,best-practices,seo \
  2>/dev/null

if [ -f "$OUTPUT_DIR/report.html" ]; then
  echo "✅ Report saved to $OUTPUT_DIR/report.html"
  
  # Extract scores from JSON
  if [ -f "$OUTPUT_DIR/report.json" ]; then
    echo ""
    echo "📊 Scores:"
    cat "$OUTPUT_DIR/report.json" | jq -r '.categories | to_entries[] | "  \(.key): \((.value.score * 100 | floor))%"'
  fi
else
  echo "❌ Audit failed"
fi
