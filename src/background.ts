import OBR, {
  buildLabel,
  buildPath,
  Command,
  type Item,
  type PathCommand,
  type ToolContext,
  type ToolEvent,
  type Vector2,
} from "@owlbear-rodeo/sdk";
import { areaPolygons, boundarySegments, type Orientation, type Point } from "./hex.ts";
import {
  loadRanges,
  MEASURE_TOOL_ID,
  MODE_ID,
  onRangesChange,
  POPOVER_ID,
  SETTINGS_ACTION_ID,
  type RangeDef,
} from "./shared.ts";

// Działanie wzorowane na oficjalnym rozszerzeniu "Ranges":
//  - Naciśnięcie myszy (onToolDown) rysuje zasięgi (lokalne elementy, widoczne tylko dla Ciebie).
//  - Jeśli naciśnięto token, to jego przeciąganie jest osobną interakcją (ruch na żywo),
//    a zasięgi zostają w miejscu startu.
//  - Jeśli naciśnięto puste miejsce, zasięgi podążają za kursorem.

/** Ikony i popover z uwzględnieniem podfolderu hostingu (base z vite.config.ts). */
const BASE = import.meta.env.BASE_URL;
const ICON = `${BASE}icon.svg`;
const SETTINGS_ICON = `${BASE}settings.svg`;
const POPOVER_URL = `${BASE}popover.html`;

/** Warstwy, których elementy można przeciągać. */
const MOVABLE_LAYERS: string[] = ["CHARACTER", "MOUNT", "PROP"];

const FILL_OPACITY = 0.3;

type TokenInteraction = [(recipe: (item: Item) => void) => unknown, () => void];

interface Visual {
  ids: string[];
  /** Przesunięcie każdego elementu względem środka zasięgów. */
  offsets: Map<string, Vector2>;
  origin: Point;
  orientation: Orientation;
  dpi: number;
}

let ranges: RangeDef[] = [];

/** Zwiększany przy każdym czyszczeniu, żeby odrzucić spóźnione wyniki wywołań asynchronicznych. */
let session = 0;

let downTarget: Item | null = null;
let grabOffset: Vector2 = { x: 0, y: 0 };
let tokenInteraction: TokenInteraction | null = null;
let tokenStart: Vector2 | null = null;
let tokenLast: Vector2 | null = null;
let visual: Visual | null = null;

let lastPointer: Vector2 | null = null;
let pendingPointer: Vector2 | null = null;
let moving: Promise<void> | null = null;

// ---------------------------------------------------------------- pomocnicze

/**
 * Orientacja siatki wykrywana z samej siatki: jeśli punkt oddalony o `dpi` w poziomie
 * od środka komórki jest też środkiem komórki, sąsiedzi leżą w poziomie ("pointy").
 * W przeciwnym razie ("flat") sąsiedzi leżą w pionie.
 * Gdy wykrycie zawiedzie, zakładamy: HEX_VERTICAL = pointy, HEX_HORIZONTAL = flat.
 */
async function detectOrientation(
  center: Vector2,
  dpi: number,
  gridType: string
): Promise<Orientation> {
  const fallback: Orientation = gridType === "HEX_HORIZONTAL" ? "flat" : "pointy";
  try {
    const probe = { x: center.x + dpi, y: center.y };
    const snapped = await OBR.scene.grid.snapPosition(probe, 1, false, true);
    const isCenter = Math.hypot(snapped.x - probe.x, snapped.y - probe.y) < dpi * 0.02;
    return isCenter ? "pointy" : "flat";
  } catch {
    return fallback;
  }
}

function lineCommandsFromPolygons(polygons: Point[][]): PathCommand[] {
  const cmds: PathCommand[] = [];
  for (const poly of polygons) {
    poly.forEach((p, i) => {
      cmds.push([i === 0 ? Command.MOVE : Command.LINE, p.x, p.y] as PathCommand);
    });
    cmds.push([Command.CLOSE] as PathCommand);
  }
  return cmds;
}

function segmentCommands(segments: [Point, Point][]): PathCommand[] {
  const cmds: PathCommand[] = [];
  for (const [a, b] of segments) {
    cmds.push([Command.MOVE, a.x, a.y] as PathCommand);
    cmds.push([Command.LINE, b.x, b.y] as PathCommand);
  }
  return cmds;
}

function isMovableCandidate(target: Item | undefined, transformer: boolean): target is Item {
  return (
    !!target &&
    !transformer &&
    target.type === "IMAGE" &&
    !target.locked &&
    MOVABLE_LAYERS.includes(target.layer)
  );
}

