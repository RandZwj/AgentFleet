FROM python:3.12-slim

WORKDIR /app

# 系统依赖（psycopg2-binary 需要 libpq）
# 配置阿里云镜像
RUN echo 'deb https://mirrors.aliyun.com/debian/ trixie main non-free-firmware' > /etc/apt/sources.list \
    && echo 'deb https://mirrors.aliyun.com/debian/ trixie-updates main non-free-firmware' >> /etc/apt/sources.list \
    && echo 'deb https://mirrors.aliyun.com/debian-security/ trixie-security main non-free-firmware' >> /etc/apt/sources.list \
    && apt-get update && apt-get install -y --no-install-recommends \
    libpq-dev curl \
    && rm -rf /var/lib/apt/lists/*

# Python 依赖（pip 24.0 已够用，直接安装）
COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt python-dotenv \
    && find /usr -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null; true

# 复制应用代码
COPY app/ app/
RUN find /usr -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null; true \
    && find /usr -name "*.pyc" -delete 2>/dev/null; true

EXPOSE 8001

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8001"]
