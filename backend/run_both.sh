#!/bin/bash
# Run both FastAPI and Streamlit servers simultaneously
# Usage: ./run_both.sh

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}Starting Third Eye 360 Services${NC}"
echo "=================================="

# Check if virtual environment is activated
if [ -z "$VIRTUAL_ENV" ]; then
    echo -e "${YELLOW}Virtual environment not activated. Activating...${NC}"
    source .myenv/bin/activate
fi

# Create log directory
mkdir -p logs

# Kill any existing processes on these ports
echo -e "${YELLOW}Checking for existing processes...${NC}"
lsof -ti:8001 | xargs kill -9 2>/dev/null || true
lsof -ti:8502 | xargs kill -9 2>/dev/null || true

# Start FastAPI in background
echo -e "${GREEN}Starting FastAPI server on port 8001...${NC}"
python run_api.py > logs/fastapi.log 2>&1 &
FASTAPI_PID=$!
echo "FastAPI PID: $FASTAPI_PID"

# Wait for FastAPI to be ready
sleep 3
if ! kill -0 $FASTAPI_PID 2>/dev/null; then
    echo -e "${RED}FastAPI failed to start. Check logs/fastapi.log${NC}"
    exit 1
fi

# Start Streamlit in background
echo -e "${GREEN}Starting Streamlit server on port 8502...${NC}"
python run_streamlit.py > logs/streamlit.log 2>&1 &
STREAMLIT_PID=$!
echo "Streamlit PID: $STREAMLIT_PID"

# Save PIDs for easy cleanup
echo $FASTAPI_PID > .fastapi.pid
echo $STREAMLIT_PID > .streamlit.pid

echo ""
echo -e "${GREEN}✓ Both services started successfully!${NC}"
echo "=================================="
echo -e "FastAPI:   ${GREEN}http://localhost:8001${NC}"
echo -e "Streamlit: ${GREEN}http://localhost:8502${NC}"
echo ""
echo -e "${YELLOW}Logs:${NC}"
echo "  FastAPI:   logs/fastapi.log"
echo "  Streamlit: logs/streamlit.log"
echo ""
echo -e "${YELLOW}To stop services:${NC} ./stop_services.sh"
echo ""

# Optional: tail logs (comment out if you don't want this)
echo -e "${GREEN}Tailing logs... (Press Ctrl+C to stop tailing, services will continue)${NC}"
tail -f logs/fastapi.log logs/streamlit.log
