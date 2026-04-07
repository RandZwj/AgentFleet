# Agent 管理功能问题清单

> 最后更新：2026-04-07（第三次更新）

## 1. 文档目标

梳理 AgentsOffice 中 Agent 管理功能（新增、展示、编辑、删除）在前后端的已知问题和交互缺陷，为后续逐项修复提供参考。

---

## 2. 功能架构概览

### 2.1 前端组件

| 组件 | 文件 | 职责 |
| --- | --- | --- |
| ReactOverlay | `frontend/src/react/ReactOverlay.tsx` | 顶层壳：Agent 数量展示、`+` 创建入口、面板协调 |
| AgentCreateDialog | `frontend/src/react/AgentCreateDialog.tsx` | 创建 Agent 对话框（名称/slug/角色/颜色/房间） |
| AgentConfigPanel | `frontend/src/react/AgentConfigPanel.tsx` | 编辑 Agent（身份/模型/提示词/技能包 四个 Tab） |
| AgentStatusBar | `frontend/src/react/AgentStatusBar.tsx` | 底部状态栏（Agent 卡片 + 状态 + token 统计） |
| agentRegistry | `frontend/src/shared/agentRegistry.ts` | 前端注册表缓存（从 `/api/v1/office/agent-registry` 加载） |

### 2.2 后端 API（`/api/v1/office/`）

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/agent-registry` | 合并注册表（内置 + DB），前端唯一数据源 |
| GET | `/agent-config` | 所有 Agent 配置（模型 + 身份） |
| PUT | `/agent-config/{slug}` | 创建或更新 Agent |
| DELETE | `/agent-config/{slug}` | 删除自定义 Agent（内置 403） |
| GET | `/agent-templates` | 预设模板列表 |
| POST | `/agent-config/{slug}/refine-prompt` | AI 优化提示词 |
| GET | `/skill-packs` | 技能包目录 |
| GET/PUT | `/agents/{agent_id}/skill-packs` | 读/写技能包绑定 |
| POST | `/agents` | 通用创建（旧路径） |
| GET | `/agents` | 列出 DB 中的 Agent |

### 2.3 数据存储

- 主存储：`agents` 表（`AgentRow`），字段包括 `agent_id`、`name`、`slug`、`model_config`（JSONB）、`extra_metadata`（JSONB）
- 运行时合并：内置定义在 `definitions.py`（代码），`registry.py` 负责与 DB 合并
- 技能包：存在 `metadata.skill_packs`（列表），与内置的 `tools` 字段做兼容

---

## 3. 架构层问题

### 3.1 两套 Agent 创建路径不统一

**现象**：

- 前端创建 Agent 走 `PUT /agent-config/{slug}`，将模型配置和身份配置扁平传入，由 `update_agent_config_by_slug` 自动 upsert
- 后端还保留了 `POST /agents`，使用 `AgentCreateRequest`，字段结构完全不同（`model_config` 是整包 JSONB，身份信息放 `metadata`）

**影响**：

- 同一张表两种写入方式，字段映射不一致
- 场景模板 `apply_scenario_template` 走 `create_agent`，与前端创建走的 `update_agent_config_by_slug` 是不同的代码路径
- 如果 `POST /agents` 创建的 Agent 缺少某些 metadata 字段（如 `active`），前端展示会异常

**建议**：统一为一套创建路径，废弃或重定向 `POST /agents`

---

### 3.2 `GET /agent-config` 返回字段不完整

**现象**：

`get_all_agent_configs()` 在 `store.py` 第 243-265 行，返回的字段列表中**不包含** `room_id`、`skill_packs`、`tools`、`phaser_agent_id`。

```python
result[row.slug] = {
    "model_name": ...,
    "temperature": ...,
    "max_tokens": ...,
    "api_base": ...,
    "api_key": ...,
    "display_name": ...,
    "role": ...,
    "system_prompt": ...,
    "color": ...,
    "active": ...,
    # 缺少: room_id, skill_packs, tools, phaser_agent_id
}
```

**影响**：

- `AgentConfigPanel` 的技能 Tab 从 `agent-config` 读取 `skill_packs` 常常拿不到值，只能靠重新勾选
- `AgentStatusBar` 调用 `agent-config` 同步时丢失某些字段

**建议**：在 `get_all_agent_configs` 中补充 `room_id`、`skill_packs`、`tools`、`phaser_agent_id` 字段的返回

---

### 3.3 内置 Agent 无法通过 UI 保存技能包

**现象**：

- 技能包保存流程：前端先 `GET /agents` 列出 DB 中所有 Agent → 按 slug 找到 `agent_id` → `PUT /agents/{agent_id}/skill-packs`
- 内置 Agent（如 `copywriter`、`ops_planner`）如果从未在 DB 中创建过（即纯代码定义），`GET /agents` 返回的列表中不包含它们
- 结果：前端提示"找不到 Agent"，无法保存技能包

**相关代码**（`AgentConfigPanel.tsx` 第 673-678 行）：

```tsx
const listRes = await fetch('/api/v1/office/agents');
const agents = listJson?.data?.agents || [];
const agent = agents.find((a) => a.slug === agentSlug);
if (!agent) { setMessage('找不到 Agent'); return; }
```

**建议**：

- 方案 A：保存技能包时，如果 DB 中不存在该 slug 的 Agent，先自动创建一条（从内置定义初始化）
- 方案 B：提供一个 `PUT /agent-config/{slug}/skill-packs` 接口，按 slug 操作而非 agent_id

---

### 3.4 `active` 默认值问题

**现象**：

- `get_active_agent_definitions()` 要求 `metadata.active == true` 才纳入活跃列表
- 默认值为 `false`（`store.py` 第 330 行：`meta.get("active", False)`）
- 如果某条 DB 记录的 metadata 中没有 `active` 字段，该 Agent 不会出现在调度员的可分配列表中

**影响**：通过 `POST /agents` 或场景模板创建的 Agent，如果创建时未显式设置 `active: true`，会出现"DB 有记录但调度时找不到"的情况

**建议**：将默认值改为 `true`，或在创建路径中确保 `active=true`

---

## 4. 新增 Agent 交互问题

### 4.1 中文名称无法自动生成 slug

**现象**：

`AgentCreateDialog` 中的 `toSlug()` 函数（第 32-42 行）会将中文字符全部移除：

```javascript
.replace(/[\u4e00-\u9fff]+/g, '')
```

如果用户输入纯中文名称（如"售后客服"），生成的 slug 为空字符串，fallback 到 `agent_${Date.now()...}` 这样的随机标识。

**影响**：用户必须手动输入英文 slug，体验不友好

**建议**：

- 可提供拼音转换（如 `pinyin` 库），将"售后客服" → `shouhou_kefu`
- 或者在 UI 上更明确地提示用户需要手动输入 slug

---

### 4.2 创建时不设置提示词

**现象**：

`AgentCreateDialog` 创建时不传 `system_prompt`，创建后页面提示"创建后可在配置面板中设置提示词和模型"。创建成功后自动打开 `AgentConfigPanel`。

**影响**：

- 创建后如果用户忘记配置提示词就关闭面板，这个 Agent 没有 `system_prompt`，调度员分配任务给它时会表现异常（空白或通用回复）
- `registry.py` 第 47-48 行：`if not agent.get("system_prompt"): continue` — 没有提示词的自定义 Agent 直接跳过，不会注册到调度员

**建议**：

- 创建对话框中增加简易提示词输入（可选但鼓励填写）
- 或在 Agent 列表/状态栏上对缺少提示词的 Agent 显示警告标识

---

### 4.3 创建后的精灵表映射

**现象**：

自定义 Agent 创建后，Phaser 场景中的精灵通过 `getSpriteKey(slug)` 映射。如果 slug 不在预定义映射中，会 fallback 到默认精灵。

**影响**：所有自定义 Agent 在地图上看起来一样（使用同一个默认角色形象），无法视觉区分

**建议**：

- 创建时允许选择精灵外观（从可用的 sprite 列表中选择）
- 或随机分配不同的默认精灵

---

## 5. 展示 / 列表问题

### 5.1 状态栏 modelDisplay 硬编码

**现象**：

`AgentStatusBar` 初始化时，所有 Agent 的 `modelDisplay` 都硬编码为 `'Gemini Flash'`（第 63、79 行）：

```tsx
modelDisplay: 'Gemini Flash',
```

只有在 `syncAgentDefinitions` 成功后才会用实际值覆盖。

**影响**：页面加载初期或 API 失败时，所有 Agent 显示相同的模型名

**建议**：默认值改为 `'默认模型'` 或空字符串，避免误导

---

### 5.2 ~~Agent 配置面板缺少房间设置~~ ✅ 已调整

~~**现象**：创建时可选房间，但编辑面板无房间字段~~

**已调整**：创建对话框已移除房间选择，改为在地图上随机可通行位置生成精灵。Agent 不再绑定固定房间，而是通过任务驱动移动到工位

---

### 5.3 配置面板底部保存按钮始终显示

**现象**：

`AgentConfigPanel` 底部有一个全局"保存配置"按钮（第 701-711 行），在所有 Tab 下都显示。但这个按钮调用的是 `handleSave`（保存模型+身份配置），并**不会保存技能包**。

**影响**：

- 用户在技能 Tab 下点"保存配置"以为保存了技能包，实际上只保存了身份和模型配置
- 技能 Tab 有单独的"保存技能配置"按钮，但两个保存按钮容易混淆

**建议**：

- 在技能 Tab 下隐藏全局保存按钮，或将两者合并
- 或点击全局保存时也一并保存技能包

---

## 6. 编辑 / 更新问题

### 6.1 配置更新后注册表不及时刷新

**现象**：

保存配置后，`AgentConfigPanel` 发送 `agent:config-updated` 事件，`AgentStatusBar` 会重新拉取 `agent-config`。但 `agentRegistry` 缓存（`agentRegistry.ts`）不会被 invalidate。

**影响**：

- 修改 `display_name` 或 `color` 后，ChatBox 中的 Agent 名称/颜色可能不会立即更新
- Phaser 场景中的 Agent 名称标签不会同步更新

**建议**：保存配置成功后，调用 `invalidateAgentCache()` 并触发 `agent:registry-changed`

---

### 6.2 编辑内置 Agent 的提示词后不持久化

**现象**：

内置 Agent（如 `copywriter`）在 DB 中可能没有记录。当用户修改其提示词并保存时，`update_agent_config_by_slug` 会自动创建一条 DB 记录。但此后调度员加载时，`registry.py` 的合并逻辑是"DB 非空字段覆盖内置默认"。

**影响**：如果用户保存时某些字段留空（如 `model_name` 为空字符串），空值可能不会覆盖内置默认值，导致保存后的配置与用户预期不一致

**建议**：明确区分"用户主动设为空"和"未设置使用默认"的语义

---

## 7. 删除问题

### 7.1 删除无级联清理

**现象**：

`delete_agent_by_slug` 只删除 `agents` 表中的记录，不清理关联数据。

**可能的遗留数据**：

- `cost_records` 表中该 Agent 的成本记录
- `chat_messages` 表中该 Agent 的消息记录
- `agent_skills` 绑定关系
- `agent_events` 事件日志

**影响**：删除后的 slug 如果被重新创建，可能关联到旧的成本记录或消息

**建议**：

- 对话记录和成本记录保留（历史数据有价值）
- `agent_skills` 绑定关系应级联删除
- 或改为软删除（标记 `active=false` + `deleted_at`）

---

### 7.2 删除后 Phaser 精灵移除逻辑

**现象**：

删除 Agent 后，前端发送 `agent:despawned` 事件，Phaser 场景的 `onAgentDespawned` 会移除精灵。但如果此时该 Agent 正在执行工作动画或移动中，可能产生异常。

**建议**：`onAgentDespawned` 中先停止所有关联的 Tween 和定时器，再销毁精灵

---

### 7.3 内置 Agent 不可删除，限制过于严格

**现象**：

- 前端 `AgentConfigPanel`：`isBuiltin` 为 `true` 时不渲染删除按钮
- 后端 `DELETE /agent-config/{slug}`：slug 在 `BUILTIN_AGENTS` 中则返回 403

导致初始化的 5 个内置 Agent 完全无法删除，用户只能停用。

**期望规则**：

- **调度员（dispatcher）**：不可删除（系统核心）
- **其他 Agent（不论内置/自定义）+ 未激活状态**：可删除
- **其他 Agent + 激活中**：需先停用再删除，或允许删除但给二次确认提醒

**需要修改的位置**：

- 前端 `AgentConfigPanel`：删除按钮的显示条件从 `!isBuiltin` 改为 `slug !== 'dispatcher' && !config.active`
- 后端 `DELETE /agent-config/{slug}`：仅禁止删除 `dispatcher`，其他 slug 允许删除

---

## 8. 数据一致性问题

### 8.1 内置定义与 DB 记录的合并冲突

**现象**：

`registry.py` 中 `load_agent_registry` 的合并规则是"DB 非空字段覆盖内置默认"。但存在以下边角情况：

- 用户修改了内置 Agent 的配置并保存到 DB
- 后续代码更新了内置 Agent 的默认 `system_prompt`
- DB 中的旧 `system_prompt` 会覆盖代码中的新版本

**影响**：内置 Agent 的提示词更新后，已修改过配置的用户不会自动获取新版本

**建议**：增加版本机制或"重置为默认"按钮

---

### 8.2 slug 唯一性缺少前端校验

**现象**：

创建 Agent 时前端不校验 slug 是否已存在。如果输入已有的 slug，`PUT /agent-config/{slug}` 会触发**更新而非创建**（upsert 行为），静默覆盖现有 Agent 的配置。

**影响**：用户可能无意中覆盖已有 Agent 的配置

**建议**：创建前先检查 slug 是否已存在，已存在时提示用户

---

## 9. 优先级排序

| 优先级 | 问题编号 | 描述 | 影响面 |
| --- | --- | --- | --- |
| ~~P0~~ | ~~3.2~~ | ~~`GET /agent-config` 返回不完整~~ | ✅ 已修复：补充 room_id/skill_packs/tools/phaser_agent_id |
| ~~P0~~ | ~~3.3~~ | ~~内置 Agent 无法保存技能包~~ | ✅ 已修复：新增按 slug 的技能包接口 |
| ~~P0~~ | ~~3.4~~ | ~~`active` 默认值导致 Agent 不可调度~~ | ✅ 已修复：默认值改为 true |
| ~~P1~~ | ~~5.3~~ | ~~保存按钮和技能保存混淆~~ | ✅ 已修复：技能 Tab 隐藏全局保存按钮 |
| ~~P1~~ | ~~6.1~~ | ~~配置更新后注册表不刷新~~ | ✅ 已修复：保存后刷新缓存 |
| P1 | 3.1 | 两套创建路径不统一 | 待后续处理 |
| ~~P1~~ | ~~8.2~~ | ~~slug 唯一性缺少校验~~ | ✅ 已修复：创建前检查已存在 |
| ~~P2~~ | ~~5.2~~ | ~~配置面板缺少房间设置~~ | ✅ 已调整：改为随机坐标生成 |
| P2 | 4.1 | 中文名称无法生成 slug | 体验优化 |
| P2 | 4.2 | 创建时不设提示词 | 引导不足 |
| ~~P2~~ | ~~5.1~~ | ~~modelDisplay 硬编码~~ | ✅ 已修复：默认显示"默认模型" |
| ~~P1~~ | ~~7.3~~ | ~~内置 Agent 不可删除，限制过严~~ | ✅ 已修复：仅 dispatcher 不可删 |
| P2 | 7.1 | 删除无级联清理 | 数据残留 |
| P2 | 7.2 | 删除时精灵清理不完整 | 潜在异常 |
| P3 | 4.3 | 自定义 Agent 精灵外观一致 | 视觉区分 |
| P3 | 6.2 | 内置 Agent 默认值覆盖问题 | 边角情况 |
| P3 | 8.1 | 内置定义更新后不同步 | 版本管理 |

---

## 10. 全局待办汇总

以下整合了 Agent 管理问题文档和动画交互文档中所有未完成的待办事项，按优先级排列。

### P1（功能完善）

| # | 来源 | 描述 | 备注 |
| --- | --- | --- | --- |
| 1 | 管理-3.1 | 两套 Agent 创建路径不统一 | `PUT /agent-config/{slug}` vs `POST /agents`，需废弃或统一 |

### P2（体验优化）

| # | 来源 | 描述 | 备注 |
| --- | --- | --- | --- |
| 2 | 管理-4.1 | 中文名称无法自动生成 slug | 可引入拼音转换或更明确的 UI 提示 |
| 3 | 管理-4.2 | 创建 Agent 时不设置提示词 | 引导不足，可增加简易提示词输入 |
| 4 | 管理-7.1 | 删除 Agent 无级联清理 | agent_skills 绑定应级联删除，或改为软删除 |
| 5 | 管理-7.2 | 删除时 Phaser 精灵清理不完整 | 需先停止 Tween/定时器再销毁 |
| 6 | 动画-待优化#1 | 角色坐下工位时应显示椅背遮挡 | 需坐姿方向帧素材 |
| 7 | 动画-待优化#3 | 角色穿过房间时门没有开关交互 | 需定义门对象 + 开关动画 + 路径触发 |

### P3（边角优化）

| # | 来源 | 描述 | 备注 |
| --- | --- | --- | --- |
| 8 | 管理-4.3 | 自定义 Agent 精灵外观一致 | 所有自定义 Agent 用同一默认精灵，无法视觉区分 |
| 9 | 管理-6.2 | 内置 Agent 默认值覆盖问题 | DB 旧配置可能覆盖代码中更新的默认提示词 |
| 10 | 管理-8.1 | 内置定义更新后不同步 | 需版本机制或"重置为默认"按钮 |

### 功能演进（无明确优先级）

| # | 来源 | 描述 | 备注 |
| --- | --- | --- | --- |
| 11 | 动画-Phase 3 | 多 Agent 协作演出 | 两人会面、房间讨论、任务交接、面向看板汇报 |
| 12 | 本轮新增 | 多 Agent 并行调度 + 调度员汇总 | ✅ 已完成：DAG 执行引擎 + 汇总总结 |

---

## 11. 结论

Agent 管理的 P0 问题已全部修复，P1 仅剩创建路径统一（改动面大，建议单独处理）。剩余待办以 P2 体验优化和 P3 边角情况为主，不影响核心功能使用。动画方面 Phase 1-2 已完成，Phase 3 协作演出和素材相关优化可按需推进。
