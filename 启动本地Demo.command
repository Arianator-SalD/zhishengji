#!/bin/zsh
cd "${0:A:h}"
if [[ ! -x .venv/bin/python ]]; then
  python3 -m venv .venv || exit 1
  .venv/bin/python -m pip install -r requirements.txt || exit 1
fi
if [[ ! -f .env ]]; then
  cp .env.example .env
  chmod 600 .env
fi
print '打开 http://127.0.0.1:8765 ，按 Ctrl+C 停止服务。'
exec .venv/bin/python -m uvicorn server.main:app --host 127.0.0.1 --port 8765
