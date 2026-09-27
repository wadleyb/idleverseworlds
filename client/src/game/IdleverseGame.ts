import {
  ACESFilmicToneMapping,
  AmbientLight,
  BoxGeometry,
  Clock,
  Color,
  ConeGeometry,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshPhongMaterial,
  PerspectiveCamera,
  Quaternion,
  Raycaster,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  Vector2,
  Vector3,
  VSMShadowMap,
  WebGLRenderer,
} from "three";
import { Globe } from "./Globe";
import { PilotAvatar } from "./PilotAvatar";
import {
  moveOnSphere,
  quaternionFromSurfaceNormal,
  tangentFrame,
} from "./SphericalMath";
import { sampleTerrain } from "./SimplexNoise";
import { addRimLight, globalRimColor } from "./RimLight";

type ViewMode = "planet" | "ground";

interface Citizen {
  carrier: Group;
  avatar: PilotAvatar;
  qPosition: Quaternion;
  heading: number;
  speed: number;
  turnTimer: number;
  phase: number;
}

const WORLD_SEED = 42;
const TERRAIN_TYPE = "default";
const PLANET_RADIUS = 5;
const PLAYER_SPEED = 1.25;
const PLAYER_TURN_SPEED = 2.2;
const PLANET_MIN_DISTANCE = 7.4;
const PLANET_MAX_DISTANCE = 18;
const PLANET_START_DISTANCE = 11.8;
const REF_Z = new Vector3(0, 0, 1);

const CHRONICLE_EVENTS = [
  "A new family settled near the old village.",
  "Farmers cleared a new patch of fertile land.",
  "A woodland path became a permanent road.",
  "Villagers discovered a richer source of stone.",
  "A workshop opened beside the village square.",
  "A flock of animals migrated toward the coast.",
  "The settlement expanded beyond its original walls.",
  "A new generation of citizens was born.",
];

export class IdleverseGame {
  private readonly container: HTMLElement;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(42, 1, 0.05, 120);
  private readonly clock = new Clock();
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  private readonly keys = new Set<string>();

  private renderer!: WebGLRenderer;
  private globe!: Globe;
  private landingSphere!: Mesh;
  private landingMarker!: Mesh;

  private readonly playerCarrier = new Group();
  private readonly playerAvatar = new PilotAvatar(0xe45b4f);
  private playerQ = new Quaternion();
  private playerHeading = 0;

  private mode: ViewMode = "planet";
  private selectedNormal = new Vector3(0, 1, 0);
  private villageNormal = new Vector3(0, 1, 0);

  private orbitYaw = 0.72;
  private orbitPitch = 0.34;
  private orbitDistance = PLANET_START_DISTANCE;
  private dragging = false;
  private dragMoved = false;
  private lastPointerX = 0;
  private lastPointerY = 0;

  private running = false;
  private raf = 0;
  private simAccumulator = 0;

  private day = 1;
  private population = 24;
  private discoveries = 3;
  private structureCount = 0;

  private readonly citizens: Citizen[] = [];
  private readonly growthGroup = new Group();
  private readonly sharedHouseWall = new BoxGeometry(0.22, 0.2, 0.22);
  private readonly sharedHouseRoof = new ConeGeometry(0.18, 0.15, 4);
  private readonly houseWallMat = new MeshPhongMaterial({
    color: 0xf1dfbd,
    flatShading: true,
    shininess: 5,
  });
  private readonly houseRoofMat = new MeshPhongMaterial({
    color: 0xb86748,
    flatShading: true,
    shininess: 7,
  });

  private shell!: HTMLDivElement;
  private modeLabel!: HTMLElement;
  private helperLabel!: HTMLElement;
  private dayLabel!: HTMLElement;
  private populationLabel!: HTMLElement;
  private discoveryLabel!: HTMLElement;
  private chronicle!: HTMLElement;
  private status!: HTMLElement;
  private landButton!: HTMLButtonElement;
  private orbitButton!: HTMLButtonElement;

