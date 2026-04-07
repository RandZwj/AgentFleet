import Phaser from 'phaser';
import { EventBus } from '../../shared/events/EventBus';
import { getAgentsCached, getSpriteKey } from '../../shared/agentRegistry';

const SPRITE_COLS = 56;
const FRAMES_PER_DIRECTION = 6;
const IDLE_ROW = 0;
const WALK_ROW = 1;

const MAP_TILESET_NAMES = [
  'Room_Builder_Office_32x32',
  'Modern_Office_32x32',
  'int_Basement_32x32',
  'int_Bathroom_32x32',
  'int_Classroom_and_library_32x32',
  'int_Generic_32x32',
  'int_Kitchen_32x32',
  'int_Hospital_32x32',
  'int_Grocery_store_32x32',
];

const VISIBLE_TILE_LAYERS = [
  'Floor Visuals',
  'Wall Visuals',
  'Furniture Visuals L1',
  'Furniture Visuals L2',
  'Furniture Visuals L3',
  'Furniture Visuals L4',
];

// ============================================================
// 房间定义 — 基于 office-agent.json 地图 (30×20 tiles, 960×640 px)
// 坐标直接使用像素值 (tileX*32+16, tileY*32+16)
// ============================================================

interface Anchor {
  x: number;
  y: number;
  facing: Direction;
  type: 'desk' | 'stand' | 'meeting' | 'screen';
}

interface RoomDef {
  label: string;
  entry: { x: number; y: number };
  anchors: Anchor[];
}

// ============================================================
// 工位椅子坐标（tile 坐标，由地图标注确认）
// 如需新增/修改工位，只需编辑此数组
// tileX/tileY 为可通行格子坐标，facing 为面朝电脑方向
// ============================================================
const WORKSTATION_TILES: Array<{ tileX: number; tileY: number; facing: Direction }> = [
  { tileX: 10, tileY: 9, facing: 'down' },
  { tileX: 13, tileY: 9, facing: 'down' },
  { tileX: 10, tileY: 12, facing: 'up' },
  { tileX: 13, tileY: 12, facing: 'up' },
  { tileX: 2, tileY: 9, facing: 'left' },
  { tileX: 2, tileY: 14, facing: 'up' },
  { tileX: 6, tileY: 4, facing: 'down' },
  { tileX: 11, tileY: 17, facing: 'down' },
  { tileX: 16, tileY: 18, facing: 'up' },
  { tileX: 27, tileY: 13, facing: 'up' },
];

function tileToPixel(tileX: number, tileY: number) {
  return { x: tileX * 32 + 16, y: tileY * 32 + 16 };
}

const ROOMS: Record<string, RoomDef> = {
  showroom: {
    label: '商品展厅',
    entry: { x: 304, y: 208 },
    anchors: [
      { x: 176, y: 160, facing: 'up', type: 'stand' },
      { x: 240, y: 160, facing: 'up', type: 'stand' },
      { x: 304, y: 160, facing: 'up', type: 'stand' },
      { x: 176, y: 192, facing: 'down', type: 'stand' },
      { x: 240, y: 192, facing: 'down', type: 'stand' },
      { x: 304, y: 192, facing: 'down', type: 'stand' },
    ],
  },
  manager: {
    label: '调度中心',
    entry: { x: 464, y: 208 },
    anchors: [
      { x: 464, y: 112, facing: 'up', type: 'stand' },
      { x: 528, y: 112, facing: 'up', type: 'stand' },
      { x: 592, y: 112, facing: 'up', type: 'stand' },
      { x: 464, y: 176, facing: 'down', type: 'stand' },
      { x: 528, y: 176, facing: 'down', type: 'stand' },
      { x: 592, y: 176, facing: 'down', type: 'stand' },
    ],
  },
  meeting: {
    label: '协作室',
    entry: { x: 304, y: 368 },
    anchors: [
      { x: 240, y: 368, facing: 'right', type: 'meeting' },
      { x: 368, y: 368, facing: 'left', type: 'meeting' },
      { x: 240, y: 432, facing: 'right', type: 'meeting' },
      { x: 368, y: 432, facing: 'left', type: 'meeting' },
      { x: 304, y: 400, facing: 'down', type: 'stand' },
      { x: 304, y: 448, facing: 'up', type: 'stand' },
    ],
  },
  workspace: {
    label: '待命区',
    entry: { x: 336, y: 272 },
    anchors: [
      { x: 272, y: 272, facing: 'down', type: 'stand' },
      { x: 336, y: 272, facing: 'down', type: 'stand' },
      { x: 400, y: 272, facing: 'down', type: 'stand' },
      { x: 464, y: 272, facing: 'down', type: 'stand' },
      { x: 528, y: 272, facing: 'down', type: 'stand' },
      { x: 592, y: 272, facing: 'down', type: 'stand' },
    ],
  },
  office: {
    label: '开放办公区',
    entry: { x: 336, y: 272 },
    anchors: WORKSTATION_TILES.map((w) => ({
      ...tileToPixel(w.tileX, w.tileY),
      facing: w.facing,
      type: 'desk' as const,
    })),
  },
  corridor: {
    label: '走廊',
    entry: { x: 336, y: 400 },
    anchors: [
      { x: 272, y: 400, facing: 'down', type: 'stand' },
      { x: 400, y: 400, facing: 'down', type: 'stand' },
      { x: 528, y: 400, facing: 'right', type: 'stand' },
      { x: 272, y: 464, facing: 'down', type: 'stand' },
      { x: 560, y: 464, facing: 'left', type: 'stand' },
      { x: 144, y: 560, facing: 'right', type: 'stand' },
      { x: 304, y: 560, facing: 'down', type: 'stand' },
      { x: 688, y: 496, facing: 'down', type: 'stand' },
      { x: 688, y: 592, facing: 'up', type: 'stand' },
    ],
  },
  datacenter: {
    label: '数据仓库',
    entry: { x: 720, y: 176 },
    anchors: [
      { x: 752, y: 112, facing: 'right', type: 'stand' },
      { x: 752, y: 144, facing: 'right', type: 'stand' },
      { x: 848, y: 112, facing: 'up', type: 'stand' },
      { x: 848, y: 144, facing: 'up', type: 'stand' },
      { x: 720, y: 112, facing: 'down', type: 'stand' },
      { x: 720, y: 176, facing: 'down', type: 'stand' },
    ],
  },
};

