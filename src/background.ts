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

/** Wynik OBR.interaction.startItemInteraction dla listy elementów. */
type InteractionUpdate = (recipe: (items: Item[]) => void) => Item[];
type InteractionStop = () => void;

interface DragState {
  update: InteractionUpdate;
  stop: InteractionStop;
  /** Id przeciąganego tokenu (null przy samym pomiarze z pustego miejsca). */
  tokenId: string | null;
  /** Różnica: pozycja tokenu minus pozycja kursora w chwili chwycenia. */
  grab: Vector2;
  startPosition: Vector2;
  lastPosition: Vector2;
  origin: Point;
  orientation: Orientation;
  dpi: number;
  rulerId: string;
  labelId: string;
  /** Lokalne (prywatne) elementy zasięgów, które trzeba usunąć na końcu. */
  localIds: string[];
  lastCellKey: string;
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

// ------------------------------------------------------------- ruch w trakcie

async function applyMove(pointer: Vector2) {
  const state = drag;
  if (!state) return;

  let measured: Vector2 = pointer;
  let tokenMoved = false;

  if (state.tokenId) {
    const wanted = { x: pointer.x + state.grab.x, y: pointer.y + state.grab.y };
    const snapped = await OBR.scene.grid.snapPosition(wanted);
    if (drag !== state) return;
    tokenMoved = snapped.x !== state.lastPosition.x || snapped.y !== state.lastPosition.y;
    state.lastPosition = snapped;
    measured = snapped;
  }

  const cell = offsetToAxial(
    measured.x - state.origin.x,
    measured.y - state.origin.y,
    state.orientation,
    state.dpi
  );
  const key = `${cell.q},${cell.r}`;
  const cellChanged = key !== state.lastCellKey;
  if (!tokenMoved && !cellChanged) return;
  state.lastCellKey = key;

  const center = cellCenter(state.origin, cell, state.orientation, state.dpi);
  const distance = hexDistance(cell);
  const tokenPosition = state.lastPosition;

  // Jedno wywołanie aktualizuje naraz token, linię i etykietę (tak samo jak w innych rozszerzeniach
  // przeciągających tokeny), więc wszystko rusza się razem i na żywo.
  state.update((items) => {
    for (const item of items) {
      if (item.id === state.tokenId) {
        item.position = tokenPosition;
      } else if (item.id === state.rulerId) {
        (item as Path).commands = lineCommands(state.origin, center);
      } else if (item.id === state.labelId) {
        const label = item as Label;
        label.text.plainText = String(distance);
        label.position = { x: center.x, y: center.y - state.dpi * 0.7 };
      }
    }
  });
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
    try {
      await applyMove(finalPointer);
    } catch (error) {
      console.error("[Hex Ranges] ostatni ruch", error);
    }
  }

  session++;
  drag = null;
  if (!state) return;

  if (state.tokenId) {
    const moved =
      state.lastPosition.x !== state.startPosition.x ||
      state.lastPosition.y !== state.startPosition.y;
    if (commit && moved) {
      try {
        const finalPosition = state.lastPosition;
        const id = state.tokenId;
        await OBR.scene.items.updateItems([id], (items) => {
          for (const item of items) {
            item.position = finalPosition;
          }
        });
      } catch (error) {
        console.error("[Hex Ranges] nie udało się zapisać pozycji tokenu", error);
      }
    }
  }

  // Zatrzymanie interakcji usuwa też tymczasową linię i etykietę.
  try {
    state.stop();
  } catch {
    // interakcja mogła już wygasnąć
  }
  await removeLocal(state.localIds);
}

// ------------------------------------------------------------ zdarzenia narzędzia

async function onDragStart(_ctx: ToolContext, event: ToolEvent) {
  await finishDrag(false);
  const mySession = session;
  const target = event.target;
  const movable = !event.transformer && isMovable(target);
  const token = movable ? target : undefined;

  try {
    const gridType = await OBR.scene.grid.getType();
    if (!gridType.startsWith("HEX")) {
      await OBR.notification.show(
        "Zasięgi hex działają tylko na siatce heksagonalnej (Hex).",
        "WARNING"
      );
      return;
    }

    const [dpi, currentRanges] = await Promise.all([
      OBR.scene.grid.getDpi(),
      loadRanges().catch(() => ranges),
    ]);
    ranges = currentRanges;

    const rawOrigin = token ? token.position : event.pointerPosition;
    const origin = await OBR.scene.grid.snapPosition(rawOrigin, 1, false, true);
    const orientation = await detectOrientation(origin, dpi, gridType);
    if (mySession !== session) return;

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

    // Token (jeśli jest) i znaczniki pomiaru w jednej interakcji: ruszają się na żywo,
    // a po stop() znikają razem. Interakcję startujemy PRZED ciężkim rysowaniem zasięgów,
    // żeby token od razu reagował na mysz.
    const interactionItems: Item[] = token ? [token, ruler, label] : [ruler, label];
    const [update, stop] = (await OBR.interaction.startItemInteraction(
      interactionItems
    )) as unknown as [InteractionUpdate, InteractionStop];

    if (mySession !== session) {
      stop();
      return;
    }

    const state: DragState = {
      update,
      stop,
      tokenId: token ? token.id : null,
      grab: token
        ? {
            x: token.position.x - event.pointerPosition.x,
            y: token.position.y - event.pointerPosition.y,
          }
        : { x: 0, y: 0 },
      startPosition: token ? { ...token.position } : { x: 0, y: 0 },
      lastPosition: token ? { ...token.position } : { x: 0, y: 0 },
      origin,
      orientation,
      dpi,
      rulerId: ruler.id,
      labelId: label.id,
      localIds: [],
      lastCellKey: "0,0",
    };
    drag = state;

    // Zasięgi (statyczne, tylko dla mnie) dodajemy po starcie ruchu.
    const rangeItems = buildRangeItems(
      origin,
      orientation,
      dpi,
      currentRanges.filter((r) => r.visible)
    );
    state.localIds = rangeItems.map((i) => i.id);
    await OBR.scene.local.addItems(rangeItems);

    if (mySession !== session) {
      // Drag skończył się w trakcie dodawania, więc sprzątamy od razu.
      await removeLocal(state.localIds);
    }
  } catch (error) {
    console.error("[Hex Ranges] start", error);
    try {
      await OBR.notification.show(
        "Hex Ranges: nie udało się rozpocząć przeciągania (szczegóły w konsoli).",
        "ERROR"
      );
    } catch {
      // brak powiadomień, trudno
    }
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

  // Ustawienia zasięgów: przycisk widoczny na pasku narzędzia Measure.
  await OBR.tool.createAction({
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
      });
    },
  });
});
