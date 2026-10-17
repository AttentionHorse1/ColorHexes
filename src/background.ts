import OBR, {
  buildLabel,
  buildPath,
  Command,
  type Item,
  type Label,
  type Path,
  type PathCommand,
  type ToolContext,
  type ToolEvent,
  type Vector2,
} from "@owlbear-rodeo/sdk";
import {
  areaPolygons,
  boundarySegments,
  cellCenter,
  hexDistance,
  offsetToAxial,
  type Orientation,
  type Point,
} from "./hex.ts";
import {
  loadRanges,
  MEASURE_TOOL_ID,
  MODE_ID,
  onRangesChange,
  POPOVER_ID,
  SETTINGS_ACTION_ID,
  type RangeDef,
} from "./shared.ts";

/** Ikony i popover z uwzględnieniem podfolderu hostingu (base z vite.config.ts). */
const BASE = import.meta.env.BASE_URL;
const ICON = `${BASE}icon.svg`;
const SETTINGS_ICON = `${BASE}settings.svg`;
const POPOVER_URL = `${BASE}popover.html`;

/** Warstwy, których elementy traktujemy jak tokeny (można je przeciągać). */
const MOVABLE_LAYERS: string[] = ["CHARACTER", "MOUNT", "PROP"];

const FILL_OPACITY = 0.3;

type ItemInteraction = [(recipe: (draft: Item) => void) => unknown, () => void];

interface TokenDrag {
  id: string;
  update: ItemInteraction[0];
  stop: ItemInteraction[1];
  /** Różnica: pozycja tokenu minus pozycja kursora w chwili chwycenia. */
  grab: Vector2;
  startPosition: Vector2;
  lastPosition: Vector2;
}

interface Visual {
  origin: Point;
  orientation: Orientation;
  dpi: number;
  rulerId: string;
  labelId: string;
  ids: string[];
  lastCellKey: string;
}

interface DragState {
  token: TokenDrag | null;
  visual: Visual | null;
}

let ranges: RangeDef[] = [];
let drag: DragState | null = null;
/** Zwiększany przy każdym starcie/końcu, żeby odrzucić spóźnione wyniki wywołań asynchronicznych. */
let session = 0;

let pending: Vector2 | null = null;
let working: Promise<void> | null = null;

// ---------------------------------------------------------------- pomocnicze

function isMovable(target: Item | undefined): target is Item {
  return (
    !!target &&
    target.type === "IMAGE" &&
    !target.locked &&
    MOVABLE_LAYERS.includes(target.layer)
  );
}

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