  private readonly tmpNormal = new Vector3();
  private readonly tmpForward = new Vector3();
  private readonly tmpRight = new Vector3();
  private readonly tmpMatrix = new Matrix4();

  private readonly onResize = () => this.resize();
  private readonly onKeyDown = (event: KeyboardEvent) => {
    this.keys.add(event.key.toLowerCase());
  };
  private readonly onKeyUp = (event: KeyboardEvent) => {
    this.keys.delete(event.key.toLowerCase());
  };

  constructor(container: HTMLElement) {
    this.container = container;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    this.mountUi();
    this.setupRenderer();
    this.setupWorld();
    this.setupInput();

    this.focusVillage(false);
    this.addChronicle("Eden is alive. Its first settlement is beginning to grow.");
    this.addChronicle("You can orbit the planet, pick a location, and walk on the world.");

    this.resize();
    this.clock.start();
    this.animate();
  }

  private setupRenderer(): void {
    const canvas = document.createElement("canvas");
    canvas.className = "idleverse-canvas";
    this.shell.prepend(canvas);

    this.renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = VSMShadowMap;

    this.scene.background = new Color(0x76b8db);
    this.scene.fog = new Fog(0x89b8c9, 11, 31);

    const hemi = new HemisphereLight(0xc8e7ff, 0x5a4934, 1.75);
    this.scene.add(hemi);

    const ambient = new AmbientLight(0xffd8b9, 0.42);
    this.scene.add(ambient);

    const sun = new DirectionalLight(0xffd29a, 3.7);
    sun.position.set(12, 2.4, 7);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -9;
    sun.shadow.camera.right = 9;
    sun.shadow.camera.top = 9;
    sun.shadow.camera.bottom = -9;
    this.scene.add(sun);

    globalRimColor.set(0xffe3b7);
    addRimLight(this.houseWallMat, globalRimColor, 0.3, 2.5);
    addRimLight(this.houseRoofMat, globalRimColor, 0.26, 2.5);
  }

  private setupWorld(): void {
    const mobile = window.matchMedia("(max-width: 720px)").matches;
    this.globe = new Globe(
      PLANET_RADIUS,
      WORLD_SEED,
      TERRAIN_TYPE,
      0xeeddbb,
      0x2a8ca0,
      0x1560a0,
      0xb3ffff,
      0xffeebb,
      0.22,
      mobile ? 128 : 192,
    );
    this.globe.addTo(this.scene);

    this.villageNormal =
      this.globe.villageCenters[0]?.normal.clone().normalize() ??
      new Vector3(0.4, 0.75, 0.52).normalize();
    this.selectedNormal.copy(this.villageNormal);

    this.landingSphere = new Mesh(
      new SphereGeometry(PLANET_RADIUS + 0.58, 48, 32),
      new MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
    );
    this.scene.add(this.landingSphere);

    this.landingMarker = new Mesh(
      new TorusGeometry(0.16, 0.022, 8, 28),
      new MeshBasicMaterial({ color: 0xffdc67 }),
    );
    this.scene.add(this.landingMarker);
    this.updateLandingMarker();

    this.playerCarrier.visible = false;
    this.playerCarrier.add(this.playerAvatar.group);
    this.scene.add(this.playerCarrier);

    this.scene.add(this.growthGroup);

    for (let i = 0; i < 7; i++) this.spawnCitizen();
    for (let i = 0; i < 3; i++) this.addGrowthHouse(false);
  }

