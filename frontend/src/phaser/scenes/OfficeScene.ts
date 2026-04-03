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

const ROOMS: Record<
  string,
  {
    label: string;
    entry: { x: number; y: number };
    spots: { x: number; y: number }[];
  }
> = {
  showroom: {
    label: '商品展厅',
    entry: { x: 304, y: 208 },
    spots: [
      { x: 208, y: 80 },
      { x: 272, y: 80 },
      { x: 336, y: 80 },
      { x: 208, y: 144 },
      { x: 272, y: 144 },
      { x: 336, y: 144 },
    ],
  },
  manager: {
    label: '调度中心',
    entry: { x: 464, y: 208 },
    spots: [
      { x: 432, y: 80 },
      { x: 528, y: 80 },
      { x: 624, y: 80 },
      { x: 432, y: 144 },
      { x: 528, y: 144 },
      { x: 624, y: 144 },
    ],
  },
  meeting: {
    label: '协作室',
    entry: { x: 304, y: 368 },
    spots: [
      { x: 240, y: 400 },
      { x: 304, y: 400 },
      { x: 368, y: 400 },
      { x: 240, y: 432 },
      { x: 304, y: 432 },
      { x: 368, y: 432 },
    ],
  },
  workspace: {
    label: '待命区',
    entry: { x: 336, y: 240 },
    spots: [
      { x: 240, y: 240 },
      { x: 336, y: 240 },
      { x: 432, y: 240 },
      { x: 240, y: 272 },
      { x: 336, y: 272 },
      { x: 432, y: 272 },
    ],
  },
  datacenter: {
    label: '数据仓库',
    entry: { x: 720, y: 336 },
    spots: [
      { x: 784, y: 272 },
      { x: 848, y: 272 },
      { x: 784, y: 304 },
      { x: 848, y: 304 },
      { x: 784, y: 336 },
      { x: 848, y: 336 },
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
  bubbleContainer?: Phaser.GameObjects.Container;
  bubbleTimer?: Phaser.Time.TimerEvent;
  idleTween?: Phaser.Tweens.Tween;
  workTween?: Phaser.Tweens.Tween;
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

  private onAgentStatusChange(data: { agentSlug: string; status: 'idle' | 'working' | 'standby' }) {
    const agent = this.agents.find((a) => a.slug === data.agentSlug);
    if (!agent) return;

    if (data.status === 'working') {
      this.startWorkingMotion(agent);
      return;
    }

    if (data.status === 'idle' && !agent.isMoving) {
      this.stopWorkingMotion(agent);
      this.startIdleMotion(agent);
    }

    if (data.status === 'standby') {
      this.stopWorkingMotion(agent);
      this.stopIdleMotion(agent);
      this.playAgentAnimation(agent, 'idle');
    }
  }

  private onAgentSpawned(data: {
    slug: string;
    displayName: string;
    color: string;
    roomId: string;
    phaserAgentId: string;
  }) {
    if (this.agents.find((a) => a.slug === data.slug)) return;

    const spriteKey = getSpriteKey(data.slug);
    const agentId = data.phaserAgentId || `agt_${data.slug}`;
    const homeRoom = data.roomId || 'workspace';
    const color = cssColorToHex(data.color);

    this.createAnimationsForSprite(spriteKey);

    const room = getRoom(homeRoom);
    const usedCount = this.agents.filter((a) => a.currentRoom === homeRoom).length;
    const spotIndex = usedCount % room.spots.length;
    const pos = room.spots[spotIndex];

    const sprite = this.add.sprite(0, 0, spriteKey, getFrameIndex(IDLE_ROW, IDLE_COL.down));
    sprite.setOrigin(0.5, 1);
    sprite.play(`${spriteKey}-idle-down`);

    const nameTag = this.add.text(0, -100, data.displayName, {
      fontFamily: 'monospace',
      fontSize: '11px',
      color: '#ffffff',
      stroke: '#000000',
      strokeThickness: 3,
      shadow: { offsetX: 1, offsetY: 1, color: '#000', blur: 2, fill: true },
    });
    nameTag.setOrigin(0.5);

    const container = this.add.container(pos.x, pos.y, [sprite, nameTag]);
    container.setDepth(pos.y);
    container.setSize(48, 96);
    container.setInteractive({ useHandCursor: true });

    container.on('pointerdown', () => {
      EventBus.emit('agent:clicked', { agentId, name: data.displayName });
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
      facing: 'down',
      homeRoom,
      currentRoom: homeRoom,
    });

    this.startIdleMotion(this.agents[this.agents.length - 1]);
  }

  private onAgentDespawned(data: { slug: string }) {
    const idx = this.agents.findIndex((a) => a.slug === data.slug);
    if (idx === -1) return;
    const agent = this.agents[idx];
    if (agent.bubbleTimer) { agent.bubbleTimer.destroy(); }
    if (agent.bubbleContainer) { agent.bubbleContainer.destroy(); }
    if (agent.idleTween) { agent.idleTween.stop(); }
    if (agent.workTween) { agent.workTween.stop(); }
    agent.container.destroy();
    this.agents.splice(idx, 1);
  }

  // ============================================================
  // 网格寻路 — Collision + Wall 双层判定
  // ============================================================
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
      return [end];
    }

    const tilePath = this.findTilePath(startTile, endTile);
    if (tilePath.length === 0) {
      return [end];
    }

    // Simplify path: keep only direction-change waypoints
    const worldPath: { x: number; y: number }[] = [];
    for (let i = 1; i < tilePath.length; i++) {
      const prev = i > 0 ? tilePath[i - 1] : tilePath[0];
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

    const last = worldPath[worldPath.length - 1];
    if (!last || Math.abs(last.x - end.x) > 4 || Math.abs(last.y - end.y) > 4) {
      worldPath.push(end);
    }

    return worldPath;
  }

  // ============================================================
  // 移动 Agent
  // ============================================================
  public moveAgentToRoom(agentId: string, roomId: string) {
    const agent = this.agents.find((a) => a.agentId === agentId);
    if (!agent || agent.isMoving) return;

    const targetRoom = getRoom(roomId);
    const usedSpots = this.agents
      .filter((a) => a.currentRoom === roomId && a.agentId !== agentId)
      .length;
    const spotIndex = usedSpots % targetRoom.spots.length;
    const targetPoint = targetRoom.spots[spotIndex];
    const cleanPath = this.buildWorldPath(
      { x: agent.container.x, y: agent.container.y },
      targetPoint,
    );

    agent.currentRoom = roomId;
    this.stopIdleMotion(agent);
    this.moveAlongPath(agent, cleanPath, 0);
  }

  private moveAlongPath(agent: AgentCharacter, path: { x: number; y: number }[], index: number) {
    if (index >= path.length) {
      agent.isMoving = false;
      this.playAgentAnimation(agent, 'idle');
      this.stopWorkingMotion(agent);
      this.startIdleMotion(agent);
      return;
    }

    const target = path[index];
    const dx = target.x - agent.container.x;
    const dy = target.y - agent.container.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance < 4) {
      this.moveAlongPath(agent, path, index + 1);
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
        this.moveAlongPath(agent, path, index + 1);
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
    const roomSpotCounter: Record<string, number> = {};

    this.agentSpawns.forEach((spawn) => {
      const room = getRoom(spawn.homeRoom);
      const usedCount = roomSpotCounter[spawn.homeRoom] || 0;
      const spotIndex = usedCount % room.spots.length;
      roomSpotCounter[spawn.homeRoom] = usedCount + 1;
      const pos = room.spots[spotIndex];

      const sprite = this.add.sprite(0, 0, spawn.spriteKey, getFrameIndex(IDLE_ROW, IDLE_COL.down));
      sprite.setOrigin(0.5, 1);
      sprite.play(`${spawn.spriteKey}-idle-down`);

      const nameTag = this.add.text(0, -100, spawn.name, {
        fontFamily: 'monospace',
        fontSize: '11px',
        color: '#ffffff',
        stroke: '#000000',
        strokeThickness: 3,
        shadow: { offsetX: 1, offsetY: 1, color: '#000', blur: 2, fill: true },
      });
      nameTag.setOrigin(0.5);

      const container = this.add.container(pos.x, pos.y, [sprite, nameTag]);
      container.setDepth(pos.y);
      container.setSize(48, 96);
      container.setInteractive({ useHandCursor: true });

      container.on('pointerdown', () => {
        EventBus.emit('agent:clicked', { agentId: spawn.agentId, name: spawn.name });
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
        facing: 'down',
        homeRoom: spawn.homeRoom,
        currentRoom: spawn.homeRoom,
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
    if (!agent) return;

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
  }

  private stopIdleMotion(agent: AgentCharacter) {
    if (agent.idleTween) {
      agent.idleTween.stop();
      agent.idleTween = undefined;
    }
    agent.sprite.y = 0;
  }

  private startWorkingMotion(agent: AgentCharacter) {
    if (agent.isMoving || agent.workTween) return;

    this.stopIdleMotion(agent);
    this.playAgentAnimation(agent, 'idle');
    agent.workTween = this.tweens.add({
      targets: agent.sprite,
      angle: { from: -2, to: 2 },
      scaleX: { from: 1.0, to: 1.03 },
      scaleY: { from: 1.0, to: 0.98 },
      duration: 180,
      ease: 'Sine.InOut',
      yoyo: true,
      repeat: -1,
    });
  }

  private stopWorkingMotion(agent: AgentCharacter) {
    if (agent.workTween) {
      agent.workTween.stop();
      agent.workTween = undefined;
    }
    agent.sprite.angle = 0;
    agent.sprite.setScale(1, 1);
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
