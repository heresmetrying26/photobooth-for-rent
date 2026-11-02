#!/bin/bash
# Copies protected/booth.html into the iOS Xcode bundle resources
set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT="$DIR/../.."
SOURCE="$ROOT/protected/booth.html"
DEST="$DIR/../photobooth4u/booth.html"

if [ -f "$SOURCE" ]; then
    cp "$SOURCE" "$DEST"
    echo "Copied protected/booth.html to ios/photobooth4u/booth.html"
else
    echo "Warning: protected/booth.html not found at $SOURCE"
fi