  private setupInput(): void {
    const canvas = this.renderer.domElement;

    canvas.addEventListener("pointerdown", (event) => {
      this.dragging = true;
      this.dragMoved = false;
      this.lastPointerX = event.clientX;
      this.lastPointerY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
    });

    canvas.addEventListener("pointermove", (event) => {
      if (!this.dragging) return;
      const dx = event.clientX - this.lastPointerX;
      const dy = event.clientY - this.lastPointerY;
      if (Math.abs(dx) + Math.abs(dy) > 3) this.dragMoved = true;

      if (this.mode === "planet") {
        this.orbitYaw -= dx * 0.006;
        this.orbitPitch = Math.max(
          -1.18,
          Math.min(1.18, this.orbitPitch - dy * 0.006),
        );
      } else {
        this.playerHeading += dx * 0.006;
      }

      this.lastPointerX = event.clientX;
      this.lastPointerY = event.clientY;
    });

    canvas.addEventListener("pointerup", (event) => {
      if (this.mode === "planet" && !this.dragMoved) {
        this.pickLandingPoint(event.clientX, event.clientY);
      }
      this.dragging = false;
    });

    canvas.addEventListener(
      "wheel",
      (event) => {
        if (this.mode !== "planet") return;
        event.preventDefault();
        this.orbitDistance = Math.max(
          PLANET_MIN_DISTANCE,
          Math.min(PLANET_MAX_DISTANCE, this.orbitDistance + event.deltaY * 0.01),
        );
      },
      { passive: false },
    );

    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("resize", this.onResize);

    this.shell.querySelector("#idleverse-land")?.addEventListener("click", () => {
      this.enterGroundMode();
    });
    this.shell.querySelector("#idleverse-orbit")?.addEventListener("click", () => {
      this.enterPlanetMode();
    });
    this.shell.querySelector("#idleverse-village")?.addEventListener("click", () => {
      this.focusVillage(true);
    });
    this.shell.querySelector("#idleverse-day")?.addEventListener("click", () => {
      this.advanceDay();
    });

    this.shell.querySelectorAll<HTMLButtonElement>("[data-move]").forEach((button) => {
      const key = button.dataset.move;
      if (!key) return;
      const down = (event: PointerEvent) => {
        event.preventDefault();
        this.keys.add(key);
      };
      const up = (event: PointerEvent) => {
        event.preventDefault();
        this.keys.delete(key);
      };
      button.addEventListener("pointerdown", down);
      button.addEventListener("pointerup", up);
      button.addEventListener("pointercancel", up);
      button.addEventListener("pointerleave", up);
    });
  }

