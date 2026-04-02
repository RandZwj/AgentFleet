/**
 * Agent 注册表 — 前端唯一数据源。
 *
 * 从后端 GET /api/v1/office/agent-registry 加载，
 * 替代 ChatBox、OfficeScene、AgentStatusBar 中的硬编码 AGENTS 数组。
 */

export interface AgentRegistryEntry {
  slug: string;
  displayName: string;
  role: string;
  color: string;         // CSS hex color, e.g. "#4ade80"
  roomId: string;        // Phaser room id
  phaserAgentId: string; // Phaser sprite id
  isDispatcher: boolean;
  isBuiltin: boolean;
}

/** sprite 映射：slug → 精灵 key。后端不管前端素材，由前端维护。 */
const AVAILABLE_SPRITES = Array.from({ length: 14 }, (_unused, index) => {
  return `char_${String(index + 7).padStart(2, '0')}`;
});

const SPRITE_MAP: Record<string, string> = {
  dispatcher: 'char_07',
  copywriter: 'char_08',
  video_editor: 'char_09',
  content_ops: 'char_10',
  art_designer: 'char_11',
};
let nextSpriteIndex = 5; // 用户自定义 agent 从剩余可用精灵开始分配

export function getSpriteKey(slug: string): string {
  if (SPRITE_MAP[slug]) return SPRITE_MAP[slug];
  // 仅在现有素材范围内循环复用，避免请求缺失的 char_01 ~ char_06。
  const key = AVAILABLE_SPRITES[nextSpriteIndex % AVAILABLE_SPRITES.length];
  SPRITE_MAP[slug] = key;
  nextSpriteIndex++;
  return key;
}

/** 已加载的缓存（模块级单例） */
let cachedAgents: AgentRegistryEntry[] | null = null;
let loadPromise: Promise<AgentRegistryEntry[]> | null = null;

/** 硬编码 fallback — 与后端 BUILTIN_AGENTS + DISPATCHER 一致 */
const FALLBACK_AGENTS: AgentRegistryEntry[] = [
  { slug: 'dispatcher', displayName: '调度员', role: '任务分配与调度', color: '#ff6b6b', roomId: 'manager', phaserAgentId: 'agt_dispatcher', isDispatcher: true, isBuiltin: true },
  { slug: 'copywriter', displayName: '文案编辑', role: '内容创作专家', color: '#4ade80', roomId: 'showroom', phaserAgentId: 'agt_copywriter', isDispatcher: false, isBuiltin: true },
  { slug: 'video_editor', displayName: '视频剪辑师', role: '后期制作专家', color: '#60a5fa', roomId: 'datacenter', phaserAgentId: 'agt_video_editor', isDispatcher: false, isBuiltin: true },
  { slug: 'content_ops', displayName: '运营策划', role: '账号运营专家', color: '#f59e0b', roomId: 'workspace', phaserAgentId: 'agt_content_ops', isDispatcher: false, isBuiltin: true },
  { slug: 'art_designer', displayName: '美工设计', role: '视觉设计专家', color: '#ec4899', roomId: 'meeting', phaserAgentId: 'agt_art_designer', isDispatcher: false, isBuiltin: true },
];

/**
 * 加载 Agent 注册表。首次调用会发请求，后续返回缓存。
 * 失败时使用 fallback。
 */
export function loadAgentRegistry(): Promise<AgentRegistryEntry[]> {
  if (cachedAgents) return Promise.resolve(cachedAgents);
  if (loadPromise) return loadPromise;

  loadPromise = fetch('/api/v1/office/agent-registry')
    .then((r) => r.json())
    .then((envelope) => {
      const raw: any[] = envelope?.data?.agents || [];
      if (raw.length === 0) throw new Error('empty registry');
      cachedAgents = raw.map((a) => ({
        slug: a.slug,
        displayName: a.display_name,
        role: a.role || '',
        color: a.color || '#cccccc',
        roomId: a.room_id || 'workspace',
        phaserAgentId: a.phaser_agent_id || '',
        isDispatcher: a.is_dispatcher || false,
        isBuiltin: a.is_builtin ?? true,
      }));
      return cachedAgents;
    })
    .catch(() => {
      cachedAgents = FALLBACK_AGENTS;
      return cachedAgents;
    });

  return loadPromise;
}

/** 同步获取已缓存的 agents（未加载时返回 fallback） */
export function getAgentsCached(): AgentRegistryEntry[] {
  return cachedAgents || FALLBACK_AGENTS;
}

/** 清除缓存，下次调用 loadAgentRegistry 时重新加载 */
export function invalidateAgentCache(): void {
  cachedAgents = null;
  loadPromise = null;
}
