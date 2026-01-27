#!/bin/bash
# Quick run script for TWS Python API test

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "================================"
echo "TWS Python API Test Runner"
echo "================================"
echo ""

# Check Python
if ! command -v python3 &> /dev/null; then
    echo "❌ python3 not found"
    echo "   Please install Python 3.7 or higher"
    exit 1
fi

PYTHON_VERSION=$(python3 --version 2>&1 | awk '{print $2}')
echo "✅ Python version: $PYTHON_VERSION"

# Check ibapi package
if ! python3 -c "import ibapi" 2>/dev/null; then
    echo ""
    echo "⚠️  ibapi package not found"
    echo "   Installing from requirements.txt..."
    echo ""
    pip install -r requirements.txt
    echo ""
fi

echo "✅ ibapi package installed"
echo ""

# Check if TWS is running
if lsof -i :7497 &> /dev/null; then
    echo "✅ TWS detected on port 7497 (paper trading)"
elif lsof -i :7496 &> /dev/null; then
    echo "✅ TWS detected on port 7496 (live trading)"
    echo "   Note: Test uses 7497 by default, update test_realtime_bars.py if needed"
else
    echo "⚠️  TWS/IB Gateway not detected"
    echo "   Make sure TWS is running and API is enabled"
    echo "   Continuing anyway..."
fi

echo ""
echo "Starting test..."
echo "================================"
echo ""

# Run the test
python3 test_realtime_bars.py "$@"

exit_code=$?

echo ""
if [ $exit_code -eq 0 ]; then
    echo "✅ Test completed successfully"
else
    echo "❌ Test failed with exit code: $exit_code"
fi

exit $exit_code