  private mountUi(): void {
    const existingStyle = document.getElementById("idleverse-prototype-style");
    if (!existingStyle) {
      const style = document.createElement("style");
      style.id = "idleverse-prototype-style";
      style.textContent = `
        #app { background: #081624; }
        .idleverse-shell { position: relative; width: 100%; height: 100%; overflow: hidden; color: #fff; font-family: 'Domine', Georgia, serif; }
        .idleverse-canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; touch-action: none; }
        .idleverse-topbar { position: absolute; left: 20px; right: 20px; top: 18px; z-index: 4; display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; pointer-events: none; }
        .idleverse-brand { text-shadow: 0 2px 14px rgba(0,0,0,.25); }
        .idleverse-brand h1 { font-family: 'Darumadrop One', sans-serif; font-size: clamp(34px,5vw,64px); line-height: .85; letter-spacing: .05em; font-weight: 400; }
        .idleverse-brand p { margin-top: 7px; font: 700 10px/1.2 Inter, sans-serif; letter-spacing: .2em; text-transform: uppercase; opacity: .8; }
        .idleverse-stats { display: grid; grid-template-columns: repeat(3,minmax(84px,1fr)); gap: 8px; pointer-events: auto; }
        .idleverse-stat { min-width: 88px; padding: 9px 12px; border: 1px solid rgba(255,255,255,.22); border-radius: 13px; background: rgba(7,20,34,.68); box-shadow: 0 8px 28px rgba(0,0,0,.16); backdrop-filter: blur(12px); }
        .idleverse-stat span { display: block; font: 600 9px/1.2 Inter,sans-serif; text-transform: uppercase; letter-spacing: .12em; opacity: .65; }
        .idleverse-stat strong { display:block; margin-top: 3px; font: 700 15px/1.2 Inter,sans-serif; }
        .idleverse-mode { position:absolute; left:20px; top:112px; z-index:4; padding:10px 13px; border-radius:13px; border:1px solid rgba(255,255,255,.2); background:rgba(7,20,34,.62); backdrop-filter:blur(10px); pointer-events:none; }
        .idleverse-mode strong { display:block; font:700 12px/1.2 Inter,sans-serif; }
        .idleverse-mode span { display:block; max-width:320px; margin-top:3px; font:500 10px/1.35 Inter,sans-serif; opacity:.72; }
        .idleverse-actions { position:absolute; left:20px; bottom:22px; z-index:5; display:flex; flex-wrap:wrap; gap:8px; max-width:min(720px,calc(100% - 40px)); }
        .idleverse-button { min-height:44px; border:1px solid rgba(255,255,255,.22); border-radius:13px; padding:0 15px; color:#fff; background:rgba(7,20,34,.75); backdrop-filter:blur(12px); font:700 12px Inter,sans-serif; box-shadow:0 7px 20px rgba(0,0,0,.14); }
        .idleverse-button:hover { background:rgba(20,48,68,.84); }
        .idleverse-button.primary { background:rgba(69,131,98,.88); }
        .idleverse-button[hidden] { display:none; }
        .idleverse-chronicle { position:absolute; right:20px; top:110px; z-index:4; width:min(300px,33vw); max-height:46%; padding:13px; border-radius:15px; border:1px solid rgba(255,255,255,.2); background:rgba(7,20,34,.65); backdrop-filter:blur(13px); overflow:hidden; }
        .idleverse-chronicle h2 { font:700 12px/1.2 Inter,sans-serif; letter-spacing:.05em; text-transform:uppercase; }
        .idleverse-feed { margin-top:9px; display:flex; flex-direction:column; gap:7px; }
        .idleverse-feed div { padding-top:7px; border-top:1px solid rgba(255,255,255,.12); font:500 10px/1.35 Inter,sans-serif; color:rgba(255,255,255,.82); }
        .idleverse-status { position:absolute; left:50%; bottom:78px; z-index:4; transform:translateX(-50%); padding:8px 12px; border-radius:999px; background:rgba(7,20,34,.7); font:600 10px Inter,sans-serif; opacity:0; transition:opacity .2s ease; pointer-events:none; }
        .idleverse-status.show { opacity:1; }
        .idleverse-touch { position:absolute; right:20px; bottom:22px; z-index:6; display:none; grid-template-columns:repeat(3,46px); gap:5px; }
        .idleverse-touch button { width:46px; height:46px; border:1px solid rgba(255,255,255,.2); border-radius:12px; color:white; background:rgba(7,20,34,.72); font-size:18px; }
        .idleverse-touch .blank { visibility:hidden; }
        @media (max-width: 760px) {
          .idleverse-topbar { left:12px; right:12px; top:12px; }
          .idleverse-brand h1 { font-size:38px; }
          .idleverse-brand p { font-size:8px; }
          .idleverse-stats { grid-template-columns:repeat(3,1fr); gap:5px; }
          .idleverse-stat { min-width:0; padding:7px 8px; }
          .idleverse-stat strong { font-size:12px; }
          .idleverse-mode { left:12px; top:88px; }
          .idleverse-chronicle { display:none; }
          .idleverse-actions { left:12px; bottom:12px; max-width:calc(100% - 24px); }
          .idleverse-button { min-height:42px; padding:0 11px; font-size:10px; }
          .idleverse-touch.active { display:grid; }
        }
      `;
      document.head.appendChild(style);
    }

    this.shell = document.createElement("div");
    this.shell.className = "idleverse-shell";
    this.shell.innerHTML = `
      <div class="idleverse-topbar">
        <div class="idleverse-brand">
          <h1>IDLEVERSE</h1>
          <p>Observe · Evolve · Explore</p>
        </div>
        <div class="idleverse-stats">
          <div class="idleverse-stat"><span>Day</span><strong id="idleverse-day-stat">1</strong></div>
          <div class="idleverse-stat"><span>Population</span><strong id="idleverse-pop-stat">24</strong></div>
          <div class="idleverse-stat"><span>Discoveries</span><strong id="idleverse-discovery-stat">3</strong></div>
        </div>
      </div>
      <div class="idleverse-mode">
        <strong id="idleverse-mode-label">Planet View</strong>
        <span id="idleverse-helper">Drag to rotate · scroll to zoom · click the planet to choose a landing point</span>
      </div>
      <aside class="idleverse-chronicle">
        <h2>World Chronicle</h2>
        <div class="idleverse-feed" id="idleverse-feed"></div>
      </aside>
      <div class="idleverse-status" id="idleverse-status"></div>
      <div class="idleverse-actions">
        <button class="idleverse-button" id="idleverse-village" type="button">🏘 Find Village</button>
        <button class="idleverse-button primary" id="idleverse-land" type="button">🚶 Land Here</button>
        <button class="idleverse-button" id="idleverse-orbit" type="button" hidden>🌍 Planet View</button>
        <button class="idleverse-button" id="idleverse-day" type="button">☀ Advance Day</button>
      </div>
      <div class="idleverse-touch" id="idleverse-touch">
        <span class="blank"></span><button type="button" data-move="w">▲</button><span class="blank"></span>
        <button type="button" data-move="a">◀</button><button type="button" data-move="s">▼</button><button type="button" data-move="d">▶</button>
      </div>
    `;

    this.container.appendChild(this.shell);

    this.modeLabel = this.shell.querySelector("#idleverse-mode-label")!;
    this.helperLabel = this.shell.querySelector("#idleverse-helper")!;
    this.dayLabel = this.shell.querySelector("#idleverse-day-stat")!;
    this.populationLabel = this.shell.querySelector("#idleverse-pop-stat")!;
    this.discoveryLabel = this.shell.querySelector("#idleverse-discovery-stat")!;
    this.chronicle = this.shell.querySelector("#idleverse-feed")!;
    this.status = this.shell.querySelector("#idleverse-status")!;
    this.landButton = this.shell.querySelector("#idleverse-land")!;
    this.orbitButton = this.shell.querySelector("#idleverse-orbit")!;
  }