type Direction = 'down' | 'right' | 'up' | 'left';

const IDLE_COL: Record<Direction, number> = {
  right: 0,
  up: 1,
  left: 2,
  down: 3,
};

const WALK_COL_START: Record<Direction, number> = {
  right: 0,
  up: 6,
  left: 12,
  down: 18,
};

const DIRECTIONS: Direction[] = ['down', 'right', 'up', 'left'];

function getFrameIndex(row: number, col: number): number {
  return row * SPRITE_COLS + col;
}

function getRoom(roomId: string) {
  return ROOMS[roomId] || ROOMS.workspace;
}

// ============================================================
// Agent 配置
// ============================================================
function cssColorToHex(css: string): number {
  return parseInt(css.replace('#', ''), 16);
}

function buildAgentSpawns() {
  return getAgentsCached().map((a) => ({
    agentId: a.phaserAgentId || `agt_${a.slug}`,
    name: a.displayName,
    slug: a.slug,
    spriteKey: getSpriteKey(a.slug),
    homeRoom: a.roomId || 'workspace',
    color: cssColorToHex(a.color),
  }));
}

interface AgentCharacter {
  container: Phaser.GameObjects.Container;
  sprite: Phaser.GameObjects.Sprite;
  nameTag: Phaser.GameObjects.Text;
  agentId: string;
  slug: string;
  spriteKey: string;
  color: number;
  isMoving: boolean;
  facing: Direction;
  homeRoom: string;
  currentRoom: string;
  currentAnchor?: Anchor;
  workStatus: 'idle' | 'working';
  pendingMoveRoom?: string;
  workTimer?: Phaser.Time.TimerEvent;
  bubbleContainer?: Phaser.GameObjects.Container;
  bubbleTimer?: Phaser.Time.TimerEvent;
  idleTween?: Phaser.Tweens.Tween;
  workTween?: Phaser.Tweens.Tween;
  statusIndicator?: Phaser.GameObjects.Container;
  statusDotTween?: Phaser.Tweens.Tween;
  idleWalkTimer?: Phaser.Time.TimerEvent;
  thinkingIndicator?: Phaser.GameObjects.Container;
  thinkingTween?: Phaser.Tweens.Tween;
}

export class OfficeScene extends Phaser.Scene {
  private agents: AgentCharacter[] = [];
  private agentSpawns: ReturnType<typeof buildAgentSpawns> = [];
  private map!: Phaser.Tilemaps.Tilemap;
  private collisionLayer?: Phaser.Tilemaps.TilemapLayer;

  constructor() {
    super('OfficeScene');
  }

