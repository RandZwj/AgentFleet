# OpenClaw 对接 AgentFleet 集成方案

> 创建日期：2026-04-07

## 1. 背景与目标

通过 OpenClaw 进行对话和任务分析，将任务通过标准化 API 传递给 AgentFleet 服务，由服务内部的调度者（Dispatcher）拆解任务并分配给不同的 Agent 执行，最终将结果返回给 OpenClaw。

**目标**：

- 提供稳定、标准化的系统间集成 API（Job API）
- 支持异步任务提交 + 轮询/回调两种结果获取方式
- 扩展 Agent 工具能力（文件操作等）
- 支持 Docker 容器化部署，合理处理文件访问

---

## 2. 整体架构

```
OpenClaw (对话 + 任务分析)
    │
    │  POST /api/v1/jobs          ← 提交任务（异步）
    │  POST /api/v1/jobs/stream   ← 提交任务（SSE 流式）
    │  GET  /api/v1/jobs/{job_id} ← 轮询结果
    │
    ▼
AgentFleet (Job API 入口，API Key 鉴权)
    │
    ▼
Job Executor (后台任务执行器)
    │
    ├── agent_slug 指定? ──是──→ run_agent 直接执行
    │                  └──否──→ dispatch 调度执行
    │                               │
    │                     ┌─────────┼─────────┐
    │                     ▼         ▼         ▼
    │                  Agent A   Agent B   Agent C
    │                     │         │         │
    │                     └─────────┼─────────┘
    │                               ▼
    │                         汇总摘要(≥2个任务时)
    │
    ▼
更新 JobRecord (status=succeeded, result=...)
    │
    ├── 有 callback_url? ──是──→ POST callback_url (回调通知)
    │
    ▼
OpenClaw 轮询 GET /api/v1/jobs/{job_id} 获取结果
```

**与现有 `/chat` 接口的关系**：

| 接口 | 定位 | 使用方 |
|------|------|--------|
| `POST /api/v1/office/chat` | 前端专用，含 Phaser 动画数据 | 浏览器前端 |
| `POST /api/v1/jobs` | 系统集成专用，结构化输入输出 | OpenClaw 等外部系统 |

底层共用 `dispatch` / `run_agent`，不重复实现调度逻辑。

---

## 3. Phase 1：标准化 Job API

### 3.1 API 端点设计

| 方法 | 路径 | 功能 | 返回 |
|------|------|------|------|
| POST | `/api/v1/jobs` | 提交任务（异步） | `{ job_id, status: "pending" }` |
| POST | `/api/v1/jobs/stream` | 提交任务（SSE 流式实时推送） | SSE 事件流 |
| GET | `/api/v1/jobs/{job_id}` | 查询任务状态和结果 | `JobRecord` |
| GET | `/api/v1/jobs` | 任务列表（分页 + 状态过滤） | `{ jobs: [...], total }` |
| POST | `/api/v1/jobs/{job_id}/cancel` | 取消任务（可选） | `{ job_id, status: "cancelled" }` |

### 3.2 数据模型

**请求体 `JobCreateRequest`**：

```python
class JobCreateRequest(BaseModel):
    task: str                                    # 任务描述（自然语言）
    context: Optional[dict] = None               # 附加上下文（文件引用、业务参数等）
    agent_slug: Optional[str] = None             # 指定 Agent（跳过调度者）
    callback_url: Optional[str] = None           # 完成后回调 URL
    priority: str = "normal"                     # normal / high
    timeout_seconds: int = 300                   # 超时时间（秒）
```

**响应体 `JobRecord`**：

```python
class JobRecord(BaseModel):
    job_id: str
    status: Literal["pending", "running", "succeeded", "failed", "cancelled"]
    created_at: str
    updated_at: str
    # 调度信息
    dispatched_agents: list[str] = []            # 参与执行的 Agent slug 列表
    # 结果
    result: Optional[dict] = None                # 结构化结果
    summary: Optional[str] = None                # 自然语言摘要
    messages: list[dict] = []                    # 完整消息链（调度过程）
    error: Optional[str] = None
    # 元数据
    usage: Optional[dict] = None                 # token 消耗统计
    duration_ms: Optional[int] = None            # 总耗时
```

### 3.3 API Key 鉴权

> **暂不实现**：鉴权功能推迟到后续迭代，当前阶段先打通核心链路。后续可增加 API Key 或 JWT 认证。

### 3.4 执行流程