  private pickLandingPoint(clientX: number, clientY: number): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObject(this.landingSphere, false)[0];
    if (!hit) return;

    const normal = hit.point.clone().normalize();
    if (!this.isLand(normal)) {
      this.showStatus("That point is ocean. Pick a patch of land.");
      return;
    }

    this.selectedNormal.copy(normal);
    this.updateLandingMarker();
    this.showStatus("Landing point selected.");
  }

  private isLand(normal: Vector3): boolean {
    return sampleTerrain(
      WORLD_SEED,
      TERRAIN_TYPE,
      normal.x,
      normal.y,
      normal.z,
    ).isLand;
  }

  private focusVillage(showMessage: boolean): void {
    this.selectedNormal.copy(this.villageNormal);
    this.orbitYaw = Math.atan2(this.villageNormal.x, this.villageNormal.z);
    this.orbitPitch = Math.asin(this.villageNormal.y);
    this.orbitDistance = 8.6;
    this.updateLandingMarker();
    if (showMessage) this.showStatus("Village centered. Land here to walk through it.");
  }

  private updateLandingMarker(): void {
    if (!this.landingMarker || !this.globe) return;
    const alt = this.globe.getSurfaceAltitudeAt(
      this.selectedNormal.x,
      this.selectedNormal.y,
      this.selectedNormal.z,
    );
    this.landingMarker.position
      .copy(this.selectedNormal)
      .multiplyScalar(this.globe.radius + alt + 0.045);
    this.landingMarker.quaternion.setFromUnitVectors(REF_Z, this.selectedNormal);
  }

  private enterGroundMode(): void {
    if (!this.isLand(this.selectedNormal)) {
      this.showStatus("Choose a land location first.");
      return;
    }

    this.mode = "ground";
    this.playerQ.copy(
      quaternionFromSurfaceNormal(
        this.selectedNormal.x,
        this.selectedNormal.y,
        this.selectedNormal.z,
      ),
    );
    this.playerHeading = 0;
    this.playerCarrier.visible = true;
    this.landingMarker.visible = false;
    this.updatePlayerCarrier();

    this.modeLabel.textContent = "Ground View";
    this.helperLabel.textContent =
      "W/S walk · A/D turn · drag left/right to look · return to Planet View anytime";
    this.landButton.hidden = true;
    this.orbitButton.hidden = false;
    this.shell.querySelector("#idleverse-touch")?.classList.add("active");
    this.showStatus("You are now walking on Eden.");
  }

  private enterPlanetMode(): void {
    this.mode = "planet";
    this.playerCarrier.visible = false;
    this.landingMarker.visible = true;
    this.modeLabel.textContent = "Planet View";
    this.helperLabel.textContent =
      "Drag to rotate · scroll to zoom · click the planet to choose a landing point";
    this.landButton.hidden = false;
    this.orbitButton.hidden = true;
    this.shell.querySelector("#idleverse-touch")?.classList.remove("active");

    const up = tangentFrame(this.playerQ).up;
    if (up.lengthSq() > 0.9) {
      this.selectedNormal.copy(up);
      this.orbitYaw = Math.atan2(up.x, up.z);
      this.orbitPitch = Math.asin(up.y);
      this.orbitDistance = 8.6;
      this.updateLandingMarker();
    }
  }

  private spawnCitizen(): void {
    if (!this.globe) return;

    const centerQ = quaternionFromSurfaceNormal(
      this.villageNormal.x,
      this.villageNormal.y,
      this.villageNormal.z,
    );

    let q = centerQ.clone();
    let normal = this.villageNormal.clone();

    for (let attempt = 0; attempt < 16; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const arc = 0.025 + Math.random() * 0.055;
      const candidate = moveOnSphere(centerQ, angle, arc);
      const candidateNormal = tangentFrame(candidate).up;
      if (this.isLand(candidateNormal)) {
        q = candidate;
        normal = candidateNormal;
        break;
      }
    }

    const colors = [0xe45b4f, 0x4b81bd, 0xe3a84f, 0x78a866, 0x9b70b6];
    const avatar = new PilotAvatar(colors[this.citizens.length % colors.length]);
    const carrier = new Group();
    carrier.add(avatar.group);
    this.scene.add(carrier);

    const citizen: Citizen = {
      carrier,
      avatar,
      qPosition: q,
      heading: Math.random() * Math.PI * 2,
      speed: 0.16 + Math.random() * 0.12,
      turnTimer: 1.2 + Math.random() * 2.8,
      phase: Math.random() * Math.PI * 2,
    };
    this.citizens.push(citizen);
    this.updateCitizenCarrier(citizen, normal);
  }

  private addGrowthHouse(logEvent = true): void {
    if (!this.globe) return;

    const centerQ = quaternionFromSurfaceNormal(
      this.villageNormal.x,
      this.villageNormal.y,
      this.villageNormal.z,
    );

    const index = this.structureCount++;
    const angle = index * 2.399963229728653;
    const arc = 0.04 + Math.sqrt(index + 1) * 0.013;
    const q = moveOnSphere(centerQ, angle, arc);
    const normal = tangentFrame(q).up;
    if (!this.isLand(normal)) return;

    const root = new Group();
    const wall = new Mesh(this.sharedHouseWall, this.houseWallMat);
    wall.position.y = 0.1;
    wall.castShadow = true;
    wall.receiveShadow = true;

    const roof = new Mesh(this.sharedHouseRoof, this.houseRoofMat);
    roof.position.y = 0.275;
    roof.rotation.y = Math.PI * 0.25;
    roof.castShadow = true;

    root.add(wall, roof);
    const alt = this.globe.getSurfaceAltitudeAt(normal.x, normal.y, normal.z);
    root.position.copy(normal).multiplyScalar(this.globe.radius + alt - 0.006);
    root.quaternion.copy(
      quaternionFromSurfaceNormal(normal.x, normal.y, normal.z),
    );
    root.rotateY((index * 1.7) % (Math.PI * 2));
    this.growthGroup.add(root);

    if (logEvent) {
      this.addChronicle("A new home was built on the edge of the settlement.");
    }
  }

  private advanceDay(): void {
    this.day += 1;
    this.population += 2 + Math.floor(Math.random() * 5);

    if (this.day % 2 === 0) this.addGrowthHouse(false);
    if (this.day % 3 === 0 && this.citizens.length < 16) this.spawnCitizen();
    if (this.day % 4 === 0) this.discoveries += 1;

    this.dayLabel.textContent = String(this.day);
    this.populationLabel.textContent = this.population.toLocaleString();
    this.discoveryLabel.textContent = String(this.discoveries);

    this.addChronicle(
      CHRONICLE_EVENTS[(this.day - 2) % CHRONICLE_EVENTS.length]!,
    );
  }

  private addChronicle(message: string): void {
    const row = document.createElement("div");
    row.textContent = `Day ${this.day} · ${message}`;
    this.chronicle.prepend(row);
    while (this.chronicle.children.length > 6) {
      this.chronicle.lastElementChild?.remove();
    }
  }

  private showStatus(message: string): void {
    this.status.textContent = message;
    this.status.classList.add("show");
    window.setTimeout(() => this.status.classList.remove("show"), 1800);
  }

  private updateGroundPlayer(dt: number): void {
    const forwardInput =
      (this.keys.has("w") || this.keys.has("arrowup") ? 1 : 0) -
      (this.keys.has("s") || this.keys.has("arrowdown") ? 1 : 0);
    const turnInput =
      (this.keys.has("d") || this.keys.has("arrowright") ? 1 : 0) -
      (this.keys.has("a") || this.keys.has("arrowleft") ? 1 : 0);

    this.playerHeading += turnInput * PLAYER_TURN_SPEED * dt;

    if (forwardInput !== 0) {
      const next = moveOnSphere(
        this.playerQ,
        this.playerHeading,
        (forwardInput * PLAYER_SPEED * dt) / this.globe.radius,
      );
      const nextNormal = tangentFrame(next).up;
      if (this.isLand(nextNormal)) {
        this.playerQ.copy(next);
      }
    }

    this.playerAvatar.update(dt, 0, forwardInput, 100);
    this.playerAvatar.group.position.set(0, 0.018, 0);
    this.updatePlayerCarrier();
  }

  private updatePlayerCarrier(): void {
    const frame = tangentFrame(this.playerQ);
    const forward = this.tmpForward
      .set(0, 0, 0)
      .addScaledVector(frame.north, Math.cos(this.playerHeading))
      .addScaledVector(frame.east, Math.sin(this.playerHeading))
      .normalize();
    const right = this.tmpRight.crossVectors(frame.up, forward).normalize();

    this.tmpMatrix.makeBasis(right, frame.up, forward);
    this.playerCarrier.quaternion.setFromRotationMatrix(this.tmpMatrix);

    const alt = this.globe.getSurfaceAltitudeAt(
      frame.up.x,
      frame.up.y,
      frame.up.z,
    );
    this.playerCarrier.position
      .copy(frame.up)
      .multiplyScalar(this.globe.radius + alt);
  }

  private updateCitizens(dt: number, elapsed: number): void {
    for (const citizen of this.citizens) {
      citizen.turnTimer -= dt;
      if (citizen.turnTimer <= 0) {
        citizen.heading += (Math.random() - 0.5) * 1.2;
        citizen.turnTimer = 1.3 + Math.random() * 3.2;
      }

      citizen.heading += Math.sin(elapsed * 0.35 + citizen.phase) * dt * 0.08;

      const next = moveOnSphere(
        citizen.qPosition,
        citizen.heading,
        (citizen.speed * dt) / this.globe.radius,
      );
      const nextNormal = tangentFrame(next).up;

      if (this.isLand(nextNormal)) {
        citizen.qPosition.copy(next);
      } else {
        citizen.heading += Math.PI * 0.8;
      }

      citizen.avatar.update(dt, 0, 0.38, 100);
      citizen.avatar.group.position.set(0, 0.012, 0);
      this.updateCitizenCarrier(citizen, tangentFrame(citizen.qPosition).up);
    }
  }

  private updateCitizenCarrier(citizen: Citizen, normal: Vector3): void {
    const frame = tangentFrame(citizen.qPosition);
    const forward = new Vector3()
      .addScaledVector(frame.north, Math.cos(citizen.heading))
      .addScaledVector(frame.east, Math.sin(citizen.heading))
      .normalize();
    const right = new Vector3().crossVectors(frame.up, forward).normalize();
    const matrix = new Matrix4().makeBasis(right, frame.up, forward);
    citizen.carrier.quaternion.setFromRotationMatrix(matrix);

    const alt = this.globe.getSurfaceAltitudeAt(
      normal.x,
      normal.y,
      normal.z,
    );
    citizen.carrier.position
      .copy(normal)
      .multiplyScalar(this.globe.radius + alt);
  }

  private updateCamera(): void {
    if (this.mode === "planet") {
      const cosPitch = Math.cos(this.orbitPitch);
      const desired = new Vector3(
        cosPitch * Math.sin(this.orbitYaw),
        Math.sin(this.orbitPitch),
        cosPitch * Math.cos(this.orbitYaw),
      ).multiplyScalar(this.orbitDistance);

      this.camera.position.lerp(desired, 0.1);
      this.camera.up.lerp(new Vector3(0, 1, 0), 0.12).normalize();
      this.camera.lookAt(0, 0, 0);
      return;
    }

    const frame = tangentFrame(this.playerQ);
    const forward = new Vector3()
      .addScaledVector(frame.north, Math.cos(this.playerHeading))
      .addScaledVector(frame.east, Math.sin(this.playerHeading))
      .normalize();

    const desired = this.playerCarrier.position
      .clone()
      .addScaledVector(frame.up, 0.9)
      .addScaledVector(forward, -1.7);

    this.camera.position.lerp(desired, 0.15);
    this.camera.up.lerp(frame.up, 0.15).normalize();
    this.camera.lookAt(
      this.playerCarrier.position
        .clone()
        .addScaledVector(frame.up, 0.34)
        .addScaledVector(forward, 0.55),
    );
  }

  private resize(): void {
    if (!this.renderer) return;
    const rect = this.container.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private animate = (): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.animate);

    const dt = Math.min(this.clock.getDelta(), 0.04);
    const elapsed = this.clock.elapsedTime;

    this.globe.update(dt);
    this.updateCitizens(dt, elapsed);

    if (this.mode === "ground") {
      this.updateGroundPlayer(dt);
    }

    this.simAccumulator += dt;
    if (this.simAccumulator >= 24) {
      this.simAccumulator = 0;
      this.advanceDay();
    }

    this.updateCamera();
    this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("resize", this.onResize);

    for (const citizen of this.citizens) {
      citizen.avatar.dispose();
      this.scene.remove(citizen.carrier);
    }
    this.playerAvatar.dispose();
    this.globe.dispose();

    this.sharedHouseWall.dispose();
    this.sharedHouseRoof.dispose();
    this.houseWallMat.dispose();
    this.houseRoofMat.dispose();
    (this.landingSphere.geometry as SphereGeometry).dispose();
    (this.landingSphere.material as MeshBasicMaterial).dispose();
    this.landingMarker.geometry.dispose();
    (this.landingMarker.material as MeshBasicMaterial).dispose();

    this.renderer.dispose();
    this.shell.remove();
  }
}