  create() {
    this.agentSpawns = buildAgentSpawns();

    this.map = this.make.tilemap({ key: 'office-map' });
    const tilesets = MAP_TILESET_NAMES
      .map((tilesetName) => this.map.addTilesetImage(tilesetName, tilesetName))
      .filter((tileset): tileset is Phaser.Tilemaps.Tileset => Boolean(tileset));

    VISIBLE_TILE_LAYERS.forEach((layerName, index) => {
      const layer = this.map.createLayer(layerName, tilesets, 0, 0);
      if (layer) {
        layer.setDepth(index);
      }
    });

    // Collision Layer (invisible) for pathfinding
    const cl = this.map.createLayer('Collision Layer', tilesets, 0, 0);
    if (cl) {
      cl.setVisible(false);
      this.collisionLayer = cl;
    }

    this.createAnimations();
    this.createAgents();

    // 摄像机
    const mapWidth = this.map.widthInPixels;
    const mapHeight = this.map.heightInPixels;
    const chatBoxWidth = 520;
    const cam = this.cameras.main;

    const vpWidth = this.scale.width - chatBoxWidth;
    const vpHeight = this.scale.height;
    cam.setViewport(0, 0, vpWidth, vpHeight);

    const fitZoom = Math.min(vpWidth / mapWidth, vpHeight / mapHeight) * 0.95;
    const initialZoom = Math.max(fitZoom, 0.5);

    cam.setBounds(-200, -200, mapWidth + 400, mapHeight + 400);
    cam.centerOn(mapWidth / 2 + 20, mapHeight / 2 + 80);
    cam.setZoom(initialZoom);

    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (pointer.isDown) {
        this.cameras.main.scrollX -= (pointer.x - pointer.prevPosition.x) / this.cameras.main.zoom;
        this.cameras.main.scrollY -= (pointer.y - pointer.prevPosition.y) / this.cameras.main.zoom;
      }
    });

    this.scale.canvas.addEventListener('wheel', (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const newZoom = Phaser.Math.Clamp(
          this.cameras.main.zoom - e.deltaY * 0.005, 0.4, 4,
        );
        this.cameras.main.setZoom(newZoom);
      } else {
        this.cameras.main.scrollX += e.deltaX / this.cameras.main.zoom;
        this.cameras.main.scrollY += e.deltaY / this.cameras.main.zoom;
      }
    }, { passive: false });

    this.input.mouse?.disableContextMenu();

    EventBus.on('chat:agent-move', this.onChatAgentMove, this);
    EventBus.on('chat:agent-bubble', this.onAgentBubble, this);
    EventBus.on('agent:spawned', this.onAgentSpawned, this);
    EventBus.on('agent:despawned', this.onAgentDespawned, this);
    EventBus.on('agent:status', this.onAgentStatusChange, this);

    EventBus.emit('scene:ready');
  }

  // ============================================================
  // 事件处理
  // ============================================================
  private onChatAgentMove(data: { agentId: string; roomId: string }) {
    this.moveAgentToRoom(data.agentId, data.roomId);
  }

  private onAgentBubble(data: { agentSlug: string; text: string; duration?: number }) {
    this.showAgentBubble(data.agentSlug, data.text, data.duration);
  }

  private onAgentStatusChange(data: { agentSlug: string; status: 'idle' | 'working' | 'standby' | 'error' }) {
    const agent = this.agents.find((a) => a.slug === data.agentSlug);
    if (!agent) return;

    if (data.status === 'working') {
      const wasIdle = agent.workStatus === 'idle';
      agent.workStatus = 'working';
      if (wasIdle) {
        this.playReceiveTaskEffect(agent);
      }
      this.showThinkingIndicator(agent);
      if (!agent.isMoving && this.isAtWorkAnchor(agent)) {
        this.hideThinkingIndicator(agent);
        this.stopIdleMotion(agent);
        this.startWorkingMotion(agent);
        this.showWorkingIndicator(agent);
      }
      return;
    }

    if (data.status === 'idle') {
      const wasWorking = agent.workStatus === 'working';
      agent.workStatus = 'idle';

      this.hideThinkingIndicator(agent);

      if (agent.workTimer) {
        agent.workTimer.destroy();
        agent.workTimer = undefined;
      }

      if (wasWorking && agent.pendingMoveRoom) {
        const dest = agent.pendingMoveRoom;
        agent.pendingMoveRoom = undefined;
        this.showCompletionEffect(agent);
        this.time.delayedCall(600, () => {
          this.executeMoveToRoom(agent, dest);
        });
        return;
      }

      this.stopWorkingMotion(agent);
      this.hideWorkingIndicator(agent);
      if (wasWorking && !agent.isMoving) {
        this.showCompletionEffect(agent);
      }
      if (!agent.isMoving) {
        this.startIdleMotion(agent);
      }
      return;
    }

    if (data.status === 'error') {
      this.hideThinkingIndicator(agent);
      this.showErrorEffect(agent);
      return;
    }

    if (data.status === 'standby') {
      agent.workStatus = 'idle';
      this.hideThinkingIndicator(agent);
      this.stopWorkingMotion(agent);
      this.hideWorkingIndicator(agent);
      this.stopIdleMotion(agent);
      this.playAgentAnimation(agent, 'idle');
    }
  }

  private onAgentSpawned(data: {
    slug: string;
    displayName: string;
    color: string;
    roomId?: string;
    phaserAgentId: string;
  }) {
    if (this.agents.find((a) => a.slug === data.slug)) return;

    const spriteKey = getSpriteKey(data.slug);
    const agentId = data.phaserAgentId || `agt_${data.slug}`;
    const homeRoom = data.roomId || 'workspace';
    const color = cssColorToHex(data.color);

    this.createAnimationsForSprite(spriteKey);

    const spawnPos = this.getRandomWalkableWorldPos();
    const facing: Direction = (['down', 'left', 'right', 'up'] as Direction[])[
      Phaser.Math.Between(0, 3)
    ];

    const sprite = this.add.sprite(0, 0, spriteKey, getFrameIndex(IDLE_ROW, IDLE_COL[facing]));
    sprite.setOrigin(0.5, 1);
    sprite.play(`${spriteKey}-idle-${facing}`);

    const nameTag = this.add.text(0, -100, data.displayName, {
      fontFamily: 'monospace',
      fontSize: '11px',
      color: '#ffffff',
      stroke: '#000000',
      strokeThickness: 3,
      shadow: { offsetX: 1, offsetY: 1, color: '#000', blur: 2, fill: true },
    });
    nameTag.setOrigin(0.5);

    const container = this.add.container(spawnPos.x, spawnPos.y, [sprite, nameTag]);
    container.setDepth(spawnPos.y);
    container.setSize(48, 96);
    container.setInteractive({ useHandCursor: true });

    container.on('pointerdown', () => {
      EventBus.emit('agent:clicked', { agentId, name: data.displayName });
      const ag = this.agents.find((a) => a.agentId === agentId);
      if (ag && ag.workStatus === 'idle') {
        this.playGreetEffect(ag);
      }
    });
    container.on('pointerover', () => sprite.setTint(0xffd700));
    container.on('pointerout', () => sprite.clearTint());

    this.agents.push({
      container,
      sprite,
      nameTag,
      agentId,
      slug: data.slug,
      spriteKey,
      color,
      isMoving: false,
      facing,
      homeRoom,
      currentRoom: homeRoom,
      workStatus: 'idle',
    });

    this.startIdleMotion(this.agents[this.agents.length - 1]);
  }

  private onAgentDespawned(data: { slug: string }) {
    const idx = this.agents.findIndex((a) => a.slug === data.slug);
    if (idx === -1) return;
    const agent = this.agents[idx];
    if (agent.bubbleTimer) { agent.bubbleTimer.destroy(); }
    if (agent.bubbleContainer) { agent.bubbleContainer.destroy(); }
    if (agent.workTimer) { agent.workTimer.destroy(); }
    if (agent.idleWalkTimer) { agent.idleWalkTimer.destroy(); }
    if (agent.idleTween) { agent.idleTween.stop(); }
    if (agent.workTween) { agent.workTween.stop(); }
    if (agent.statusDotTween) { agent.statusDotTween.stop(); }
    if (agent.statusIndicator) { agent.statusIndicator.destroy(); }
    if (agent.thinkingTween) { agent.thinkingTween.stop(); }
    if (agent.thinkingIndicator) { agent.thinkingIndicator.destroy(); }
    agent.container.destroy();
    this.agents.splice(idx, 1);
  }

  // ============================================================
  // 网格寻路 — Collision + Wall 双层判定
  // ============================================================
  private getRandomWalkableWorldPos(): { x: number; y: number } {
    const tw = this.map.tileWidth;
    const th = this.map.tileHeight;
    for (let attempt = 0; attempt < 200; attempt++) {
      const tx = Phaser.Math.Between(1, this.map.width - 2);
      const ty = Phaser.Math.Between(1, this.map.height - 2);
      if (this.isWalkableTile(tx, ty)) {
        return { x: tx * tw + tw / 2, y: ty * th + th };
      }
    }
    return { x: this.map.widthInPixels / 2, y: this.map.heightInPixels / 2 };
  }

  private isWalkableTile(tileX: number, tileY: number): boolean {
    if (tileX < 0 || tileY < 0 || tileX >= this.map.width || tileY >= this.map.height) {
      return false;
    }

    const collisionBlocked = this.collisionLayer?.getTileAt(tileX, tileY);
    return !collisionBlocked;
  }

  private worldToTile(point: { x: number; y: number }) {
    const tileX = this.map.worldToTileX(point.x) ?? 0;
    const tileY = this.map.worldToTileY(point.y) ?? 0;
    return {
      x: Phaser.Math.Clamp(tileX, 0, this.map.width - 1),
      y: Phaser.Math.Clamp(tileY, 0, this.map.height - 1),
    };
  }

  private tileToWorld(tile: { x: number; y: number }) {
    const worldX = this.map.tileToWorldX(tile.x) ?? 0;
    const worldY = this.map.tileToWorldY(tile.y) ?? 0;
    return {
      x: worldX + this.map.tileWidth / 2,
      y: worldY + this.map.tileHeight / 2,
    };
  }

  private findNearestWalkableTile(tile: { x: number; y: number }) {
    if (this.isWalkableTile(tile.x, tile.y)) {
      return tile;
    }

    const maxRadius = 5;
    for (let radius = 1; radius <= maxRadius; radius++) {
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const x = tile.x + dx;
          const y = tile.y + dy;
          if (this.isWalkableTile(x, y)) {
            return { x, y };
          }
        }
      }
    }

    return null;
  }

  private findTilePath(start: { x: number; y: number }, end: { x: number; y: number }) {
    const key = (x: number, y: number) => `${x},${y}`;
    const queue: Array<{ x: number; y: number }> = [start];
    const visited = new Set([key(start.x, start.y)]);
    const parent = new Map<string, string>();
    const dirs = [
      { x: 1, y: 0 },
      { x: -1, y: 0 },
      { x: 0, y: 1 },
      { x: 0, y: -1 },
    ];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.x === end.x && current.y === end.y) {
        const path: Array<{ x: number; y: number }> = [];
        let currentKey = key(end.x, end.y);

        while (currentKey) {
          const [xStr, yStr] = currentKey.split(',');
          path.push({ x: Number(xStr), y: Number(yStr) });
          const prev = parent.get(currentKey);
          if (!prev) break;
          currentKey = prev;
        }

        return path.reverse();
      }

      for (const dir of dirs) {
        const next = { x: current.x + dir.x, y: current.y + dir.y };
        const nextKey = key(next.x, next.y);
        if (visited.has(nextKey) || !this.isWalkableTile(next.x, next.y)) {
          continue;
        }
        visited.add(nextKey);
        parent.set(nextKey, key(current.x, current.y));
        queue.push(next);
      }
    }

    return [];
  }

  private buildWorldPath(start: { x: number; y: number }, end: { x: number; y: number }) {
    const startTile = this.findNearestWalkableTile(this.worldToTile(start));
    const endTile = this.findNearestWalkableTile(this.worldToTile(end));

    if (!startTile || !endTile) {
      return [];
    }

    const tilePath = this.findTilePath(startTile, endTile);
    if (tilePath.length === 0) {
      return [];
    }

    const worldPath: { x: number; y: number }[] = [];
    for (let i = 1; i < tilePath.length; i++) {
      const prev = tilePath[i - 1];
      const curr = tilePath[i];
      const next = i < tilePath.length - 1 ? tilePath[i + 1] : null;

      if (!next) {
        worldPath.push(this.tileToWorld(curr));
      } else {
        const dx1 = curr.x - prev.x;
        const dy1 = curr.y - prev.y;
        const dx2 = next.x - curr.x;
        const dy2 = next.y - curr.y;
        if (dx1 !== dx2 || dy1 !== dy2) {
          worldPath.push(this.tileToWorld(curr));
        }
      }
    }

    return worldPath;
  }

  // ============================================================
  // 移动 Agent
  // ============================================================
  private findFreeAnchor(roomId: string, excludeAgentId?: string, preferWork = false): Anchor | null {
    const room = getRoom(roomId);
    const occupiedPositions = new Set(
      this.agents
        .filter((a) => a.currentRoom === roomId && a.agentId !== excludeAgentId && a.currentAnchor)
        .map((a) => `${a.currentAnchor!.x},${a.currentAnchor!.y}`),
    );
    const free = room.anchors.filter((a) => !occupiedPositions.has(`${a.x},${a.y}`));
    if (free.length === 0) return room.anchors[0];
    if (preferWork) {
      const workAnchor = free.find((a) => a.type === 'desk' || a.type === 'screen');
      if (workAnchor) return workAnchor;
    }
    return free[0];
  }

  private findNearestFreeWorkAnchor(agent: AgentCharacter): { roomId: string; anchor: Anchor } | null {
    let best: { roomId: string; anchor: Anchor; dist: number } | null = null;

    for (const [roomId, room] of Object.entries(ROOMS)) {
      const occupied = new Set(
        this.agents
          .filter((a) => a.currentRoom === roomId && a.agentId !== agent.agentId && a.currentAnchor)
          .map((a) => `${a.currentAnchor!.x},${a.currentAnchor!.y}`),
      );

      for (const anchor of room.anchors) {
        if (anchor.type !== 'desk' && anchor.type !== 'screen') continue;
        if (occupied.has(`${anchor.x},${anchor.y}`)) continue;

        const dx = anchor.x - agent.container.x;
        const dy = anchor.y - agent.container.y;
        const dist = dx * dx + dy * dy;

        if (!best || dist < best.dist) {
          best = { roomId, anchor, dist };
        }
      }
    }

    return best;
  }

  public moveAgentToRoom(agentId: string, roomId: string) {
    const agent = this.agents.find((a) => a.agentId === agentId);
    if (!agent) return;

    if (agent.workStatus === 'working' && roomId === agent.homeRoom) {
      agent.pendingMoveRoom = roomId;
      return;
    }

    if (roomId !== agent.homeRoom) {
      const workTarget = this.findNearestFreeWorkAnchor(agent);
      if (workTarget) {
        this.executeMoveToRoom(agent, workTarget.roomId, workTarget.anchor);
        return;
      }
    }

    this.executeMoveToRoom(agent, roomId);
  }

  private executeMoveToRoom(agent: AgentCharacter, roomId: string, targetAnchor?: Anchor) {
    if (agent.isMoving) {
      this.tweens.killTweensOf(agent.container);
      agent.isMoving = false;
    }

    if (agent.workTimer) {
      agent.workTimer.destroy();
      agent.workTimer = undefined;
    }
    agent.pendingMoveRoom = undefined;
    this.stopWorkingMotion(agent);
    this.hideWorkingIndicator(agent);

    const anchor = targetAnchor || this.findFreeAnchor(roomId, agent.agentId, roomId !== agent.homeRoom);
    if (!anchor) return;

    const cleanPath = this.buildWorldPath(
      { x: agent.container.x, y: agent.container.y },
      { x: anchor.x, y: anchor.y },
    );

    if (cleanPath.length === 0) {
      this.startIdleMotion(agent);
      return;
    }

    agent.currentRoom = roomId;
    agent.currentAnchor = anchor;
    this.stopIdleMotion(agent);
    this.moveAlongPath(agent, cleanPath, 0, anchor.facing);
  }

  private moveAlongPath(agent: AgentCharacter, path: { x: number; y: number }[], index: number, arrivalFacing?: Direction) {
    if (index >= path.length) {
      agent.isMoving = false;
      if (arrivalFacing) {
        agent.facing = arrivalFacing;
      }
      this.playAgentAnimation(agent, 'idle');

      if (agent.workStatus === 'working' && this.isAtWorkAnchor(agent)) {
        this.hideThinkingIndicator(agent);
        this.startWorkingMotion(agent);
        this.showWorkingIndicator(agent);
        if (agent.pendingMoveRoom) {
          const dest = agent.pendingMoveRoom;
          agent.workTimer = this.time.delayedCall(3000, () => {
            agent.workTimer = undefined;
            this.showCompletionEffect(agent);
            agent.workStatus = 'idle';
            this.executeMoveToRoom(agent, dest);
          });
        }
      } else {
        this.stopWorkingMotion(agent);
        this.startIdleMotion(agent);
      }
      return;
    }

    const target = path[index];
    const dx = target.x - agent.container.x;
    const dy = target.y - agent.container.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance < 4) {
      this.moveAlongPath(agent, path, index + 1, arrivalFacing);
      return;
    }

    const dir = this.getDirection(dx, dy);
    agent.facing = dir;
    this.stopWorkingMotion(agent);
    this.stopIdleMotion(agent);
    this.playAgentAnimation(agent, 'walk', dir);
    agent.isMoving = true;

    const duration = (distance / 80) * 1000;

    this.tweens.add({
      targets: agent.container,
      x: target.x,
      y: target.y,
      duration,
      ease: 'Linear',
      onUpdate: () => {
        agent.container.setDepth(agent.container.y);
      },
      onComplete: () => {
        this.moveAlongPath(agent, path, index + 1, arrivalFacing);
      },
    });
  }

  // ============================================================
  // 动画
  // ============================================================
  private createAnimations() {
    this.agentSpawns.forEach((spawn) => {
      this.createAnimationsForSprite(spawn.spriteKey);
    });
  }

  private createAnimationsForSprite(spriteKey: string) {
    for (const dir of DIRECTIONS) {
      const idleKey = `${spriteKey}-idle-${dir}`;
      if (!this.anims.exists(idleKey)) {
        this.anims.create({
          key: idleKey,
          frames: [{ key: spriteKey, frame: getFrameIndex(IDLE_ROW, IDLE_COL[dir]) }],
          frameRate: 1,
          repeat: 0,
        });
      }

      const walkKey = `${spriteKey}-walk-${dir}`;
      if (!this.anims.exists(walkKey)) {
        const walkStart = WALK_COL_START[dir];
        const frames: Phaser.Types.Animations.AnimationFrame[] = [];
        for (let i = 0; i < FRAMES_PER_DIRECTION; i++) {
          frames.push({ key: spriteKey, frame: getFrameIndex(WALK_ROW, walkStart + i) });
        }
        this.anims.create({ key: walkKey, frames, frameRate: 10, repeat: -1 });
      }
    }
  }

  private createAgents() {
    this.agentSpawns.forEach((spawn) => {
      const anchor = this.findFreeAnchor(spawn.homeRoom);
      if (!anchor) return;

      const sprite = this.add.sprite(0, 0, spawn.spriteKey, getFrameIndex(IDLE_ROW, IDLE_COL[anchor.facing]));
      sprite.setOrigin(0.5, 1);
      sprite.play(`${spawn.spriteKey}-idle-${anchor.facing}`);

      const nameTag = this.add.text(0, -100, spawn.name, {
        fontFamily: 'monospace',
        fontSize: '11px',
        color: '#ffffff',
        stroke: '#000000',
        strokeThickness: 3,
        shadow: { offsetX: 1, offsetY: 1, color: '#000', blur: 2, fill: true },
      });
      nameTag.setOrigin(0.5);

      const container = this.add.container(anchor.x, anchor.y, [sprite, nameTag]);
      container.setDepth(anchor.y);
      container.setSize(48, 96);
      container.setInteractive({ useHandCursor: true });

      container.on('pointerdown', () => {
        EventBus.emit('agent:clicked', { agentId: spawn.agentId, name: spawn.name });
        const ag = this.agents.find((a) => a.agentId === spawn.agentId);
        if (ag && ag.workStatus === 'idle') {
          this.playGreetEffect(ag);
        }
      });
      container.on('pointerover', () => sprite.setTint(0xffd700));
      container.on('pointerout', () => sprite.clearTint());

      this.agents.push({
        container,
        sprite,
        nameTag,
        agentId: spawn.agentId,
        slug: spawn.slug,
        spriteKey: spawn.spriteKey,
        color: spawn.color,
        isMoving: false,
        facing: anchor.facing,
        homeRoom: spawn.homeRoom,
        currentRoom: spawn.homeRoom,
        currentAnchor: anchor,
        workStatus: 'idle',
      });

      this.startIdleMotion(this.agents[this.agents.length - 1]);
    });
  }

  private playAgentAnimation(agent: AgentCharacter, state: 'idle' | 'walk', dir: Direction = agent.facing) {
    const key = `${agent.spriteKey}-${state}-${dir}`;
    if (agent.sprite.anims.currentAnim?.key !== key) {
      agent.sprite.play(key);
    }
  }

  private getDirection(dx: number, dy: number): Direction {
    if (Math.abs(dx) > Math.abs(dy)) {
      return dx > 0 ? 'right' : 'left';
    }
    return dy > 0 ? 'down' : 'up';
  }

  // ============================================================
  // Agent 对话气泡
  // ============================================================
  public showAgentBubble(agentSlug: string, text: string, duration = 4000) {
    const agent = this.agents.find((a) => a.slug === agentSlug);
    if (!agent || !text || !text.trim()) return;

    this.playSpeakingPulse(agent);
    this.hideAgentBubble(agent);

    const displayText = text.length > 40 ? text.slice(0, 37) + '...' : text;

    const bubbleText = this.add.text(0, 0, displayText, {
      fontFamily: 'monospace',
      fontSize: '14px',
      color: '#ffe',
      fontStyle: 'bold',
      wordWrap: { width: 180 },
      lineSpacing: 4,
      stroke: '#000',
      strokeThickness: 1,
    });
    bubbleText.setOrigin(0.5);

    const padX = 12;
    const padY = 8;
    const tailH = 7;
    const bgW = bubbleText.width + padX * 2;
    const bgH = bubbleText.height + padY * 2;

    const gfx = this.add.graphics();

    gfx.fillStyle(0x0a0a1e, 0.95);
    gfx.fillRoundedRect(-bgW / 2, -bgH, bgW, bgH, 4);

    gfx.lineStyle(2, agent.color, 0.9);
    gfx.strokeRoundedRect(-bgW / 2, -bgH, bgW, bgH, 4);

    gfx.fillStyle(0x0a0a1e, 0.95);
    gfx.fillTriangle(-5, 0, 5, 0, 0, tailH);

    bubbleText.setPosition(0, -bgH / 2);

    const bubbleContainer = this.add.container(0, -100, [gfx, bubbleText]);
    bubbleContainer.setAlpha(0);

    agent.container.add(bubbleContainer);
    agent.bubbleContainer = bubbleContainer;

    this.tweens.add({
      targets: bubbleContainer,
      alpha: 1,
      duration: 200,
    });

    agent.bubbleTimer = this.time.delayedCall(duration, () => {
      this.fadeOutBubble(agent);
    });
  }

  private fadeOutBubble(agent: AgentCharacter) {
    if (!agent.bubbleContainer) return;
    const bc = agent.bubbleContainer;
    this.tweens.add({
      targets: bc,
      alpha: 0,
      duration: 300,
      onComplete: () => {
        bc.destroy();
        agent.bubbleContainer = undefined;
      },
    });
  }

  private hideAgentBubble(agent: AgentCharacter) {
    if (agent.bubbleTimer) {
      agent.bubbleTimer.destroy();
      agent.bubbleTimer = undefined;
    }
    if (agent.bubbleContainer) {
      agent.bubbleContainer.destroy();
      agent.bubbleContainer = undefined;
    }
  }

  // ============================================================
  // 待机 & 工作状态动画
  // ============================================================
  private startIdleMotion(agent: AgentCharacter) {
    if (agent.idleTween || agent.isMoving) return;

    agent.idleTween = this.tweens.add({
      targets: agent.sprite,
      y: -3,
      duration: 1000,
      ease: 'Sine.InOut',
      yoyo: true,
      repeat: -1,
    });

    if (agent.workStatus === 'idle') {
      this.scheduleIdleWalk(agent);
    }
  }

  private stopIdleMotion(agent: AgentCharacter) {
    if (agent.idleTween) {
      agent.idleTween.stop();
      agent.idleTween = undefined;
    }
    agent.sprite.y = 0;
    this.cancelIdleWalk(agent);
  }

  private scheduleIdleWalk(agent: AgentCharacter) {
    if (agent.idleWalkTimer) return;
    const delay = Phaser.Math.Between(8000, 20000);
    agent.idleWalkTimer = this.time.delayedCall(delay, () => {
      agent.idleWalkTimer = undefined;
      this.doIdleWalk(agent);
    });
  }

  private cancelIdleWalk(agent: AgentCharacter) {
    if (agent.idleWalkTimer) {
      agent.idleWalkTimer.destroy();
      agent.idleWalkTimer = undefined;
    }
  }

  private doIdleWalk(agent: AgentCharacter) {
    if (agent.isMoving || agent.workStatus === 'working') return;

    const maxTileDist = 12;
    const agentTile = this.worldToTile({ x: agent.container.x, y: agent.container.y });

    let target: { x: number; y: number } | null = null;
    for (let i = 0; i < 15; i++) {
      const tx = agentTile.x + Phaser.Math.Between(-maxTileDist, maxTileDist);
      const ty = agentTile.y + Phaser.Math.Between(-maxTileDist, maxTileDist);
      if (tx === agentTile.x && ty === agentTile.y) continue;
      if (!this.isWalkableTile(tx, ty)) continue;
      target = { x: tx, y: ty };
      break;
    }

    if (!target) {
      this.scheduleIdleWalk(agent);
      return;
    }

    const worldTarget = this.tileToWorld(target);
    const path = this.buildWorldPath(
      { x: agent.container.x, y: agent.container.y },
      worldTarget,
    );

    if (path.length === 0) {
      this.scheduleIdleWalk(agent);
      return;
    }

    agent.currentAnchor = undefined;
    this.stopIdleMotion(agent);
    this.moveAlongPath(agent, path, 0);
  }

  private startWorkingMotion(agent: AgentCharacter) {
    if (agent.isMoving || agent.workTween) return;

    this.stopIdleMotion(agent);
    this.playAgentAnimation(agent, 'idle');
    agent.workTween = this.tweens.add({
      targets: agent.sprite,
      y: { from: 0, to: -2 },
      angle: { from: -1, to: 1 },
      duration: 350,
      ease: 'Sine.InOut',
      yoyo: true,
      repeat: -1,
      repeatDelay: 80,
    });
  }

  private stopWorkingMotion(agent: AgentCharacter) {
    if (agent.workTween) {
      agent.workTween.stop();
      agent.workTween = undefined;
    }
    agent.sprite.y = 0;
    agent.sprite.angle = 0;
    agent.sprite.setScale(1, 1);
  }

  private isAtWorkAnchor(agent: AgentCharacter): boolean {
    return !!agent.currentAnchor &&
      (agent.currentAnchor.type === 'desk' || agent.currentAnchor.type === 'screen');
  }

  private showWorkingIndicator(agent: AgentCharacter) {
    if (agent.statusIndicator) return;

    const icon = this.add.text(0, 0, '⚡', { fontSize: '14px' });
    icon.setOrigin(0.5);

    const indicatorContainer = this.add.container(0, -112, [icon]);
    agent.container.add(indicatorContainer);
    agent.statusIndicator = indicatorContainer;

    agent.statusDotTween = this.tweens.add({
      targets: icon,
      alpha: { from: 1, to: 0.3 },
      scaleX: { from: 1, to: 0.7 },
      scaleY: { from: 1, to: 0.7 },
      duration: 700,
      ease: 'Sine.InOut',
      yoyo: true,
      repeat: -1,
    });
  }

  private hideWorkingIndicator(agent: AgentCharacter) {
    if (agent.statusDotTween) {
      agent.statusDotTween.stop();
      agent.statusDotTween = undefined;
    }
    if (agent.statusIndicator) {
      agent.statusIndicator.destroy();
      agent.statusIndicator = undefined;
    }
  }

  private showCompletionEffect(agent: AgentCharacter) {
    const cx = 0;
    const cy = -112;
    const count = 6;
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.5;
      const dist = Phaser.Math.Between(18, 35);
      const star = this.add.text(cx, cy, '✨', { fontSize: `${Phaser.Math.Between(10, 16)}px` });
      star.setOrigin(0.5);
      agent.container.add(star);

      this.tweens.add({
        targets: star,
        x: cx + Math.cos(angle) * dist,
        y: cy + Math.sin(angle) * dist - 10,
        alpha: { from: 1, to: 0 },
        scaleX: { from: 1, to: 0.3 },
        scaleY: { from: 1, to: 0.3 },
        duration: Phaser.Math.Between(600, 1000),
        ease: 'Power2',
        onComplete: () => star.destroy(),
      });
    }
  }

  // ============================================================
  // Phase 1 状态可读性：thinking / speaking / error
  // ============================================================

  private showThinkingIndicator(agent: AgentCharacter) {
    if (agent.thinkingIndicator) return;

    const dots = this.add.text(0, 0, '💭', { fontSize: '16px' });
    dots.setOrigin(0.5);

    const container = this.add.container(0, -116, [dots]);
    agent.container.add(container);
    agent.thinkingIndicator = container;

    agent.thinkingTween = this.tweens.add({
      targets: dots,
      alpha: { from: 1, to: 0.3 },
      scaleX: { from: 1, to: 0.75 },
      scaleY: { from: 1, to: 0.75 },
      y: { from: 0, to: -3 },
      duration: 800,
      ease: 'Sine.InOut',
      yoyo: true,
      repeat: -1,
    });
  }

  private hideThinkingIndicator(agent: AgentCharacter) {
    if (agent.thinkingTween) {
      agent.thinkingTween.stop();
      agent.thinkingTween = undefined;
    }
    if (agent.thinkingIndicator) {
      agent.thinkingIndicator.destroy();
      agent.thinkingIndicator = undefined;
    }
  }

  private playSpeakingPulse(agent: AgentCharacter) {
    if (agent.isMoving) return;
    this.tweens.add({
      targets: agent.sprite,
      scaleX: { from: 1, to: 1.08 },
      scaleY: { from: 1, to: 1.06 },
      duration: 120,
      ease: 'Quad.Out',
      yoyo: true,
    });
  }

  private showErrorEffect(agent: AgentCharacter) {
    const icon = this.add.text(0, -112, '❗', { fontSize: '16px' });
    icon.setOrigin(0.5);
    agent.container.add(icon);

    // shake the sprite
    const origX = agent.sprite.x;
    this.tweens.add({
      targets: agent.sprite,
      x: origX + 2,
      duration: 50,
      yoyo: true,
      repeat: 5,
      onComplete: () => { agent.sprite.x = origX; },
    });

    // icon stays then fades
    this.time.delayedCall(2000, () => {
      this.tweens.add({
        targets: icon,
        alpha: 0,
        y: icon.y - 15,
        duration: 500,
        onComplete: () => icon.destroy(),
      });
    });
  }

  // ============================================================
  // Phase 2 点击与任务交互增强
  // ============================================================

  private playGreetEffect(agent: AgentCharacter) {
    if (agent.isMoving) return;

    // turn to face down (toward camera/user)
    agent.facing = 'down';
    this.playAgentAnimation(agent, 'idle', 'down');

    // small hop
    this.tweens.add({
      targets: agent.sprite,
      y: agent.sprite.y - 8,
      duration: 150,
      ease: 'Quad.Out',
      yoyo: true,
    });

    // wave emoji
    const wave = this.add.text(12, -100, '👋', { fontSize: '16px' });
    wave.setOrigin(0.5);
    agent.container.add(wave);

    this.tweens.add({
      targets: wave,
      y: wave.y - 20,
      alpha: { from: 1, to: 0 },
      duration: 1000,
      ease: 'Power2',
      onComplete: () => wave.destroy(),
    });
  }

  private playReceiveTaskEffect(agent: AgentCharacter) {
    if (agent.isMoving) return;

    // excited hop
    this.tweens.add({
      targets: agent.sprite,
      y: agent.sprite.y - 10,
      duration: 120,
      ease: 'Quad.Out',
      yoyo: true,
      onComplete: () => {
        // second smaller hop
        this.tweens.add({
          targets: agent.sprite,
          y: agent.sprite.y - 4,
          duration: 100,
          ease: 'Quad.Out',
          yoyo: true,
        });
      },
    });

    // show "!" accept indicator
    const excl = this.add.text(0, -112, '📋', { fontSize: '14px' });
    excl.setOrigin(0.5);
    agent.container.add(excl);

    this.tweens.add({
      targets: excl,
      y: excl.y - 25,
      alpha: { from: 1, to: 0 },
      duration: 900,
      ease: 'Power2',
      onComplete: () => excl.destroy(),
    });
  }

  shutdown() {
    EventBus.off('chat:agent-move', this.onChatAgentMove, this);
    EventBus.off('chat:agent-bubble', this.onAgentBubble, this);
    EventBus.off('agent:spawned', this.onAgentSpawned, this);
    EventBus.off('agent:despawned', this.onAgentDespawned, this);
    EventBus.off('agent:status', this.onAgentStatusChange, this);
  }

  update(_time: number, _delta: number) {
    // reserved
  }
}
