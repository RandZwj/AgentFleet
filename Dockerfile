FROM python:3.12-slim

WORKDIR /app

# 系统依赖（psycopg2-binary 需要 libpq）
RUN apt-get update && apt-get install -y --no-install-recommends --fix-missing \
    libpq-dev curl \
    && rm -rf /var/lib/apt/lists/*

# Python 依赖（pip 24.0 已够用，直接安装）
COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt python-dotenv

# 复制应用代码
COPY app/ app/

EXPOSE 8001

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8001"]
