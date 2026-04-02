import Phaser from 'phaser';

const TILESET_IMAGES = [
  {
    key: 'Room_Builder_Office_32x32',
    path: 'assets/tilemaps/Modern_Office_Revamped_v1.2/1_Room_Builder_Office/Room_Builder_Office_32x32.png',
  },
  {
    key: 'Modern_Office_32x32',
    path: 'assets/tilemaps/Modern_Office_Revamped_v1.2/Modern_Office_32x32.png',
  },
  {
    key: 'int_Basement_32x32',
    path: 'assets/tilemaps/moderninteriors-win/1_Interiors/32x32/Theme_Sorter_32x32/14_Basement_32x32.png',
  },
  {
    key: 'int_Bathroom_32x32',
    path: 'assets/tilemaps/moderninteriors-win/1_Interiors/32x32/Theme_Sorter_32x32/3_Bathroom_32x32.png',
  },
  {
    key: 'int_Classroom_and_library_32x32',
    path: 'assets/tilemaps/moderninteriors-win/1_Interiors/32x32/Theme_Sorter_32x32/5_Classroom_and_library_32x32.png',
  },
  {
    key: 'int_Generic_32x32',
    path: 'assets/tilemaps/moderninteriors-win/1_Interiors/32x32/Theme_Sorter_32x32/1_Generic_32x32.png',
  },
  {
    key: 'int_Kitchen_32x32',
    path: 'assets/tilemaps/moderninteriors-win/1_Interiors/32x32/Theme_Sorter_32x32/12_Kitchen_32x32.png',
  },
  {
    key: 'int_Hospital_32x32',
    path: 'assets/tilemaps/moderninteriors-win/1_Interiors/32x32/Theme_Sorter_32x32/19_Hospital_32x32.png',
  },
  {
    key: 'int_Grocery_store_32x32',
    path: 'assets/tilemaps/moderninteriors-win/1_Interiors/32x32/Theme_Sorter_32x32/16_Grocery_store_32x32.png',
  },
];

export class PreloadScene extends Phaser.Scene {
  private progressBar!: Phaser.GameObjects.Graphics;
  private progressBox!: Phaser.GameObjects.Graphics;
  private loadingText!: Phaser.GameObjects.Text;

  constructor() {
    super('PreloadScene');
  }

  preload() {
    const { width, height } = this.cameras.main;
    const centerX = width / 2;
    const centerY = height / 2;

    this.progressBox = this.add.graphics();
    this.progressBox.fillStyle(0x222222, 0.8);
    this.progressBox.fillRect(centerX - 160, centerY - 15, 320, 30);

    this.progressBar = this.add.graphics();

    this.loadingText = this.add.text(centerX, centerY - 40, 'Loading AgentsOffice...', {
      fontFamily: 'monospace',
      fontSize: '14px',
      color: '#e0e0e0',
    });
    this.loadingText.setOrigin(0.5);

    this.load.on('progress', (value: number) => {
      this.progressBar.clear();
      this.progressBar.fillStyle(0x4ade80, 1);
      this.progressBar.fillRect(centerX - 155, centerY - 10, 310 * value, 20);
    });

    this.load.on('complete', () => {
      this.progressBar.destroy();
      this.progressBox.destroy();
      this.loadingText.destroy();
    });

    // 加载与当前精简 tileset 方案匹配的办公室地图。
    this.load.tilemapTiledJSON('office-map', 'assets/tilemaps/references/office-agent.json');

    TILESET_IMAGES.forEach((tileset) => {
      this.load.image(tileset.key, tileset.path);
    });

    // 当前仓库只保留 char_07 ~ char_20。
    for (let i = 7; i <= 20; i++) {
      const key = `char_${String(i).padStart(2, '0')}`;
      this.load.spritesheet(key, `assets/sprites/characters/${key}.png`, {
        frameWidth: 32,
        frameHeight: 64,
      });
    }
  }

  create() {
    this.scene.start('OfficeScene');
  }
}