/** Czy bieżący gracz może przesuwać ten element (GM zawsze, gracz według uprawnień pokoju). */
async function canUpdateItem(item: Item): Promise<boolean> {
  try {
    const role = await OBR.player.getRole();
    if (role === "GM") return true;

    const permissions: Record<string, string> = {
      CHARACTER: "CHARACTER_UPDATE",
      MOUNT: "MOUNT_UPDATE",
      PROP: "PROP_UPDATE",
    };
    const permission = permissions[item.layer];
    if (!permission) return false;
    if (!(await OBR.player.hasPermission(permission as never))) return false;

    if (item.layer === "CHARACTER" && (await OBR.player.hasPermission("CHARACTER_OWNER_ONLY" as never))) {
      return item.createdUserId === OBR.player.id;
    }
    return true;
  } catch (error) {
    console.error("[Hex Ranges] sprawdzanie uprawnień", error);
    return false;
  }
}

async function removeLocal(ids: string[]) {
  if (ids.length === 0) return;
  try {
    await OBR.scene.local.deleteItems(ids);
  } catch {
    // elementy mogły już zostać usunięte
  }
}

// ------------------------------------------------------------------ rysowanie

/**
 * Każdy zasięg to osobny pierścień: wypełnione są tylko komórki między poprzednim
 * (mniejszym) a tym zasięgiem. Dzięki temu kolory się nie nakładają i nie mieszają.
 * Kształty są zbudowane względem punktu (0, 0), a na miejsce ustawia je `position`.
 */
function buildRangeItems(
  origin: Point,
  orientation: Orientation,
  dpi: number,
  visibleRanges: RangeDef[],
  distanceText: (cells: number) => string
): { items: Item[]; offsets: Map<string, Vector2> } {
  const zero = { x: 0, y: 0 };
  const sorted = [...visibleRanges].sort((a, b) => a.cells - b.cells);
  const items: Item[] = [];
  const offsets = new Map<string, Vector2>();
  let previousCells = -1;
  let z = 0;

  for (const range of sorted) {
    const band = areaPolygons(zero, range.cells, orientation, dpi, previousCells);
    previousCells = Math.max(previousCells, range.cells);
    if (band.length === 0) continue; // ten sam rozmiar co poprzedni zasięg

    const fill = buildPath()
      .commands(lineCommandsFromPolygons(band))
      .fillRule("nonzero")
      .fillColor(range.color)
      .fillOpacity(FILL_OPACITY)
      .strokeOpacity(0)
      .strokeWidth(0)
      .position(origin)
      .layer("DRAWING")
      .locked(true)
      .disableHit(true)
      .zIndex(z++)
      .build();

    const outline = buildPath()
      .commands(segmentCommands(boundarySegments(zero, range.cells, orientation, dpi)))
      .fillOpacity(0)
      .strokeColor(range.color)
      .strokeOpacity(0.95)
      .strokeWidth(Math.max(3, dpi * 0.04))
      .position(origin)
      .layer("DRAWING")
      .locked(true)
      .disableHit(true)
      .zIndex(z++)
      .build();

    items.push(fill, outline);
    offsets.set(fill.id, { x: 0, y: 0 });
    offsets.set(outline.id, { x: 0, y: 0 });

    // Etykieta z nazwą i odległością nad zasięgiem (pomijana, jeśli budowanie się nie powiedzie).
    try {
      const top =
        orientation === "pointy"
          ? range.cells * dpi * (Math.sqrt(3) / 2) + dpi * 0.58
          : range.cells * dpi + dpi * 0.5;
      const offset = { x: 0, y: -(top + dpi * 0.3) };
      const text = [range.name.trim(), distanceText(range.cells)].filter(Boolean).join(" ");
      const label = buildLabel()
        .plainText(text)
        .position({ x: origin.x + offset.x, y: origin.y + offset.y })
        .layer("TEXT")
        .locked(true)
        .disableHit(true)
        .zIndex(1000 + z)
        .build();
      items.push(label);
      offsets.set(label.id, offset);
    } catch (error) {
      console.warn("[Hex Ranges] etykieta pominięta", error);
    }
  }
  return { items, offsets };
}

