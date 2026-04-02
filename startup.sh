#!/bin/bash
# 启动脚本：在 uvicorn 启动前安装缺失的依赖
pip3 install pandas -q --no-warn-script-location 2>/dev/null
exec uvicorn app.main:app --host 0.0.0.0 --port 8001
