#!/bin/bash
# Stop both FastAPI and Streamlit servers
# Usage: ./stop_services.sh

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}Stopping Third Eye 360 Services${NC}"
echo "=================================="

# Stop services by PID files
if [ -f .fastapi.pid ]; then
    FASTAPI_PID=$(cat .fastapi.pid)
    if kill -0 $FASTAPI_PID 2>/dev/null; then
        echo -e "${YELLOW}Stopping FastAPI (PID: $FASTAPI_PID)...${NC}"
        kill $FASTAPI_PID
        echo -e "${GREEN}✓ FastAPI stopped${NC}"
    else
        echo -e "${YELLOW}FastAPI process not running${NC}"
    fi
    rm .fastapi.pid
fi

if [ -f .streamlit.pid ]; then
    STREAMLIT_PID=$(cat .streamlit.pid)
    if kill -0 $STREAMLIT_PID 2>/dev/null; then
        echo -e "${YELLOW}Stopping Streamlit (PID: $STREAMLIT_PID)...${NC}"
        kill $STREAMLIT_PID
        echo -e "${GREEN}✓ Streamlit stopped${NC}"
    else
        echo -e "${YELLOW}Streamlit process not running${NC}"
    fi
    rm .streamlit.pid
fi

# Fallback: kill by port
echo -e "${YELLOW}Cleaning up any remaining processes...${NC}"
lsof -ti:8001 | xargs kill -9 2>/dev/null || true
lsof -ti:8502 | xargs kill -9 2>/dev/null || true

echo -e "${GREEN}✓ All services stopped${NC}"