async function setupVisual(event: ToolEvent, mySession: number) {
  const gridType = await OBR.scene.grid.getType();
  if (!gridType.startsWith("HEX")) {
    await OBR.notification.show(
      "Zasięgi hex działają tylko na siatce heksagonalnej (Hex).",
      "WARNING"
    );
    return;
  }

  const [dpi, currentRanges, scale] = await Promise.all([
    OBR.scene.grid.getDpi(),
    loadRanges().catch(() => ranges),
    OBR.scene.grid.getScale().catch(() => null),
  ]);
  ranges = currentRanges;

  const rawOrigin = downTarget ? downTarget.position : event.pointerPosition;
  const origin = await OBR.scene.grid.snapPosition(rawOrigin, 1, false, true);
  const orientation = await detectOrientation(origin, dpi, gridType);
  if (mySession !== session) return;

  const multiplier = scale?.parsed?.multiplier ?? 1;
  const unit = scale?.parsed?.unit ?? "";
  const distanceText = (cells: number) => {
    const value = Math.round(cells * multiplier * 100) / 100;
    return `${value}${unit}`;
  };

  const { items, offsets } = buildRangeItems(
    origin,
    orientation,
    dpi,
    currentRanges.filter((r) => r.visible),
    distanceText
  );
  const ids = items.map((i) => i.id);
  await OBR.scene.local.addItems(items);

  if (mySession !== session) {
    await removeLocal(ids); // tymczasem ruch się skończył
    return;
  }
  visual = { ids, offsets, origin, orientation, dpi };
  if (lastPointer) scheduleMove(lastPointer); // nadrabiamy ruch z czasu przygotowań
}

// ------------------------------------------------------------- ruch w trakcie

async function applyMove(pointer: Vector2) {
  const mySession = session;

  if (downTarget) {
    // Token: przyciągamy do siatki i aktualizujemy interakcję (zasięgi zostają na miejscu).
    const interaction = tokenInteraction;
    if (!interaction) return;
    const position = await OBR.scene.grid.snapPosition({
      x: pointer.x - grabOffset.x,
      y: pointer.y - grabOffset.y,
    });
    if (mySession !== session || tokenInteraction !== interaction) return;
    tokenLast = position;
    interaction[0]((item) => {
      item.position = position;
    });
    return;
  }

  // Pusty punkt: zasięgi podążają za kursorem.
  const current = visual;
  if (!current) return;
  const origin = await OBR.scene.grid.snapPosition(pointer, 1, false, true);
  if (mySession !== session || visual !== current) return;
  if (origin.x === current.origin.x && origin.y === current.origin.y) return;
  current.origin = origin;
  await OBR.scene.local.updateItems(current.ids, (items) => {
    for (const item of items) {
      const offset = current.offsets.get(item.id) ?? { x: 0, y: 0 };
      item.position = { x: origin.x + offset.x, y: origin.y + offset.y };
    }
  });
}

/** Zawsze przetwarzamy tylko najnowszą pozycję kursora, żeby nie budować kolejki opóźnień. */
function scheduleMove(pointer: Vector2) {
  pendingPointer = pointer;
  if (moving) return;
  moving = (async () => {
    try {
      while (pendingPointer) {
        const next = pendingPointer;
        pendingPointer = null;
        await applyMove(next);
      }
    } catch (error) {
      console.error("[Hex Ranges] ruch", error);
    } finally {
      moving = null;
    }
  })();
}

/** Zapisuje końcową pozycję tokenu w scenie (jeśli się ruszył). */
async function finalizeMove(finalPointer?: Vector2) {
  const inFlight = moving;
  if (inFlight) await inFlight;

  if (downTarget && tokenInteraction && finalPointer) {
    try {
      await applyMove(finalPointer);
    } catch (error) {
      console.error("[Hex Ranges] ostatni ruch", error);
    }
  }

  const target = downTarget;
  const start = tokenStart;
  const last = tokenLast;
  if (!target || !tokenInteraction || !start || !last) return;
  if (last.x === start.x && last.y === start.y) return;

  try {
    await OBR.scene.items.updateItems([target.id], (items) => {
      for (const item of items) {
        item.position = last;
      }
    });
  } catch (error) {
    console.error("[Hex Ranges] nie udało się zapisać pozycji tokenu", error);
  }
}

function cleanup() {
  session++;
  pendingPointer = null;

  const interaction = tokenInteraction;
  tokenInteraction = null;
  if (interaction) {
    try {
      interaction[1]();
    } catch {
      // interakcja mogła już wygasnąć
    }
  }

  const current = visual;
  visual = null;
  if (current) void removeLocal(current.ids);

  downTarget = null;
  tokenStart = null;
  tokenLast = null;
}

// ------------------------------------------------------------ zdarzenia narzędzia