```
POST /api/v1/jobs
    │
    ▼
创建 JobRecord (status=pending)
    │
    ▼
加入 BackgroundTasks
    │
    ├──→ 立即返回 { job_id } 给调用方
    │
    ▼
job_executor.run (后台)
    │
    ├── agent_slug 指定? ──是──→ run_agent 直接执行
    │                  └──否──→ dispatch 调度执行
    │
    ▼
收集结果 → 提取 summary / dispatched_agents / usage
    │
    ▼
更新 JobRecord (status=succeeded/failed)
    │
    ├── 有 callback_url? ──是──→ POST callback_url with result
    │
    ▼
完成
```

### 3.5 SSE 流式端点

`POST /api/v1/jobs/stream` 提供实时进度推送，事件类型：

| 事件 | 说明 | data 示例 |
|------|------|-----------|
| `init` | 任务已创建 | `{ "job_id": "..." }` |
| `routing` | 调度者正在分析 | `{ "message": "正在分析任务..." }` |
| `process` | Agent 执行进度 | `{ "agent_slug": "...", "content": "查询数据中..." }` |
| `message` | Agent 返回结果 | `{ "agent_slug": "...", "content": "分析结果..." }` |
| `done` | 全部完成 | `{ "job_id": "...", "summary": "..." }` |
| `error` | 执行失败 | `{ "error": "..." }` |

### 3.6 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `app/models.py` | 修改 | 新增 `JobCreateRequest`、`JobRecord` 模型 |
| `app/api/jobs.py` | **新建** | Job API 路由 |
| `app/services/job_executor.py` | **新建** | 后台任务执行器 |
| `app/main.py` | 修改 | 挂载 `jobs_router`，前缀 `/api/v1/jobs` |
| `app/store.py` | 修改 | 扩展 StoreProtocol，增加 job 相关方法 |
| `app/config.py` | 修改 | 新增 `JOB_DEFAULT_TIMEOUT` 等配置（鉴权暂不实现） |

---

## 4. Phase 2：Agent 工具扩展

### 4.1 扩展机制

当前项目已有清晰的工具扩展模式，新增一个工具需要改 3 个文件：

```
tools.py          → 定义 function schema + 加入 TOOLS_MAP
tool_executors.py → 实现执行逻辑 + 注册到 _TOOL_NAME_TO_EXECUTOR
definitions.py    → 为 Agent 配置 tools 字段
```

### 4.2 新增 FILE_TOOLS 工具包

| 工具名 | 功能 | 参数 |
|--------|------|------|
| `read_file` | 读取文件内容 | `file_path: str`, `encoding: str = "utf-8"` |
| `write_file` | 写入文件 | `file_path: str`, `content: str`, `encoding: str = "utf-8"` |
| `list_files` | 列出目录下的文件 | `directory: str = ""`, `pattern: str = "*"` |
| `file_info` | 获取文件元信息 | `file_path: str` |

### 4.3 安全约束

- 所有路径操作限制在 `UPLOAD_DIR` 内
- 使用 `pathlib.Path.resolve()` + 前缀校验防止路径穿越
- `..` 路径段检测与拦截
- 可配置最大文件大小（`MAX_UPLOAD_SIZE_MB`）

```python
def _safe_resolve(file_path: str) -> Path:
    """将相对路径解析为 UPLOAD_DIR 下的安全绝对路径。"""
    upload_dir = Path(os.getenv("UPLOAD_DIR", "uploads")).resolve()
    resolved = (upload_dir / file_path).resolve()
    if not str(resolved).startswith(str(upload_dir)):
        raise ValueError(f"路径越界: {file_path}")
    return resolved
```

### 4.4 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `app/services/agents/tools.py` | 修改 | 新增 `FILE_TOOLS` schema 列表，加入 `TOOLS_MAP` |
| `app/services/agents/tool_executors.py` | 修改 | 新增 `execute_file_tool`，注册到 `_TOOL_NAME_TO_EXECUTOR` |
| `app/services/agents/definitions.py` | 修改 | 为需要文件能力的 Agent 配置 `FILE_TOOLS` |

### 4.5 后续可扩展方向

| 工具包 | 场景 | 优先级 |
|--------|------|--------|
| `HTTP_TOOLS` | 调用外部 API、Webhook | 按需 |
| `CODE_TOOLS` | 执行 Python 代码片段（沙箱） | 按需 |
| `NOTIFICATION_TOOLS` | 发送通知（邮件、消息） | 按需 |

---

## 5. Phase 3：部署方案

### 5.1 现有 Docker 配置

当前已有 `Dockerfile` 和 `docker-compose.yml`，包含：
- `app` 服务（FastAPI，端口 8001）
- `postgres` 服务（PostgreSQL 16）

### 5.2 Docker Compose 更新

