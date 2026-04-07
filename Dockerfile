FROM python:3.12-slim

WORKDIR /app

# 系统依赖（psycopg2-binary 需要 libpq）
# 配置阿里云镜像
RUN rm -rf /etc/apt/sources.list.d/* \
    && echo 'deb https://mirrors.aliyun.com/debian/ trixie main non-free-firmware' > /etc/apt/sources.list \
    && echo 'deb https://mirrors.aliyun.com/debian/ trixie-updates main non-free-firmware' >> /etc/apt/sources.list \
    && echo 'deb https://mirrors.aliyun.com/debian-security/ trixie-security main non-free-firmware' >> /etc/apt/sources.list \
    && apt-get update && apt-get install -y --no-install-recommends \
    libpq-dev curl \
    && rm -rf /var/lib/apt/lists/*

# Python 依赖
RUN pip3 install --no-cache-dir \
    'fastapi==0.115.0' \
    'uvicorn[standard]==0.30.6' \
    'httpx==0.27.2' \
    'pytest==8.3.3' \
    'python-docx==1.2.0' \
    'sqlalchemy>=2.0,<3.0' \
    'psycopg2-binary>=2.9,<3.0' \
    'pyyaml>=6.0,<7.0' \
    'patchright>=1.40' \
    'playwright-stealth>=1.0' \
    'litellm>=1.0' \
    'python-multipart>=0.0.6' \
    'pandas>=2.0' \
    'python-dotenv' \
    && find /usr -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null; true

# 复制应用代码
COPY app/ app/
RUN mkdir -p /app/uploads \
    && find /usr -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null; true \
    && find /usr -name "*.pyc" -delete 2>/dev/null; true

EXPOSE 8001

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8001"]