function polygonCommands(polygons: Point[][]): PathCommand[] {
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

function lineCommands(a: Point, b: Point): PathCommand[] {
  return [
    [Command.MOVE, a.x, a.y] as PathCommand,
    [Command.LINE, b.x, b.y] as PathCommand,
  ];
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
 */
function buildRangeItems(
  origin: Point,
  orientation: Orientation,
  dpi: number,
  visibleRanges: RangeDef[]
): Item[] {
  const sorted = [...visibleRanges].sort((a, b) => a.cells - b.cells);
  const items: Item[] = [];
  let previousCells = -1;
  let z = 0;

  for (const range of sorted) {
    const band = areaPolygons(origin, range.cells, orientation, dpi, previousCells);
    previousCells = Math.max(previousCells, range.cells);
    if (band.length === 0) continue; // ten sam rozmiar co poprzedni zasięg

    const fill = buildPath()
      .commands(polygonCommands(band))
      .fillRule("nonzero")
      .fillColor(range.color)
      .fillOpacity(FILL_OPACITY)
      .strokeOpacity(0)
      .strokeWidth(0)
      .position({ x: 0, y: 0 })
      .layer("DRAWING")
      .locked(true)
      .disableHit(true)
      .zIndex(z++)
      .build();

    const outline = buildPath()
      .commands(segmentCommands(boundarySegments(origin, range.cells, orientation, dpi)))
      .fillOpacity(0)
      .strokeColor(range.color)
      .strokeOpacity(0.95)
      .strokeWidth(Math.max(3, dpi * 0.04))
      .position({ x: 0, y: 0 })
      .layer("DRAWING")
      .locked(true)
      .disableHit(true)
      .zIndex(z++)
      .build();

    items.push(fill, outline);
  }
  return items;
}

/** Zasięgi, linia pomiarowa i etykieta. Zwraca null, gdy siatka nie jest heksagonalna. */
async function setupVisual(
  event: ToolEvent,
  token: Item | undefined,
  mySession: number
): Promise<Visual | null> {
  const gridType = await OBR.scene.grid.getType();
  if (!gridType.startsWith("HEX")) {
    await OBR.notification.show(
      "Zasięgi hex działają tylko na siatce heksagonalnej (Hex).",
      "WARNING"
    );
    return null;
  }

  const [dpi, currentRanges] = await Promise.all([
    OBR.scene.grid.getDpi(),
    loadRanges().catch(() => ranges),
  ]);
  ranges = currentRanges;

  const rawOrigin = token ? token.position : event.pointerPosition;
  const origin = await OBR.scene.grid.snapPosition(rawOrigin, 1, false, true);
  const orientation = await detectOrientation(origin, dpi, gridType);
  if (mySession !== session) return null;

  const rangeItems = buildRangeItems(
    origin,
    orientation,
    dpi,
    currentRanges.filter((r) => r.visible)
  );

  const ruler = buildPath()
    .commands(lineCommands(origin, origin))
    .fillOpacity(0)
    .strokeColor("#ffffff")
    .strokeOpacity(0.9)
    .strokeWidth(Math.max(3, dpi * 0.035))
    .strokeDash([dpi * 0.12, dpi * 0.1])
    .position({ x: 0, y: 0 })
    .layer("DRAWING")
    .locked(true)
    .disableHit(true)
    .zIndex(1000)
    .build();

  const label = buildLabel()
    .plainText("0")
    .position({ x: origin.x, y: origin.y - dpi * 0.7 })
    .layer("TEXT")
    .locked(true)
    .disableHit(true)
    .zIndex(1001)
    .build();

  const all: Item[] = [...rangeItems, ruler, label];
  await OBR.scene.local.addItems(all);

  const ids = all.map((i) => i.id);
  if (mySession !== session) {
    // Drag skończył się zanim dodaliśmy elementy, więc sprzątamy od razu.
    await removeLocal(ids);
    return null;
  }

  return {
    origin,
    orientation,
    dpi,
    rulerId: ruler.id,
    labelId: label.id,
    ids,
    lastCellKey: "0,0",
  };
}

// ------------------------------------------------------------- ruch w trakcie

async function applyMove(pointer: Vector2) {
  const state = drag;
  if (!state) return;

  let measured: Vector2 = pointer;

  const token = state.token;
  if (token) {
    const wanted = { x: pointer.x + token.grab.x, y: pointer.y + token.grab.y };
    const snapped = await OBR.scene.grid.snapPosition(wanted);
    if (drag !== state) return;
    token.lastPosition = snapped;
    token.update((draft) => {
      draft.position = snapped;
    });
    measured = snapped;
  }

  const visual = state.visual;
  if (!visual) return;

  const cell = offsetToAxial(
    measured.x - visual.origin.x,
    measured.y - visual.origin.y,
    visual.orientation,
    visual.dpi
  );
  const key = `${cell.q},${cell.r}`;
  if (key === visual.lastCellKey) return; // aktualizujemy tylko przy przejściu do innej komórki
  visual.lastCellKey = key;

  const center = cellCenter(visual.origin, cell, visual.orientation, visual.dpi);
  const distance = hexDistance(cell);

  try {
    await OBR.scene.local.updateItems([visual.rulerId, visual.labelId], (items) => {
      for (const item of items) {
        if (item.id === visual.rulerId) {
          (item as Path).commands = lineCommands(visual.origin, center);
        } else if (item.id === visual.labelId) {
          const label = item as Label;
          label.text.plainText = String(distance);
          label.position = { x: center.x, y: center.y - visual.dpi * 0.7 };
        }
      }
    });
  } catch {
    // elementy mogły zniknąć (np. koniec dragu), ignorujemy
  }
}

/** Zawsze przetwarzamy tylko najnowszą pozycję kursora, żeby nie budować kolejki opóźnień. */
function scheduleMove(pointer: Vector2) {
  pending = pointer;
  if (working) return;
  working = (async () => {
    try {
      while (pending && drag) {
        const next = pending;
        pending = null;
        await applyMove(next);
      }
    } catch (error) {
      console.error("[Hex Ranges] move", error);
    } finally {
      working = null;
    }
  })();
}

async function finishDrag(commit: boolean, finalPointer?: Vector2) {
  pending = null;
  const state = drag;
  const inFlight = working;
  if (inFlight) await inFlight;

  if (state && commit && finalPointer && drag === state) {
    await applyMove(finalPointer);
  }

  session++;
  drag = null;
  if (!state) return;

  const token = state.token;
  if (token) {
    const moved =
      token.lastPosition.x !== token.startPosition.x ||
      token.lastPosition.y !== token.startPosition.y;
    if (commit && moved) {
      try {
        const finalPosition = token.lastPosition;
        await OBR.scene.items.updateItems([token.id], (items) => {
          for (const item of items) {
            item.position = finalPosition;
          }
        });
      } catch (error) {
        console.error("[Hex Ranges] nie udało się zapisać pozycji tokenu", error);
      }
    }
    token.stop();
  }

  if (state.visual) await removeLocal(state.visual.ids);
}

// ------------------------------------------------------------ zdarzenia narzędzia

async function onDragStart(_ctx: ToolContext, event: ToolEvent) {
  await finishDrag(false);
  const mySession = session;
  const target = event.target;
  const movable = !event.transformer && isMovable(target);

  try {
    const state: DragState = { token: null, visual: null };

    // Token ruszamy od razu, zanim jeszcze narysujemy zasięgi.
    if (movable && target) {
      const [update, stop] = (await OBR.interaction.startItemInteraction(
        target
      )) as unknown as ItemInteraction;
      if (mySession !== session) {
        stop();
        return;
      }
      state.token = {
        id: target.id,
        update,
        stop,
        grab: {
          x: target.position.x - event.pointerPosition.x,
          y: target.position.y - event.pointerPosition.y,
        },
        startPosition: { ...target.position },
        lastPosition: { ...target.position },
      };
      drag = state;
    }

    const visual = await setupVisual(event, movable ? target : undefined, mySession);
    if (mySession !== session) return;

    if (visual) {
      state.visual = visual;
      drag = state;
    }
  } catch (error) {
    console.error("[Hex Ranges] start", error);
  }
}

function onDragMove(_ctx: ToolContext, event: ToolEvent) {
  scheduleMove(event.pointerPosition);
}

async function onDragEnd(_ctx: ToolContext, event: ToolEvent) {
  await finishDrag(true, event.pointerPosition);
}

async function onDragCancel() {
  await finishDrag(false);
}

async function onDeactivate() {
  await finishDrag(false);
}

// --------------------------------------------------------------- uruchomienie

OBR.onReady(async () => {
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
    onToolDragStart: onDragStart,
    onToolDragMove: onDragMove,
    onToolDragEnd: onDragEnd,
    onToolDragCancel: onDragCancel,
    onDeactivate,
  });

  // Ustawienia zasięgów: przycisk widoczny tylko, gdy aktywny jest nasz tryb.
  await OBR.tool.createAction({
    id: SETTINGS_ACTION_ID,
    icons: [
      {
        icon: SETTINGS_ICON,
        label: "Ustawienia zasięgów",
        filter: { activeTools: [MEASURE_TOOL_ID], activeModes: [MODE_ID] },
      },
    ],
    onClick(_ctx, elementId) {
      void OBR.popover.open({
        id: POPOVER_ID,
        url: POPOVER_URL,
        width: 360,
        height: 440,
        anchorElementId: elementId,
      });
    },
  });
});