```yaml
services:
  postgres:
    image: postgres:16-alpine
    container_name: agents_office_db
    restart: unless-stopped
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: ecom_dev
      POSTGRES_PASSWORD: ecom_dev_pass
      POSTGRES_DB: ecom_ai_lab
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./scripts/init_db.sql:/docker-entrypoint-initdb.d/01_init.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ecom_dev -d ecom_ai_lab"]
      interval: 5s
      timeout: 3s
      retries: 5

  app:
    build: .
    container_name: agents_office_app
    restart: unless-stopped
    ports:
      - "8001:8001"
    env_file:
      - .env
    environment:
      DATABASE_URL_SYNC: postgresql://ecom_dev:ecom_dev_pass@postgres:5432/ecom_ai_lab
    volumes:
      - uploads_data:/app/uploads              # 文件持久化（命名 volume）
      # - /host/shared-data:/app/uploads       # 或 bind mount 共享宿主机目录
    depends_on:
      postgres:
        condition: service_healthy

volumes:
  pgdata:
    driver: local
  uploads_data:
    driver: local
```

### 5.3 Dockerfile 更新

```dockerfile
FROM python:3.12-slim

WORKDIR /app

RUN echo 'deb https://mirrors.aliyun.com/debian/ trixie main non-free-firmware' > /etc/apt/sources.list \
    && echo 'deb https://mirrors.aliyun.com/debian/ trixie-updates main non-free-firmware' >> /etc/apt/sources.list \
    && echo 'deb https://mirrors.aliyun.com/debian-security/ trixie-security main non-free-firmware' >> /etc/apt/sources.list \
    && apt-get update && apt-get install -y --no-install-recommends \
    libpq-dev curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt python-dotenv \
    && find /usr -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null; true

COPY app/ app/
RUN mkdir -p /app/uploads \
    && find /usr -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null; true \
    && find /usr -name "*.pyc" -delete 2>/dev/null; true

EXPOSE 8001

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8001"]
```

### 5.4 宿主机文件访问方式对比

在 Docker 容器中，默认**无法**直接操作宿主机文件。以下是两种解决方案：

| 方案 | 原理 | 适用场景 | 优缺点 |
|------|------|----------|--------|
| **Volume 挂载** | `docker run -v /host/data:/app/uploads` | 同机部署，共享目录 | 简单直接；耦合宿主机路径 |
| **API 传输** | OpenClaw 通过 upload 接口上传文件 | 分机部署 | 完全解耦；大文件效率低 |

**推荐**：默认使用 API 传输模式（利用已有 `POST /api/v1/office/upload` 接口），docker-compose 中预留 bind mount 注释行供同机场景启用。

文件交互流程：

```
OpenClaw
  │
  ├── 1. POST /api/v1/office/upload  (上传文件到 AgentFleet)
  │       → 返回 { file_name, file_path }
  │
  ├── 2. POST /api/v1/jobs           (提交任务，引用文件名)
  │       → { "task": "分析文件", "context": { "file": "sales.csv" } }
  │
  │   ... Agent 在容器内 /app/uploads/ 下读写文件 ...
  │
  ├── 3. GET /api/v1/jobs/{job_id}   (获取结果)
  │       → result 中包含输出文件路径
  │
  └── 4. GET /api/v1/office/uploads/{file_name}/preview  (下载结果文件)
```

### 5.5 环境变量配置（.env.example 新增项）

```bash
# ---------- Job API ----------
# JOB_API_KEY=                        # 鉴权暂不实现，后续迭代增加
JOB_DEFAULT_TIMEOUT=300               # 默认任务超时（秒）
JOB_CALLBACK_TIMEOUT=10               # 回调请求超时（秒）

# ---------- 文件存储 ----------
UPLOAD_DIR=uploads                    # 文件上传目录（Docker 中建议挂载 volume）
MAX_UPLOAD_SIZE_MB=50                 # 单文件上传大小限制
```

### 5.6 数据库建表 SQL

在 `scripts/init_db.sql` 中新增：

```sql
CREATE TABLE IF NOT EXISTS jobs (
    job_id            VARCHAR(32) PRIMARY KEY,
    status            VARCHAR(20) NOT NULL DEFAULT 'pending',
    task              TEXT NOT NULL,
    context           JSONB,
    agent_slug        VARCHAR(100),
    callback_url      TEXT,
    priority          VARCHAR(20) NOT NULL DEFAULT 'normal',
    timeout_seconds   INTEGER NOT NULL DEFAULT 300,
    dispatched_agents JSONB DEFAULT '[]',
    result            JSONB,
    summary           TEXT,
    messages          JSONB DEFAULT '[]',
    error             TEXT,
    usage             JSONB,
    duration_ms       INTEGER,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_jobs_status ON jobs (status);
CREATE INDEX idx_jobs_created_at ON jobs (created_at DESC);
```