async function onToolDown(_ctx: ToolContext, event: ToolEvent) {
  cleanup();
  const mySession = session;
  lastPointer = event.pointerPosition;

  // Wszystko, co decyduje o tokenie, ustalamy od razu (synchronicznie), zanim zaczną się
  // opóźnienia asynchroniczne, żeby późniejszy start przeciągania wiedział, co ruszać.
  const target = event.target;
  if (isMovableCandidate(target, event.transformer)) {
    downTarget = target;
    tokenStart = { ...target.position };
    tokenLast = { ...target.position };
    grabOffset = {
      x: event.pointerPosition.x - target.position.x,
      y: event.pointerPosition.y - target.position.y,
    };
  }

  try {
    await setupVisual(event, mySession);
  } catch (error) {
    console.error("[Hex Ranges] start", error);
    try {
      await OBR.notification.show(
        "Hex Ranges: nie udało się narysować zasięgów (szczegóły w konsoli).",
        "ERROR"
      );
    } catch {
      // brak powiadomień
    }
  }
}

async function onToolDragStart(_ctx: ToolContext, event: ToolEvent) {
  lastPointer = event.pointerPosition;
  const mySession = session;
  const target = downTarget;
  if (!target) return;

  try {
    if (!(await canUpdateItem(target))) {
      if (mySession === session) downTarget = null; // bez uprawnień: tylko pomiar
      return;
    }
    const interaction = (await OBR.interaction.startItemInteraction(
      target
    )) as unknown as TokenInteraction;
    if (mySession !== session) {
      interaction[1]();
      return;
    }
    tokenInteraction = interaction;
    scheduleMove(lastPointer); // zaczynamy od aktualnej pozycji kursora
  } catch (error) {
    console.error("[Hex Ranges] start przeciągania", error);
  }
}

function onToolDragMove(_ctx: ToolContext, event: ToolEvent) {
  lastPointer = event.pointerPosition;
  scheduleMove(event.pointerPosition);
}

async function onToolEnd(_ctx: ToolContext, event: ToolEvent) {
  const mySession = session;
  await finalizeMove(event.pointerPosition);
  if (mySession === session) cleanup();
}

function onToolDragCancel() {
  cleanup();
}

function onDeactivate() {
  cleanup();
}

// --------------------------------------------------------------- uruchomienie

OBR.onReady(() => {
  void (async () => {
    ranges = await loadRanges().catch(() => []);
    onRangesChange((next) => {
      ranges = next;
    });

    // Tryb pojawia się na pasku narzędzia Measure obok Ruler, Movement itd.
    await OBR.tool.createMode({
      id: MODE_ID,
      icons: [
        {
          icon: ICON,
          label: "Zasięgi hex",
          filter: { activeTools: [MEASURE_TOOL_ID] },
        },
      ],
      cursors: [
        {
          cursor: "grabbing",
          filter: { dragging: true, target: [{ key: "type", value: "IMAGE" }] },
        },
        {
          cursor: "grab",
          filter: {
            target: [
              { key: "type", value: "IMAGE" },
              { key: "locked", value: false },
            ],
          },
        },
        { cursor: "crosshair" },
      ],
      // Pojedyncze kliknięcie nie zaznacza niczego (jak w oficjalnym Ranges).
      onToolClick: () => false,
      onToolDown,
      onToolDragStart,
      onToolDragMove,
      onToolDragEnd: onToolEnd,
      onToolUp: onToolEnd,
      onToolDragCancel,
      onDeactivate,
    });
  })().catch((error) => console.error("[Hex Ranges] tryb", error));

  // Przycisk ustawień jest rejestrowany niezależnie od trybu (jak w oficjalnym Ranges),
  // żeby błąd w jednym nie blokował drugiego.
  void OBR.tool
    .createAction({
      id: SETTINGS_ACTION_ID,
      icons: [
        {
          icon: SETTINGS_ICON,
          label: "Ustawienia zasięgów hex",
          filter: { activeTools: [MEASURE_TOOL_ID] },
        },
      ],
      onClick(_ctx, elementId) {
        void OBR.popover.open({
          id: POPOVER_ID,
          url: POPOVER_URL,
          width: 360,
          height: 440,
          anchorElementId: elementId,
          anchorOrigin: { horizontal: "CENTER", vertical: "BOTTOM" },
          transformOrigin: { horizontal: "CENTER", vertical: "TOP" },
        });
      },
    })
    .catch((error) => console.error("[Hex Ranges] akcja ustawień", error));
});
