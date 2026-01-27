#!/bin/bash
# Setup script for TWS Python API test

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "================================"
echo "TWS Python API Test Setup"
echo "================================"
echo ""

# Check Python version
if ! command -v python3 &> /dev/null; then
    echo "❌ Python 3 not found"
    echo ""
    echo "Please install Python 3.7 or higher:"
    echo "  macOS: brew install python3"
    echo "  Ubuntu: sudo apt install python3 python3-pip"
    exit 1
fi

PYTHON_VERSION=$(python3 --version 2>&1 | awk '{print $2}')
echo "✅ Python found: $PYTHON_VERSION"

# Check pip
if ! python3 -m pip --version &> /dev/null; then
    echo "❌ pip not found"
    echo ""
    echo "Please install pip:"
    echo "  python3 -m ensurepip --upgrade"
    exit 1
fi

echo "✅ pip found"
echo ""

# Install dependencies
echo "Installing dependencies from requirements.txt..."
python3 -m pip install -r requirements.txt

echo ""
echo "✅ Setup complete!"
echo ""
echo "To run the test:"
echo "  ./run.sh"
echo ""
echo "Or directly:"
echo "  python3 test_realtime_bars.py"
echo ""
echo "Make sure TWS or IB Gateway is running before testing."