---

## 6. OpenClaw 对接示例

### 6.1 轮询模式

```python
import httpx
import time

BASE_URL = "http://agentfleet:8001"

# 1. 上传文件（如有需要）
with open("sales_2024.csv", "rb") as f:
    upload_resp = httpx.post(
        f"{BASE_URL}/api/v1/office/upload",
        files={"file": ("sales_2024.csv", f)},
    )
    file_info = upload_resp.json()

# 2. 提交任务
resp = httpx.post(f"{BASE_URL}/api/v1/jobs", json={
    "task": "分析 sales_2024.csv 文件，生成销售趋势报告",
    "context": {"file": "sales_2024.csv"},
    "timeout_seconds": 120,
})
job_id = resp.json()["data"]["job_id"]

# 3. 轮询结果
while True:
    resp = httpx.get(f"{BASE_URL}/api/v1/jobs/{job_id}")
    job = resp.json()["data"]
    if job["status"] in ("succeeded", "failed"):
        break
    time.sleep(2)

# 4. 获取结果
if job["status"] == "succeeded":
    print(job["summary"])       # 自然语言摘要
    print(job["result"])        # 结构化结果
    print(job["usage"])         # token 消耗
else:
    print(job["error"])         # 错误信息
```

### 6.2 回调模式

```python
import httpx

BASE_URL = "http://agentfleet:8001"

# 提交任务并指定回调 URL
resp = httpx.post(f"{BASE_URL}/api/v1/jobs", json={
    "task": "生成产品对比分析报告",
    "callback_url": "http://openclaw:9001/api/webhook/agentfleet",
    "timeout_seconds": 180,
}, headers=headers)
job_id = resp.json()["data"]["job_id"]

# AgentFleet 完成后主动 POST 到 callback_url，body 为：
# {
#     "job_id": "...",
#     "status": "succeeded",
#     "summary": "...",
#     "result": {...},
#     "usage": {...},
#     "duration_ms": 12345
# }
```

### 6.3 SSE 流式模式

```python
import httpx

BASE_URL = "http://agentfleet:8001"

with httpx.stream("POST", f"{BASE_URL}/api/v1/jobs/stream", json={
    "task": "帮我查询本月销量前10的商品",
}) as response:
    for line in response.iter_lines():
        if line.startswith("event:"):
            event_type = line[len("event:"):].strip()
        elif line.startswith("data:"):
            data = line[len("data:"):].strip()
            print(f"[{event_type}] {data}")
```

### 6.4 指定 Agent 直接执行

```python
# 跳过调度者，直接指定 Agent 执行
resp = httpx.post(f"{BASE_URL}/api/v1/jobs", json={
    "task": "生成一张电商促销海报",
    "agent_slug": "designer",               # 直接指定设计师 Agent
    "timeout_seconds": 60,
})
```

---

## 7. 实施步骤

按三个阶段推进，每个阶段可独立验证：

### Phase 1：Job API（打通链路）— 优先

1. 新增 `JobCreateRequest` / `JobRecord` 数据模型
2. 新增 `app/api/jobs.py` 路由
3. 新增 `app/services/job_executor.py` 后台执行器
4. 扩展 store 层（内存 + PostgreSQL）
5. 更新 `app/main.py` 挂载路由
6. 更新 `app/config.py` 新增 Job 配置项
7. 数据库建表 SQL
8. ~~新增 API Key 鉴权中间件~~（暂不实现，后续迭代）

### Phase 2：Agent 工具扩展

8. 新增 `FILE_TOOLS` 工具包 schema
9. 实现 `execute_file_tool` 执行器 + 路径安全校验
10. 注册到 `_TOOL_NAME_TO_EXECUTOR`
11. 为适当的 Agent 启用文件工具

### Phase 3：部署完善

12. 更新 Dockerfile（创建 uploads 目录）
13. 更新 docker-compose.yml（volume 配置）
14. 更新 .env.example（新增配置项）
15. 更新 `scripts/init_db.sql`（jobs 表）

---

## 8. 注意事项

- **超时处理**：`job_executor` 应使用 `asyncio.wait_for` 包裹 dispatch 调用，超时后更新 JobRecord 状态为 failed
- **并发控制**：可通过 `asyncio.Semaphore` 限制同时执行的 job 数量，防止资源耗尽
- **幂等性**：相同 job_id 不可重复提交
- **日志**：job 执行全程应记录 trace_id，便于排查问题
- **监控**：可在 `/api/v1/jobs` 列表接口基础上增加统计端点（成功率、平均耗时等）
